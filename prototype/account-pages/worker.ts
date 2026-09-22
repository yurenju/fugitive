// PROTOTYPE — throwaway, lives only on the prototype/account-pages branch.
// Question: what should the Authorization Page and Settings Page (spec #24) look like, and how do the
// pages link to each other? Three structurally different variants on the same routes, switched with
// `?variant=A|B|C` and the floating bar at the bottom. No OAuth, no email, no KV: everything is faked
// in memory and shown in the "prototype state" panel so you can see what each click changed.

type Variant = "A" | "B" | "C";
const VARIANTS: Record<Variant, string> = {
  A: "One step per page",
  B: "One growing page",
  C: "Split: tool on the left",
};

// ---------- fake state ----------

interface Grant { id: number; email: string; client: string; scope: "read" | "write"; created: string; lastUsed: string }
const users = new Map<string, string>([["yurenju@example.com", "yurenju"], ["alice@example.com", "alice"]]);
const allowlist = new Set(["yurenju@example.com", "alice@example.com", "new@example.com"]);
const codes = new Map<string, { code: string; sentAt: number; tries: number }>();
const outbox: { to: string; code: string; at: string }[] = [];
let nextGrant = 4;
const grants: Grant[] = [
  { id: 1, email: "yurenju@example.com", client: "git on yuren-mbp", scope: "write", created: "2026-09-01", lastUsed: "2026-09-22" },
  { id: 2, email: "yurenju@example.com", client: "Claude", scope: "write", created: "2026-09-10", lastUsed: "2026-09-21" },
  { id: 3, email: "yurenju@example.com", client: "git on ci-runner", scope: "read", created: "2026-06-02", lastUsed: "2026-07-15" },
];
const repositories = new Map<string, { name: string; created: string; empty?: boolean }[]>([
  ["yurenju@example.com", [
    { name: "notes", created: "2026-09-02" },
    { name: "dotfiles", created: "2026-09-05" },
    { name: "fugtive", created: "2026-09-20", empty: true },
  ]],
]);

const CLIENTS: Record<string, { name: string; requested: "read" | null; manual: boolean }> = {
  git: { name: "git on yuren-mbp", requested: null, manual: true },
  claude: { name: "Claude", requested: null, manual: false },
  reader: { name: "Docs indexer", requested: "read", manual: false },
};

const today = () => new Date().toISOString().slice(0, 10);
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function sendCode(email: string): string | undefined {
  const prev = codes.get(email);
  if (prev && Date.now() - prev.sentAt < 60_000) return "You can request a new code in a minute.";
  if (!users.has(email) && !allowlist.has(email)) return; // silently no email
  const code = String(Math.floor(100000 + Math.random() * 900000));
  codes.set(email, { code, sentAt: Date.now(), tries: 0 });
  outbox.unshift({ to: email, code, at: new Date().toLocaleTimeString("en-GB") });
}

function checkCode(email: string, code: string): string | undefined {
  const c = codes.get(email);
  if (!c) return "That code has expired or was already used. Request a new one.";
  if (c.code !== code.trim()) {
    if (++c.tries >= 5) { codes.delete(email); return "Too many wrong tries. Request a new code."; }
    return `Incorrect code. ${5 - c.tries} tries left.`;
  }
}

function checkName(name: string): string | undefined {
  if (!name) return "Pick a user name.";
  if (!NAME.test(name) || name.length > 39) return "Use 1–39 lowercase letters, digits or single hyphens (not at the start or end).";
  if ([...users.values()].includes(name)) return `"${name}" is taken. Try another.`;
}

// ---------- helpers ----------

const h = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
let V: Variant = "A"; // current request's variant (single-threaded prototype)
function u(path: string, params: Record<string, string | undefined> = {}) {
  const q = new URLSearchParams({ variant: V });
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return `${path}?${q}`;
}
const hidden = (fields: Record<string, string | undefined>) =>
  Object.entries(fields).map(([k, v]) => (v ? `<input type="hidden" name="${k}" value="${h(v)}">` : "")).join("");
const redirect = (to: string, cookie?: string) =>
  new Response(null, { status: 303, headers: { Location: to, ...(cookie ? { "Set-Cookie": cookie } : {}) } });
const scopeOf = (client: string, readonly: boolean): "read" | "write" =>
  CLIENTS[client]?.requested === "read" || readonly ? "read" : "write";

// ---------- page steps (what each variant has to render) ----------

type Step =
  | { kind: "email"; client: string; error?: string }
  | { kind: "code"; client: string; email: string; isNew: boolean; error?: string; notice?: string; name?: string }
  | { kind: "consent"; client: string; email: string } // variant A only
  | { kind: "done"; code: string }
  | { kind: "denied"; client: string }
  | { kind: "settingsEmail"; error?: string }
  | { kind: "settingsCode"; email: string; error?: string; notice?: string }
  | { kind: "settings"; email: string; tab: "tools" | "repositories"; msg?: string }
  | { kind: "deleteConfirm"; email: string; repo: string; error?: string }; // variant B only

