# shoebox — deployment runbook

Written to be picked up cold, by a person or an agent, in a later session.
Everything below has been designed and tested locally; **nothing has been deployed.**

---

## Where things stand

| | |
|---|---|
| Code | Complete. 41 tests, typecheck clean. |
| Caddyfile | Passes `caddy validate` (Caddy 2.11.4), `caddy fmt`-clean. |
| End-to-end | Verified locally: real Caddy in front of shoebox, driven by `Host: share-<id>.enzoiwith.us`. Secret→cookie exchange, asset loading, sibling-host 404s, cross-bundle cookie forgery all confirmed. |
| CI | `.github/workflows/docker.yml` → `ghcr.io/bigsaam/shoebox`, gated on tests + typecheck + `caddy validate`. Never run. |
| Deployed | **No.** No image pushed, no tunnel route, no DNS. |

## Decisions already locked

- **Caddy serves the files; shoebox only authorizes** via `forward_auth → /_/authz`.
  shoebox is not a web server in production (`SHOEBOX_SERVE_FILES=false`).
- **Bundle URL is `share-<id>.enzoiwith.us`** — one label deep so free Universal SSL
  covers it; `share-` prefix keeps ids out of the service namespace.
- **No web index.** Enumeration requires the API token (`shoebox ls`).
- **Metadata lives outside the served tree** (`data/meta/<id>.json`), so a bundle's
  bypass secret can never be served as a file.
- **`SHOEBOX_COOKIE_DOMAIN` is refused at startup** with this host template. The cost
  is one password prompt per bundle; bypass links are unaffected.

---

## ⚠️ Verify these three before touching the tunnel

They are assumptions, not facts I could check from a laptop. Each one blocks deploy.

1. **Universal SSL covers `*.enzoiwith.us`.**
   Cloudflare → your zone → SSL/TLS → Edge Certificates. Confirm the Universal
   certificate lists `*.enzoiwith.us` alongside `enzoiwith.us`.
   *If it does not:* bundles won't load over HTTPS. Fall back to path mode (unset
   `SHOEBOX_HOST_TEMPLATE`, set `SHOEBOX_SERVE_FILES=true`, drop Caddy).

2. **Your plan allows a *proxied* wildcard DNS record.**
   Proxied wildcards have historically been a paid-plan feature. Try creating
   `*.enzoiwith.us` CNAME → `<TUNNEL_ID>.cfargotunnel.com` (proxied) and see.
   *If it is blocked:* have shoebox create one proxied CNAME per bundle through the
   Cloudflare API on publish, and delete it on `rm`. The `*.enzoiwith.us` **ingress**
   rule still works either way — only the DNS record needs to exist.

3. **`utils` has disk.** `homelab/utils/README.md` records the Docker root filesystem
   filling twice. Run `docker system df` before adding a service that stores uploads.

---

## Step by step

### 0. Publish the repo

```bash
cd ~/workspace/shoebox
gh repo create bigsaam/shoebox --public --source=. --push
```

The first Actions run builds and pushes `ghcr.io/bigsaam/shoebox:latest`.
**Then make the GHCR package public** (Packages → shoebox → Package settings), or add
a pull secret on the host.

### 1. Secrets

1Password vault `Homelab`, item `shoebox`:

| Field | Generate with |
|---|---|
| `password` | `openssl rand -base64 24` |
| `api-token` | `openssl rand -hex 32` |
| `session-secret` | `openssl rand -hex 32` |

### 2. Deploy on manz-utils

```bash
ssh manz-utils
mkdir -p /docker/services/shoebox && cd /docker/services/shoebox
# copy compose.yml, Caddyfile, .env.example from deploy/homelab/
tailscale ip -4                      # → SHOEBOX_BIND_ADDR in .env.example
op inject -i .env.example -o .env
docker compose up -d
docker compose ps                    # both containers healthy
curl -s localhost:8080/_/health      # {"ok":true}   (from the VM itself)
```

Both containers join the existing external `utils` network, so the `tunnel` container
reaches `shoebox-caddy` by name — same as `tripwala-caddy` and `mytube`.

### 3. Tunnel route — a wildcard, and it must go LAST

A per-hostname route will not work: bundle hostnames are minted at publish time.
cloudflared only supports a **leading `*.` label** (`ingress.matchHost` does
`strings.HasPrefix(ruleHost, "*.")` and nothing else), so `share-*.enzoiwith.us`
never matches. And `FindMatchingRule` returns the **first** match.

