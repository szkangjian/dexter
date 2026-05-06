/**
 * Finnhub adapter — translates Financial Datasets-style endpoint calls into
 * Finnhub HTTP requests, then reshapes Finnhub responses to match the
 * Financial Datasets payload shapes that downstream tools expect.
 *
 * Finnhub free tier covers:
 * - All US equities and major ETFs (price, news, insider, basic financials)
 * - 60 calls/min
 *
 * Endpoints covered (best effort):
 *   /prices/snapshot/                       -> /quote
 *   /prices/                                -> /stock/candle
 *   /prices/snapshot/tickers/               -> /stock/symbol (US exchange)
 *   /news                                   -> /company-news (or /news for market)
 *   /insider-trades/                        -> /stock/insider-transactions
 *   /financial-metrics/snapshot/            -> /stock/metric?metric=all
 *   /financial-metrics/                     -> /stock/metric (single snapshot, no history)
 *   /financials/income-statements/          -> /stock/financials-reported (XBRL extract)
 *   /financials/balance-sheets/             -> /stock/financials-reported
 *   /financials/cash-flow-statements/       -> /stock/financials-reported
 *   /financials/                            -> /stock/financials-reported (combined)
 *   /earnings                               -> /stock/earnings + /quote
 *   /analyst-estimates/                     -> /stock/recommendation + /stock/price-target
 *
 * Endpoints with NO Finnhub equivalent (caller falls back to FD):
 *   /financials/segments/
 *   /financials/search/screener/
 *   /financials/search/screener/filters/
 *   /filings/items/      (XBRL section extraction is FD-specific)
 *   /filings/items/types/
 *   /filings/
 *   /crypto/*
 */

import { logger } from '../../utils/logger.js';
import { readCache, writeCache, describeRequest } from '../../utils/cache.js';
import type { ApiResponse } from './api.js';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

function getFinnhubKey(): string {
  return process.env.FINNHUB_API_KEY || '';
}

/** Endpoints we know how to translate. Used by the router in api.ts. */
export const FINNHUB_SUPPORTED_ENDPOINTS = new Set([
  '/prices/snapshot/',
  '/prices/',
  '/prices/snapshot/tickers/',
  '/news',
  '/news/',
  '/insider-trades/',
  '/financial-metrics/snapshot/',
  '/financial-metrics/',
  '/financials/income-statements/',
  '/financials/balance-sheets/',
  '/financials/cash-flow-statements/',
  '/financials/',
  '/earnings',
  '/earnings/',
  '/analyst-estimates/',
]);

