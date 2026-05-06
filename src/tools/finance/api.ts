import { readCache, writeCache, describeRequest } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { finnhubGet, FINNHUB_SUPPORTED_ENDPOINTS, isFinnhubAvailable } from './finnhub-api.js';
import { edgarGet, edgarSupports } from './sec-edgar-api.js';

const BASE_URL = 'https://api.financialdatasets.ai';

/**
 * Finnhub is preferred when its key is set (broader free-tier coverage than
 * the Financial Datasets free tier, which is restricted to 5 mega-cap tickers).
 * Set FINANCE_PROVIDER=financialdatasets to force Financial Datasets.
 */
function shouldUseFinnhub(endpoint: string): boolean {
  const forced = (process.env.FINANCE_PROVIDER ?? '').toLowerCase();
  if (forced === 'financialdatasets' || forced === 'fd') return false;
  if (forced === 'finnhub') return isFinnhubAvailable() && FINNHUB_SUPPORTED_ENDPOINTS.has(endpoint);
  // Default: prefer Finnhub when its key is set and the endpoint is supported.
  return isFinnhubAvailable() && FINNHUB_SUPPORTED_ENDPOINTS.has(endpoint);
}

export interface ApiResponse {
  data: Record<string, unknown>;
  url: string;
}

/**
 * Remove redundant fields from API payloads before they are returned to the LLM.
 * This reduces token usage while preserving the financial metrics needed for analysis.
 */
export function stripFieldsDeep(value: unknown, fields: readonly string[]): unknown {
  const fieldsToStrip = new Set(fields);

  function walk(node: unknown): unknown {
    if (Array.isArray(node)) {
      return node.map(walk);
    }

    if (!node || typeof node !== 'object') {
      return node;
    }

    const record = node as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(record)) {
      if (fieldsToStrip.has(key)) {
        continue;
      }
      cleaned[key] = walk(child);
    }

    return cleaned;
  }

  return walk(value);
}

function getApiKey(): string {
  return process.env.FINANCIAL_DATASETS_API_KEY || '';
}

/**
 * Shared request execution: handles API key, error handling, logging, and response parsing.
 */
async function executeRequest(
  url: string,
  label: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const apiKey = getApiKey();

  if (!apiKey) {
    logger.warn(`[Financial Datasets API] call without key: ${label}`);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'x-api-key': apiKey,
        ...init.headers,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[Financial Datasets API] network error: ${label} — ${message}`);
    throw new Error(`[Financial Datasets API] request failed for ${label}: ${message}`);
  }

  if (!response.ok) {
    const detail = `${response.status} ${response.statusText}`;
    logger.error(`[Financial Datasets API] error: ${label} — ${detail}`);
    throw new Error(`[Financial Datasets API] request failed: ${detail}`);
  }

  const data = await response.json().catch(() => {
    const detail = `invalid JSON (${response.status} ${response.statusText})`;
    logger.error(`[Financial Datasets API] parse error: ${label} — ${detail}`);
    throw new Error(`[Financial Datasets API] request failed: ${detail}`);
  });

  return data as Record<string, unknown>;
}

export const api = {
  async get(
    endpoint: string,
    params: Record<string, string | number | string[] | undefined>,
    options?: { cacheable?: boolean; ttlMs?: number },
  ): Promise<ApiResponse> {
    const label = describeRequest(endpoint, params);

    // Route to Finnhub when preferred and supported. Falls back to FD on Finnhub error.
    if (shouldUseFinnhub(endpoint)) {
      try {
        return await finnhubGet(endpoint, params, options);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[Finance API] Finnhub failed for ${label}, falling back to Financial Datasets — ${msg}`);
      }
    }

    // Check local cache first — avoids redundant network calls for immutable data
    if (options?.cacheable) {
      const cached = readCache(endpoint, params, options.ttlMs);
      if (cached) {
        return cached;
      }
    }

    // SEC EDGAR fallback for /filings/ — try EDGAR first, only hit FD if EDGAR
    // fails. EDGAR is free, no key, authoritative, no per-ticker gating.
    // FD's value-add is /filings/items/ (pre-extracted sections); for that
    // endpoint we still try FD first (below) and fall back to EDGAR's stub.
    if (endpoint === '/filings/') {
      try {
        const edgarResult = await edgarGet(endpoint, params);
        if (options?.cacheable) {
          writeCache(endpoint, params, edgarResult.data as Record<string, unknown>, edgarResult.url);
        }
        return edgarResult;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[Finance API] EDGAR failed for ${label}, falling back to Financial Datasets — ${msg}`);
      }
    }

    const url = new URL(`${BASE_URL}${endpoint}`);

    // Add params to URL, handling arrays
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        if (Array.isArray(value)) {
          value.forEach((v) => url.searchParams.append(key, v));
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }

    let data: Record<string, unknown>;
    try {
      data = await executeRequest(url.toString(), label, {});
    } catch (fdErr) {
      // Last-resort EDGAR fallback for filings endpoints. We've already tried
      // EDGAR-first for /filings/ above; this catches the items endpoint.
      if (edgarSupports(endpoint)) {
        const msg = fdErr instanceof Error ? fdErr.message : String(fdErr);
        logger.warn(`[Finance API] FD failed for ${label}, falling back to EDGAR — ${msg}`);
        return await edgarGet(endpoint, params);
      }
      throw fdErr;
    }

    // Persist for future requests when the caller marked the response as cacheable
    if (options?.cacheable) {
      writeCache(endpoint, params, data, url.toString());
    }

    return { data, url: url.toString() };
  },

  async post(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<ApiResponse> {
    const label = `POST ${endpoint}`;
    const url = `${BASE_URL}${endpoint}`;

    const data = await executeRequest(url, label, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    return { data, url };
  },
};

/** @deprecated Use `api.get` instead */
export const callApi = api.get;
