/**
 * IB tool — bridges Dexter to the user's Interactive Brokers account via the
 * read-only JSON API exposed by the Option project (~/Projects/IB/Option).
 *
 * Bridge URL is configured via IB_BRIDGE_URL env var (default http://127.0.0.1:8000).
 * Tool is only registered in src/tools/registry.ts when that env var is set OR
 * the default URL is reachable — checked at registry-build time.
 *
 * READ ONLY. There are no order-placing actions. Even if the bridge added them,
 * this tool would refuse to call them.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';

export const IB_BRIDGE_DEFAULT_URL = 'http://127.0.0.1:8000';

export function getBridgeUrl(): string {
  return (process.env.IB_BRIDGE_URL || IB_BRIDGE_DEFAULT_URL).replace(/\/+$/, '');
}

/** Returns true if the bridge responds to /api/health within ~1s. */
export async function pingBridge(timeoutMs = 1000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${getBridgeUrl()}/api/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const IB_TOOL_DESCRIPTION = `
Query the user's actual Interactive Brokers portfolio via the local options-tool bridge (read-only).

## When to Use

- User asks about their REAL holdings: "what's my IB portfolio", "do I own X", "how many shares of Y"
- User wants to verify a hypothetical against actual positions: "double-check my URA exposure"
- Before giving advice on a specific position, confirm the actual qty / cost basis from IB
- User asks about their real option chain quotes: "what's the bid on URA Jun 60 call right now"
- User asks for live spot price tied to their broker (intra-day, includes frozen quote off-hours)

## When NOT to Use

- General market data (use get_market_data or get_financials — those work for any ticker)
- Hypothetical analysis when user has explicitly described a position in chat
- Anything requiring an order placement — this tool CANNOT and WILL NOT place orders

## Actions

- **portfolio**: All stock + option positions across all IB accounts, plus open orders
- **symbols**: Tracked-symbol watchlist with intent tags (CORE_HOLD/INCOME/TRADE/WANT_TO_OWN/WATCH)
- **positions**: Detailed positions for one symbol (requires \`symbol\`)
- **spot**: Live spot price from IB Gateway for one symbol (requires \`symbol\`)
- **option_chain**: Full option chain with greeks for one symbol (requires \`symbol\` + \`side\`; optional \`dte_min\`/\`dte_max\`)
- **health**: Bridge status + last-sync timestamp (use to verify bridge is up)

## Notes

- Position data comes from a local SQLite cache populated by the Option project's \`/sync-positions\`. If the cache looks stale, suggest the user re-sync from the Option web panel.
- \`spot\` and \`option_chain\` are LIVE IB Gateway calls — slower (~2-5s) but always fresh.
- Negative \`qty\` on options = short (sold). Positive = long (bought).
`.trim();

const ibSchema = z.object({
  action: z.enum(['portfolio', 'symbols', 'positions', 'spot', 'option_chain', 'health']),
  symbol: z.string().optional().describe('Stock ticker, e.g. "URA". Required for positions, spot, option_chain.'),
  side: z.enum(['CALL', 'PUT']).optional().describe('Option side. Required for option_chain.'),
  dte_min: z.number().int().min(0).max(730).optional().describe('Min days-to-expiry for option_chain (default 20).'),
  dte_max: z.number().int().min(1).max(730).optional().describe('Max days-to-expiry for option_chain (default 60).'),
});

async function callBridge(path: string): Promise<{ data: unknown; url: string }> {
  const url = `${getBridgeUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`IB bridge unreachable at ${url}. Is options-tool web running? (${msg})`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`IB bridge ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return { data, url };
}

export const ibTool = new DynamicStructuredTool({
  name: 'ib_portfolio',
  description: IB_TOOL_DESCRIPTION,
  schema: ibSchema,
  func: async (input) => {
    const { action, symbol, side, dte_min, dte_max } = input;
    const sym = symbol?.trim().toUpperCase();

    let path: string;
    switch (action) {
      case 'health':
        path = '/api/health';
        break;
      case 'portfolio':
        path = '/api/portfolio';
        break;
      case 'symbols':
        path = '/api/symbols';
        break;
      case 'positions':
        if (!sym) throw new Error('positions requires "symbol"');
        path = `/api/positions/${encodeURIComponent(sym)}`;
        break;
      case 'spot':
        if (!sym) throw new Error('spot requires "symbol"');
        path = `/api/spot/${encodeURIComponent(sym)}`;
        break;
      case 'option_chain': {
        if (!sym) throw new Error('option_chain requires "symbol"');
        if (!side) throw new Error('option_chain requires "side" (CALL or PUT)');
        const params = new URLSearchParams({
          side,
          dte_min: String(dte_min ?? 20),
          dte_max: String(dte_max ?? 60),
        });
        path = `/api/option-chain/${encodeURIComponent(sym)}?${params.toString()}`;
        break;
      }
      default:
        throw new Error(`unknown action: ${action}`);
    }

    const { data, url } = await callBridge(path);
    return formatToolResult(data as Record<string, unknown>, [url]);
  },
});
