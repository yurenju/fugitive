// Shared by the HTTP tests: a stand-in for Resend, and the whole OAuth flow a tool goes through to get a token.
import { exports } from "cloudflare:workers";
import { expect, vi } from "vitest";

export const ORIGIN = "https://fugitive.test";

export interface Mail {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

/** Everything the Worker sent to Resend; set `resend.fail` to make Resend answer with an error. */
export const resend = { mail: [] as Mail[], fail: false };
const realFetch = globalThis.fetch;
vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const request = new Request(input, init);
  if (!request.url.startsWith("https://resend.test/")) return realFetch(input, init);
  expect(request.url).toBe("https://resend.test/emails");
  expect(request.headers.get("Authorization")).toBe("Bearer test-key");
  if (resend.fail) return Response.json({ message: "domain not verified" }, { status: 403 });
  resend.mail.push(await request.json());
  return Response.json({ id: "email-id" });
});

export function mailTo(email: string): Mail[] {
  return resend.mail.filter((m) => m.to[0] === email.toLowerCase());
}

export function lastCode(email: string): string {
  const mail = mailTo(email).at(-1);
  if (!mail) throw new Error(`no mail to ${email}`);
  return /\b(\d{6})\b/.exec(mail.subject)![1];
}

export function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(new URL(path, ORIGIN), { redirect: "manual", ...init }));
}

export function post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return call(path, { method: "POST", body: new URLSearchParams(fields), headers });
}

/** Allowlisted addresses are u0@example.com … u59@example.com; each test file takes its own range. */
export function emails(start: number) {
  let n = start;
  return () => `u${n++}@example.com`;
}

let names = 0;
export const freshName = (prefix = "user") => `${prefix}${++names}`;

export interface Client {
  id: string;
  redirect: string;
}

export async function registerClient(name = "test tool", redirect = "https://tool.test/callback"): Promise<Client> {
  const res = await call("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
  });
  expect(res.status).toBe(201);
  return { id: ((await res.json()) as { client_id: string }).client_id, redirect };
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface Authorization {
  client: Client;
  verifier: string;
  /** `/authorize?...` */
  path: string;
}

export async function authorization(client: Client, opts: { scope?: string; state?: string } = {}): Promise<Authorization> {
  const verifier = `verifier-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.id,
    redirect_uri: client.redirect,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    state: opts.state ?? "some-state",
  });
  if (opts.scope !== undefined) params.set("scope", opts.scope);
  return { client, verifier, path: `/authorize?${params}` };
}

export function ticketIn(html: string): string {
  const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1];
  if (!ticket) throw new Error(`no approval ticket in:\n${html}`);
  return ticket;
}

/** Email page → code page → approve page. Returns the approve page's HTML. */
export async function throughCode(a: Authorization, email: string, name?: string): Promise<string> {
  expect((await call(a.path)).status).toBe(200);
  const codePage = await post(a.path, { step: "email", email });
  expect(codePage.status).toBe(200);
  const fields: Record<string, string> = { step: "code", email, code: lastCode(email) };
  if (name !== undefined) fields.name = name;
  const approvePage = await (await post(a.path, fields)).text();
  expect(approvePage).toContain("Approve");
  return approvePage;
}

export async function approve(a: Authorization, ticket: string, extra: Record<string, string> = {}): Promise<URL> {
  const res = await post(a.path, { step: "approve", ticket, decision: "approve", ...extra });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("Location")!);
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  scope: string;
}

export async function exchange(a: Authorization, code: string): Promise<Tokens> {
  const res = await post("/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: a.client.redirect,
    client_id: a.client.id,
    code_verifier: a.verifier,
  });
  expect(res.status).toBe(200);
  return res.json();
}

export function refresh(client: Client, refreshToken: string): Promise<Response> {
  return post("/token", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.id });
}

export interface SignedUp extends Tokens {
  email: string;
  name: string;
  client: Client;
}

/** A new User who approves a new tool; `readOnly` ticks the box on the approve page. */
export async function signUp(email: string, opts: { scope?: string; readOnly?: boolean; name?: string } = {}): Promise<SignedUp> {
  const name = opts.name ?? freshName();
  const client = await registerClient();
  const a = await authorization(client, { scope: opts.scope });
  const ticket = ticketIn(await throughCode(a, email, name));
  const redirect = await approve(a, ticket, opts.readOnly ? { read_only: "1" } : {});
  return { ...(await exchange(a, redirect.searchParams.get("code")!)), email, name, client };
}

/** Another tool for an existing User (no name field this time). */
export async function signIn(email: string, name: string, opts: { scope?: string } = {}): Promise<SignedUp> {
  const client = await registerClient();
  const a = await authorization(client, opts);
  const ticket = ticketIn(await throughCode(a, email));
  const redirect = await approve(a, ticket);
  return { ...(await exchange(a, redirect.searchParams.get("code")!)), email, name, client };
}

export const basic = (token: string) => `Basic ${btoa(`fugitive:${token}`)}`;
