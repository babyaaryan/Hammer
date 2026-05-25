/**
 * TONGADIVE.COM — page-flood stress test (pure HTTP, no browser).
 * Authorized load test of OWN production site. VUS/DURATION from env.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const okC   = new Counter('pages_ok');
const failC = new Counter('pages_fail');
const rate  = new Rate('page_success_rate');
const dur   = new Trend('page_duration_ms', true);

const BASE     = __ENV.BASE || 'https://www.tongadive.com';
const VUS      = Number(__ENV.VUS || 2000);
const DURATION = __ENV.DURATION || '30m';
const THINK    = Number(__ENV.THINK || 0);

const PAGES = [
  '/',
  '/solutions/',
  '/industries-dpp/',
  '/contact-us-digital-product-passport-enquiry/',
  '/supply-chain-visibility-software-about-us/',
  '/gs1-serialisation-digital-product-passport/',
  '/ecosystem-partners/',
  '/sustainable-supply-chain-media/',
  '/technologies/',
];

export const options = {
  scenarios: {
    pages: { executor: 'constant-vus', vus: VUS, duration: DURATION },
  },
  // No thresholds — we expect failures when the edge/WAF throttles.
};

export default function () {
  const page = PAGES[Math.floor(Math.random() * PAGES.length)];
  const t0 = Date.now();
  const res = http.get(BASE + page, {
    headers: { Accept: 'text/html,*/*', 'Cache-Control': 'no-cache' },
    redirects: 5,
    timeout: '10s',
    tags: { page },
  });
  dur.add(Date.now() - t0);
  const good = check(res, { 'status 2xx/3xx': (r) => r.status >= 200 && r.status < 400 });
  if (good) { okC.add(1); rate.add(true); }
  else { failC.add(1); rate.add(false); }
  if (THINK > 0) sleep(THINK);
}

export function handleSummary(data) {
  const m = data.metrics;
  const ok = m.pages_ok?.values?.count || 0;
  const fail = m.pages_fail?.values?.count || 0;
  const tot = ok + fail;
  const pct = tot > 0 ? ((ok / tot) * 100).toFixed(1) : '0';
  const rps = (m.http_reqs?.values?.rate || 0).toFixed(0);
  const p95 = (m.page_duration_ms?.values?.['p(95)'] || 0).toFixed(0);
  return {
    stdout: `\n  🌊 TONGADIVE | hits:${tot} ok:${ok}(${pct}%) fail:${fail} | ${rps} req/s | p95:${p95}ms\n`,
  };
}
