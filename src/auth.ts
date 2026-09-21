// Authentication for git over HTTPS (ADR 0002): the server issues a challenge in its 401,
// the helper signs it with the User key, and the signature comes back as the Basic password.
import { concat } from "./pktline";

export type Mode = "read" | "write";

export const NAMESPACE = "fugitive-git-v1";
export const CHALLENGE_TTL_SECONDS = 600;
const PASSWORD_PREFIX = "fgt1";
const MAC_LENGTH = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new AuthError("invalid base64url");
  try {
    return fromBase64(s.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new AuthError("invalid base64url");
  }
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export class AuthError extends Error {}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

interface ChallengePayload {
  /** `<owner>/<repository>` */
  r: string;
  m: Mode;
  /** Issue time (Unix seconds, server clock) */
  t: number;
  n: string;
}

/** challenge = base64url(JSON payload ‖ HMAC). It never contains `.`, so it fits in the password string as is. */
export async function issueChallenge(secret: string, repository: string, mode: Mode, now: number): Promise<string> {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = encoder.encode(JSON.stringify({ r: repository, m: mode, t: now, n: nonce } satisfies ChallengePayload));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), payload));
  const out = new Uint8Array(payload.length + mac.length);
  out.set(payload);
  out.set(mac, payload.length);
  return base64url(out);
}

async function checkChallenge(secret: string, challenge: string, repository: string, mode: Mode, now: number) {
  const bytes = fromBase64url(challenge);
  if (bytes.length <= MAC_LENGTH) throw new AuthError("challenge too short");
  const payload = bytes.subarray(0, bytes.length - MAC_LENGTH);
  const mac = bytes.subarray(bytes.length - MAC_LENGTH);
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), mac, payload))) {
    throw new AuthError("challenge was not issued by this server");
  }
  // The MAC matched, so this is JSON this server produced itself.
  const c = JSON.parse(decoder.decode(payload)) as ChallengePayload;
  if (c.r !== repository) throw new AuthError("challenge is for another repository");
  if (c.m !== mode) throw new AuthError(`challenge is for ${c.m}, not ${mode}`);
  if (now - c.t > CHALLENGE_TTL_SECONDS || c.t > now + 60) throw new AuthError("challenge expired");
}

/** Reads SSH wire-format strings (uint32 length + bytes). */
class SshReader {
  pos = 0;
  constructor(private buf: Uint8Array) {}
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new AuthError("truncated SSH data");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  string(): Uint8Array {
    const b = this.bytes(4);
    return this.bytes(((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);
  }
  text(): string {
    return decoder.decode(this.string());
  }
}

function sshString(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The key blob inside an OpenSSH public key line (`ssh-ed25519 AAAA... comment`). */
export function publicKeyBlob(line: string): Uint8Array {
  const [type, b64] = line.trim().split(/\s+/);
  if (type !== "ssh-ed25519" || !b64) throw new Error("user key must be an ssh-ed25519 public key");
  return fromBase64(b64);
}

/**
 * Verify an SSHSIG signature (the output of `ssh-keygen -Y sign`; format in OpenSSH's PROTOCOL.sshsig)
 * and return the public key blob it carries.
 */
export async function verifySshSig(sig: Uint8Array, message: Uint8Array, namespace: string): Promise<Uint8Array> {
  const r = new SshReader(sig);
  if (decoder.decode(r.bytes(6)) !== "SSHSIG") throw new AuthError("not an SSHSIG signature");
  const version = r.bytes(4);
  if (version[3] !== 1 || version[0] | version[1] | version[2]) throw new AuthError("unsupported SSHSIG version");
  const publicKey = r.string();
  const ns = r.text();
  const reserved = r.string();
  const hashAlg = r.text();
  const signature = r.string();
  if (ns !== namespace) throw new AuthError("wrong signature namespace");
  if (hashAlg !== "sha512" && hashAlg !== "sha256") throw new AuthError("unsupported hash algorithm");

  const pk = new SshReader(publicKey);
  if (pk.text() !== "ssh-ed25519") throw new AuthError("only ssh-ed25519 keys are supported");
  const rawKey = pk.string();
  const s = new SshReader(signature);
  if (s.text() !== "ssh-ed25519") throw new AuthError("signature is not ssh-ed25519");
  const rawSig = s.string();

  const digest = new Uint8Array(await crypto.subtle.digest(hashAlg === "sha512" ? "SHA-512" : "SHA-256", message));
  const signed = concat([
    encoder.encode("SSHSIG"),
    sshString(namespace),
    sshString(reserved),
    sshString(hashAlg),
    sshString(digest),
  ]);
  let valid: boolean;
  try {
    const key = await crypto.subtle.importKey("raw", rawKey, { name: "Ed25519" }, false, ["verify"]);
    valid = await crypto.subtle.verify({ name: "Ed25519" }, key, rawSig, signed);
  } catch {
    valid = false; // key or signature of the wrong length
  }
  if (!valid) throw new AuthError("bad signature");
  return publicKey;
}

export interface User {
  name: string;
  keyBlob: Uint8Array;
}

/**
 * Check the Authorization header and return the User it belongs to.
 * The password is `fgt1.<challenge>.<base64url(SSHSIG)>`; the Basic username is ignored.
 */
export async function authenticate(
  authorization: string | null,
  opts: { secret: string; repository: string; mode: Mode; now: number; users: User[] },
): Promise<User> {
  if (!authorization?.startsWith("Basic ")) throw new AuthError("missing credentials");
  let decoded: string;
  try {
    decoded = atob(authorization.slice(6).trim());
  } catch {
    throw new AuthError("malformed Basic credentials");
  }
  const password = decoded.slice(decoded.indexOf(":") + 1);
  const parts = password.split(".");
  if (parts.length !== 3 || parts[0] !== PASSWORD_PREFIX) throw new AuthError("password is not a fugitive signature");
  const [, challenge, sig] = parts;
  await checkChallenge(opts.secret, challenge, opts.repository, opts.mode, opts.now);
  const keyBlob = await verifySshSig(fromBase64url(sig), encoder.encode(challenge), NAMESPACE);
  const user = opts.users.find((u) => equalBytes(u.keyBlob, keyBlob));
  if (!user) throw new AuthError("unknown user key");
  return user;
}
