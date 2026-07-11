# shoebox

Where you toss the one-offs.

A small server that takes a static artifact — a generated report, a chart, a
throwaway SPA — gives it a short unguessable URL, and puts one shared password in
front of it. Optionally hands out a `?secret=…` link that skips the password
entirely.

Built because agents generate a lot of HTML and there is nowhere good to put it.

```bash
$ shoebox put ./india-trip.html
published  india-trip.html
  link     https://share-k3f9qhtm.enzoiwith.us/
  bypass   https://share-k3f9qhtm.enzoiwith.us/?secret=8f2c1e…
  expires  2026-10-09T22:20:15Z
```

Paste the link into a chat, paste the password after it. Or send the bypass link
on its own and skip the explanation.

## Architecture: Caddy serves, shoebox authorizes

```
Cloudflare Tunnel ──▶ shoebox-caddy ──forward_auth──▶ shoebox
                           │                             │
                      serves files                  authorizes,
                   /srv/bundles/<id>               accepts uploads
```

Serving static files behind a wildcard host is a solved problem, so **Caddy does
it** — file_server, try_files, compression, ETags, range requests. shoebox is not a
web server in production; it answers one question on `/_/authz`: may this request
proceed? Caddy copies any non-2xx answer, headers and all, straight to the browser.

### Why this needs custom code at all

Because the obvious off-the-shelf answers don't fit:

- **`basic_auth` / `auth_basic`** gives you the shared password, but has no notion
  of a per-artifact bypass, and no cookie.
- **nginx's `secure_link`** *is* the signed-URL primitive — but it signs
  **per-URI**. Your page then requests `assets/app.js` with no query string and
  gets a 403. You would have to sign every asset URL of an arbitrary, agent-written
  bundle.

The missing piece is exactly one exchange: **take a one-time `?secret=…`, mint a
session cookie, redirect to the clean URL, get out of the way.** After that the
browser carries the cookie and Caddy serves everything normally. The token never
lingers in the address bar to be screenshotted. That exchange is `src/authz.ts`,
and it is the reason this repo exists.

## The rest of why it works this way

**One password, not accounts.** The recipients are friends, family, a contractor.
Nobody is signing up for anything.

**One origin per bundle.** Each bundle lives at `share-<id>.enzoiwith.us`, so one bundle's
JavaScript can never read another's, and its session cookie is host-only.

**No index.** Knowing the password does not tell you which bundles exist. The only
way to enumerate them is `shoebox ls`, which needs the API token.

**Publish privately, share publicly.** The CLI can post over Tailscale to
`http://manz-utils:8080`; the link it prints is still the public HTTPS URL. Links
are built from `SHOEBOX_HOST_TEMPLATE`, never from the request host.

**Static only.** No server-side code, no sandbox to get wrong.

**Disposable by construction.** Files in `data/bundles/<id>/`, metadata in
`data/meta/<id>.json` — deliberately *outside* the directory Caddy roots, so a
secret can never be served as a file. `rm -rf data/bundles/k3f9qhtm` is a
legitimate delete. There is no database to fall out of sync.

## Quick start

```bash
cp .env.example .env      # then fill in the three secrets
npm install
npm run dev

# in another shell
node bin/shoebox.mjs init --url http://localhost:8080 --token <SHOEBOX_API_TOKEN>
node bin/shoebox.mjs put ./some-page.html
```

Or with Docker:

```bash
cp .env.example .env
docker compose up -d --build
```

Picking this up cold? Start with [`HANDOFF.md`](HANDOFF.md).

For the homelab deployment behind the Cloudflare Tunnel, see [`DEPLOY.md`](DEPLOY.md)
(the runbook) and [`deploy/homelab/README.md`](deploy/homelab/README.md).

## CLI

| Command | Does |
|---|---|
| `shoebox put <file\|dir>` | Publish (expires in 90d). `--ttl 7d`/`--ttl never`, `--entry app.html`, `--name x`, `--json` |
| `shoebox ls` | List bundles with age and view counts |
| `shoebox rm <id>` | Delete one, immediately |
| `shoebox prune --older-than 30d` | Delete everything older than that |
| `shoebox init --url … --token …` | Write `~/.config/shoebox/config.json` |

