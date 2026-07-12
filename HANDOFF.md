# shoebox — session handoff

Read this first, then [`AGENTS.md`](AGENTS.md) (what the thing does), then
[`DEPLOY.md`](DEPLOY.md) (the runbook). This file is the context you cannot
reconstruct from the code.

**Repo:** `github.com/bigsaam/shoebox` (public) · `main`
**Status: DEPLOYED AND LIVE** on manz-utils (2026-07). All three containers up, proxied
wildcard DNS in place, and a real bundle published and fetched over the public tunnel.
Every assumption that once blocked deploy is now settled. The CLI is wired on this Mac
(`~/.config/shoebox/config.json` → `http://manz-utils:8087`).

**The port trap:** shoebox listens on 8080 inside the container, but publishes on
**8087** on manz-utils (`SHOEBOX_HOST_PORT`) — `:8080` there is birdnet. A JSON
`{"message":"Not Found"}` means you are talking to birdnet; shoebox's 404 is plain text.

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

## Verified in the 2026-07 session (fresh facts)

| Claim | How it was checked |
|---|---|
| **Universal SSL covers `*.enzoiwith.us`** (assumption 1, the big one) | Read the live cert on `mytube.enzoiwith.us`: SANs are `enzoiwith.us` + `*.enzoiwith.us`. The single-label wildcard is genuinely covered, which is what the whole `share-<id>` naming rests on |
| **`utils` has disk** (assumption 3) | `df` on manz-utils: 40 GB free (66% used) + 16 GB reclaimable images |
| **The Dockerfile builds** | Built clean on the first try — the predicted "expect to fix something" did **not** hit the build |
| **The image boots and serves** in production mode (`SERVE_FILES=false`) | Ran it; `/_/health` 200, full authz flow correct |
| **The real `deploy/homelab/Caddyfile` works unmodified** | Ran shoebox + `caddy:2-alpine` with the actual Caddyfile. anonymous→302, `?secret=`→302+Set-Cookie+clean `Location: /`, asset-with-cookie→200, no-cookie→302, and mytube/apex/`xshare-`/bad-alphabet-id all 404 |
| **The `route{}` ordering fact, empirically** | Because `?secret=` redirected to `Location: /` (not `/index.html`), `forward_auth` demonstrably ran before `try_files` |

## No assumptions remain unverified

The last one — **a proxied wildcard DNS record on this Cloudflare plan** — was settled by
doing it. `*.enzoiwith.us` → `<UUID>.cfargotunnel.com` (proxied) exists, resolves, and has
served a real bundle over HTTPS. **The per-bundle-CNAME fallback in DEPLOY.md §4 is dead
code — do not build it.**

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
npm run typecheck && npm test        # 46 tests
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

**Nothing to deploy — it is live.** Everything the old checklist listed (repo, image,
1Password item, compose on manz-utils, dedicated tunnel, wildcard DNS, CLI wiring, smoke
test, backport to `config/homelab/utils/shoebox/`) is done.

Two things surfaced only at deploy time and are worth remembering, because both would
otherwise be rediscovered the hard way:

- **Port collision.** `:8080` on manz-utils is birdnet; `:8081`/`:8082` are shopwala;
  `:8083` (sure) is firewalled to the Authentik outpost. shoebox publishes on **8087** via
  `SHOEBOX_HOST_PORT` while still listening on 8080 inside the container.
- **Tunnel credentials JSON must be `chmod 644`, not 600.** `cloudflared:latest` runs as
  uid 65532 and reads the creds via world-read; 600 makes the tunnel fail to start.

Open, but not a problem: wildcard DNS means every nonexistent subdomain resolves and hits
shoebox-caddy's 404 instead of returning NXDOMAIN. Accepted.

### Deliberately not built

- **Cloudflare DNS API integration.** The wildcard works, so this is permanently unnecessary.
- **CI beyond build.** No deploy step; watchtower pulls `:latest`.
- **Any listing UI.** See invariants.
- **Non-static apps.** No server-side code runs in a bundle, on purpose.

---

## Operator decisions — settled 2026-07

- **Repo visibility: public.** Done — `github.com/bigsaam/shoebox`.
- **Default TTL: 90 days.** Done in `47f355e` — `shoebox put` defaults to `--ttl 90d`,
  `--ttl never` opts out. The default is a CLI policy; the server primitive (absent TTL
  = forever) is unchanged.
- **`SHOEBOX_SESSION_TTL`: kept at 30d.** A bypass-link viewer keeps access for a month;
  accepted, since the bypass secret is already "the credential."

Still genuinely open (not blocking):

- Wildcard DNS makes every nonexistent subdomain resolve and hit shoebox-caddy's 404
  instead of returning NXDOMAIN. Acceptable? (One of the operator's own earlier questions.)

## Fixed this session — do not re-introduce

- **macOS AppleDouble leak (`1b9ac19`).** `tar` on a Mac emitted `._<name>` sidecars
  into every bundle, carrying `com.apple.metadata:kMDItemWhereFroms` — *the URL a file
  was downloaded from*. Reproduced it leaking an internal URL into a published bundle.
  Fixed at the trust boundary (`isMacMetadata` filter in `api.ts`'s `tar.x`, so it holds
  for any client) **and** at the source (`COPYFILE_DISABLE=1` in the CLI). Regression
  test asserts on stored files, so it fails on Linux CI too. If you ever loosen the
  `tar.x` filter, keep AppleDouble + `.DS_Store` excluded.

Test count is now **46** (was 41): +3 CLI (`test/cli.test.ts`, first coverage of
`bin/shoebox.mjs`) and +2 AppleDouble/junk in `test/server.test.ts`.

---

## Unrelated, in case you trip over it

`~/workspace/india-trip-results/` (`results.md`, `results.db`) is finished work from
earlier in the same session — live Google Flights research, nothing to do with shoebox.
The published artifact for it is at `claude.ai/code/artifact/10d17213-…`. Leave it be.
