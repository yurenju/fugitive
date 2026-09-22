// Registration, sign-in, tokens, scopes and the Settings Page, through the Worker's HTTP interface.
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, inject, it } from "vitest";
import { ZERO_OID } from "../src/objects";
import { concat, FLUSH, pkt } from "../src/pktline";
import { sign } from "../src/signing";
import {
  approve,
  authorization,
  basic,
  call,
  emails,
  exchange,
  freshName,
  lastCode,
  mailTo,
  post,
  refresh,
  registerClient,
  resend,
  signIn,
  signUp,
  throughCode,
  ticketIn,
  type SignedUp,
} from "./helpers";

const nextEmail = emails(0);
const fx = inject("fixtures");
const basePack = Uint8Array.from(atob(fx.basePack), (c) => c.charCodeAt(0));
const now = () => Math.floor(Date.now() / 1000);
const users = () => env.USERS.getByName("global");

const infoRefs = (u: { name: string }, repository: string, service: string, token?: string) =>
  call(`/@${u.name}/${repository}.git/info/refs?service=${service}`, token ? { headers: { Authorization: basic(token) } } : {});

/** A real push of commit 1 to a new branch; the body is the report-status result. */
function push(u: { name: string }, repository: string, token: string, opts: { stream?: boolean } = {}) {
  const body = concat([pkt(`${ZERO_OID} ${fx.commits[1]} refs/heads/main\0report-status\n`), FLUSH, basePack]);
  return call(`/@${u.name}/${repository}.git/git-receive-pack`, {
    method: "POST",
    headers: { Authorization: basic(token) },
    body: opts.stream
      ? new ReadableStream({
          start(c) {
            c.enqueue(body);
            c.close();
          },
        })
      : body,
  });
}

/** Tests sign the same email in more than once a minute; pretend the last code went out long ago. */
const allowNewCode = () => runInDurableObject(users(), (_, s) => void s.storage.sql.exec("UPDATE codes SET sent_at = 0"));

function sessionCookie(res: Response): string {
  const cookie = res.headers.get("Set-Cookie")!;
  expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Strict/);
  expect(cookie).toContain("Path=/settings");
  return cookie.split(";")[0];
}

async function settingsSession(email: string): Promise<string> {
  await allowNewCode();
  await post("/settings", { step: "email", email });
  const res = await post("/settings", { step: "code", email, code: lastCode(email) });
  expect(res.status).toBe(303);
  return sessionCookie(res);
}

const settingsPage = async (cookie: string) => (await call("/settings", { headers: { Cookie: cookie } })).text();

