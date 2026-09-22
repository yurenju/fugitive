// The Authorization Page: one question per page (email → code, and a name for new Users → approve), all at
// /authorize. The OAuth request rides along in the form action's query string and is re-validated on every POST.
import { AuthorizationError, type AuthRequest, type ClientInfo } from "@cloudflare/workers-oauth-provider";
import { sendCode } from "./email";
import { codeForm, emailForm, esc, hidden, page } from "./pages";
import { sign, verify } from "./signing";
import type { Redeemed, User } from "./users";

export const TICKET_TTL_SECONDS = 600;

/** What the grant carries back on every token (ADR 0007). `lastUsedAt` is Unix seconds. */
export interface Props {
  userId: string;
  userName: string;
  lastUsedAt: number;
}

/** Proof, on the approve page, that this person just passed the code page for this very OAuth request. */
interface Ticket {
  user: User;
  request: string;
}

type Scope = ["read"] | ["read", "write"];

const now = () => Math.floor(Date.now() / 1000);

export function users(env: Pick<Env, "USERS">) {
  return env.USERS.getByName("global");
}

function clientName(client: ClientInfo): string {
  return client.clientName || "An unnamed tool";
}

/** A tool that asks for nothing gets write; one that asks only for read gets only read (ADR 0007). */
function offersWrite(request: AuthRequest): boolean {
  return request.scope.length === 0 || request.scope.includes("write");
}

export function codeError(r: Exclude<Redeemed, { ok: true }>): string {
  switch (r.reason) {
    case "wrong":
      return `That code is not right. ${r.remaining} ${r.remaining === 1 ? "try" : "tries"} left.`;
    case "too-many":
      return "Too many wrong codes. Ask for a new code.";
    case "no-code":
      return "This code has expired or was already used. Ask for a new code.";
    case "needs-name":
      return "Choose a user name to create your account.";
    case "name-invalid":
      return r.detail;
    case "name-taken":
      return "That name is taken. Choose another.";
  }
}

/** Ask for a code and mail it. Returns an error message for the page, if any. */
export async function mailCode(env: Env, email: string): Promise<{ askName: boolean; error?: string; notice?: string }> {
  const r = await users(env).requestCode(email, now());
  if (r.tooSoon) return { askName: r.askName, notice: "A code was sent less than a minute ago. Wait before asking for another." };
  if (r.code && !(await sendCode(env, email.trim().toLowerCase(), r.code))) {
    return { askName: r.askName, error: "We could not send the email. Please try again later." };
  }
  return { askName: r.askName };
}

export async function authorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const show = (title: string, body: string, status = 200) => page(title, body, { host: url.host, status });
  if (request.method !== "GET" && request.method !== "POST") return new Response("method not allowed\n", { status: 405 });

  let oauth: AuthRequest;
  let client: ClientInfo | null;
  try {
    oauth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    client = await env.OAUTH_PROVIDER.lookupClient(oauth.clientId);
  } catch (e) {
    if (!(e instanceof AuthorizationError)) throw e;
    if (e.redirectUri) return denyRedirect(e.redirectUri, e.code, e.state);
    return show("Invalid request", `<h1>Invalid request</h1><p>${esc(e.description)}</p>`, 400);
  }
  if (!client) return show("Invalid request", "<h1>Invalid request</h1><p>Unknown client.</p>", 400);

  const name = clientName(client);
  const action = `/authorize${url.search}`;
  const signIn = (error?: string) =>
    show(
      "Sign in",
      emailForm({ action, heading: "Sign in to continue", intro: `${name} wants access to your repositories.`, error }),
    );
  if (request.method === "GET") return signIn();

  const form = await request.formData();
  const field = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : "");
  const email = field("email");

  switch (field("step")) {
    case "email": {
      if (!email.includes("@")) return signIn("Enter your email address.");
      const sent = await mailCode(env, email);
      if (sent.error) return signIn(sent.error);
      return show("Enter your code", codeForm({ action, email, ...sent }));
    }
    case "code": {
      const askName = form.has("name");
      const r = await users(env).redeemCode(email, field("code"), now(), askName ? field("name").trim() : undefined);
      if (!r.ok) {
        const again = codeForm({ action, email, askName: askName || r.reason === "needs-name", name: field("name"), error: codeError(r) });
        return show("Enter your code", again);
      }
      const ticket = await sign(env.SESSION_SECRET, { user: r.user, request: JSON.stringify(oauth) } satisfies Ticket, now() + TICKET_TTL_SECONDS);
      return show(`Allow ${name}?`, approveForm(action, name, r.user, offersWrite(oauth), ticket));
    }
    case "approve": {
      const ticket = await verify<Ticket>(env.SESSION_SECRET, field("ticket"), now());
      // The ticket must be for this exact request: another client, redirect URI, scope or state starts over.
      if (!ticket || ticket.request !== JSON.stringify(oauth)) return signIn("Your sign-in expired. Please start again.");
      if (field("decision") !== "approve") return denyRedirect(oauth.redirectUri, "access_denied", oauth.state);
      const scope: Scope = offersWrite(oauth) && !form.has("read_only") ? ["read", "write"] : ["read"];
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauth,
        userId: ticket.user.id,
        scope,
        props: { userId: ticket.user.id, userName: ticket.user.name, lastUsedAt: now() } satisfies Props,
        metadata: { clientName: name },
        revokeExistingGrants: false,
      });
      return Response.redirect(redirectTo, 302);
    }
    default:
      return signIn();
  }
}

function approveForm(action: string, clientName: string, user: User, write: boolean, ticket: string): string {
  const can = write
    ? "<li>Clone and fetch your repositories</li><li>Push, and create repositories by pushing</li>"
    : "<li>Clone and fetch your repositories</li>";
  const readOnly = write
    ? `<label class="check"><input type="checkbox" name="read_only" value="1"> Allow read only</label>`
    : "";
  return `<h1>Allow ${esc(clientName)}?</h1>
<p class="muted">Signed in as ${esc(user.name)}</p>
<p>It will be able to:</p>
<ul>${can}</ul>
<form method="post" action="${esc(action)}">
${hidden("step", "approve")}${hidden("ticket", ticket)}
${readOnly}
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny" class="secondary">Deny</button>
</form>`;
}

function denyRedirect(redirectUri: string, error: string, state?: string): Response {
  const to = new URL(redirectUri);
  to.searchParams.set("error", error);
  if (state) to.searchParams.set("state", state);
  return Response.redirect(to.toString(), 302);
}

/** /authorize/done: where the helper's manual paste flow lands. It shows the code to paste back, nothing more. */
export function authorizeDone(request: Request): Response {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const opts = { host: url.host };
  if (url.searchParams.has("error") || !code) {
    return page("Access denied", "<h1>Access denied</h1><p>Nothing was shared. You can close this page.</p>", opts);
  }
  return page(
    "Almost done",
    `<h1>Almost done</h1>
<p>Copy this code and paste it back into your terminal.</p>
<div class="code">${esc(code)}</div>
<p class="muted">Once it is pasted, you can close this page.</p>`,
    opts,
  );
}
