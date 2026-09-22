// HMAC-signed, expiring payloads: the approval ticket on the Authorization Page and the Settings Page cookie
// both use these, with SESSION_SECRET.

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** `<base64url(JSON)>.<base64url(HMAC)>`; `exp` is Unix seconds. */
export async function sign(secret: string, payload: object, exp: number): Promise<string> {
  const body = encoder.encode(JSON.stringify({ ...payload, exp }));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), body));
  return `${base64url(body)}.${base64url(mac)}`;
}

/** The payload, or null when the signature is wrong, the value is malformed or it has expired. */
export async function verify<T>(secret: string, value: string | null | undefined, now: number): Promise<T | null> {
  const [body, mac, extra] = (value ?? "").split(".");
  if (!body || !mac || extra !== undefined) return null;
  try {
    const bytes = fromBase64url(body);
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), fromBase64url(mac), bytes))) return null;
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as T & { exp: number };
    return payload.exp > now ? payload : null;
  } catch {
    return null;
  }
}