describe("the whole OAuth flow", () => {
  it("registers a tool, signs up, approves, exchanges with PKCE and uses the token with git", async () => {
    const u = await signUp(nextEmail());
    expect(u.scope).toBe("read write");
    expect((await infoRefs(u, "notes", "git-receive-pack", u.access_token)).status).toBe(200);
    expect((await push(u, "notes", u.access_token)).status).toBe(200);
    expect((await infoRefs(u, "notes", "git-upload-pack", u.access_token)).status).toBe(200);
  });

  it("mails a plain-text code with its lifetime and an ignore-me line", async () => {
    const email = nextEmail();
    const a = await authorization(await registerClient());
    await post(a.path, { step: "email", email });
    const [mail] = mailTo(email);
    expect(mail.from).toBe("fugitive <noreply@fugitive.test>");
    const code = lastCode(email);
    expect(code).toMatch(/^\d{6}$/);
    expect(mail.text).toContain(code);
    expect(mail.text).toContain("10 minutes");
    expect(mail.text).toContain("ignore");
  });

  it("serves OAuth metadata that advertises read and write and S256 only", async () => {
    const meta = (await (await call("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(meta.scopes_supported).toEqual(["read", "write"]);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.registration_endpoint).toBe("https://fugitive.test/register");
  });
});

describe("the approve page", () => {
  it("creates no grant until Approve; the page names the tool and the User", async () => {
    const email = nextEmail();
    const name = freshName();
    const a = await authorization(await registerClient("git on laptop"));
    expect(await (await call(a.path)).text()).toContain("git on laptop wants access to your repositories");
    const html = await throughCode(a, email, name);
    expect(html).toContain("Allow git on laptop?");
    expect(html).toContain(`Signed in as ${name}`);
    expect(html).toContain("Allow read only");
    const cookie = await settingsSession(email);
    expect(await settingsPage(cookie)).toContain("No tools yet.");
    await approve(a, ticketIn(html));
    expect(await settingsPage(cookie)).toContain("git on laptop</td>");
  });

  it("Deny sends the tool access_denied with its state, and the account stays", async () => {
    const email = nextEmail();
    const name = freshName();
    const a = await authorization(await registerClient(), { state: "xyz" });
    const ticket = ticketIn(await throughCode(a, email, name));
    const res = await post(a.path, { step: "approve", ticket, decision: "deny" });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("Location")!);
    expect(to.origin + to.pathname).toBe("https://tool.test/callback");
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("xyz");
    // Registered anyway: signing in again asks for no name.
    await allowNewCode();
    expect((await signIn(email, name)).access_token).toBeTruthy();
  });

  it("/authorize/done shows the code to paste, or that access was denied", async () => {
    const shown = await (await call("/authorize/done?code=abc:def:ghi&state=s")).text();
    expect(shown).toContain("Almost done");
    expect(shown).toContain("abc:def:ghi");
    expect(shown).toContain('<meta name="color-scheme" content="dark">');
    expect(await (await call("/authorize/done?error=access_denied")).text()).toContain("Access denied");
  });

  it("a manual-paste tool is sent to /authorize/done on Deny", async () => {
    const client = await registerClient("git on box", "https://fugitive.test/authorize/done");
    const a = await authorization(client);
    const ticket = ticketIn(await throughCode(a, nextEmail(), freshName()));
    const res = await post(a.path, { step: "approve", ticket, decision: "deny" });
    const location = res.headers.get("Location")!;
    expect(location).toMatch(/^https:\/\/fugitive\.test\/authorize\/done\?error=access_denied/);
    expect(await (await call(location)).text()).toContain("Access denied");
  });

  it("Allow read only gives a read token", async () => {
    const u = await signUp(nextEmail(), { readOnly: true });
    expect(u.scope).toBe("read");
  });

  it("a tool that asks only for read gets read, and sees no checkbox", async () => {
    const a = await authorization(await registerClient(), { scope: "read" });
    const html = await throughCode(a, nextEmail(), freshName());
    expect(html).not.toContain("Allow read only");
    const redirect = await approve(a, ticketIn(html));
    expect((await exchange(a, redirect.searchParams.get("code")!)).scope).toBe("read");
  });

  describe("rejects an approval ticket that doesn't fit, and starts over at the email page", () => {
    async function setup() {
      const client = await registerClient();
      const a = await authorization(client);
      const ticket = ticketIn(await throughCode(a, nextEmail(), freshName()));
      return { client, a, ticket };
    }
    const startsOver = async (res: Response) => {
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Sign in to continue");
      expect(html).toContain("Your sign-in expired");
    };

    it("tampered", async () => {
      const { a, ticket } = await setup();
      const [body, mac] = ticket.split(".");
      const forged = btoa(atob(body.replace(/-/g, "+").replace(/_/g, "/")).replace(/"name":"[^"]+"/, '"name":"someone"'))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      await startsOver(await post(a.path, { step: "approve", ticket: `${forged}.${mac}`, decision: "approve" }));
    });

    it("expired", async () => {
      const { a, ticket } = await setup();
      // The same ticket, signed with the right secret but already past its expiry.
      const { user, request } = JSON.parse(atob(ticket.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")));
      const old = await sign("test-secret", { user, request }, now() - 1);
      await startsOver(await post(a.path, { step: "approve", ticket: old, decision: "approve" }));
    });

    it("another client", async () => {
      const { ticket } = await setup();
      const other = await authorization(await registerClient());
      await startsOver(await post(other.path, { step: "approve", ticket, decision: "approve" }));
    });

    it("another redirect URI, or a wider scope", async () => {
      const { client, a, ticket } = await setup();
      const narrow = await authorization(client, { scope: "read" });
      const readTicket = ticketIn(await throughCode(narrow, nextEmail(), freshName()));
      // The read-only ticket, replayed on a request that asks for write:
      const wide = new URL(narrow.path, "https://x");
      wide.searchParams.set("scope", "write");
      await startsOver(await post(wide.pathname + wide.search, { step: "approve", ticket: readTicket, decision: "approve" }));
      const moved = new URL(a.path, "https://x");
      moved.searchParams.set("state", "changed");
      await startsOver(await post(moved.pathname + moved.search, { step: "approve", ticket, decision: "approve" }));
    });
  });

  it("an OAuth request with an unregistered redirect URI is refused", async () => {
    const client = await registerClient();
    const a = await authorization({ ...client, redirect: "https://evil.test/cb" });
    const res = await call(a.path);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid redirect URI");
  });
});

describe("registration", () => {
  it("names must follow the rules; the code survives a bad name", async () => {
    const email = nextEmail();
    const a = await authorization(await registerClient());
    await post(a.path, { step: "email", email });
    const code = lastCode(email);
    const bad = await (await post(a.path, { step: "code", email, code, name: "Bad--Name" })).text();
    expect(bad).toContain("Use lowercase letters");
    expect(bad).toContain('value="Bad--Name"');
    const good = await (await post(a.path, { step: "code", email, code, name: freshName() })).text();
    expect(good).toContain("Approve");
  });

  it("a taken name keeps the code; another name then works", async () => {
    const first = await signUp(nextEmail());
    const email = nextEmail();
    const a = await authorization(await registerClient());
    await post(a.path, { step: "email", email });
    const code = lastCode(email);
    const taken = await (await post(a.path, { step: "code", email, code, name: first.name })).text();
    expect(taken).toContain("That name is taken");
    expect(mailTo(email)).toHaveLength(1);
    expect(await (await post(a.path, { step: "code", email, code, name: freshName() })).text()).toContain("Approve");
  });

  it("only allowlisted emails that are not Users yet see the name field", async () => {
    const email = nextEmail();
    const a = await authorization(await registerClient());
    const newcomer = await (await post(a.path, { step: "email", email })).text();
    expect(newcomer).toContain("Create your account");
    expect(newcomer).toContain('name="name"');
    await post(a.path, { step: "code", email, code: lastCode(email), name: freshName() });
    await allowNewCode();
    const known = await (await post(a.path, { step: "email", email })).text();
    expect(known).not.toContain('name="name"');
    expect(known).toContain("Enter your code");
  });

  it("an email off the allowlist gets no mail and the same words on the page", async () => {
    const a = await authorization(await registerClient());
    const html = await (await post(a.path, { step: "email", email: "stranger@example.com" })).text();
    expect(mailTo("stranger@example.com")).toHaveLength(0);
    expect(html).toContain("If this email can be used, a code has been sent to <strong>stranger@example.com</strong>");
    expect(html).not.toContain('name="name"');
  });

  it("treats email case as the same mailbox", async () => {
    const email = nextEmail();
    const u = await signUp(email.toUpperCase());
    expect(mailTo(email)).toHaveLength(1);
    await allowNewCode();
    const again = await signIn(email, u.name);
    expect(again.access_token).toBeTruthy();
  });

  it("says so when Resend fails", async () => {
    const a = await authorization(await registerClient());
    resend.fail = true;
    try {
      const html = await (await post(a.path, { step: "email", email: nextEmail() })).text();
      expect(html).toContain("We could not send the email");
    } finally {
      resend.fail = false;
    }
  });
});

describe("verification codes", () => {
  async function codePage() {
    const email = nextEmail();
    const a = await authorization(await registerClient());
    await post(a.path, { step: "email", email });
    const submit = (code: string) => post(a.path, { step: "code", email, code, name: freshName() }).then((r) => r.text());
    return { email, a, submit };
  }
  const wrong = (code: string) => (code === "000000" ? "111111" : "000000");

  it("five wrong codes void it", async () => {
    const { email, submit } = await codePage();
    const code = lastCode(email);
    for (let left = 4; left >= 1; left--) expect(await submit(wrong(code))).toContain(`${left} ${left === 1 ? "try" : "tries"} left`);
    expect(await submit(wrong(code))).toContain("Too many wrong codes");
    expect(await submit(code)).toContain("expired or was already used");
  });

  it("says nothing about asking too soon, which would give away who is on the allowlist", async () => {
    const u = await signUp(nextEmail());
    const a = await authorization(await registerClient());
    await post(a.path, { step: "email", email: u.email });
    const soon = await (await post(a.path, { step: "email", email: u.email })).text();
    expect(mailTo(u.email)).toHaveLength(2); // signing up, then the first request here; not the second
    const stranger = await (await post(a.path, { step: "email", email: "stranger@example.com" })).text();
    expect(soon.replaceAll(u.email, "E")).toBe(stranger.replaceAll("stranger@example.com", "E"));
  });

  it("expires after 10 minutes", async () => {
    const { email, submit } = await codePage();
    await runInDurableObject(users(), (_, s) => s.storage.sql.exec("UPDATE codes SET expires_at = ?", now() - 1));
    expect(await submit(lastCode(email))).toContain("expired or was already used");
  });

  it("works once", async () => {
    const { email, submit } = await codePage();
    const code = lastCode(email);
    expect(await submit(code)).toContain("Approve");
    expect(await submit(code)).toContain("expired or was already used");
  });

  it("a new code voids the old one, but not within 60 seconds", async () => {
    const { email, a, submit } = await codePage();
    const old = lastCode(email);
    await post(a.path, { step: "email", email });
    expect(mailTo(email)).toHaveLength(1);
    await allowNewCode();
    await post(a.path, { step: "email", email });
    expect(mailTo(email)).toHaveLength(2);
    const fresh = lastCode(email);
    if (fresh !== old) expect(await submit(old)).toContain("not right");
    expect(await submit(fresh)).toContain("Approve");
  });
});

describe("scopes, owners and tokens", () => {
  it("a read token clones but cannot push or create", async () => {
    const writer = await signUp(nextEmail());
    expect((await push(writer, "shared", writer.access_token)).status).toBe(200);
    await allowNewCode();
    const reader = await signIn(writer.email, writer.name, { scope: "read" });
    expect(reader.scope).toBe("read");
    expect((await infoRefs(writer, "shared", "git-upload-pack", reader.access_token)).status).toBe(200);
    const denied = await infoRefs(writer, "shared", "git-receive-pack", reader.access_token);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("this token is read-only");
    expect((await push(writer, "brand-new", reader.access_token)).status).toBe(403);
    expect(await users().findRepository(reader.access_token.split(":")[0], "brand-new")).toBeNull();
  });

  it("another User's token gets 404 on my repositories", async () => {
    const me = await signUp(nextEmail());
    const other = await signUp(nextEmail());
    await push(me, "private", me.access_token);
    expect((await infoRefs(me, "private", "git-upload-pack", other.access_token)).status).toBe(404);
    expect((await infoRefs(me, "private", "git-receive-pack", other.access_token)).status).toBe(404);
  });

  it("no token, a bad token, and a revoked token get 401 with a Basic challenge", async () => {
    const u = await signUp(nextEmail());
    for (const token of [undefined, "garbage", "a:b:c"]) {
      const res = await infoRefs(u, "x", "git-upload-pack", token);
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="fugitive"');
    }
    // A tool revokes its own grant at the token endpoint (RFC 7009), like `git credential-fugitive logout`.
    const revoked = await post("/token", { token: u.refresh_token, token_type_hint: "refresh_token", client_id: u.client.id });
    expect(revoked.status).toBe(200);
    expect((await infoRefs(u, "x", "git-upload-pack", u.access_token)).status).toBe(401);
    expect((await refresh(u.client, u.refresh_token)).status).toBe(400);
  });

  it("an owner name with capitals, and stage 1's URLs, are 404", async () => {
    const u = await signUp(nextEmail());
    await push(u, "cased", u.access_token);
    const upper = await call(`/@${u.name.toUpperCase()}/cased.git/info/refs?service=git-upload-pack`, {
      headers: { Authorization: basic(u.access_token) },
    });
    expect(upper.status).toBe(404);
    const old = await call(`/${u.name}/cased.git/info/refs?service=git-upload-pack`, { headers: { Authorization: basic(u.access_token) } });
    expect(old.status).toBe(404);
  });

  it("refreshing rotates the refresh token: the one before last stops working", async () => {
    const u = await signUp(nextEmail());
    const first = (await (await refresh(u.client, u.refresh_token)).json()) as SignedUp;
    expect((await infoRefs(u, "r", "git-receive-pack", first.access_token)).status).toBe(200);
    const second = await refresh(u.client, first.refresh_token);
    expect(second.status).toBe(200);
    // The package keeps the previous refresh token alive until its successor is used (in case a response was lost),
    // so the original one is dead now.
    const stale = await refresh(u.client, u.refresh_token);
    expect(stale.status).toBe(400);
    expect(((await stale.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("a tool that asks for no scope gets write", async () => {
    const u = await signUp(nextEmail(), { scope: "" });
    expect(u.scope).toBe("read write");
  });
});

describe("repositories", () => {
  it("clone of a missing repository is 404; push's info/refs does not register it", async () => {
    const u = await signUp(nextEmail());
    expect((await infoRefs(u, "nothing", "git-upload-pack", u.access_token)).status).toBe(404);
    const ad = await infoRefs(u, "nothing", "git-receive-pack", u.access_token);
    expect(ad.status).toBe(200);
    expect(new TextDecoder().decode(await ad.arrayBuffer())).toContain("capabilities^{}");
    expect(await users().listRepositories(u.access_token.split(":")[0])).toEqual([]);
  });

  it("push creates it, and a failed push leaves an empty one on the Settings Page", async () => {
    const email = nextEmail();
    const u = await signUp(email);
    await push(u, "made", u.access_token);
    const broken = await call(`/@${u.name}/failed.git/git-receive-pack`, {
      method: "POST",
      headers: { Authorization: basic(u.access_token) },
      body: concat([pkt(`${ZERO_OID} ${fx.commits[1]} refs/heads/main\0report-status\n`), FLUSH, basePack.slice(0, 40)]),
    });
    expect(broken.status).toBe(200);
    const html = await settingsPage(await settingsSession(email));
    expect(html).toContain("made</td>");
    expect(html).toMatch(/failed <span class="muted">\(empty\)<\/span>/);
  });

  it("rejects bad names on push, with the lowercase spelling", async () => {
    const u = await signUp(nextEmail());
    const early = await infoRefs(u, "Notes", "git-receive-pack", u.access_token);
    expect(early.status).toBe(400);
    expect(await early.text()).toContain('use "notes"');
    const res = await push(u, "Notes", u.access_token);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('use "notes"');
    const suffix = await push(u, "x.git", u.access_token);
    expect(suffix.status).toBe(400);
    expect(await suffix.text()).toContain("cannot end in .git");
  });
});

describe("the Settings Page", () => {
  it("needs a signed-in session", async () => {
    const html = await (await call("/settings")).text();
    expect(html).toContain("Sign in with your email");
    const res = await post("/settings/delete", { repository: "a", confirm: "a" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/settings");
  });

  it("does not let a non-User in", async () => {
    await post("/settings", { step: "email", email: "stranger@example.com" });
    expect(mailTo("stranger@example.com")).toHaveLength(0);
  });

  it("lists tools and repositories; revoking stops the token", async () => {
    const email = nextEmail();
    const u = await signUp(email);
    await push(u, "listed", u.access_token);
    const cookie = await settingsSession(email);
    const html = await settingsPage(cookie);
    expect(html).toContain(`Settings — ${u.name}`);
    expect(html).toContain("test tool</td><td>write</td>");
    expect(html).toContain("listed</td>");
    const grant = /name="grant" value="([^"]+)"/.exec(html)![1];
    const res = await post("/settings/revoke", { grant }, { Cookie: cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/settings?done=revoked&what=test+tool");
    const after = await (await call(res.headers.get("Location")!, { headers: { Cookie: cookie } })).text();
    expect(after).toContain("Revoked test tool. It stops working within a minute.");
    expect(after).toContain("No tools yet.");
    expect((await infoRefs(u, "listed", "git-upload-pack", u.access_token)).status).toBe(401);
  });

  it("deletes only when the name is typed exactly; the URL is gone, R2 is cleared, and the name is fresh", async () => {
    const email = nextEmail();
    const u = await signUp(email);
    expect((await push(u, "doomed", u.access_token, { stream: true })).status).toBe(200);
    const userId = u.access_token.split(":")[0];
    const id = (await users().findRepository(userId, "doomed"))!;
    expect((await env.PACKS.list({ prefix: `${id}/` })).objects.length).toBe(1);
    const cookie = await settingsSession(email);

    const typo = await post("/settings/delete", { repository: "doomed", confirm: "doome" }, { Cookie: cookie });
    expect(typo.headers.get("Location")).toBe("/settings?done=mismatch&what=doomed");
    expect(await (await call(typo.headers.get("Location")!, { headers: { Cookie: cookie } })).text()).toContain("Type doomed exactly");
    expect(await users().findRepository(userId, "doomed")).toBe(id);

    const gone = await post("/settings/delete", { repository: "doomed", confirm: "doomed" }, { Cookie: cookie });
    expect(gone.headers.get("Location")).toBe("/settings?done=deleted&what=doomed");
    expect(await (await call(gone.headers.get("Location")!, { headers: { Cookie: cookie } })).text()).toContain(
      "Deleted doomed. The name is free to use again.",
    );
    expect((await infoRefs(u, "doomed", "git-upload-pack", u.access_token)).status).toBe(404);

    // Same name again: a new, empty Repository with a new Repository ID.
    expect((await push(u, "doomed", u.access_token)).status).toBe(200);
    expect(await users().findRepository(userId, "doomed")).not.toBe(id);

    const old = env.REPOSITORIES.get(env.REPOSITORIES.idFromString(id));
    // The alarm is due at once, so it may have run already; if not, run it now.
    await runDurableObjectAlarm(old);
    expect((await env.PACKS.list({ prefix: `${id}/` })).objects).toEqual([]);
    expect(await runInDurableObject(old, (_, s) => s.storage.sql.exec("SELECT name FROM sqlite_master").toArray())).toEqual([]);
  });

  it("an expired or forged cookie is signed out", async () => {
    const email = nextEmail();
    await signUp(email);
    const cookie = await settingsSession(email);
    const userId = /"userId":"([^"]+)"/.exec(atob(cookie.split("=")[1].split(".")[0].replace(/-/g, "+").replace(/_/g, "/")))![1];
    const expired = `fugitive_settings=${await sign("test-secret", { userId }, now() - 1)}`;
    const forged = `fugitive_settings=${await sign("other-secret", { userId }, now() + 600)}`;
    for (const c of [expired, forged]) expect(await settingsPage(c)).toContain("Sign in with your email");
    expect(await settingsPage(cookie)).toContain("Settings —");
  });

  it("signs out", async () => {
    const res = await post("/settings/signout", {});
    expect(res.status).toBe(303);
    expect(res.headers.get("Set-Cookie")).toMatch(/^fugitive_settings=; Max-Age=0/);
  });
});
