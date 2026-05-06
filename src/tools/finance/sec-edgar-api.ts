/**
 * SEC EDGAR fallback for the /filings/ endpoint.
 *
 * Why: Financial Datasets free tier covers 5 tickers; EDGAR is the
 * authoritative source, free, no key required, no per-ticker gating.
 *
 * Coverage:
 *   /filings/                 — full filings metadata (form, date, primary doc URL)
 *
 * Out of scope (FD has unique value here):
 *   /filings/items/           — FD pre-extracts named items (Item-1A, Item-7, etc.).
 *                               EDGAR doesn't; agent should web_fetch the
 *                               primary document URL we return instead.
 *
 * EDGAR fair-access: requires a User-Agent identifying the requester.
 */

import type { ApiResponse } from './api.js';
import { logger } from '../../utils/logger.js';

/**
 * SEC fair-access requires a UA with a real contact. They block generic UAs.
 * Override via env if you want to identify yourself differently.
 */
const EDGAR_UA = process.env.SEC_EDGAR_USER_AGENT
  || 'Dexter Research Agent kangjian.sz@gmail.com';

// Map FD's 3-letter form names to the broader set EDGAR uses (foreign filers,
// smaller reporting companies, etc.). When the user asks for "10-K" of a
// Canadian company like CCJ, surface their 40-F too.
const FORM_EQUIVALENTS: Record<string, string[]> = {
  '10-K': ['10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A'],
  '10-Q': ['10-Q', '10-Q/A', '6-K', '6-K/A'],
  '8-K': ['8-K', '8-K/A', '6-K'],
};

interface TickerInfo {
  cik: string;
  /** Series ID for fund tickers (e.g. URA → S000041867). Operating companies = undefined. */
  seriesId?: string;
  classId?: string;
}

let tickerToInfoCache: Map<string, TickerInfo> | null = null;
let tickerCacheLoadedAt = 0;
const TICKER_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

async function loadTickerToInfo(): Promise<Map<string, TickerInfo>> {
  const now = Date.now();
  if (tickerToInfoCache && now - tickerCacheLoadedAt < TICKER_CACHE_TTL_MS) {
    return tickerToInfoCache;
  }
  const map = new Map<string, TickerInfo>();

  // (1) Operating companies
  try {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': EDGAR_UA },
    });
    if (res.ok) {
      const json = await res.json() as Record<string, { cik_str: number; ticker: string; title: string }>;
      for (const entry of Object.values(json)) {
        if (entry?.ticker && entry.cik_str !== undefined) {
          map.set(entry.ticker.toUpperCase(), {
            cik: String(entry.cik_str).padStart(10, '0'),
          });
        }
      }
    } else {
      logger.warn(`[EDGAR] company_tickers.json ${res.status}`);
    }
  } catch (e) {
    logger.warn(`[EDGAR] company_tickers.json failed: ${e instanceof Error ? e.message : e}`);
  }

  // (2) Mutual funds + ETFs — also captures seriesId/classId, needed to
  //     disambiguate funds sharing a CIK (e.g. Global X Funds files NPORT-P
  //     for URA, KWEB, MLPX, ... all under CIK 1432353).
  try {
    const res = await fetch('https://www.sec.gov/files/company_tickers_mf.json', {
      headers: { 'User-Agent': EDGAR_UA },
    });
    if (res.ok) {
      const json = await res.json() as { fields?: string[]; data?: Array<Array<string | number>> };
      const fields = json.fields ?? [];
      const cikIdx = fields.indexOf('cik');
      const symIdx = fields.indexOf('symbol');
      const seriesIdx = fields.indexOf('seriesId');
      const classIdx = fields.indexOf('classId');
      if (cikIdx >= 0 && symIdx >= 0) {
        for (const row of json.data ?? []) {
          const cik = row[cikIdx];
          const sym = row[symIdx];
          if (typeof sym !== 'string') continue;
          if (typeof cik !== 'number' && typeof cik !== 'string') continue;
          const ticker = sym.toUpperCase();
          if (!map.has(ticker)) {
            map.set(ticker, {
              cik: String(Number(cik)).padStart(10, '0'),
              seriesId: seriesIdx >= 0 ? (row[seriesIdx] as string | undefined) : undefined,
              classId: classIdx >= 0 ? (row[classIdx] as string | undefined) : undefined,
            });
          }
        }
      }
    } else {
      logger.warn(`[EDGAR] company_tickers_mf.json ${res.status}`);
    }
  } catch (e) {
    logger.warn(`[EDGAR] company_tickers_mf.json failed: ${e instanceof Error ? e.message : e}`);
  }

  if (map.size === 0) {
    throw new Error('[EDGAR] failed to load any ticker→CIK mappings');
  }

  tickerToInfoCache = map;
  tickerCacheLoadedAt = now;
  return map;
}

