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
| Deployed | **No.** No image pushed, no tunnel created, no DNS record. |

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
- **shoebox brings its own Cloudflare Tunnel.** The `utils` tunnel is never edited, so
  no step here can take mytube / tripwala / apprise / birds down.

---

## ⚠️ Verify these three before deploying

They are assumptions, not facts I could check from a laptop. Each one blocks deploy.

1. **Universal SSL covers `*.enzoiwith.us`.**
   Cloudflare → your zone → SSL/TLS → Edge Certificates. Confirm the Universal
   certificate lists `*.enzoiwith.us` alongside `enzoiwith.us`.
   *If it does not:* bundles won't load over HTTPS. Fall back to path mode (unset
   `SHOEBOX_HOST_TEMPLATE`, set `SHOEBOX_SERVE_FILES=true`, drop Caddy).

2. **Your plan allows a *proxied* wildcard DNS record.**
   Proxied wildcards have historically been a paid-plan feature. Try creating
   `*.enzoiwith.us` CNAME → `<SHOEBOX_TUNNEL_UUID>.cfargotunnel.com` (proxied).
   *If it is blocked:* have shoebox create one proxied CNAME per bundle through the
   Cloudflare API on publish and delete it on `rm` (see §4). The tunnel ingress needs
   no change either way — only the DNS record has to exist.

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
mkdir -p /docker/services/shoebox/cloudflared && cd /docker/services/shoebox
# copy compose.yml, Caddyfile, .env.example from deploy/homelab/
TS_IP=$(tailscale ip -4) && echo "$TS_IP"   # → SHOEBOX_BIND_ADDR in .env.example
op inject -i .env.example -o .env

# Bring up the app first. shoebox-tunnel would crash-loop until step 3 writes its config.
docker compose up -d shoebox shoebox-caddy
docker compose ps                            # both healthy

curl -s "http://$TS_IP:8080/_/health"        # {"ok":true} — shoebox binds only Tailscale
docker compose exec shoebox-caddy wget -qO- http://shoebox:8080/_/health   # from inside
```

All three containers join the existing external `utils` network, so `shoebox-tunnel`
reaches `shoebox-caddy` by name — the same mechanism `tripwala-caddy` uses.

Note `SHOEBOX_BIND_ADDR` binds the **Tailscale address only**. `curl localhost:8080`
on the VM will fail, and that is the point: the upload API is not on the LAN.

### 3. Its own tunnel

shoebox runs `shoebox-tunnel`, a Cloudflare Tunnel of its own. A bad config here
cannot drop mytube, tripwala, apprise or birds, and the ingress collapses to a single
catch-all — Caddy already 404s any host that is not `share-<id>.enzoiwith.us`.

```bash
cloudflared tunnel create shoebox            # note the UUID
cp ~/.cloudflared/<UUID>.json /docker/services/shoebox/cloudflared/
chmod 600 /docker/services/shoebox/cloudflared/<UUID>.json
cp deploy/homelab/cloudflared/config.yml.example \
   /docker/services/shoebox/cloudflared/config.yml
# fill in <SHOEBOX_TUNNEL_UUID> in that file, twice
docker compose up -d shoebox-tunnel
```

*Alternative:* reuse the `utils` tunnel instead — delete the `shoebox-tunnel`
service and add the rule from `cloudflared-ingress-shared-tunnel` (see
`deploy/homelab/cloudflared-ingress.snippet.yml`). It must go **second-to-last**,
ahead of `http_status:404`, because `FindMatchingRule` returns the first match and
cloudflared only matches a leading `*.` label. Higher blast radius; only do it if a
second tunnel credential is not worth it.

### 4. DNS — the part that actually makes bundles resolve

One proxied wildcard record, pointing at whichever tunnel serves shoebox.
`cloudflared tunnel route dns` will not create a wildcard, so add it by hand:

```
*.enzoiwith.us   CNAME   <SHOEBOX_TUNNEL_UUID>.cfargotunnel.com   (proxied)
```

Specific records (`mytube`, `tripwala`, …) still win over the wildcard and keep
pointing at the utils tunnel. Only unrouted subdomains land on shoebox.

**Side effect to accept:** every nonexistent subdomain now resolves and reaches
shoebox-caddy's 404 rather than returning NXDOMAIN.

#### Do not add a route per publish

An ingress rule is not what makes a hostname resolve — DNS is. A per-bundle ingress
rule with no DNS record still returns NXDOMAIN, so it buys nothing, and scripting
edits to a shared tunnel's config on every publish risks dropping every other service
on the VM.

If proxied **wildcard** DNS turns out to be unavailable on your plan, the correct
per-publish action is to create a proxied **CNAME per bundle** through the Cloudflare
API (`Zone:DNS:Edit`), and delete it on `shoebox rm`. That is a real feature worth
adding *then*, not now — it costs an API token in the container, cleanup on delete,
and it leaves one public DNS record per artifact. The wildcard leaves nothing behind.

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

- `config/homelab/utils/shoebox/` ← `compose.yml`, `Caddyfile`, `.env.example`,
  `cloudflared/config.yml.example`, README
- `config/homelab/utils/README.md` ← a row in the service table

The `utils` tunnel's `cloudflared/config.yml` is **not** modified: shoebox has its own
tunnel. (Only the shared-tunnel alternative would touch it.)

Never commit `cloudflared/config.yml` or the credentials JSON — both are gitignored
here and are host secrets, exactly like the `utils` tunnel's credentials.

Commit straight to `main`, small and focused, no secrets.

---

## Rollback

`docker compose down` in `/docker/services/shoebox`, then delete the wildcard DNS
record. With the dedicated tunnel, that is the entire footprint — the `utils` tunnel,
its config, and every existing hostname are never touched. Optionally
`cloudflared tunnel delete shoebox`.

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
| `deploy/homelab/` | compose (shoebox + caddy + its own tunnel), Caddyfile, cloudflared config, deploy README |
| `test/authz.test.ts` | The forward_auth contract, asserted |
| `AGENTS.md` | How an agent should publish (also symlinked as `CLAUDE.md`) |

## For the agent picking this up

Read `AGENTS.md` first, then this file. Do **not** change `resolveWithin`,
`idFromHost`, `authz.ts`, or `crypto.ts` without reading `test/` — those four are the
entire security boundary. Run `npm test` before and after anything.
