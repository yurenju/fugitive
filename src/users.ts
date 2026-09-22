// The one site-wide Durable Object for Users, Verification Codes and each User's list of Repositories
// (ADR 0005, 0008). Every method runs its SQL in one synchronous transaction, so each is one step.
import { DurableObject } from "cloudflare:workers";
import { repositoryNameProblem, userNameProblem } from "./rules";

export const CODE_TTL_SECONDS = 600;
export const CODE_RESEND_SECONDS = 60;
export const MAX_CODE_FAILURES = 5;

/**
 * The resend wait, which the e2e run sets to 0 with CODE_RESEND_SECONDS. It also caps guessing, since each new code
 * resets the failure count, so anything but a whole number of seconds falls back to the default instead of to no wait.
 */
export function codeResendSeconds(raw: string | undefined): number {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : CODE_RESEND_SECONDS;
}

export interface User {
  id: string;
  name: string;
}

export interface RepositoryEntry {
  name: string;
  id: string;
  createdAt: number;
}

/**
 * `code` is the new code in the clear, for the Worker to mail, or null when none was made (too soon, or the email is
 * neither a User nor on the Registration Allowlist). `askName` is true for an allowlisted email not yet registered.
 */
export interface CodeRequest {
  tooSoon: boolean;
  code: string | null;
  askName: boolean;
}

export type Redeemed =
  | { ok: true; user: User; created: boolean }
  | { ok: false; reason: "no-code" | "too-many" | "needs-name" | "name-taken" }
  | { ok: false; reason: "wrong"; remaining: number }
  | { ok: false; reason: "name-invalid"; detail: string };