/** Lookup tickerInfo for a ticker. Returns null if unknown. */
export async function lookupTickerInfo(ticker: string): Promise<TickerInfo | null> {
  const map = await loadTickerToInfo();
  return map.get(ticker.toUpperCase()) ?? null;
}

interface SubmissionsResponse {
  cik?: string;
  name?: string;
  tickers?: string[];
  filings?: {
    recent?: {
      accessionNumber?: string[];
      filingDate?: string[];
      reportDate?: string[];
      form?: string[];
      primaryDocument?: string[];
      primaryDocDescription?: string[];
      isXBRL?: number[];
      isInlineXBRL?: number[];
    };
  };
}

async function fetchSubmissions(cik: string): Promise<SubmissionsResponse> {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const res = await fetch(url, { headers: { 'User-Agent': EDGAR_UA } });
  if (!res.ok) throw new Error(`[EDGAR] submissions ${cik} ${res.status}`);
  return await res.json() as SubmissionsResponse;
}

/** Build the public archive URL for a filing's primary document. */
function buildFilingUrl(cik: string, accession: string, primaryDoc: string): string {
  const noDashes = accession.replace(/-/g, '');
  const cikInt = String(parseInt(cik, 10));
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${noDashes}/${primaryDoc}`;
}

/** Build the filing index URL (HTML listing of all docs in the filing). */
function buildFilingIndexUrl(cik: string, accession: string): string {
  const noDashes = accession.replace(/-/g, '');
  const cikInt = String(parseInt(cik, 10));
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${noDashes}/${accession}-index.htm`;
}

