// The Settings Page (ADR 0007): one page, /settings, listing the User's tools and Repositories. Revoking a tool and
// deleting a Repository happen only here. Changes are POSTs guarded by a SameSite=Strict cookie.
import { codeError, formField, mailCode, now, users } from "./sign-in";
import { repositoryObject } from "./repository";
import { codeForm, emailForm, error, esc, hidden, page } from "./pages";
import { sign, verify } from "./signing";

export const SESSION_TTL_SECONDS = 30 * 60;
const COOKIE = "fugitive_settings";

function cookie(value: string, maxAge: number): string {
  return `${COOKIE}=${value}; Max-Age=${maxAge}; Path=/settings; HttpOnly; Secure; SameSite=Strict`;
}

async function signedInUser(request: Request, env: Env): Promise<string | null> {
  const value = /(?:^|;\s*)fugitive_settings=([^;]+)/.exec(request.headers.get("Cookie") ?? "")?.[1];
  return (await verify<{ userId: string }>(env.SESSION_SECRET, value, now()))?.userId ?? null;
}

function seeOther(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...headers } });
}

function done(kind: string, what: string): Response {
  return seeOther(`/settings?${new URLSearchParams({ done: kind, what })}`);
}

// Day only: "last used" is only as fresh as the last refresh, about an hour; the full time is in the tooltip.
const date = (seconds: number) => {
  const iso = new Date(seconds * 1000).toISOString();
  return `<time datetime="${iso}" title="${iso.slice(0, 16).replace("T", " ")} UTC">${iso.slice(0, 10)}</time>`;
};

export async function settings(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const show = (title: string, body: string, headers?: HeadersInit, wide = false) =>
    page(title, body, { host: url.host, headers, wide });
  const userId = await signedInUser(request, env);
  const signIn = (error?: string) =>
    show("Settings", emailForm({ action: "/settings", heading: "Settings", intro: "Sign in with your email to manage your tools and repositories.", error }));

  if (url.pathname === "/settings" && request.method === "GET") {
    return userId ? signedInPage(env, userId, url, show) : signIn();
  }
  if (request.method !== "POST") return new Response("method not allowed\n", { status: 405 });
  const form = await request.formData();
  const field = formField(form);

  if (url.pathname === "/settings") {
    const email = field("email");
    if (field("step") === "code") {
      const r = await users(env).redeemCode(email, field("code"), now());
      if (!r.ok) {
        // Not a User: the Settings Page has no name field, so this is as good as no code.
        const message = codeError(r.reason === "needs-name" ? { ok: false, reason: "no-code" } : r);
        return show("Settings", codeForm({ action: "/settings", email, askName: false, error: message }));
      }
      const value = await sign(env.SESSION_SECRET, { userId: r.user.id }, now() + SESSION_TTL_SECONDS);
      return seeOther("/settings", { "Set-Cookie": cookie(value, SESSION_TTL_SECONDS) });
    }
    if (!email.includes("@")) return signIn("Enter your email address.");
    const sent = await mailCode(env, email);
    if (sent.error) return signIn(sent.error);
    return show("Settings", codeForm({ action: "/settings", email, askName: false }));
  }
  if (url.pathname === "/settings/signout") return seeOther("/settings", { "Set-Cookie": cookie("", 0) });
  if (!userId) return seeOther("/settings");

  if (url.pathname === "/settings/revoke") {
    const grantId = field("grant");
    const grants = (await env.OAUTH_PROVIDER.listUserGrants(userId)).items;
    const grant = grants.find((g) => g.id === grantId);
    if (!grant) return seeOther("/settings");
    await env.OAUTH_PROVIDER.revokeGrant(grant.id, userId);
    return done("revoked", grant.metadata?.clientName ?? "the tool");
  }
  if (url.pathname === "/settings/delete") {
    const name = field("repository");
    if (field("confirm") !== name) return done("mismatch", name);
    const id = await users(env).deleteRepository(userId, name);
    if (id) await repositoryObject(env, id).destroy();
    return done("deleted", name);
  }
  return new Response("not found\n", { status: 404 });
}

async function signedInPage(
  env: Env,
  userId: string,
  url: URL,
  show: (title: string, body: string, headers?: HeadersInit, wide?: boolean) => Response,
): Promise<Response> {
  const directory = users(env);
  const user = await directory.getUser(userId);
  if (!user) return seeOther("/settings", { "Set-Cookie": cookie("", 0) });

  // ponytail: first page of grants only (the package's default page size); add paging when someone has that many tools.
  const grants = (await env.OAUTH_PROVIDER.listUserGrants(userId)).items.sort((a, b) => b.createdAt - a.createdAt);
  const uses = await directory.grantUses(grants.map((g) => g.id));
  const repositories = await directory.listRepositories(userId);
  const empty = await Promise.all(
    repositories.map((r) => repositoryObject(env, r.id).isEmpty()),
  );

  const what = url.searchParams.get("what") ?? "";
  const messages: Record<string, string> = {
    revoked: `Revoked ${what}. It stops working within a minute.`,
    deleted: `Deleted ${what}. The name is free to use again.`,
  };
  const kind = url.searchParams.get("done") ?? "";
  const banner =
    kind === "mismatch"
      ? error(`Type ${what} exactly to delete it.`)
      : messages[kind]
        ? `<p class="notice" role="status">${esc(messages[kind])}</p>`
        : "";

  const toolRows = grants
    .map(
      (g) => `<tr><td>${esc(g.metadata?.clientName ?? g.clientId)}</td><td>${g.scope.includes("write") ? "write" : "read"}</td>
<td class="wide-only">${date(g.createdAt)}</td><td>${date(uses[g.id] ?? g.createdAt)}</td>
<td><form method="post" action="/settings/revoke">${hidden("grant", g.id)}<button type="submit" class="secondary">Revoke</button></form></td></tr>`,
    )
    .join("\n");
  const repositoryRows = repositories
    .map(
      (r, i) => `<tr><td>${esc(r.name)}${empty[i] ? ' <span class="muted">(empty)</span>' : ""}</td><td class="wide-only">${date(r.createdAt)}</td>
<td><form method="post" action="/settings/delete">${hidden("repository", r.name)}
<input type="text" name="confirm" placeholder="${esc(r.name)}" aria-label="Type ${esc(r.name)} to delete it" autocomplete="off" required>
<button type="submit" class="danger">Delete</button></form></td></tr>`,
    )
    .join("\n");

  return show(
    "Settings",
    `<h1>Settings — ${esc(user.name)}</h1>
${banner}
<h2>Tools</h2>
${
  grants.length
    ? `<div class="table"><table><thead><tr><th>Tool</th><th>Scope</th><th class="wide-only">Created</th><th>Last used</th><th></th></tr></thead>
<tbody>${toolRows}</tbody></table></div>`
    : `<p class="muted">No tools yet.</p>`
}
<h2>Repositories</h2>
${
  repositories.length
    ? `<div class="table"><table><thead><tr><th>Name</th><th class="wide-only">Created</th><th>Delete (type the name)</th></tr></thead>
<tbody>${repositoryRows}</tbody></table></div>
<p class="muted">Deleting a repository cannot be undone.</p>`
    : `<p class="muted">No repositories yet. Push to /@${esc(user.name)}/&lt;name&gt;.git to create one.</p>`
}
<form method="post" action="/settings/signout"><button type="submit" class="link">Sign out</button></form>`,
    undefined,
    true,
  );
}
