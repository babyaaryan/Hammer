# Blast — distributed load test (owner-authorized)

Authorized capacity testing of **own** infrastructure:
- `keycloak-login` → password-grant load against the staging Keycloak token endpoint (realm `tongadive`).
- `tongadive-pages` → page-flood against `www.tongadive.com`.

Pure HTTP via [k6](https://k6.io) — no browser. Each matrix shard is a separate
runner with its own source IP, so N shards = N distinct IPs hitting the target.

## Run it

Actions tab → **blast** → **Run workflow**, or:

```
gh workflow run blast.yml -R anubha-dixit/Hammer \
  -f target=keycloak-login -f shards=20 -f vus=2000 -f duration=30m
```

It runs for `duration`, then stops on its own. Stop early:

```
gh run cancel <run-id> -R anubha-dixit/Hammer
```

## Notes
- Credentials come from repo **secrets** `KC_USER` / `KC_PASS` (never committed).
- Manual trigger only + unique concurrency group per run → runs never cancel each other.
- `timeout-minutes: 40` is a hard safety ceiling.
- Watch the per-shard summary: `ok%`, `req/s`, `p95` — raise `shards`/`vus` only until success starts to dip; that's the server's true ceiling.