/** Build the raw NPORT-P XBRL document URL (parseable XML). */
function buildNportXmlUrl(cik: string, accession: string): string {
  const noDashes = accession.replace(/-/g, '');
  const cikInt = String(parseInt(cik, 10));
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${noDashes}/primary_doc.xml`;
}

interface NportHolding {
  name: string;
  ticker: string | null;
  cusip: string | null;
  shares: number | null;
  value_usd: number | null;
  pct_of_fund: number | null;
  payoff: string | null;  // Long / Short
  asset_category: string | null;
}

interface NportSummary {
  filer: string | null;
  fund: string | null;
  period_of_report: string | null;
  total_assets_usd: number | null;
  total_liabilities_usd: number | null;
  net_assets_usd: number | null;
  holdings: NportHolding[];
  holdings_count: number;
}

/**
 * Fetch + parse a NPORT-P XBRL document into a structured summary.
 * NPORT-P encodes holdings as <invstOrSec> elements; we extract the fields
 * an investor actually cares about (name, ticker, shares, value, pct).
 */
export async function fetchNportHoldings(cik: string, accession: string): Promise<NportSummary> {
  const url = buildNportXmlUrl(cik, accession);
  const res = await fetch(url, { headers: { 'User-Agent': EDGAR_UA } });
  if (!res.ok) throw new Error(`[EDGAR] NPORT XML ${res.status} for ${accession}`);
  const xml = await res.text();
  const { parseHTML } = await import('linkedom');
  const { document } = parseHTML(xml);

  const text = (sel: string, root: Element | Document = document): string | null => {
    const el = root.querySelector(sel);
    return el?.textContent?.trim() || null;
  };
  const num = (s: string | null): number | null => {
    if (s === null) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const holdings: NportHolding[] = [];
  const items = document.querySelectorAll('invstOrSec');
  for (const item of Array.from(items)) {
    const tickerEl = item.querySelector('identifiers ticker');
    const tickerVal = tickerEl?.getAttribute('value') ?? text('identifiers > ticker', item);
    holdings.push({
      name: text('name', item) ?? '',
      ticker: tickerVal || null,
      cusip: text('cusip', item),
      shares: num(text('balance', item)),
      value_usd: num(text('valUSD', item)),
      pct_of_fund: num(text('pctVal', item)),
      payoff: text('payoffProfile', item),
      asset_category: text('assetCat', item),
    });
  }
  // Sort by absolute value descending — biggest positions first.
  holdings.sort((a, b) => (Math.abs(b.value_usd ?? 0)) - (Math.abs(a.value_usd ?? 0)));

  return {
    filer: text('filerInfo registrant name'),
    fund: text('fundInfo seriesName') ?? text('genInfo seriesName'),
    period_of_report: text('genInfo repPdEnd') ?? text('repPdEnd'),
    total_assets_usd: num(text('fundInfo totAssets') ?? text('totAssets')),
    total_liabilities_usd: num(text('fundInfo totLiabs') ?? text('totLiabs')),
    net_assets_usd: num(text('fundInfo netAssets') ?? text('netAssets')),
    holdings,
    holdings_count: holdings.length,
  };
}

/**
 * EDGAR adapter for /filings/ — returns FD-shaped filings list.
 *
 * Args:
 *   - ticker (required)
 *   - filing_type: string or string[] (e.g. "10-K" or ["10-K","10-Q"])
 *   - limit: max items to return (default 10)
 */
export async function edgarGetFilings(params: Record<string, unknown>): Promise<ApiResponse> {
  const ticker = String(params.ticker ?? '').trim().toUpperCase();
  if (!ticker) throw new Error('[EDGAR] ticker required');
  const limit = Number(params.limit ?? 10);

  const requestedTypes = Array.isArray(params.filing_type)
    ? (params.filing_type as string[]).map(t => String(t).toUpperCase())
    : params.filing_type
      ? [String(params.filing_type).toUpperCase()]
      : [];

  const allowedForms = new Set<string>();
  if (requestedTypes.length === 0) {
    // No filter — accept the common operating-company forms PLUS the common
    // 1940-Act fund forms so ETFs (URA, KWEB, etc.) return something useful.
    [
      '10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '8-K/A',  // operating cos
      '20-F', '40-F', '6-K',                                // foreign filers
      'N-CSR', 'N-CSRS', 'N-PX', 'NPORT-P',                 // 1940 Act funds
      '497', '497K', '485BPOS', '24F-2NT',                  // prospectus / shelf
    ].forEach(f => allowedForms.add(f));
  } else {
    for (const t of requestedTypes) {
      const equiv = FORM_EQUIVALENTS[t] ?? [t];
      equiv.forEach(f => allowedForms.add(f));
    }
  }

  const info = await lookupTickerInfo(ticker);
  if (!info) {
    throw new Error(`[EDGAR] no CIK for ticker ${ticker} (not registered with SEC?)`);
  }
  const { cik, seriesId } = info;

  const subs = await fetchSubmissions(cik);
  const recent = subs.filings?.recent;
  if (!recent) {
    return { data: { filings: [] }, url: `https://data.sec.gov/submissions/CIK${cik}.json` };
  }

  const issuerName = subs.name ?? ticker;
  const accessions = recent.accessionNumber ?? [];
  const dates = recent.filingDate ?? [];
  const periods = recent.reportDate ?? [];
  const forms = recent.form ?? [];
  const primaries = recent.primaryDocument ?? [];

  // Collect candidates first; if this is a fund (has seriesId) and the
  // candidate set includes series-scoped forms, filter by series match.
  const candidates: Array<{ idx: number; form: string }> = [];
  for (let i = 0; i < accessions.length; i++) {
    const form = forms[i];
    if (form && allowedForms.has(form)) candidates.push({ idx: i, form });
  }

  // Series-scoped forms: each filing maps to ONE series within the filer.
  // For fund tickers we must filter so we don't return URA's sibling funds.
  const SERIES_SCOPED = new Set(['NPORT-P', 'N-CSR', 'N-CSRS', 'N-PX', 'N-Q', '497', '485BPOS', '485APOS', '24F-2NT']);

  const filings: Array<Record<string, unknown>> = [];
  for (const cand of candidates) {
    if (filings.length >= limit) break;
    const i = cand.idx;
    const accession = accessions[i];
    const primary = primaries[i] ?? '';

    // Series filter for fund tickers — verify each candidate's XML before keeping.
    if (seriesId && SERIES_SCOPED.has(cand.form)) {
      try {
        const matches = await accessionMatchesSeries(cik, accession, seriesId);
        if (!matches) continue;
      } catch (e) {
        // Treat fetch failure as non-match so we don't return wrong-fund data.
        logger.warn(`[EDGAR] series check failed for ${accession}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
    }

    filings.push({
      ticker,
      issuer: issuerName,
      series_id: seriesId ?? null,
      filing_type: cand.form,
      accession_number: accession,
      filing_date: dates[i],
      period_of_report: periods[i] || null,
      document_url: primary ? buildFilingUrl(cik, accession, primary) : null,
      filing_index_url: buildFilingIndexUrl(cik, accession),
      source: 'sec-edgar',
    });
  }

  return {
    data: { filings },
    url: `https://data.sec.gov/submissions/CIK${cik}.json`,
  };
}

/**
 * Check whether a given accession's primary doc references our target series.
 * Looks for `<seriesId>S000xxxxx</seriesId>` anywhere in the XML.
 */
async function accessionMatchesSeries(cik: string, accession: string, seriesId: string): Promise<boolean> {
  const url = buildNportXmlUrl(cik, accession);
  const res = await fetch(url, { headers: { 'User-Agent': EDGAR_UA } });
  if (!res.ok) return false;
  const xml = await res.text();
  // Cheap text match — avoids loading a parser when answer is clearly no.
  return xml.includes(seriesId);
}

/**
 * Stub for /filings/items/ — EDGAR doesn't pre-split filings into named items.
 * Return a clear instruction so the calling LLM uses web_fetch on the document URL.
 */
export function edgarFilingsItemsFallback(params: Record<string, unknown>): ApiResponse {
  return {
    data: {
      error: 'sec-edgar-no-item-extraction',
      message: 'SEC EDGAR (the free fallback used here) does not pre-extract named filing items (Item-1A, Item-7, etc.). To read this filing\'s content, call get_filings first to get the document_url, then web_fetch that URL and let me parse the section you need.',
      requested_params: params,
    },
    url: 'https://www.sec.gov/edgar',
  };
}

/** Whether EDGAR can serve this endpoint. */
export function edgarSupports(endpoint: string): boolean {
  return endpoint === '/filings/' || endpoint === '/filings/items/';
}

export async function edgarGet(
  endpoint: string,
  params: Record<string, unknown>,
): Promise<ApiResponse> {
  if (endpoint === '/filings/') return edgarGetFilings(params);
  if (endpoint === '/filings/items/') {
    logger.warn('[EDGAR] /filings/items/ requested but not supported; returning instruction stub');
    return edgarFilingsItemsFallback(params);
  }
  throw new Error(`[EDGAR] unsupported endpoint: ${endpoint}`);
}
