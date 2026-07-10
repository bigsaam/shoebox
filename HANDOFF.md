# shoebox — session handoff

Read this first, then [`AGENTS.md`](AGENTS.md) (what the thing does), then
[`DEPLOY.md`](DEPLOY.md) (the runbook). This file is the context you cannot
reconstruct from the code.

**Repo:** `~/workspace/shoebox` · committed on `main` · **no git remote yet**
**Status:** built, tested, verified locally. **Never deployed. No image ever built.**

---

## What it is, in one paragraph

A password-gated preview server for throwaway static artifacts. Agents generate a lot
of HTML — reports, charts, one-off SPAs — and there was nowhere good to put them.
`shoebox put ./report.html` returns a short link on its own subdomain, guarded by one
shared password, plus a `?secret=…` bypass link that skips the password entirely.
Bundles are disposable by construction.

## Architecture, and why it isn't all custom

```
shoebox-tunnel ──▶ shoebox-caddy ──forward_auth──▶ shoebox
 (dedicated CF tunnel)   │                            │
                    serves files                 authorizes,
                 /srv/bundles/<id>              accepts uploads
                                                       ▲
                                        tailnet ───────┘  shoebox put
```

The first draft had shoebox serving files. That was wrong — Caddy does static serving
behind a wildcard host in ten lines. **shoebox is not a web server in production**
(`SHOEBOX_SERVE_FILES=false`); it answers one question on `GET /_/authz`.

The reason any custom code exists at all: `basic_auth` has no per-artifact bypass, and
nginx's `secure_link` signs **per-URI**, so the page's `assets/app.js` request — which
carries no query string — would 403. The missing primitive is *take a one-time
`?secret=`, mint a session cookie, redirect to the clean URL, get out of the way.*
That's `src/authz.ts`, ~70 lines, and it's the whole reason for this repo.

---

## Facts verified in this session (do not re-litigate)

| Claim | How it was checked |
|---|---|
| Caddy's `forward_auth` copies a non-2xx response — **including `Set-Cookie`** — to the browser | Ran real Caddy 2.11.4 in front of shoebox; observed the 302 + cookie, then the asset loading on the cookie alone |
| Caddy sorts `try_files` **ahead of** `forward_auth` unless you wrap them in `route` | Without `route`, `/?secret=…` is rewritten to `/index.html?secret=…` before shoebox sees it |
| cloudflared matches **only** a leading `*.` label | `ingress.matchHost` does `strings.HasPrefix(ruleHost, "*.")` and nothing else. `share-*.enzoiwith.us` never matches |
| cloudflared returns the **first** matching ingress rule | `ingress.FindMatchingRule` iterates in order |
| Fastify auto-registers `HEAD` for every `GET` | An explicit `app.head("/_/authz")` threw `FST_ERR_DUPLICATED_ROUTE` |
| The `tunnel` container sits on a docker network literally named `utils` | `config/homelab/utils/compose.yml` → `networks: default: name: utils` |
| GitHub owner is `bigsaam` | remotes of `mytube`, `config`, `Questarr` |

## Assumptions **not** verified — these block deploy

1. **Universal SSL covers `*.enzoiwith.us`.** This is the entire reason bundles live at
   `share-<id>.enzoiwith.us` rather than `<id>.preview.enzoiwith.us` (two labels deep,
   which free Universal SSL does not cover). Check SSL/TLS → Edge Certificates.
2. **A *proxied* wildcard DNS record is allowed on the plan.** Historically paid-only.
   If blocked → create one proxied CNAME per bundle via the Cloudflare API on publish,
   delete on `rm`. Documented in `DEPLOY.md` §4, not built.
3. **`utils` has disk.** `config/homelab/utils/README.md` records the Docker root
   filesystem filling twice. `docker system df` first.

---

## Design invariants — break these and it stops being safe

- **`src/crypto.ts`, `src/store.ts` (`resolveWithin`), `src/links.ts` (`idFromHost`),
  `src/authz.ts`** are the entire security boundary. Read `test/` before touching them.
- **Metadata lives outside the served tree** (`data/meta/<id>.json`, not inside
  `data/bundles/<id>/`). Caddy roots at `bundles/<id>` read-only, so a bundle's bypass
  secret cannot be served as a file — not by traversal, not by a forgotten deny rule.