The token may be an `op://vault/item/field` reference; the CLI resolves it with
the 1Password CLI at call time so it never lands on disk.

## HTTP API

Everything the CLI does, in case you'd rather `curl`. Authenticate with
`Authorization: Bearer <SHOEBOX_API_TOKEN>`.

| Route | Purpose |
|---|---|
| `POST /_/api/bundles` | Body is a gzipped tar of the bundle. Headers: `x-shoebox-name`, `x-shoebox-entry`, `x-shoebox-ttl` |
| `GET /_/api/bundles` | List, including `url` and `secretUrl` |
| `DELETE /_/api/bundles/:id` | Delete |
| `POST /_/api/prune` | `{"olderThan":"30d"}`; omit to sweep only expired bundles |
| `GET /_/authz` | Caddy's forward_auth target. 200 proceed, 302 login/secret-exchange, 404 unknown |
| `GET /_/health` | Unauthenticated liveness |

Human routes: `/_/login` and the bundle itself. There is no index.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `SHOEBOX_PASSWORD` | — | Required. The one you share. |
| `SHOEBOX_API_TOKEN` | — | Required. Publish/delete. Never share. |
| `SHOEBOX_SESSION_SECRET` | — | Required. Signs cookies; rotating logs everyone out. |
| `SHOEBOX_HOST_TEMPLATE` | unset | e.g. `share-{id}.enzoiwith.us`. Set ⇒ one origin per bundle. Unset ⇒ path mode. |
| `SHOEBOX_PUBLIC_SCHEME` | `https` if templated | Scheme used in printed links and the cookie `Secure` flag. |
| `SHOEBOX_SERVE_FILES` | `true` | `false` when Caddy serves and shoebox only authorizes. |
| `SHOEBOX_COOKIE_DOMAIN` | unset | Share one password session across bundles. Refused when `{id}` sits inside a label. |
| `SHOEBOX_BASE_URL` | request host | Origin for path-mode links. |
| `SHOEBOX_PORT` | `8080` | |
| `SHOEBOX_DATA_DIR` | `./data` | |
| `SHOEBOX_SESSION_TTL` | `30d` | How long a login lasts. |
| `SHOEBOX_MAX_BUNDLE_SIZE` | `100mb` | |

## What it does not protect against

Worth being explicit, because "one password" is a deliberate choice and not an
oversight:

- **One password guards every bundle.** It does not *reveal* them (there is no
  index), but anyone who has it and a link can open that link. Rotate it by
  changing `SHOEBOX_PASSWORD`.
- **A bypass link is a credential.** It grants its own bundle to whoever holds it,
  forever, until you `shoebox rm` the bundle.
- **IDs leak existence.** A nonexistent subdomain 404s while a real one redirects to
  login. IDs are 8 characters from a 27-symbol alphabet (~2.8 × 10¹¹), so
  enumeration is impractical, but it is not zero.
- **Bundles are siblings of your other services.** `share-<id>.enzoiwith.us` shares a
  registrable domain with everything else you host. Session cookies are host-only, and
  shoebox refuses to start if you try to widen them — but never set a `.enzoiwith.us`
  cookie on any other service, and don't host untrusted HTML here.
- **No virus scanning, no CSP.** Bundles run their own JavaScript, on purpose.

## Tests

```bash
npm test
```

41 tests. The ones that matter cover the forward_auth contract (`test/authz.test.ts`),
path traversal (`resolveWithin`), host parsing (`idFromHost` must reject
`mytube.enzoiwith.us`), cookie scope forgery (a bundle token must not open a different
bundle), the secret-link redirect, and that a failed publish leaves nothing behind.

The Caddyfile is validated with `caddy validate`, and the whole stack — Caddy in
front of shoebox — has been exercised end to end against `Host:` headers.
