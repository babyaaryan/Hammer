/**
 * k6 LOGIN BLAST — Keycloak token-endpoint load (pure HTTP, no browser).
 *
 * Each VU repeatedly does a password-grant login against the staging realm,
 * which exercises Keycloak's password-hashing path — the real cost of a login.
 * Authorized capacity test of OWN staging (realm: tongadive).
 *
 * All knobs come from env (set by the workflow):
 *   KC_BASE, KC_REALM, KC_CLIENT_ID, KC_USER, KC_PASS, VUS, DURATION, THINK
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const ok   = new Counter('login_success');
const bad  = new Counter('login_failure');
const rate = new Rate('login_success_rate');
const dur  = new Trend('login_duration_ms', true);

const KC_BASE   = __ENV.KC_BASE      || 'https://stage.evidnt.io';
const KC_REALM  = __ENV.KC_REALM     || 'tongadive';
const KC_CLIENT = __ENV.KC_CLIENT_ID || 'login';
const USER      = __ENV.KC_USER      || '';
const PASS      = __ENV.KC_PASS      || '';
const VUS       = Number(__ENV.VUS || 2000);
const DURATION  = __ENV.DURATION || '30m';
const THINK     = Number(__ENV.THINK || 0); // seconds between iterations; 0 = max throughput

const TOKEN_URL = `${KC_BASE}/auth/realms/${KC_REALM}/protocol/openid-connect/token`;

export const options = {
  scenarios: {
    login: { executor: 'constant-vus', vus: VUS, duration: DURATION },
  },
  // We WANT to find the breaking point, so a breach reports but doesn't abort.
  thresholds: {
    login_success_rate: [{ threshold: 'rate>0.90', abortOnFail: false }],
    login_duration_ms:  [{ threshold: 'p(95)<15000', abortOnFail: false }],
  },
  insecureSkipTLSVerify: true,
  discardResponseBodies: false,
};

export default function () {
  const t0 = Date.now();
  const res = http.post(
    TOKEN_URL,
    { grant_type: 'password', client_id: KC_CLIENT, username: USER, password: PASS, scope: 'openid' },
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, tags: { name: 'kc_login' } }
  );
  dur.add(Date.now() - t0);

  const good = check(res, {
    'status 200': (r) => r.status === 200,
    'access_token': (r) => { try { return !!JSON.parse(r.body).access_token; } catch { return false; } },
  });
  if (good) { ok.add(1); rate.add(true); }
  else { bad.add(1); rate.add(false); }

  if (THINK > 0) sleep(THINK);
}

export function handleSummary(data) {
  const m = data.metrics;
  const s = m.login_success?.values?.count || 0;
  const f = m.login_failure?.values?.count || 0;
  const tot = s + f;
  const pct = tot > 0 ? ((s / tot) * 100).toFixed(1) : '0';
  const p95 = (m.login_duration_ms?.values?.['p(95)'] || 0).toFixed(0);
  const rps = (m.http_reqs?.values?.rate || 0).toFixed(0);
  return {
    stdout: `\n  🔑 LOGIN BLAST | logins:${tot} ok:${s}(${pct}%) fail:${f} | ${rps} req/s | p95:${p95}ms\n`,
  };
}