export function isFinnhubAvailable(): boolean {
  return !!getFinnhubKey();
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function finnhubFetch(path: string, query: Record<string, string | number | undefined>): Promise<{ data: unknown; url: string }> {
  const apiKey = getFinnhubKey();
  if (!apiKey) {
    throw new Error('[Finnhub] FINNHUB_API_KEY not set');
  }

  const url = new URL(`${FINNHUB_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.append(k, String(v));
    }
  }
  url.searchParams.append('token', apiKey);

  const displayUrl = url.toString().replace(/token=[^&]+/, 'token=<redacted>');

  let res: Response;
  try {
    res = await fetch(url.toString());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`[Finnhub] network error: ${displayUrl} — ${msg}`);
    throw new Error(`[Finnhub] request failed: ${msg}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const detail = `${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`;
    logger.error(`[Finnhub] error: ${displayUrl} — ${detail}`);
    throw new Error(`[Finnhub] request failed: ${detail}`);
  }

  const data = await res.json().catch(() => {
    throw new Error(`[Finnhub] invalid JSON from ${displayUrl}`);
  });

  return { data, url: displayUrl };
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoToUnix(iso: string): number {
  return Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / 1000);
}

function unixToISO(t: number): string {
  return new Date(t * 1000).toISOString();
}

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// XBRL → named field translation for financials-reported
// ---------------------------------------------------------------------------

/**
 * Common XBRL/US-GAAP concept names → FD-style snake_case field names.
 * Finnhub returns line items like { concept: 'us-gaap_Revenues', value: 123 }.
 * We squash a small set of high-signal concepts into the same names FD uses,
 * so downstream tool callers see familiar fields.
 */
const XBRL_INCOME_MAP: Record<string, string> = {
  'us-gaap_Revenues': 'revenue',
  'us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax': 'revenue',
  'us-gaap_SalesRevenueNet': 'revenue',
  'us-gaap_CostOfRevenue': 'cost_of_revenue',
  'us-gaap_CostOfGoodsAndServicesSold': 'cost_of_revenue',
  'us-gaap_GrossProfit': 'gross_profit',
  'us-gaap_OperatingExpenses': 'operating_expense',
  'us-gaap_ResearchAndDevelopmentExpense': 'research_and_development',
  'us-gaap_SellingGeneralAndAdministrativeExpense': 'selling_general_and_administrative_expenses',
  'us-gaap_OperatingIncomeLoss': 'operating_income',
  'us-gaap_InterestExpense': 'interest_expense',
  'us-gaap_IncomeTaxExpenseBenefit': 'income_tax_expense',
  'us-gaap_NetIncomeLoss': 'net_income',
  'us-gaap_EarningsPerShareBasic': 'earnings_per_share',
  'us-gaap_EarningsPerShareDiluted': 'earnings_per_share_diluted',
  'us-gaap_WeightedAverageNumberOfSharesOutstandingBasic': 'weighted_average_shares',
  'us-gaap_WeightedAverageNumberOfDilutedSharesOutstanding': 'weighted_average_shares_diluted',
};

const XBRL_BALANCE_MAP: Record<string, string> = {
  'us-gaap_CashAndCashEquivalentsAtCarryingValue': 'cash_and_equivalents',
  'us-gaap_ShortTermInvestments': 'current_investments',
  'us-gaap_AccountsReceivableNetCurrent': 'accounts_receivable',
  'us-gaap_InventoryNet': 'inventory',
  'us-gaap_AssetsCurrent': 'current_assets',
  'us-gaap_PropertyPlantAndEquipmentNet': 'property_plant_and_equipment',
  'us-gaap_Goodwill': 'goodwill',
  'us-gaap_IntangibleAssetsNetExcludingGoodwill': 'intangible_assets',
  'us-gaap_Assets': 'total_assets',
  'us-gaap_AccountsPayableCurrent': 'accounts_payable',
  'us-gaap_LiabilitiesCurrent': 'current_liabilities',
  'us-gaap_LongTermDebtNoncurrent': 'long_term_debt',
  'us-gaap_LongTermDebt': 'long_term_debt',
  'us-gaap_Liabilities': 'total_liabilities',
  'us-gaap_StockholdersEquity': 'shareholders_equity',
  'us-gaap_StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest': 'shareholders_equity',
  'us-gaap_CommonStockSharesOutstanding': 'outstanding_shares',
};

const XBRL_CASHFLOW_MAP: Record<string, string> = {
  'us-gaap_NetCashProvidedByUsedInOperatingActivities': 'net_cash_flow_from_operations',
  'us-gaap_PaymentsToAcquirePropertyPlantAndEquipment': 'capital_expenditure',
  'us-gaap_NetCashProvidedByUsedInInvestingActivities': 'net_cash_flow_from_investing',
  'us-gaap_NetCashProvidedByUsedInFinancingActivities': 'net_cash_flow_from_financing',
  'us-gaap_PaymentsOfDividends': 'dividends_paid',
  'us-gaap_PaymentsForRepurchaseOfCommonStock': 'share_repurchases',
  'us-gaap_DepreciationAndAmortization': 'depreciation_and_amortization',
};

interface FinnhubReportItem {
  concept?: string;
  unit?: string;
  label?: string;
  value?: number;
}

interface FinnhubReport {
  cik?: string;
  symbol?: string;
  year?: number;
  quarter?: number;
  startDate?: string;
  endDate?: string;
  filedDate?: string;
  form?: string;
  report?: {
    bs?: FinnhubReportItem[];
    ic?: FinnhubReportItem[];
    cf?: FinnhubReportItem[];
  };
}

function extractFromReport(items: FinnhubReportItem[] | undefined, conceptMap: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  if (!items) return out;
  for (const item of items) {
    if (!item.concept || typeof item.value !== 'number') continue;
    const fdName = conceptMap[item.concept];
    if (fdName && out[fdName] === undefined) {
      out[fdName] = item.value;
    }
  }
  return out;
}

function buildFinancialRecord(report: FinnhubReport, ticker: string, kind: 'income' | 'balance' | 'cashflow' | 'all'): Record<string, unknown> {
  const reportPeriod = report.endDate ?? '';
  const fiscalPeriod = report.quarter && report.quarter > 0 ? `Q${report.quarter}` : 'FY';

  const base: Record<string, unknown> = {
    ticker,
    report_period: reportPeriod,
    fiscal_period: fiscalPeriod,
    filed_date: report.filedDate,
  };

  if (kind === 'income' || kind === 'all') {
    Object.assign(base, extractFromReport(report.report?.ic, XBRL_INCOME_MAP));
  }
  if (kind === 'balance' || kind === 'all') {
    Object.assign(base, extractFromReport(report.report?.bs, XBRL_BALANCE_MAP));
  }
  if (kind === 'cashflow' || kind === 'all') {
    Object.assign(base, extractFromReport(report.report?.cf, XBRL_CASHFLOW_MAP));
    // Derived: free_cash_flow = OCF - CapEx
    const ocf = base['net_cash_flow_from_operations'];
    const capex = base['capital_expenditure'];
    if (typeof ocf === 'number' && typeof capex === 'number') {
      base['free_cash_flow'] = ocf - Math.abs(capex);
    }
  }

  return base;
}

// ---------------------------------------------------------------------------
// Endpoint translators
// ---------------------------------------------------------------------------

async function priceSnapshot(ticker: string): Promise<ApiResponse> {
  const { data, url } = await finnhubFetch('/quote', { symbol: ticker });
  const q = data as { c?: number; h?: number; l?: number; o?: number; pc?: number; t?: number };
  const price = q.c ?? 0;
  const prevClose = q.pc ?? 0;
  const dayChange = price - prevClose;
  const dayChangePct = prevClose > 0 ? (dayChange / prevClose) * 100 : 0;
  return {
    data: {
      snapshot: {
        ticker,
        price,
        day_open: q.o ?? null,
        day_high: q.h ?? null,
        day_low: q.l ?? null,
        previous_close: prevClose,
        day_change: dayChange,
        day_change_percent: dayChangePct,
        time: q.t ? unixToISO(q.t) : todayISO(),
      },
    },
    url,
  };
}

async function priceHistory(ticker: string, startDate: string, endDate: string, interval: string): Promise<ApiResponse> {
  // Finnhub /stock/candle moved to paid tier — go straight to Yahoo Finance,
  // which exposes a stable, free, no-key chart endpoint.
  const yhInterval = interval === 'week' ? '1wk' : interval === 'month' ? '1mo' : interval === 'year' ? '1mo' : '1d';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${isoToUnix(startDate)}&period2=${isoToUnix(endDate)}&interval=${yhInterval}`;

  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) {
    throw new Error(`[Yahoo] price history ${res.status} ${res.statusText}`);
  }
  const json = await res.json() as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }> };
      }>;
      error?: { description?: string } | null;
    };
  };
  if (json.chart?.error) {
    throw new Error(`[Yahoo] ${json.chart.error.description ?? 'unknown error'}`);
  }
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0] ?? {};
  const prices = ts.map((t, i) => ({
    open: q.open?.[i] ?? null,
    high: q.high?.[i] ?? null,
    low: q.low?.[i] ?? null,
    close: q.close?.[i] ?? null,
    volume: q.volume?.[i] ?? null,
    time: unixToISO(t),
  }));
  return { data: { prices }, url };
}

async function tickerList(): Promise<ApiResponse> {
  const { data, url } = await finnhubFetch('/stock/symbol', { exchange: 'US' });
  const list = data as Array<{ symbol?: string; description?: string; type?: string }>;
  const tickers = list
    .filter(s => s.symbol && (s.type === 'Common Stock' || s.type === 'ETP' || s.type === 'ETF'))
    .map(s => s.symbol);
  return { data: { tickers }, url };
}

async function companyNews(ticker: string | undefined, limit: number): Promise<ApiResponse> {
  const cap = Math.min(Math.max(limit, 1), 50);
  if (!ticker) {
    // Market-wide news (general category)
    const { data, url } = await finnhubFetch('/news', { category: 'general' });
    const arr = data as Array<{ id?: number; datetime?: number; headline?: string; summary?: string; source?: string; url?: string; image?: string }>;
    const news = arr.slice(0, cap).map(n => ({
      ticker: null,
      title: n.headline,
      author: null,
      source: n.source,
      date: n.datetime ? unixToISO(n.datetime) : null,
      url: n.url,
    }));
    return { data: { news }, url };
  }
  const { data, url } = await finnhubFetch('/company-news', {
    symbol: ticker,
    from: daysAgoISO(14),
    to: todayISO(),
  });
  const arr = data as Array<{ id?: number; datetime?: number; headline?: string; summary?: string; source?: string; url?: string }>;
  const news = arr.slice(0, cap).map(n => ({
    ticker,
    title: n.headline,
    author: null,
    source: n.source,
    date: n.datetime ? unixToISO(n.datetime) : null,
    url: n.url,
  }));
  return { data: { news }, url };
}

async function insiderTrades(ticker: string, limit: number, fromDate?: string, toDate?: string): Promise<ApiResponse> {
  const { data, url } = await finnhubFetch('/stock/insider-transactions', {
    symbol: ticker,
    from: fromDate,
    to: toDate,
  });
  const d = data as { data?: Array<{ name?: string; share?: number; change?: number; filingDate?: string; transactionDate?: string; transactionCode?: string; transactionPrice?: number }> };
  const list = (d.data ?? []).slice(0, limit).map(t => {
    const shares = t.change ?? 0;
    const pricePerShare = t.transactionPrice ?? null;
    const value = pricePerShare !== null ? shares * pricePerShare : null;
    return {
      ticker,
      name: t.name,
      title: null,
      transaction_date: t.transactionDate,
      filing_date: t.filingDate,
      transaction_code: t.transactionCode,
      transaction_shares: shares,
      transaction_price_per_share: pricePerShare,
      transaction_value: value,
      shares_owned_after: t.share,
      is_board_director: null,
    };
  });
  return { data: { insider_trades: list }, url };
}

interface FinnhubMetricResponse {
  metric?: Record<string, number | string | null>;
  series?: { annual?: Record<string, Array<{ period: string; v: number }>> };
  metricType?: string;
  symbol?: string;
}

/**
 * Per-field translation: { fdKey, scale }.
 * - scale 'raw': pass through unchanged (ratios, prices, counts, beta)
 * - scale 'pct': Finnhub returns "17.75" meaning 17.75%; downstream fmtPct
 *   will *100, so we /100 here to land on the fraction (0.1775).
 * - scale 'millions': Finnhub returns dollars in millions; multiply by 1e6
 *   so downstream fmtNum picks the right suffix (B/T).
 */
type MetricSpec = { fdKey: string; scale: 'raw' | 'pct' | 'millions' };

const METRIC_SPECS: Record<string, MetricSpec> = {
  // Market cap / enterprise value — Finnhub returns in MILLIONS of USD
  marketCapitalization: { fdKey: 'market_cap', scale: 'millions' },
  enterpriseValue: { fdKey: 'enterprise_value', scale: 'millions' },

  // Pure ratios — pass through
  peBasicExclExtraTTM: { fdKey: 'price_to_earnings_ratio', scale: 'raw' },
  peTTM: { fdKey: 'price_to_earnings_ratio', scale: 'raw' },
  peNormalizedAnnual: { fdKey: 'price_to_earnings_ratio_normalized', scale: 'raw' },
  pbAnnual: { fdKey: 'price_to_book_ratio', scale: 'raw' },
  psTTM: { fdKey: 'price_to_sales_ratio', scale: 'raw' },
  psAnnual: { fdKey: 'price_to_sales_ratio_annual', scale: 'raw' },
  pegRatio: { fdKey: 'peg_ratio', scale: 'raw' },
  evToEbitdaTTM: { fdKey: 'enterprise_value_to_ebitda_ratio', scale: 'raw' },
  evToSalesTTM: { fdKey: 'enterprise_value_to_revenue_ratio', scale: 'raw' },

  // Yields & payout — Finnhub returns as PERCENT (e.g. 0.072 means 0.072%)
  dividendYieldIndicatedAnnual: { fdKey: 'dividend_yield', scale: 'pct' },
  currentDividendYieldTTM: { fdKey: 'dividend_yield_ttm', scale: 'pct' },
  payoutRatioTTM: { fdKey: 'payout_ratio', scale: 'pct' },

  // Margins — Finnhub returns as PERCENT (e.g. 17.75 means 17.75%)
  grossMarginTTM: { fdKey: 'gross_margin', scale: 'pct' },
  grossMarginAnnual: { fdKey: 'gross_margin_annual', scale: 'pct' },
  operatingMarginTTM: { fdKey: 'operating_margin', scale: 'pct' },
  operatingMarginAnnual: { fdKey: 'operating_margin_annual', scale: 'pct' },
  netProfitMarginTTM: { fdKey: 'net_margin', scale: 'pct' },
  netProfitMarginAnnual: { fdKey: 'net_margin_annual', scale: 'pct' },

  // Returns — Finnhub returns as PERCENT
  roeTTM: { fdKey: 'return_on_equity', scale: 'pct' },
  roeRfy: { fdKey: 'return_on_equity_annual', scale: 'pct' },
  roiTTM: { fdKey: 'return_on_invested_capital', scale: 'pct' },
  roaTTM: { fdKey: 'return_on_assets', scale: 'pct' },
  roaRfy: { fdKey: 'return_on_assets_annual', scale: 'pct' },

  // Liquidity / leverage — pure ratios
  currentRatioAnnual: { fdKey: 'current_ratio', scale: 'raw' },
  quickRatioAnnual: { fdKey: 'quick_ratio', scale: 'raw' },
  totalDebtToEquityAnnual: { fdKey: 'debt_to_equity', scale: 'raw' },
  totalDebtToTotalAssetAnnual: { fdKey: 'debt_to_assets', scale: 'raw' },
  longTermDebtToEquityAnnual: { fdKey: 'long_term_debt_to_equity', scale: 'raw' },

  // Debt amounts — Finnhub returns in MILLIONS
  totalDebt_fy: { fdKey: 'total_debt', scale: 'millions' },
  longTermDebt_fy: { fdKey: 'long_term_debt', scale: 'millions' },

  // Per-share figures — already in dollars per share (raw)
  bookValuePerShareAnnual: { fdKey: 'book_value_per_share', scale: 'raw' },
  cashFlowPerShareTTM: { fdKey: 'cash_flow_per_share', scale: 'raw' },
  freeCashFlowPerShareTTM: { fdKey: 'free_cash_flow_per_share', scale: 'raw' },
  epsTTM: { fdKey: 'earnings_per_share', scale: 'raw' },
  epsBasicExclExtraItemsTTM: { fdKey: 'earnings_per_share_basic', scale: 'raw' },
  epsNormalizedAnnual: { fdKey: 'earnings_per_share_normalized', scale: 'raw' },
  revenuePerShareTTM: { fdKey: 'revenue_per_share', scale: 'raw' },

  // Beta + price levels — raw
  beta: { fdKey: 'beta', scale: 'raw' },
  '52WeekHigh': { fdKey: 'fifty_two_week_high', scale: 'raw' },
  '52WeekLow': { fdKey: 'fifty_two_week_low', scale: 'raw' },

  // Returns over windows — Finnhub returns as PERCENT
  '52WeekPriceReturnDaily': { fdKey: 'one_year_return', scale: 'pct' },
  '5DayPriceReturnDaily': { fdKey: 'five_day_return', scale: 'pct' },
  monthToDatePriceReturnDaily: { fdKey: 'month_to_date_return', scale: 'pct' },
  yearToDatePriceReturnDaily: { fdKey: 'year_to_date_return', scale: 'pct' },

  // Growth rates — Finnhub returns as PERCENT
  revenueGrowthTTMYoy: { fdKey: 'revenue_growth', scale: 'pct' },
  revenueGrowth5Y: { fdKey: 'revenue_growth_5y', scale: 'pct' },
  epsGrowthTTMYoy: { fdKey: 'earnings_per_share_growth', scale: 'pct' },
  epsGrowth5Y: { fdKey: 'earnings_per_share_growth_5y', scale: 'pct' },
  ebitdaCagr5Y: { fdKey: 'ebitda_growth_5y', scale: 'pct' },
  focfCagr5Y: { fdKey: 'free_cash_flow_growth_5y', scale: 'pct' },
};

function applyScale(value: number, scale: MetricSpec['scale']): number {
  switch (scale) {
    case 'pct': return value / 100;       // 17.75 → 0.1775; downstream *100 → "17.8%"
    case 'millions': return value * 1e6;  // 52516.23 → 5.25e10; downstream → "52.5B"
    default: return value;
  }
}

/**
 * The downstream formatter ([formatters.ts](./formatters.ts)) reads short
 * field names (`pe_ratio`, `eps`, `roe`, `roic`, `revenue_growth_rate`).
 * Emit those as aliases of the canonical FD names so the rendered output is
 * populated regardless of which name a caller looks for.
 */
const METRIC_ALIASES: Record<string, string> = {
  price_to_earnings_ratio: 'pe_ratio',
  price_to_book_ratio: 'pb_ratio',
  price_to_sales_ratio: 'ps_ratio',
  earnings_per_share: 'eps',
  return_on_equity: 'roe',
  return_on_assets: 'roa',
  return_on_invested_capital: 'roic',
  revenue_growth: 'revenue_growth_rate',
  earnings_per_share_growth: 'earnings_growth_rate',
  enterprise_value_to_ebitda_ratio: 'ev_ebitda',
  enterprise_value_to_revenue_ratio: 'ev_revenue',
};

async function metricSnapshot(ticker: string): Promise<ApiResponse> {
  const { data, url } = await finnhubFetch('/stock/metric', { symbol: ticker, metric: 'all' });
  const m = (data as FinnhubMetricResponse).metric ?? {};
  const snapshot: Record<string, unknown> = { ticker };
  for (const [finnhubKey, value] of Object.entries(m)) {
    const spec = METRIC_SPECS[finnhubKey];
    if (!spec || value === null || value === undefined) continue;
    const num = Number(value);
    if (!Number.isFinite(num)) continue;
    const scaled = applyScale(num, spec.scale);
    snapshot[spec.fdKey] = scaled;
    const alias = METRIC_ALIASES[spec.fdKey];
    if (alias && snapshot[alias] === undefined) {
      snapshot[alias] = scaled;
    }
  }
  return { data: { snapshot }, url };
}

async function metricHistory(ticker: string): Promise<ApiResponse> {
  // Finnhub free tier doesn't expose historical financial metrics nicely;
  // return current snapshot wrapped in an array so downstream code keeps working.
  const snap = await metricSnapshot(ticker);
  const snapData = (snap.data as { snapshot: Record<string, unknown> }).snapshot;
  return {
    data: {
      financial_metrics: [{ ...snapData, report_period: todayISO(), fiscal_period: 'TTM' }],
    },
    url: snap.url,
  };
}

async function financialsReported(
  ticker: string,
  period: string,
  limit: number,
  kind: 'income' | 'balance' | 'cashflow' | 'all',
): Promise<ApiResponse> {
  const freq = period === 'quarterly' ? 'quarterly' : 'annual';
  const { data, url } = await finnhubFetch('/stock/financials-reported', {
    symbol: ticker,
    freq,
  });
  const reports = ((data as { data?: FinnhubReport[] }).data ?? []).slice(0, limit);
  const records = reports.map(r => buildFinancialRecord(r, ticker, kind));

  const wrapperKey =
    kind === 'income' ? 'income_statements'
    : kind === 'balance' ? 'balance_sheets'
    : kind === 'cashflow' ? 'cash_flow_statements'
    : 'financials';

  return { data: { [wrapperKey]: records }, url };
}

async function earningsSnapshot(ticker: string): Promise<ApiResponse> {
  const { data, url } = await finnhubFetch('/stock/earnings', { symbol: ticker });
  const arr = data as Array<{ actual?: number; estimate?: number; period?: string; quarter?: number; surprise?: number; surprisePercent?: number; symbol?: string; year?: number }>;
  const latest = arr[0];
  if (!latest) {
    return { data: { earnings: [] }, url };
  }
  const record = {
    ticker,
    report_period: latest.period,
    fiscal_year: latest.year,
    fiscal_quarter: latest.quarter ? `Q${latest.quarter}` : null,
    eps_actual: latest.actual,
    eps_estimate: latest.estimate,
    eps_surprise: latest.surprise,
    eps_surprise_percent: latest.surprisePercent,
  };
  return { data: { earnings: [record] }, url };
}

async function analystEstimates(ticker: string): Promise<ApiResponse> {
  const [recRes, ptRes] = await Promise.all([
    finnhubFetch('/stock/recommendation', { symbol: ticker }).catch(() => null),
    finnhubFetch('/stock/price-target', { symbol: ticker }).catch(() => null),
  ]);
  const rec = recRes ? (recRes.data as Array<{ buy?: number; hold?: number; period?: string; sell?: number; strongBuy?: number; strongSell?: number }>) : [];
  const pt = ptRes ? (ptRes.data as { lastUpdated?: string; targetHigh?: number; targetLow?: number; targetMean?: number; targetMedian?: number }) : {};
  const latestRec = rec[0];

  const estimates = [{
    ticker,
    period: latestRec?.period ?? null,
    target_high: pt.targetHigh ?? null,
    target_low: pt.targetLow ?? null,
    target_mean: pt.targetMean ?? null,
    target_median: pt.targetMedian ?? null,
    last_updated: pt.lastUpdated ?? null,
    strong_buy: latestRec?.strongBuy ?? null,
    buy: latestRec?.buy ?? null,
    hold: latestRec?.hold ?? null,
    sell: latestRec?.sell ?? null,
    strong_sell: latestRec?.strongSell ?? null,
  }];

  return {
    data: { analyst_estimates: estimates },
    url: recRes?.url ?? ptRes?.url ?? `${FINNHUB_BASE}/stock/recommendation?symbol=${ticker}`,
  };
}

// ---------------------------------------------------------------------------
// Public router
// ---------------------------------------------------------------------------

export async function finnhubGet(
  endpoint: string,
  params: Record<string, string | number | string[] | undefined>,
  options?: { cacheable?: boolean; ttlMs?: number },
): Promise<ApiResponse> {
  // Cache check first
  if (options?.cacheable) {
    const cached = readCache(`finnhub:${endpoint}`, params, options.ttlMs);
    if (cached) return cached;
  }

  const ticker = (params.ticker ?? params.symbol) as string | undefined;
  const upperTicker = ticker?.toString().trim().toUpperCase();

  let result: ApiResponse;

  switch (endpoint) {
    case '/prices/snapshot/':
      if (!upperTicker) throw new Error('[Finnhub] ticker required for price snapshot');
      result = await priceSnapshot(upperTicker);
      break;

    case '/prices/':
      if (!upperTicker) throw new Error('[Finnhub] ticker required for price history');
      result = await priceHistory(
        upperTicker,
        String(params.start_date ?? daysAgoISO(30)),
        String(params.end_date ?? todayISO()),
        String(params.interval ?? 'day'),
      );
      break;

    case '/prices/snapshot/tickers/':
      result = await tickerList();
      break;

    case '/news':
    case '/news/': {
      const limit = typeof params.limit === 'number' ? params.limit : 10;
      result = await companyNews(upperTicker, limit);
      break;
    }

    case '/insider-trades/':
      if (!upperTicker) throw new Error('[Finnhub] ticker required for insider trades');
      result = await insiderTrades(
        upperTicker,
        typeof params.limit === 'number' ? params.limit : 10,
        params.filing_date_gte as string | undefined,
        params.filing_date_lte as string | undefined,
      );
      break;

    case '/financial-metrics/snapshot/':
      if (!upperTicker) throw new Error('[Finnhub] ticker required for metric snapshot');
      result = await metricSnapshot(upperTicker);
      break;

    case '/financial-metrics/':
      if (!upperTicker) throw new Error('[Finnhub] ticker required for metric history');
      result = await metricHistory(upperTicker);
      break;

    case '/financials/income-statements/':
      if (!upperTicker) throw new Error('[Finnhub] ticker required');
      result = await financialsReported(
        upperTicker,
        String(params.period ?? 'annual'),
        typeof params.limit === 'number' ? params.limit : 4,
        'income',
      );
      break;

    case '/financials/balance-sheets/':
      if (!upperTicker) throw new Error('[Finnhub] ticker required');
      result = await financialsReported(
        upperTicker,
        String(params.period ?? 'annual'),
        typeof params.limit === 'number' ? params.limit : 4,
        'balance',
      );
      break;

    case '/financials/cash-flow-statements/':
      if (!upperTicker) throw new Error('[Finnhub] ticker required');
      result = await financialsReported(
        upperTicker,
        String(params.period ?? 'annual'),
        typeof params.limit === 'number' ? params.limit : 4,
        'cashflow',
      );
      break;

    case '/financials/':
      if (!upperTicker) throw new Error('[Finnhub] ticker required');
      result = await financialsReported(
        upperTicker,
        String(params.period ?? 'annual'),
        typeof params.limit === 'number' ? params.limit : 4,
        'all',
      );
      break;

    case '/earnings':
    case '/earnings/':
      if (!upperTicker) throw new Error('[Finnhub] ticker required for earnings');
      result = await earningsSnapshot(upperTicker);
      break;

    case '/analyst-estimates/':
      if (!upperTicker) throw new Error('[Finnhub] ticker required for analyst estimates');
      result = await analystEstimates(upperTicker);
      break;

    default:
      throw new Error(`[Finnhub] unsupported endpoint: ${endpoint}`);
  }

  if (options?.cacheable) {
    writeCache(`finnhub:${endpoint}`, params, result.data as Record<string, unknown>, result.url);
  }

  // Suppress unused-import warning (describeRequest is imported for symmetry with api.ts)
  void describeRequest;

  return result;
}