export function allowlisted(list: string | undefined, email: string): boolean {
  return (list ?? "")
    .split(/[,\n]/)
    .map((e) => e.trim().toLowerCase())
    .includes(email);
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Users extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS codes (
        email TEXT PRIMARY KEY, hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
        failures INTEGER NOT NULL, sent_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS repositories (
        owner_id TEXT NOT NULL, name TEXT NOT NULL, id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (owner_id, name));
      CREATE TABLE IF NOT EXISTS grant_uses (grant_id TEXT PRIMARY KEY, last_used_at INTEGER NOT NULL);
    `);
  }

  private userByEmail(email: string): User | undefined {
    return this.sql.exec<{ id: string; name: string }>("SELECT id, name FROM users WHERE email = ?", email).toArray()[0];
  }

  getUser(id: string): User | null {
    return this.sql.exec<{ id: string; name: string }>("SELECT id, name FROM users WHERE id = ?", id).toArray()[0] ?? null;
  }

  /** A new code for this email, replacing any earlier one; at most one every CODE_RESEND_SECONDS. */
  async requestCode(rawEmail: string, now: number): Promise<CodeRequest> {
    const email = rawEmail.trim().toLowerCase();
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    const hash = await sha256(code);
    return this.ctx.storage.transactionSync((): CodeRequest => {
      const registered = !!this.userByEmail(email);
      const listed = allowlisted(this.env.REGISTRATION_ALLOWLIST, email);
      const askName = !registered && listed;
      const last = this.sql.exec<{ sent_at: number }>("SELECT sent_at FROM codes WHERE email = ?", email).toArray()[0];
      if (last && now - last.sent_at < codeResendSeconds(this.env.CODE_RESEND_SECONDS)) return { tooSoon: true, code: null, askName };
      if (!registered && !listed) return { tooSoon: false, code: null, askName };
      this.sql.exec(
        "INSERT OR REPLACE INTO codes (email, hash, expires_at, failures, sent_at) VALUES (?, ?, ?, 0, ?)",
        email,
        hash,
        now + CODE_TTL_SECONDS,
        now,
      );
      return { tooSoon: false, code, askName };
    });
  }

  /**
   * Sign in with a code, or register with a code and a name. A wrong code counts as a failure; a bad or taken name
   * does not, and leaves the code in place so the person can try another name.
   */
  async redeemCode(rawEmail: string, code: string, now: number, name?: string): Promise<Redeemed> {
    const email = rawEmail.trim().toLowerCase();
    const hash = await sha256(code.trim());
    return this.ctx.storage.transactionSync((): Redeemed => {
      const row = this.sql
        .exec<{ hash: string; expires_at: number; failures: number }>(
          "SELECT hash, expires_at, failures FROM codes WHERE email = ?",
          email,
        )
        .toArray()[0];
      if (!row || row.expires_at < now) return { ok: false, reason: "no-code" };
      if (row.hash !== hash) {
        const failures = row.failures + 1;
        if (failures >= MAX_CODE_FAILURES) {
          this.sql.exec("DELETE FROM codes WHERE email = ?", email);
          return { ok: false, reason: "too-many" };
        }
        this.sql.exec("UPDATE codes SET failures = ? WHERE email = ?", failures, email);
        return { ok: false, reason: "wrong", remaining: MAX_CODE_FAILURES - failures };
      }
      const existing = this.userByEmail(email);
      if (existing) {
        this.sql.exec("DELETE FROM codes WHERE email = ?", email);
        return { ok: true, user: existing, created: false };
      }
      if (name === undefined) return { ok: false, reason: "needs-name" };
      const problem = userNameProblem(name);
      if (problem) return { ok: false, reason: "name-invalid", detail: problem };
      if (this.sql.exec("SELECT 1 FROM users WHERE name = ?", name).toArray().length) {
        return { ok: false, reason: "name-taken" };
      }
      const user = { id: randomId(), name };
      this.sql.exec("INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)", user.id, name, email, now);
      this.sql.exec("DELETE FROM codes WHERE email = ?", email);
      return { ok: true, user, created: true };
    });
  }

  findRepository(ownerId: string, name: string): string | null {
    return (
      this.sql
        .exec<{ id: string }>("SELECT id FROM repositories WHERE owner_id = ? AND name = ?", ownerId, name)
        .toArray()[0]?.id ?? null
    );
  }

  /** Only push creates Repositories: find the Repository ID, or register a new one before any data is written. */
  findOrCreateRepository(ownerId: string, name: string, now: number): string {
    if (repositoryNameProblem(name)) throw new Error(`invalid repository name: ${name}`);
    return this.ctx.storage.transactionSync(() => {
      const found = this.findRepository(ownerId, name);
      if (found) return found;
      const id = this.env.REPOSITORIES.newUniqueId().toString();
      this.sql.exec(
        "INSERT INTO repositories (owner_id, name, id, created_at) VALUES (?, ?, ?, ?)",
        ownerId,
        name,
        id,
        now,
      );
      return id;
    });
  }

  listRepositories(ownerId: string): RepositoryEntry[] {
    return this.sql
      .exec<{ name: string; id: string; created_at: number }>(
        "SELECT name, id, created_at FROM repositories WHERE owner_id = ? ORDER BY name",
        ownerId,
      )
      .toArray()
      .map((r) => ({ name: r.name, id: r.id, createdAt: r.created_at }));
  }

  /** Take the Repository off the list, so its URL is gone at once; returns its Repository ID. */
  deleteRepository(ownerId: string, name: string): string | null {
    return (
      this.sql
        .exec<{ id: string }>("DELETE FROM repositories WHERE owner_id = ? AND name = ? RETURNING id", ownerId, name)
        .toArray()[0]?.id ?? null
    );
  }

  /**
   * The Settings Page's "last used" column. It mirrors `lastUsedAt` in the grant's props, which the page cannot read:
   * the OAuth package encrypts props with a key only the tokens unwrap.
   */
  // ponytail: rows of grants revoked elsewhere stay behind; tiny, and the page only shows live grants.
  touchGrant(grantId: string, now: number): void {
    this.sql.exec("INSERT OR REPLACE INTO grant_uses (grant_id, last_used_at) VALUES (?, ?)", grantId, now);
  }

  grantUses(grantIds: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const id of grantIds) {
      const row = this.sql.exec<{ last_used_at: number }>("SELECT last_used_at FROM grant_uses WHERE grant_id = ?", id);
      for (const r of row) out[id] = r.last_used_at;
    }
    return out;
  }
}
