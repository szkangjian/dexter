/**
 * Smoke test the IB bridge end-to-end via Dexter's ib_portfolio tool.
 *
 * Prereq: options-tool web must be running.
 *   cd ~/Projects/IB/Option && uv run options-tool web
 *
 * Usage:
 *   bun run scripts/smoke-ib.ts            # default tests
 *   bun run scripts/smoke-ib.ts URA        # test against a specific symbol
 */
import { config } from 'dotenv';
config({ quiet: true });

import { ibTool, pingBridge, getBridgeUrl } from '../src/tools/ib/ib-tool.js';

const sym = process.argv[2] ?? 'URA';

async function call(action: string, args: Record<string, unknown> = {}): Promise<void> {
  try {
    const result = await ibTool.invoke({ action, ...args });
    const obj = JSON.parse(result);
    const data = obj.data ?? obj;
    const summary = JSON.stringify(data).slice(0, 300);
    console.log(`✓ ${action}${args.symbol ? `(${args.symbol})` : ''}: ${summary}${summary.length === 300 ? '...' : ''}`);
  } catch (e) {
    console.log(`✗ ${action}${args.symbol ? `(${args.symbol})` : ''} failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function main() {
  console.log(`\n=== IB bridge smoke test ===`);
  console.log(`Bridge URL: ${getBridgeUrl()}`);
  const reachable = await pingBridge(2000);
  console.log(`Reachable:  ${reachable}\n`);

  if (!reachable) {
    console.log('Bridge unreachable. Start it with:');
    console.log('  cd ~/Projects/IB/Option && uv run options-tool web');
    process.exit(1);
  }

  await call('health');
  await call('symbols');
  await call('portfolio');
  await call('positions', { symbol: sym });
  // Live IB calls — only work if IB Gateway is logged in.
  await call('spot', { symbol: sym });
  await call('option_chain', { symbol: sym, side: 'CALL', dte_min: 20, dte_max: 50 });

  console.log('\n=== Done ===\n');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