- **No web index.** Knowing the password must never reveal which bundles exist.
  Enumeration requires the API token. Do not add a listing page.
- **The session token's scope is inside the HMAC**, so bundle A's cookie cannot be
  renamed into bundle B's. There is a test for exactly this.
- **`SHOEBOX_COOKIE_DOMAIN` is refused at startup** under a `share-{id}` template. The
  id sits inside a hostname label, so the only domain wide enough to span bundles is
  `.enzoiwith.us` — which would also send the session cookie to mytube, tripwala, and
  everything else. Cost: one password prompt per bundle. Bypass links unaffected.
- **Links are built from `SHOEBOX_HOST_TEMPLATE`, never the request host.** That's what
  lets you publish over Tailscale and still hand out a public HTTPS URL.
- **A single file is staged as `index.html`** by the CLI, because Caddy resolves `/`
  with `try_files` and cannot read shoebox's metadata.

---

## Verify the tree in 60 seconds

```bash
cd ~/workspace/shoebox
npm ci
npm run typecheck && npm test        # 41 tests
```

To re-run the full stack locally without Docker (the scratchpad Caddy binary from last
session is **gone**; fetch a fresh one):

```bash
# 1. grab caddy into a temp dir (do not brew install)
# 2. build a local Caddyfile from deploy/homelab/Caddyfile, swapping:
#      shoebox:8080          -> 127.0.0.1:8099
#      /srv/bundles/{re...}  -> <tmp>/data/bundles/{re.bundle.1}
#      :80                   -> :8081
# 3. run shoebox with SHOEBOX_HOST_TEMPLATE='share-{id}.enzoiwith.us'
#      SHOEBOX_PUBLIC_SCHEME=http SHOEBOX_SERVE_FILES=false
# 4. curl -H 'Host: share-<id>.enzoiwith.us' http://127.0.0.1:8081/?secret=...
```

What that must show: anonymous → 302 login · valid secret → 302 + `Set-Cookie`, clean
`Location: /` · page and `assets/app.js` → 200 with the cookie · `mytube.enzoiwith.us`,
`enzoiwith.us`, `xshare-<id>.enzoiwith.us` → 404.

---

## What is left

In order. Full commands in [`DEPLOY.md`](DEPLOY.md).

1. `gh repo create bigsaam/shoebox --public --source=. --push` — first Actions run
   builds `ghcr.io/bigsaam/shoebox:latest`. **This is the first time the Dockerfile is
   ever built.** Expect to fix something.
2. Make the GHCR package public.
3. 1Password item `Homelab/shoebox`: `password`, `api-token`, `session-secret`.
4. `docker compose up -d shoebox shoebox-caddy` on manz-utils — *not* the tunnel yet;
   it crash-loops until step 5 writes its config.
5. `cloudflared tunnel create shoebox`, drop credentials + `config.yml` into
   `cloudflared/`, `up -d shoebox-tunnel`.
6. Proxied wildcard CNAME `*.enzoiwith.us` → `<UUID>.cfargotunnel.com`.
7. `shoebox init --url http://manz-utils:8080 --token 'op://Homelab/shoebox/api-token'`
   on the Mac and the dev box; symlink `bin/shoebox.mjs` onto `PATH`.
8. Smoke test, then backport service config to `config/homelab/utils/shoebox/`.

### Deliberately not built

- **Cloudflare DNS API integration.** Only needed if assumption 2 fails.
- **CI beyond build.** No deploy step; watchtower pulls `:latest`.
- **Any listing UI.** See invariants.
- **Non-static apps.** No server-side code runs in a bundle, on purpose.

---

## Open questions for the operator

- Wildcard DNS makes every nonexistent subdomain resolve and hit shoebox-caddy's 404
  instead of returning NXDOMAIN. Acceptable?
- `SHOEBOX_SESSION_TTL` is 30d. A viewer who opened a bypass link keeps access for that
  long without re-entering anything. Shorter?
- Bundles never expire unless `--ttl` is passed. Worth defaulting `shoebox put` to
  `--ttl 90d` and letting `--ttl never` opt out?

---

## Unrelated, in case you trip over it

`~/workspace/india-trip-results/` (`results.md`, `results.db`) is finished work from
earlier in the same session — live Google Flights research, nothing to do with shoebox.
The published artifact for it is at `claude.ai/code/artifact/10d17213-…`. Leave it be.
