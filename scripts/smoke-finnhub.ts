/**
 * Smoke test: verify Finnhub routing works for URA (which is NOT in
 * Financial Datasets free tier). Run: bun run scripts/smoke-finnhub.ts
 */
import { config } from 'dotenv';
config({ quiet: true });

import { api } from '../src/tools/finance/api.js';

const ticker = process.argv[2] ?? 'URA';

async function main() {
  console.log(`\n=== Smoke test: Finnhub routing for ${ticker} ===\n`);

  // 1. Price snapshot
  try {
    const r = await api.get('/prices/snapshot/', { ticker });
    const snap = (r.data as { snapshot?: Record<string, unknown> }).snapshot ?? {};
    console.log(`✓ price snapshot: $${snap.price} (Δ ${snap.day_change_percent}%)`);
  } catch (e) {
    console.log(`✗ price snapshot failed: ${e instanceof Error ? e.message : e}`);
  }

  // 2. Recent news (last 14 days)
  try {
    const r = await api.get('/news', { ticker, limit: 3 });
    const news = (r.data as { news?: Array<{ title?: string; date?: string }> }).news ?? [];
    console.log(`✓ news: ${news.length} articles`);
    news.slice(0, 2).forEach(n => console.log(`    - [${n.date?.slice(0, 10)}] ${n.title?.slice(0, 80)}`));
  } catch (e) {
    console.log(`✗ news failed: ${e instanceof Error ? e.message : e}`);
  }

  // 3. Insider trades
  try {
    const r = await api.get('/insider-trades/', { ticker, limit: 3 });
    const trades = (r.data as { insider_trades?: unknown[] }).insider_trades ?? [];
    console.log(`✓ insider trades: ${trades.length} records`);
  } catch (e) {
    console.log(`✗ insider trades failed: ${e instanceof Error ? e.message : e}`);
  }

  // 4. Key metrics snapshot
  try {
    const r = await api.get('/financial-metrics/snapshot/', { ticker });
    const snap = (r.data as { snapshot?: Record<string, unknown> }).snapshot ?? {};
    const fields = Object.keys(snap).filter(k => k !== 'ticker').slice(0, 5);
    console.log(`✓ metrics snapshot: ${Object.keys(snap).length} fields (sample: ${fields.join(', ')})`);
  } catch (e) {
    console.log(`✗ metrics snapshot failed: ${e instanceof Error ? e.message : e}`);
  }

  // 5. Historical prices (last 5 days)
  try {
    const today = new Date().toISOString().slice(0, 10);
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const r = await api.get('/prices/', { ticker, interval: 'day', start_date: fiveDaysAgo, end_date: today });
    const prices = (r.data as { prices?: unknown[] }).prices ?? [];
    console.log(`✓ historical prices: ${prices.length} bars`);
  } catch (e) {
    console.log(`✗ historical prices failed: ${e instanceof Error ? e.message : e}`);
  }

  // 6. Financials (annual income statements, last 3 years) — ETFs typically empty
  try {
    const r = await api.get('/financials/income-statements/', { ticker, period: 'annual', limit: 3 });
    const stmts = (r.data as { income_statements?: unknown[] }).income_statements ?? [];
    console.log(`✓ income statements: ${stmts.length} reports (ETFs typically return 0, that's expected)`);
  } catch (e) {
    console.log(`✗ income statements failed: ${e instanceof Error ? e.message : e}`);
  }

  // 7. Earnings
  try {
    const r = await api.get('/earnings', { ticker });
    const earnings = (r.data as { earnings?: unknown[] }).earnings ?? [];
    console.log(`✓ earnings: ${earnings.length} record(s)`);
  } catch (e) {
    console.log(`✗ earnings failed: ${e instanceof Error ? e.message : e}`);
  }

  console.log('\n=== Done ===\n');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
