# Deploying shoebox to manz-utils

Same shape as `tripwala/`: standalone compose on the external `utils` network,
secrets from 1Password, Cloudflare Tunnel reaching the Caddy container by name.

```
shoebox-tunnel ──▶ shoebox-caddy ──forward_auth──▶ shoebox
 (its own CF tunnel)     │                            │
                    serves files                 authorizes,
                 /srv/bundles/<id>              accepts uploads
                                                       ▲
                                        tailnet ───────┘  (shoebox put)
```

shoebox brings **its own Cloudflare Tunnel**. The `utils` tunnel — which routes
mytube, tripwala, apprise and birds — is never touched, so nothing here can take
those down. The ingress is a single catch-all; Caddy does the hostname matching.

Caddy does the serving because serving static files behind a wildcard host is a
solved problem. shoebox exists only for the part Caddy and nginx cannot do: turn a
one-time `?secret=…` into a session cookie so the page's *assets* load too.

## Why `share-<id>.enzoiwith.us`

Cloudflare's free **Universal SSL covers `enzoiwith.us` and `*.enzoiwith.us` — exactly
one wildcard label.** `<id>.preview.enzoiwith.us` is two levels deep and would need
Advanced Certificate Manager (~$10/mo). `share-<id>.enzoiwith.us` is one label, so the
free certificate already covers it.

The `share-` prefix keeps bundles out of the service namespace, so a bundle id can
never collide with `mytube`, `tripwala`, or a future service.

**The cost of that choice:** bundles are now siblings of your other services on the same
registrable domain. Session cookies are therefore host-only, and shoebox **refuses to
start** if you set `SHOEBOX_COOKIE_DOMAIN` with this template — the only domain wide
enough to span bundles (`.enzoiwith.us`) would also reach every other service. One
password prompt per bundle is the price. Bypass links are unaffected.

Still worth confirming in your zone's **SSL/TLS → Edge Certificates** that
`*.enzoiwith.us` is listed under the Universal certificate.

## 1. Create the 1Password item

Vault `Homelab`, item `shoebox`:

| Field | Generate with | Shared with |
|---|---|---|
| `password` | `openssl rand -base64 24` | anyone you send a link to |
| `api-token` | `openssl rand -hex 32` | nobody — agents read it via `op` |
| `session-secret` | `openssl rand -hex 32` | nobody |

## 2. The image builds itself

`.github/workflows/docker.yml` builds and pushes `ghcr.io/bigsaam/shoebox` on every
push to `main` (tags: `latest`, `sha-…`, and `v*` semver). The push is gated on
`npm test`, `npm run typecheck`, and `caddy validate` — a red build never reaches the
tunnel.

Make the GHCR package **public** once after the first build, or add a pull secret on
the host. Watchtower then keeps `:latest` current, as with your other services.

## 3. Deploy on the host

```bash
mkdir -p /docker/services/shoebox && cd /docker/services/shoebox
# copy compose.yml, Caddyfile, .env.example here
tailscale ip -4                       # put this in SHOEBOX_BIND_ADDR
op inject -i .env.example -o .env
docker compose up -d
docker compose ps                     # both healthy
```

Bundles land in `./data/bundles/<id>/`; metadata in `./data/meta/<id>.json`.
Caddy mounts only `./data/bundles` and only read-only, so **a bundle's secret can
never be served as a file** — not by traversal, not by a forgotten deny rule.

## 4. Its own tunnel, and one DNS record

```bash
cloudflared tunnel create shoebox                       # note the UUID
cp ~/.cloudflared/<UUID>.json ./cloudflared/ && chmod 600 ./cloudflared/<UUID>.json
cp cloudflared/config.yml.example cloudflared/config.yml # fill in the UUID, twice
docker compose up -d shoebox-tunnel
```

The ingress is a single catch-all — no hostname matcher, no rule ordering — because
Caddy already 404s anything that is not `share-<id>.enzoiwith.us`.

Then the DNS record, which is the thing that actually makes a bundle resolve.
`cloudflared tunnel route dns` will not create a wildcard, so add it by hand:

```
*.enzoiwith.us  CNAME  <UUID>.cfargotunnel.com  (proxied)
```

Specific DNS records still win over the wildcard, so `mytube`, `tripwala` and the rest
keep pointing at the `utils` tunnel. The side effect to accept: every nonexistent
subdomain now resolves and reaches shoebox-caddy's 404 rather than NXDOMAIN.

**Do not add an ingress rule per publish.** An ingress rule is not what makes a
hostname resolve; DNS is. One wildcard record covers every bundle, forever, and leaves
no per-artifact record behind to enumerate. If proxied wildcards turn out to be
plan-gated, the right move is a proxied CNAME per bundle via the Cloudflare API — not
rewriting a tunnel config on every upload.

*Alternative:* reuse the `utils` tunnel — see `cloudflared-ingress.snippet.yml`. Higher
blast radius, and the rule must be second-to-last.

## 5. Publish from anywhere on the tailnet

`shoebox` binds its API on the Tailscale address. From the Mac, the dev box, or any
tailnet host:

```bash
shoebox init --url http://manz-utils:8080 --token 'op://Homelab/shoebox/api-token'
shoebox put ./report.html
```

The link it prints is the **public** `https://share-<id>.enzoiwith.us/` URL, not
the tailnet address — the server builds links from `SHOEBOX_HOST_TEMPLATE`, never
from the request host. Publish privately, share publicly.

If you would rather not bind a port at all, point the CLI at the public host
instead (any `share-<id>` host answers `/_/*`); uploads are bearer-token authenticated
either way.

## 6. Backport to the config repo

Per `config/AGENTS.md`, source stays out of that repo but service config belongs in
it. Copy `compose.yml`, `Caddyfile`, `.env.example`, and this README to
`config/homelab/utils/shoebox/`, add the tunnel route, and add a row to the service
table in `config/homelab/utils/README.md`:

| Service | Purpose | Port |
|---|---|---|
| `shoebox`, `shoebox-caddy`, `shoebox-tunnel` | Password-gated preview server for throwaway artifacts (`share-<id>.enzoiwith.us`). `shoebox-caddy` serves bundles, `shoebox` authorizes and accepts uploads, `shoebox-tunnel` is a dedicated Cloudflare Tunnel | no public ports; shoebox `8080` on the Tailscale address |

## Notes

- `watchtower` will pick up `:latest`, as it does for the other services.
- **Do not put shoebox behind the Authentik outpost.** The point is a link plus a
  password you can paste to someone who has no account.
- There is no web index. The only way to enumerate bundles is `shoebox ls`, which
  needs the API token.