Edit `config/homelab/utils/cloudflared/config.yml`:

```yaml
ingress:
  - hostname: message.enzoiwith.us
    service: http://apprise:8000
  # … every existing specific hostname stays here, ABOVE the wildcard …
  - hostname: mytube.enzoiwith.us
    service: http://mytube:3000

  - hostname: "*.enzoiwith.us"        # ← new, second-to-last
    service: http://shoebox-caddy:80

  - service: http_status:404          # ← stays last
```

Then `docker restart tunnel` on manz-utils (the config is mounted read-only from
`$CONFIGDIR/cloudflared`).

Nothing existing changes: every named service still matches its own rule first.
Only unrouted hosts fall through to `shoebox-caddy`, which 404s anything that is not
a `share-<id>` host.

### 4. DNS

`cloudflared tunnel route dns` will not create a wildcard. Add by hand:

```
*.enzoiwith.us   CNAME   <TUNNEL_ID>.cfargotunnel.com   (proxied)
```

Specific records still win over the wildcard.
**Side effect to accept:** every nonexistent subdomain now resolves and reaches the
tunnel, so typos land on shoebox-caddy's 404 rather than NXDOMAIN.

### 5. Wire up the CLI

On the Mac and the dev box:

```bash
shoebox init --url http://manz-utils:8080 --token 'op://Homelab/shoebox/api-token'
```

Publishing goes over Tailscale; the link that comes back is the public HTTPS URL.
Symlink `bin/shoebox.mjs` onto `PATH` (it has no npm dependencies).

### 6. Smoke test

```bash
printf '<h1>hi</h1><script src="a.js"></script>' > /tmp/i/index.html   # mkdir -p /tmp/i first
printf 'console.log(1)' > /tmp/i/a.js
shoebox put /tmp/i --ttl 1d

# The bypass link must open with no password, and the asset must load.
curl -sI "$BYPASS"                 # 302 + Set-Cookie
curl -s  "$LINK"                   # 302 → /_/login
curl -sI https://enzoiwith.us/     # unrelated services unaffected
shoebox ls && shoebox rm <id>
```

### 7. Backport to the config repo

Per `config/AGENTS.md`, source stays out but service config belongs in it:

- `config/homelab/utils/shoebox/` ← `compose.yml`, `Caddyfile`, `.env.example`, README
- `config/homelab/utils/cloudflared/config.yml` ← the wildcard ingress rule
- `config/homelab/utils/README.md` ← a row in the service table

Commit straight to `main`, small and focused, no secrets.

---

## Rollback

Remove the `*.enzoiwith.us` ingress rule and the wildcard DNS record, restart `tunnel`,
`docker compose down` in `/docker/services/shoebox`. Nothing else was touched: no
existing hostname, route, or container is modified by any step above.

---

## Known limitations (deliberate)

- **One password prompt per bundle.** Cookies are host-only; widening them would leak
  the session to every other `enzoiwith.us` service, so it is refused at startup.
- **A bypass link is a credential**, valid until the bundle is deleted.
- **IDs leak existence** — a real subdomain 302s to login, a fake one 404s. 8 chars from
  a 27-symbol alphabet (~2.8 × 10¹¹), so enumeration is impractical, not impossible.
- **Bundles are siblings of your services** on the same registrable domain. Never set a
  `.enzoiwith.us`-scoped cookie on any service, and do not host untrusted HTML here.
- **No CSP, no scanning.** Bundles run their own JavaScript, on purpose.

## Map

| Path | What |
|---|---|
| `src/authz.ts` | The forward_auth endpoint. The reason this repo exists. |
| `src/links.ts` | `share-<id>` ⇄ hostname. |
| `src/store.ts` | Bundles on disk; `resolveWithin` is a security boundary. |
| `deploy/homelab/` | compose, Caddyfile, ingress snippet, deploy README |
| `test/authz.test.ts` | The forward_auth contract, asserted |
| `AGENTS.md` | How an agent should publish (also symlinked as `CLAUDE.md`) |

## For the agent picking this up

Read `AGENTS.md` first, then this file. Do **not** change `resolveWithin`,
`idFromHost`, `authz.ts`, or `crypto.ts` without reading `test/` — those four are the
entire security boundary. Run `npm test` before and after anything.
