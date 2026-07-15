# shoebox — Agent Guide

## What this is

A password-gated preview server for **throwaway static artifacts**. You build an
HTML page (or a built SPA), publish it, and hand the user a short link they can
paste into a chat. Everything here is disposable by design.

Live at `https://share-<id>.enzoiwith.us` — one subdomain per bundle.

## The one thing you need to know

```bash
shoebox put ./report.html
```

That prints:

```
published  report.html
  link     https://share-k3f9qhtm.enzoiwith.us/
  bypass   https://share-k3f9qhtm.enzoiwith.us/?secret=8f2c…
  expires  2026-10-09T22:20:15Z
```

Every bundle gets its own subdomain, and therefore its own browser origin.

Give the user **both** lines and explain the difference in one sentence:

- **link** — asks for the shared shoebox password. Send this when the recipient
  already knows the password, or when you want a second factor on a link that
  might get forwarded.
- **bypass** — opens immediately, no password. Send this on its own to someone
  you'd rather not explain a password to. Treat it as the credential it is.

## Publishing

```bash
shoebox put ./page.html                  # a single self-contained page (expires in 90 days)
shoebox put ./dist/                      # a built SPA (needs dist/index.html)
shoebox put ./dist/ --entry app.html     # …or name the page (directories only)
shoebox put ./page.html --ttl 7d         # sooner: delete itself after 7 days
shoebox put ./page.html --ttl never      # keep it permanently
shoebox put ./page.html --json           # machine-readable, for scripting
```

- A **single file** is staged as `index.html`; the link opens it directly. Its
  original name is kept for `shoebox ls`.
- A **directory** is served whole. It must contain `index.html`, or you must pass
  `--entry`. Relative paths, assets, fonts, images all work.
- Bundles are capped at 100 MB.

### Updating a bundle in place

```bash
shoebox put ./report.html --update k3f9qhtm   # replace the content, keep the link
```

When you revise something you've already shared, **update it — don't republish.**
`--update <id>` swaps in the new files while keeping the **same link, the same bypass
secret, and the same expiry**, so every link you already handed out still works and
still shows the latest version. Republishing instead mints a new id, so the old link
would keep serving the stale copy.

- Same flags as `put` (`--entry`, `--name`) apply to the new content.
- Expiry is left untouched unless you pass `--ttl` (which resets it from now; `--ttl
  never` clears it).
- The update is atomic: if the new bundle is rejected (e.g. no `index.html`), the
  previous content keeps serving unchanged.

## What it will and will not run

**Static files only.** HTML, CSS, JS, images, fonts, WASM. Client-side JavaScript
runs normally — React, canvas, charts, local storage, `fetch` to third-party APIs.

**No server-side code.** There is no Node process, no Python, no database, no API
routes. If your artifact needs a backend, either inline the data into the page or
build something else. Do not try to work around this.

## Housekeeping

```bash
shoebox ls                        # what's out there, with view counts
shoebox rm k3f9qhtm               # delete one
shoebox prune --older-than 30d    # delete everything older than 30 days
```

Bundles expire **90 days** after publish by default, so nothing accumulates forever.
Pass `--ttl 7d` for a one-off tied to a single conversation, or `--ttl never` for
something the user will keep coming back to. The server sweeps expired bundles hourly;
`shoebox prune` is only for clearing things out ahead of their TTL.

## Rules

1. **Never publish secrets.** Anything you put in a bundle is readable by anyone
   with the link and the password. No API keys, no tokens, no `.env`, no
   credentials inlined into JS. Check before you publish.

2. **Never paste the API token into a chat, a bundle, or a commit.** It grants
   publish and delete on everything. The password and the per-bundle secret are
   the only things meant to be shared.

3. **Don't publish someone else's data.** Personal information, private repos,
   customer data — none of it belongs on a public hostname behind one password.

4. **There is no index, deliberately.** Knowing the password does not reveal which
   bundles exist — the only way to enumerate them is `shoebox ls`, which needs the
   API token. Do not build a listing page.

5. **`shoebox rm` is instant and irreversible.** There is no trash.

## Setting up on a new host

The CLI reads `~/.config/shoebox/config.json`, or `SHOEBOX_URL` and
`SHOEBOX_API_TOKEN` from the environment. The token can be an `op://` reference,
which the CLI resolves through the 1Password CLI — matching the homelab convention:

```bash
# Anywhere on the tailnet — publishes straight to the homelab VM.
node /path/to/shoebox/bin/shoebox.mjs init \
  --url http://manz-utils:8087 \
  --token 'op://Homelab/shoebox/api-token'
```

**The port is 8087, not 8080.** shoebox listens on 8080 *inside* the container, but on
manz-utils the published host port is 8087 (`SHOEBOX_HOST_PORT`) — `:8080` there is
birdnet. If `init` seems to work but every call 404s with `{"message":"Not Found"}`,
you are talking to birdnet: shoebox's own 404 is plain text, never JSON.

The printed link is always the public `https://share-<id>.enzoiwith.us/` URL,
never the address you published to. Publish over Tailscale, share over the internet.

Then `npm link` (or symlink `bin/shoebox.mjs` onto your `PATH`) so `shoebox` works
from any directory. The CLI has no npm dependencies — it shells out to `tar` — so
it runs fine from an absolute path without installing anything.

## Working on shoebox itself

```bash
npm install
npm test          # 46 tests; the authz and path-traversal ones are the important ones
npm run typecheck
npm run dev       # needs a .env; see .env.example
```

Source layout, all small and single-purpose:

| File | Owns |
|---|---|
| `src/config.ts` | env parsing, durations, sizes |
| `src/crypto.ts` | cookie signing, constant-time compare |
| `src/auth.ts` | who may see what; login rate limit |
| `src/links.ts` | id ⇄ hostname, and the links handed to humans |
| `src/store.ts` | bundles on disk, path containment, pruning |
| `src/authz.ts` | `GET /_/authz`, Caddy's forward_auth target |
| `src/serve.ts` | the built-in file server (local dev only) |
| `src/api.ts` | login pages, upload/list/delete/prune |
| `bin/shoebox.mjs` | the CLI |

**In production Caddy serves the files and shoebox never touches them**
(`SHOEBOX_SERVE_FILES=false`). shoebox answers `/_/authz` with 200 (proceed), 302
(login, or exchange `?secret=` for a cookie), or 404. Caddy copies any non-2xx
response — headers included — straight to the browser.

If you touch `resolveWithin`, `idFromHost`, `authz.ts`, or anything in `crypto.ts`,
read the tests first. Those files are the entire security boundary.
