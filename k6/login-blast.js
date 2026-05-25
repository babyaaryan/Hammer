/**
 * k6 LOGIN BLAST — distributed Keycloak login load (pure HTTP, no browser).
 *
 * Hammering ONE user trips Keycloak brute-force protection (returns the generic
 * "Invalid user credentials" once an account is temp-locked), and a freshly
 * created user can't password-grant until its T&C / UPDATE_PASSWORD required
 * actions are cleared ("Account is not fully set up").
 *
 * So: setup() creates a POOL of pre-cleared users (admin API, requiredActions:[],
 * emailVerified:true) and VUs log in rotating across the pool — many distinct
 * users, all succeeding, no single-account lockout. Authorized OWN staging
 * (realm: tongadive).
 *
 * Env (set by the workflow): KC_BASE, KC_REALM, KC_CLIENT_ID, KC_USER, KC_PASS,
 *                            VUS, DURATION, POOL, THINK
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
const ADMIN_U   = __ENV.KC_USER      || '';
const ADMIN_P   = __ENV.KC_PASS      || '';
const VUS       = Number(__ENV.VUS || 2000);
const DURATION  = __ENV.DURATION || '30m';
const POOL      = Number(__ENV.POOL || 300);   // distinct users per shard
const THINK     = Number(__ENV.THINK || 0);

const TOKEN_URL = `${KC_BASE}/auth/realms/${KC_REALM}/protocol/openid-connect/token`;
const ADMIN_URL = `${KC_BASE}/auth/admin/realms/${KC_REALM}/users`;

export const options = {
  setupTimeout: '180s',
  scenarios: { login: { executor: 'constant-vus', vus: VUS, duration: DURATION } },
  thresholds: {
    login_success_rate: [{ threshold: 'rate>0.90', abortOnFail: false }],
    login_duration_ms:  [{ threshold: 'p(95)<15000', abortOnFail: false }],
  },
  insecureSkipTLSVerify: true,
};

function adminToken() {
  const r = http.post(TOKEN_URL,
    { grant_type: 'password', client_id: KC_CLIENT, username: ADMIN_U, password: ADMIN_P },
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  try { return JSON.parse(r.body).access_token; } catch { return null; }
}

// Build a pool of pre-cleared, login-ready users (runs once per shard).
export function setup() {
  const at = adminToken();
  if (!at) throw new Error('admin token failed in setup');
  const users = [];
  const rnd = () => Math.random().toString(36).slice(2, 9);
  const BATCH = 25;
  for (let i = 0; i < POOL; i += BATCH) {
    const reqs = [], batch = [];
    for (let j = 0; j < BATCH && (i + j) < POOL; j++) {
      const id = rnd();
      const u = { username: 'kc' + id, password: `Blast@${id}Zz9` };
      batch.push(u);
      reqs.push(['POST', ADMIN_URL, JSON.stringify({
        username: u.username, email: `${u.username}@gmail.com`,
        firstName: 'K', lastName: 'C', enabled: true, emailVerified: true,
        requiredActions: [], credentials: [{ type: 'password', value: u.password, temporary: false }],
      }), { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + at } }]);
    }
    const res = http.batch(reqs);
    res.forEach((r, k) => { if ((r.status >= 200 && r.status < 300) || r.status === 409) users.push(batch[k]); });
  }
  console.log(`pool ready: ${users.length}/${POOL} users`);
  if (!users.length) throw new Error('no pool users created');
  return { users };
}

export default function (data) {
  const u = data.users[Math.floor(Math.random() * data.users.length)];
  const t0 = Date.now();
  const res = http.post(TOKEN_URL,
    { grant_type: 'password', client_id: KC_CLIENT, username: u.username, password: u.password, scope: 'openid' },
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, tags: { name: 'kc_login' } });
  dur.add(Date.now() - t0);
  const good = check(res, {
    'status 200': (r) => r.status === 200,
    'access_token': (r) => { try { return !!JSON.parse(r.body).access_token; } catch { return false; } },
  });
  if (good) { ok.add(1); rate.add(true); }
  else {
    bad.add(1); rate.add(false);
    if (__ITER < 3) console.log(`FAIL[${res.status}] ${String(res.body).slice(0, 180)}`);
  }
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
  return { stdout: `\n  🔑 LOGIN BLAST | logins:${tot} ok:${s}(${pct}%) fail:${f} | ${rps} req/s | p95:${p95}ms\n` };
}
