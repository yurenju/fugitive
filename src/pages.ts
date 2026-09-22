// HTML for the Authorization Page, /authorize/done and the Settings Page: plain forms, no JavaScript, dark only.

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Dark only (spec #24). All colours are variables here, so a light set is one more block of values.
const CSS = `
:root{--bg:#0b0b0e;--card:#16161b;--border:#2a2a33;--text:#ececf1;--muted:#9a9aa6;--field:#0f0f13;
  --primary:#ececf1;--on-primary:#0b0b0e;--danger:#dc2626;--on-danger:#fff;--err:#f87171;--ok:#4ade80}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:48px 16px;
  background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px}
.card.wide{max-width:760px}
.host{color:var(--muted);font-size:13px;margin:0 0 20px}
h1{font-size:20px;margin:0 0 8px}
p{margin:0 0 16px}
.muted{color:var(--muted);font-size:13px}
label{display:block;font-size:13px;color:var(--muted);margin:0 0 6px}
input[type=email],input[type=text]{width:100%;padding:10px 12px;margin:0 0 16px;border:1px solid var(--border);
  border-radius:8px;background:var(--field);color:var(--text);font:inherit}
button{width:100%;padding:10px 12px;border:0;border-radius:8px;background:var(--primary);color:var(--on-primary);
  font:inherit;font-weight:600;cursor:pointer}
button.secondary{background:transparent;color:var(--text);border:1px solid var(--border);margin-top:8px}
button.link{background:none;color:var(--muted);text-decoration:underline;font-weight:400;margin-top:8px}
button.danger{background:var(--danger);color:var(--on-danger)}
.check{display:flex;gap:8px;align-items:center;margin:0 0 16px;color:var(--text);font-size:15px}
.error{color:var(--err);margin:0 0 16px}
.notice{color:var(--ok);margin:0 0 16px}
ul{margin:0 0 20px;padding-left:20px}
.code{font:28px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--field);border:1px solid var(--border);
  border-radius:8px;padding:16px;margin:0 0 16px;word-break:break-all;user-select:all}
h2{font-size:15px;margin:28px 0 8px}
.table{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--border);vertical-align:middle}
th{color:var(--muted);font-weight:400}
td form{display:flex;gap:6px;margin:0}
td input[type=text]{margin:0;padding:6px 8px;min-width:0}
td button{width:auto;padding:6px 12px}
`;

export function page(title: string, body: string, opts: { status?: number; wide?: boolean; host: string; headers?: HeadersInit }) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main class="card${opts.wide ? " wide" : ""}"><p class="host">${esc(opts.host)}</p>
${body}
</main></body></html>`;
  const headers = new Headers(opts.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  return new Response(html, { status: opts.status ?? 200, headers });
}

export const hidden = (name: string, value: string) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
export const error = (message?: string) => (message ? `<p class="error" role="alert">${esc(message)}</p>` : "");

export interface EmailForm {
  action: string;
  heading: string;
  intro: string;
  error?: string;
}

export function emailForm(f: EmailForm): string {
  return `<h1>${esc(f.heading)}</h1>
<p>${esc(f.intro)}</p>
${error(f.error)}
<form method="post" action="${esc(f.action)}">
${hidden("step", "email")}
<label for="email">Email</label>
<input type="email" id="email" name="email" required autofocus autocomplete="email">
<button type="submit">Send code</button>
</form>`;
}

export interface CodeForm {
  action: string;
  email: string;
  askName: boolean;
  name?: string;
  error?: string;
  notice?: string;
}

export function codeForm(f: CodeForm): string {
  const nameField = f.askName
    ? `<label for="name">Choose a user name</label>
<input type="text" id="name" name="name" required value="${esc(f.name ?? "")}" autocomplete="username"
  autocapitalize="none" spellcheck="false" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="39">
<p class="muted">Your repositories will live at /@name/…, and the name cannot be changed later.</p>`
    : "";
  return `<h1>${f.askName ? "Create your account" : "Enter your code"}</h1>
<p>If this email can be used, a code has been sent to <strong>${esc(f.email)}</strong>.</p>
${f.notice ? `<p class="muted">${esc(f.notice)}</p>` : ""}
${error(f.error)}
<form method="post" action="${esc(f.action)}">
${hidden("step", "code")}${hidden("email", f.email)}
<label for="code">Verification code</label>
<input type="text" id="code" name="code" required autofocus inputmode="numeric" autocomplete="one-time-code"
  pattern="[0-9]{6}" maxlength="6">
${nameField}
<button type="submit">Continue</button>
</form>
<form method="post" action="${esc(f.action)}">
${hidden("step", "email")}${hidden("email", f.email)}
<button type="submit" class="link">Send a new code</button>
</form>`;
}
