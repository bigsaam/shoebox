function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1b2027;--mut:#6b7280;--card:#fff;--line:#e2e5ea;--acc:#2f6b4f}
@media(prefers-color-scheme:dark){:root{--bg:#0e1116;--fg:#e6e9ee;--mut:#8b93a1;--card:#161a21;--line:#262b34;--acc:#7fbf9c}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;
background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:2rem;width:100%;max-width:24rem}
h1{margin:0 0 .35rem;font-size:1.3rem}
p.sub{margin:0 0 1.5rem;color:var(--mut);font-size:.9rem}
label{display:block;font-size:.85rem;color:var(--mut);margin-bottom:.4rem}
input{width:100%;padding:.7rem .8rem;font-size:1rem;border:1px solid var(--line);border-radius:6px;
background:var(--bg);color:var(--fg)}
input:focus{outline:2px solid var(--acc);outline-offset:1px}
button{margin-top:1rem;width:100%;padding:.7rem;font-size:1rem;font-weight:600;border:0;border-radius:6px;
background:var(--acc);color:var(--bg);cursor:pointer}
.err{margin-top:1rem;padding:.6rem .8rem;border-radius:6px;background:#b91c1c1a;color:#b91c1c;font-size:.88rem}
@media(prefers-color-scheme:dark){.err{color:#fca5a5}}
`;

export function loginPage(next: string, failed: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>shoebox</title><style>${STYLE}</style></head>
<body><form class="card" method="POST" action="/_/login">
<h1>shoebox</h1><p class="sub">This preview is password protected.</p>
<input type="hidden" name="next" value="${esc(next)}">
<label for="p">Password</label>
<input id="p" name="password" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Open</button>
${failed ? '<div class="err">Wrong password.</div>' : ""}
</form></body></html>`;
}