// Shared bits every variant may use (a shared header is fine; layouts are per variant).
const err = (s?: string) => (s ? `<p class="err">${h(s)}</p>` : "");
const note = (s?: string) => (s ? `<p class="note">${h(s)}</p>` : "");
function canList(scope: "read" | "write") {
  return scope === "read"
    ? ["Clone and fetch your repositories"]
    : ["Clone and fetch your repositories", "Push, and create repositories by pushing"];
}
const cannot = ["Delete repositories", "Revoke other tools"];

// ===== Variant A: one question per page, narrow centred card; consent is its own last step =====

const A = {
  css: `body{font:16px/1.5 system-ui,sans-serif;background:#f4f4f5;color:#18181b;margin:0;padding:48px 16px}
  .card{max-width:380px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px}
  .brand{text-align:center;font-weight:700;letter-spacing:.02em;margin-bottom:20px;color:#52525b}
  h1{font-size:20px;margin:0 0 8px} label{display:block;font-size:14px;margin:16px 0 4px;color:#3f3f46}
  input[type=email],input[type=text]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d4d4d8;border-radius:8px;font:inherit}
  button{width:100%;margin-top:20px;padding:11px;border:0;border-radius:8px;background:#18181b;color:#fff;font:inherit;cursor:pointer}
  button.link{background:none;color:#52525b;margin-top:8px;padding:4px;text-decoration:underline}
  .err{color:#b91c1c}.note{color:#15803d}.muted{color:#71717a;font-size:14px}
  .code{font:28px/1.2 ui-monospace,monospace;letter-spacing:.15em;text-align:center;padding:16px;background:#f4f4f5;border-radius:8px}
  table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:8px 4px;border-bottom:1px solid #e4e4e7}
  .wide{max-width:720px} .row-del input{width:130px;padding:6px} .row-del button{width:auto;margin:0 0 0 6px;padding:6px 10px;background:#b91c1c}
  td form{display:inline} td button{width:auto;margin:0;padding:6px 10px}`,
  page(step: Step): [string, string] {
    const wrap = (title: string, body: string, wide = false) =>
      [title, `<div class="brand">fugitive</div><div class="card${wide ? " wide" : ""}">${body}</div>`] as [string, string];
    switch (step.kind) {
      case "email":
        return wrap("Sign in", `<h1>Sign in to continue</h1>
          <p class="muted"><b>${h(CLIENTS[step.client].name)}</b> wants access to your repositories.</p>${err(step.error)}
          <form method="post" action="${u("/authorize")}">${hidden({ step: "email", client: step.client })}
          <label>Email</label><input type="email" name="email" required autofocus>
          <button>Send code</button></form>`);
      case "code":
        return wrap("Enter code", `<h1>${step.isNew ? "Create your account" : "Check your email"}</h1>
          <p class="muted">We sent a 6-digit code to ${h(step.email)} if it can be used here.</p>${note(step.notice)}${err(step.error)}
          <form method="post" action="${u("/authorize")}">${hidden({ step: "code", client: step.client, email: step.email })}
          <label>Code</label><input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus>
          ${step.isNew ? `<label>User name</label><input type="text" name="name" value="${h(step.name)}" required>
          <p class="muted">Your repositories will live at /@name/… — it can't be changed later.</p>` : ""}
          <button>Continue</button></form>
          <form method="post" action="${u("/authorize")}">${hidden({ step: "resend", client: step.client, email: step.email })}
          <button class="link">Send a new code</button></form>`);
      case "consent": {
        const c = CLIENTS[step.client];
        return wrap("Approve", `<h1>Allow ${h(c.name)}?</h1>
          <p class="muted">Signed in as ${h(users.get(step.email))}</p>
          <form method="post" action="${u("/authorize")}">${hidden({ step: "consent", client: step.client, email: step.email })}
          <p>It will be able to:</p><ul>${canList(c.requested ?? "write").map((x) => `<li>${x}</li>`).join("")}</ul>
          ${c.requested ? "" : `<label><input type="checkbox" name="readonly"> Allow read only</label>`}
          <button name="decision" value="approve">Approve</button>
          <button class="link" name="decision" value="deny">Deny</button></form>`);
      }
      case "done":
        return wrap("Paste this code", `<h1>Almost done</h1><p>Copy this code and paste it into your terminal.</p>
          <div class="code">${h(step.code)}</div><p class="muted">You can close this page afterwards.</p>`);
      case "denied":
        return wrap("Denied", `<h1>Access denied</h1><p>${h(CLIENTS[step.client].name)} did not get access. You can close this page.</p>`);
      case "settingsEmail":
        return wrap("Settings", `<h1>Settings</h1><p class="muted">Sign in to manage your tools and repositories.</p>${err(step.error)}
          <form method="post" action="${u("/settings")}">${hidden({ step: "email" })}
          <label>Email</label><input type="email" name="email" required autofocus><button>Send code</button></form>`);
      case "settingsCode":
        return wrap("Settings", `<h1>Check your email</h1>${note(step.notice)}${err(step.error)}
          <form method="post" action="${u("/settings")}">${hidden({ step: "code", email: step.email })}
          <label>Code</label><input type="text" name="code" inputmode="numeric" required autofocus><button>Continue</button></form>`);
      case "settings": {
        const mine = grants.filter((g) => g.email === step.email);
        const repos = repositories.get(step.email) ?? [];
        return wrap("Settings", `<h1>Settings — ${h(users.get(step.email))}</h1>${note(step.msg)}
          <h2>Tools</h2><table><tr><th>Tool</th><th>Access</th><th>Created</th><th>Last used</th><th></th></tr>
          ${mine.map((g) => `<tr><td>${h(g.client)}</td><td>${g.scope}</td><td>${g.created}</td><td>${g.lastUsed}</td>
            <td><form method="post" action="${u("/settings/revoke")}">${hidden({ grant: String(g.id) })}<button>Revoke</button></form></td></tr>`).join("")}</table>
          <h2>Repositories</h2><table><tr><th>Name</th><th>Created</th><th>Delete (type the name)</th></tr>
          ${repos.map((r) => `<tr><td>${h(r.name)}${r.empty ? ' <span class="muted">(empty)</span>' : ""}</td><td>${r.created}</td>
            <td class="row-del"><form method="post" action="${u("/settings/delete")}">${hidden({ repo: r.name })}
            <input name="confirm" placeholder="${h(r.name)}"><button>Delete</button></form></td></tr>`).join("")}</table>
          <form method="post" action="${u("/settings/signout")}"><button class="link">Sign out</button></form>`, true);
      }
      case "deleteConfirm":
        return A.page({ kind: "settings", email: step.email, tab: "repositories", msg: step.error });
    }
  },
};

// ===== Variant B: one page per task that grows as you go; top bar; settings as cards =====

const B = {
  css: `body{font:16px/1.55 Georgia,serif;margin:0;background:#fffdf8;color:#222}
  header{background:#1d3557;color:#fff;padding:12px 16px;font:600 15px system-ui,sans-serif;display:flex;justify-content:space-between}
  header a{color:#cfe3ff} main{max-width:640px;margin:0 auto;padding:24px 16px 120px}
  .panel{border-left:4px solid #1d3557;background:#eef3f9;padding:12px 16px;margin-bottom:24px;font-family:system-ui,sans-serif;font-size:15px}
  fieldset{border:0;border-top:1px solid #ddd;padding:16px 0;margin:0} legend{font:600 13px system-ui;text-transform:uppercase;color:#1d3557;letter-spacing:.06em}
  input[type=email],input[type=text]{font:inherit;padding:8px;border:1px solid #bbb;width:100%;box-sizing:border-box;max-width:360px}
  .locked{font-family:ui-monospace,monospace} button{font:600 15px system-ui;padding:10px 18px;background:#e63946;color:#fff;border:0;cursor:pointer}
  button.plain{background:none;color:#1d3557;text-decoration:underline;padding:0} .err{color:#b00020}.note{color:#1b7f3b}.muted{color:#666;font-size:14px}
  .cards{display:grid;gap:12px} .c{border:1px solid #ddd;padding:12px 16px;background:#fff;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}
  .c small{display:block;color:#666;font-family:system-ui} .big{font:36px ui-monospace,monospace;letter-spacing:.2em;margin:12px 0}
  pre{background:#111;color:#ddd;padding:12px;overflow:auto;font-size:13px} a.danger{color:#b00020}`,
  chrome(title: string, body: string, who?: string): [string, string] {
    return [title, `<header><span>fugitive</span>${who ? `<span>${h(who)} · <a href="${u("/settings")}">Settings</a></span>` : ""}</header><main>${body}</main>`];
  },
  auth(step: Step & { kind: "email" | "code" }): string {
    const c = CLIENTS[step.client];
    const scope = c.requested ?? "write";
    const email = step.kind === "code" ? step.email : undefined;
    return `<h1>Authorize ${h(c.name)}</h1>
      <div class="panel"><b>${h(c.name)}</b> is asking for ${scope === "read" ? "<b>read-only</b>" : "<b>read and write</b>"} access to your repositories.
      It can never delete repositories or revoke other tools.</div>${err(step.error)}${note(step.kind === "code" ? step.notice : undefined)}
      <form method="post" action="${u("/authorize")}">${hidden({ client: step.client, email })}
      <fieldset><legend>1 · Email</legend>${email
        ? `<span class="locked">${h(email)}</span> <button class="plain" name="step" value="restart" formnovalidate>change</button>`
        : `<input type="email" name="email" required autofocus> <button name="step" value="email">Send code</button>`}</fieldset>
      ${step.kind === "code" ? `
      <fieldset><legend>2 · Code from your email</legend><input type="text" name="code" inputmode="numeric" autofocus>
        <button class="plain" name="step" value="resend" formnovalidate>send a new code</button></fieldset>
      ${step.isNew ? `<fieldset><legend>3 · Pick a user name</legend><input type="text" name="name" value="${h(step.name)}">
        <p class="muted">Lowercase letters, digits, hyphens. Your URLs: /@name/repo.git. Can't be changed later.</p></fieldset>` : ""}
      <fieldset><legend>${step.isNew ? "4" : "3"} · Approve</legend>
        ${c.requested ? "" : `<label><input type="checkbox" name="readonly"> Read only (can't push)</label><br><br>`}
        <button name="step" value="code">${step.isNew ? "Create account and approve" : "Approve"}</button>
        <button class="plain" name="step" value="deny" formnovalidate>deny</button></fieldset>` : ""}
      </form>`;
  },
  page(step: Step): [string, string] {
    switch (step.kind) {
      case "email":
      case "code":
        return B.chrome("Authorize", B.auth(step));
      case "consent":
        return B.chrome("", "");
      case "done":
        return B.chrome("Paste this code", `<h1>Paste this code into your terminal</h1><div class="big">${h(step.code)}</div>
          <pre>$ git clone https://fugitive…/@yurenju/notes.git
Opening your browser… if nothing opens, visit:
  https://fugitive…/authorize?…
Paste the code from the browser: <b style="color:#fff">${h(step.code)}</b>▌</pre>
          <p class="muted">Your git command continues by itself after you paste.</p>`);
      case "denied":
        return B.chrome("Denied", `<h1>Not authorized</h1><p>${h(CLIENTS[step.client].name)} did not get access.</p>`);
      case "settingsEmail":
      case "settingsCode": {
        const email = step.kind === "settingsCode" ? step.email : undefined;
        return B.chrome("Settings", `<h1>Settings</h1><p class="muted">Enter the code we email you to manage tools and repositories.</p>
          ${err(step.error)}${note(step.kind === "settingsCode" ? step.notice : undefined)}
          <form method="post" action="${u("/settings")}">${hidden({ email })}
          <fieldset><legend>1 · Email</legend>${email ? `<span class="locked">${h(email)}</span>`
            : `<input type="email" name="email" required autofocus> <button name="step" value="email">Send code</button>`}</fieldset>
          ${email ? `<fieldset><legend>2 · Code</legend><input type="text" name="code" inputmode="numeric" autofocus> <button name="step" value="code">Open settings</button></fieldset>` : ""}
          </form>`);
      }
      case "settings": {
        const mine = grants.filter((g) => g.email === step.email);
        const repos = repositories.get(step.email) ?? [];
        return B.chrome("Settings", `<h1>Settings</h1>${note(step.msg)}
          <h2>Tools with access</h2><div class="cards">${mine.map((g) => `<div class="c"><div><b>${h(g.client)}</b>
            <small>${g.scope === "read" ? "Read only" : "Read and write"} · since ${g.created} · last used ${g.lastUsed}</small></div>
            <form method="post" action="${u("/settings/revoke")}">${hidden({ grant: String(g.id) })}<button>Revoke</button></form></div>`).join("") || "<p>No tools.</p>"}</div>
          <h2>Repositories</h2><div class="cards">${repos.map((r) => `<div class="c"><div><b>${h(r.name)}</b>
            <small>created ${r.created}${r.empty ? " · empty (a push failed or never finished)" : ""}</small></div>
            <a class="danger" href="${u(`/settings/repositories/${r.name}/delete`)}">Delete…</a></div>`).join("") || "<p>No repositories.</p>"}</div>
          <form method="post" action="${u("/settings/signout")}"><br><button class="plain">Sign out</button></form>`, users.get(step.email));
      }
      case "deleteConfirm":
        return B.chrome("Delete", `<p><a href="${u("/settings")}">← Settings</a></p><h1>Delete ${h(step.repo)}?</h1>
          <div class="panel" style="border-color:#e63946;background:#fdecee">This deletes <b>@${h(users.get(step.email))}/${h(step.repo)}</b> and all its history.
          It cannot be undone. The name can be used again afterwards.</div>${err(step.error)}
          <form method="post" action="${u("/settings/delete")}">${hidden({ repo: step.repo })}
          <p>Type <b>${h(step.repo)}</b> to confirm:</p><input type="text" name="confirm" autofocus> <button>Delete forever</button></form>`, users.get(step.email));
    }
  },
};

// ===== Variant C: split screen — who is asking on the left, form on the right; settings in tabs =====

const C = {
  css: `body{margin:0;font:15px/1.5 "Inter",system-ui,sans-serif;color:#0f172a;background:#fff}
  .split{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);min-height:100vh}
  .left{background:#0f172a;color:#e2e8f0;padding:48px 32px} .left h2{color:#fff;font-size:26px;margin:.2em 0}
  .left .tag{display:inline-block;padding:2px 8px;border:1px solid #475569;border-radius:99px;font-size:12px;color:#94a3b8}
  .yes li::marker{content:"✓  ";color:#4ade80}.no li::marker{content:"✕  ";color:#f87171}.no{color:#94a3b8}
  .right{padding:48px 32px;max-width:440px} h1{font-size:22px;margin-top:0}
  label{display:block;font-size:13px;font-weight:600;margin:14px 0 4px}
  input[type=email],input[type=text]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:6px;font:inherit}
  input.otp{font:24px ui-monospace,monospace;letter-spacing:.5em;text-align:center}
  button{margin-top:18px;padding:10px 16px;border-radius:6px;border:1px solid #0f172a;background:#0f172a;color:#fff;font:inherit;cursor:pointer}
  button.ghost{background:#fff;color:#0f172a} button.red{background:#dc2626;border-color:#dc2626}
  .err{color:#dc2626}.note{color:#16a34a}.muted{color:#64748b;font-size:13px}
  .steps{display:flex;gap:6px;margin-bottom:24px}.steps span{flex:1;height:4px;border-radius:2px;background:#e2e8f0}.steps .on{background:#0f172a}
  .top{display:flex;justify-content:space-between;align-items:center;padding:14px 24px;border-bottom:1px solid #e2e8f0}
  .tabs{display:flex;gap:4px;padding:0 24px;border-bottom:1px solid #e2e8f0}.tabs a{padding:12px 14px;color:#64748b;text-decoration:none;border-bottom:2px solid transparent}
  .tabs a.on{color:#0f172a;border-color:#0f172a;font-weight:600} .body{padding:24px;max-width:760px}
  .item{border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin-bottom:10px}
  .item .head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
  .item button{margin:0} details summary{cursor:pointer;color:#dc2626;font-size:13px;margin-top:8px}
  .codebox{font:34px ui-monospace,monospace;letter-spacing:.25em;border:2px dashed #cbd5e1;border-radius:8px;padding:18px;text-align:center}
  @media (max-width:720px){.split{grid-template-columns:1fr}.left{padding:24px 16px}.right{padding:24px 16px}}`,
  split(title: string, client: string | undefined, active: number, body: string): [string, string] {
    const c = client ? CLIENTS[client] : undefined;
    const scope = c?.requested ?? "write";
    const left = c
      ? `<span class="tag">wants access</span><h2>${h(c.name)}</h2>
         <p>If you approve, it can:</p><ul class="yes">${canList(scope).map((x) => `<li>${x}</li>`).join("")}</ul>
         <p>It can never:</p><ul class="no">${cannot.map((x) => `<li>${x}</li>`).join("")}</ul>
         <p style="color:#94a3b8;font-size:13px">Access ends if unused for 90 days, or when you revoke it in Settings.</p>`
      : `<span class="tag">fugitive</span><h2>Settings</h2><p>Manage the tools that can reach your repositories, and delete repositories.</p>`;
    const bars = [1, 2, 3].map((i) => `<span class="${i <= active ? "on" : ""}"></span>`).join("");
    return [title, `<div class="split"><div class="left">${left}</div><div class="right"><div class="steps">${bars}</div>${body}</div></div>`];
  },
  page(step: Step): [string, string] {
    switch (step.kind) {
      case "email":
        return C.split("Sign in", step.client, 1, `<h1>Continue with email</h1>${err(step.error)}
          <form method="post" action="${u("/authorize")}">${hidden({ step: "email", client: step.client })}
          <label>Email</label><input type="email" name="email" required autofocus><button>Email me a code</button></form>
          <p class="muted">New here? If your email is on the list, you'll create an account in the next step.</p>`);
      case "code": {
        const c = CLIENTS[step.client];
        return C.split("Enter code", step.client, 2, `<h1>${step.isNew ? "Welcome — create your account" : "Enter your code"}</h1>
          <p class="muted">Sent to ${h(step.email)} · valid for 10 minutes</p>${note(step.notice)}${err(step.error)}
          <form method="post" action="${u("/authorize")}">${hidden({ step: "code", client: step.client, email: step.email })}
          <label>6-digit code</label><input class="otp" type="text" name="code" maxlength="6" inputmode="numeric" autocomplete="one-time-code" required autofocus>
          ${step.isNew ? `<label>User name</label><input type="text" name="name" value="${h(step.name)}" required>
            <p class="muted">Permanent. Appears in your URLs: /@<i>name</i>/repo.git</p>` : ""}
          ${c.requested ? "" : `<label style="font-weight:400"><input type="checkbox" name="readonly"> Limit to read only</label>`}
          <button>${step.isNew ? "Create account & approve" : "Approve"}</button>
          <button class="ghost" name="step" value="deny" formnovalidate>Deny</button></form>
          <form method="post" action="${u("/authorize")}">${hidden({ step: "resend", client: step.client, email: step.email })}
          <button class="ghost" style="border:0;padding:0;text-decoration:underline">Send a new code</button></form>`);
      }
      case "consent":
        return C.split("", undefined, 0, "");
      case "done":
        return C.split("Paste this code", "git", 3, `<h1>Last step: back to your terminal</h1>
          <ol><li>Copy the code below</li><li>Paste it where git is waiting</li><li>Close this tab</li></ol>
          <div class="codebox">${h(step.code)}</div>`);
      case "denied":
        return C.split("Denied", step.client, 3, `<h1>Access denied</h1><p>Nothing was shared. You can close this tab.</p>`);
      case "settingsEmail":
        return C.split("Settings", undefined, 1, `<h1>Sign in to Settings</h1>${err(step.error)}
          <form method="post" action="${u("/settings")}">${hidden({ step: "email" })}
          <label>Email</label><input type="email" name="email" required autofocus><button>Email me a code</button></form>`);
      case "settingsCode":
        return C.split("Settings", undefined, 2, `<h1>Enter your code</h1><p class="muted">Sent to ${h(step.email)}</p>${note(step.notice)}${err(step.error)}
          <form method="post" action="${u("/settings")}">${hidden({ step: "code", email: step.email })}
          <label>6-digit code</label><input class="otp" type="text" name="code" maxlength="6" inputmode="numeric" required autofocus><button>Open settings</button></form>`);
      case "settings": {
        const mine = grants.filter((g) => g.email === step.email);
        const repos = repositories.get(step.email) ?? [];
        const tab = (t: string, label: string, n: number) =>
          `<a class="${step.tab === t ? "on" : ""}" href="${u(`/settings/${t}`)}">${label} (${n})</a>`;
        const list = step.tab === "tools"
          ? mine.map((g) => `<div class="item"><div class="head"><div><b>${h(g.client)}</b><div class="muted">
              ${g.scope === "read" ? "Read only" : "Read & write"} · approved ${g.created} · last used ${g.lastUsed}</div></div>
              <form method="post" action="${u("/settings/revoke")}">${hidden({ grant: String(g.id) })}<button class="ghost">Revoke</button></form></div></div>`).join("")
          : repos.map((r) => `<div class="item"><div class="head"><div><b>@${h(users.get(step.email))}/${h(r.name)}</b>
              <div class="muted">created ${r.created}${r.empty ? " · empty" : ""}</div></div></div>
              <details><summary>Delete this repository…</summary><form method="post" action="${u("/settings/delete")}">${hidden({ repo: r.name })}
              <p class="muted">Permanent. Type <b>${h(r.name)}</b> to confirm.</p><input type="text" name="confirm"><button class="red">Delete</button></form></details></div>`).join("");
        return ["Settings", `<div class="top"><b>fugitive</b><span>${h(users.get(step.email))} ·
          <form method="post" action="${u("/settings/signout")}" style="display:inline"><button class="ghost" style="margin:0;padding:4px 10px">Sign out</button></form></span></div>
          <nav class="tabs">${tab("tools", "Tools", mine.length)}${tab("repositories", "Repositories", repos.length)}</nav>
          <div class="body">${note(step.msg)}${list || '<p class="muted">Nothing here.</p>'}</div>`];
      }
      case "deleteConfirm":
        return C.page({ kind: "settings", email: step.email, tab: "repositories", msg: step.error });
    }
  },
};

const RENDER = { A, B, C };

// ---------- prototype chrome: switcher bar, state panel, landing page ----------

function frame(title: string, css: string, body: string, url: URL): Response {
  const order = Object.keys(VARIANTS) as Variant[];
  const i = order.indexOf(V);
  const at = (d: number) => { const n = new URL(url); n.searchParams.set("variant", order[(i + d + order.length) % order.length]); return n.pathname + n.search; };
  const latest = outbox[0];
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} · fugitive (prototype ${V})</title><style>${css}
#proto-bar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99;display:flex;align-items:center;gap:10px;
 background:#ff0;color:#000;border:2px solid #000;border-radius:99px;padding:6px 10px;font:600 13px system-ui;box-shadow:0 4px 16px #0005}
#proto-bar a{color:#000;text-decoration:none;font-size:18px;padding:0 6px}
#proto-inbox{position:fixed;top:8px;right:8px;z-index:99;background:#ff0;color:#000;border:2px solid #000;border-radius:8px;padding:6px 10px;font:12px ui-monospace,monospace;max-width:60vw}
#proto-state{position:fixed;left:8px;bottom:70px;z-index:99;background:#fffbe0;color:#000;border:2px solid #000;border-radius:8px;font:11px/1.4 ui-monospace,monospace;max-width:min(420px,90vw);max-height:50vh;overflow:auto}
#proto-state summary{padding:4px 8px;cursor:pointer;font-weight:700} #proto-state pre{margin:0;padding:0 8px 8px;white-space:pre-wrap}
</style></head><body>${body}
<div id="proto-inbox">📬 fake inbox: ${latest ? `<b>${latest.code}</b> → ${h(latest.to)} (${latest.at})` : "empty"} · <a href="/?variant=${V}">scenarios</a></div>
<details id="proto-state"><summary>prototype state</summary><pre>${h(JSON.stringify({
    users: Object.fromEntries(users), allowlist: [...allowlist],
    grants: grants.map((g) => `${g.id} ${users.get(g.email)} · ${g.client} · ${g.scope}`),
    repositories: Object.fromEntries([...repositories].map(([e, r]) => [users.get(e), r.map((x) => x.name)])),
    pendingCodes: Object.fromEntries([...codes].map(([e, c]) => [e, `${c.code} (${c.tries} wrong)`])),
  }, null, 1))}</pre></details>
<nav id="proto-bar"><a href="${at(-1)}" id="proto-prev">‹</a><span>${V} — ${VARIANTS[V]}</span><a href="${at(1)}" id="proto-next">›</a></nav>
<script>addEventListener("keydown",e=>{if(e.target.closest("input,textarea,[contenteditable]"))return;
if(e.key==="ArrowLeft")location=document.getElementById("proto-prev").href;if(e.key==="ArrowRight")location=document.getElementById("proto-next").href})</script>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function landing(url: URL): Response {
  const body = `<main style="max-width:680px;margin:0 auto;padding:32px 16px 120px;font:16px/1.6 system-ui">
  <h1>PROTOTYPE — account pages</h1>
  <p>Throwaway prototype for spec #24. Flip variants with the yellow bar (or ← →). Nothing is real: codes appear in the yellow fake inbox, top right.</p>
  <h2>Test emails</h2><ul>
   <li><code>yurenju@example.com</code> — existing user (has tools and repositories)</li>
   <li><code>new@example.com</code> — on the allowlist, not registered yet (sees the user name field)</li>
   <li><code>stranger@example.com</code> — not on the allowlist (no code is ever sent)</li></ul>
  <h2>Start a scenario</h2>
  <p><b>1. git on a new machine (manual paste)</b></p>
  <pre style="background:#111;color:#ddd;padding:12px;overflow:auto">$ git clone https://fugitive…/@yurenju/notes.git
Opening your browser… if nothing opens, visit:
  <a style="color:#8cf" href="${u("/authorize", { client: "git" })}">https://fugitive…/authorize?client_id=…</a>
Paste the code from the browser: ▌</pre>
  <p><b>2. Claude (MCP client, redirects back automatically)</b> — <a href="${u("/authorize", { client: "claude" })}">open the Authorization Page</a></p>
  <p><b>3. A tool that only asks for read access</b> — <a href="${u("/authorize", { client: "reader" })}">open the Authorization Page</a></p>
  <p><b>4. Settings Page</b> — <a href="${u("/settings")}">open Settings</a></p>
  <p style="color:#666">Variant A shows approval as its own page after the code (the spec puts it on the code page) — that's one of the things to judge.</p></main>`;
  return frame("Scenarios", "", body, url);
}

// ---------- routes (shared by all variants; only rendering differs) ----------

function sessionOf(req: Request): string | undefined {
  const m = /(?:^|;\s*)proto_session=([^;]+)/.exec(req.headers.get("Cookie") ?? "");
  const email = m ? decodeURIComponent(m[1]) : undefined;
  return email && users.has(email) ? email : undefined;
}

function complete(client: string, email: string, readonly: boolean): Response {
  grants.push({ id: nextGrant++, email, client: CLIENTS[client].name, scope: scopeOf(client, readonly), created: today(), lastUsed: today() });
  if (CLIENTS[client].manual) return redirect(u("/authorize/done", { code: `fgc_${crypto.randomUUID().slice(0, 13)}` }));
  return redirect(u("/prototype/returned", { client }));
}

async function handle(req: Request, url: URL): Promise<Response | Step> {
  const path = url.pathname;
  const form = req.method === "POST" ? await req.formData() : new FormData();
  const f = (k: string) => String(form.get(k) ?? "").trim();

  if (path === "/authorize") {
    const client = f("client") || url.searchParams.get("client") || "git";
    const email = f("email").toLowerCase();
    const isNew = !users.has(email) && allowlist.has(email);
    switch (req.method === "POST" ? f("step") : "") {
      case "email": {
        const wait = sendCode(email);
        return { kind: "code", client, email, isNew, error: wait };
      }
      case "resend": {
        const wait = sendCode(email);
        return { kind: "code", client, email, isNew, error: wait, notice: wait ? undefined : "A new code is on its way." };
      }
      case "restart":
        return { kind: "email", client };
      case "deny":
        return { kind: "denied", client };
      case "code": {
        const bad = checkCode(email, f("code"));
        if (bad) return { kind: "code", client, email, isNew, error: bad, name: f("name") };
        if (isNew) {
          const badName = checkName(f("name"));
          if (badName) return { kind: "code", client, email, isNew, error: badName, name: f("name") };
          users.set(email, f("name"));
        }
        codes.delete(email);
        if (V === "A") return { kind: "consent", client, email };
        return complete(client, email, form.has("readonly"));
      }
      case "consent":
        if (f("decision") === "deny") return { kind: "denied", client };
        return complete(client, email, form.has("readonly"));
      default:
        return { kind: "email", client };
    }
  }
  if (path === "/authorize/done") return { kind: "done", code: url.searchParams.get("code") ?? "" };

  // Settings
  const who = sessionOf(req);
  if (path === "/settings" && req.method === "POST") {
    const email = f("email").toLowerCase();
    if (f("step") === "email") {
      const wait = users.has(email) ? sendCode(email) : undefined;
      return { kind: "settingsCode", email, error: wait };
    }
    const bad = users.has(email) ? checkCode(email, f("code")) : "Incorrect code.";
    if (bad) return { kind: "settingsCode", email, error: bad };
    codes.delete(email);
    return redirect(u(V === "C" ? "/settings/tools" : "/settings"), `proto_session=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800`);
  }
  if (path.startsWith("/settings") && !who) return { kind: "settingsEmail" };
  if (!who) return new Response("not found", { status: 404 });
  if (path === "/settings") return V === "C" ? redirect(u("/settings/tools")) : { kind: "settings", email: who, tab: "tools", msg: url.searchParams.get("msg") ?? undefined };
  if (path === "/settings/tools" || path === "/settings/repositories")
    return { kind: "settings", email: who, tab: path.endsWith("tools") ? "tools" : "repositories", msg: url.searchParams.get("msg") ?? undefined };
  const del = /^\/settings\/repositories\/([^/]+)\/delete$/.exec(path);
  if (del) return { kind: "deleteConfirm", email: who, repo: decodeURIComponent(del[1]) };
  if (path === "/settings/revoke" && req.method === "POST") {
    const i = grants.findIndex((g) => g.id === Number(f("grant")) && g.email === who);
    const name = i >= 0 ? grants.splice(i, 1)[0].client : "";
    return redirect(u(V === "C" ? "/settings/tools" : "/settings", { msg: `Revoked ${name}. It stops working within a minute.` }));
  }
  if (path === "/settings/delete" && req.method === "POST") {
    const repo = f("repo");
    if (f("confirm") !== repo) {
      const error = `Type "${repo}" exactly to delete it.`;
      return { kind: "deleteConfirm", email: who, repo, error };
    }
    const list = repositories.get(who) ?? [];
    repositories.set(who, list.filter((r) => r.name !== repo));
    return redirect(u(V === "C" ? "/settings/repositories" : "/settings", { msg: `Deleted ${repo}. The name is free to use again.` }));
  }
  if (path === "/settings/signout" && req.method === "POST") return redirect(u("/settings"), "proto_session=; Path=/; Max-Age=0");
  return new Response("not found", { status: 404 });
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const v = url.searchParams.get("variant");
    V = v === "B" || v === "C" ? v : "A";
    if (url.pathname === "/") return landing(url);
    if (url.pathname === "/prototype/returned") {
      const c = CLIENTS[url.searchParams.get("client") ?? ""]?.name ?? "The tool";
      return frame("Returned", "", `<main style="max-width:560px;margin:80px auto;padding:0 16px;font:16px/1.6 system-ui">
        <h1>↩︎ Back in ${h(c)}</h1><p>(Prototype stand-in) The browser was redirected to ${h(c)} with an authorization code; the tool takes over from here.</p>
        <p><a href="/?variant=${V}">Back to scenarios</a></p></main>`, url);
    }
    const out = await handle(req, url);
    if (out instanceof Response) return out;
    const r = RENDER[V];
    const [title, body] = r.page(out);
    return frame(title, r.css, body, url);
  },
};
