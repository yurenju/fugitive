// Send HTTP requests straight to the Worker to test cases real git can't easily produce.
// The packs come from real git, generated in global-setup.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, inject, it } from "vitest";
import { base64url, issueChallenge, NAMESPACE, publicKeyBlob, type Mode } from "../src/auth";
import { ZERO_OID } from "../src/objects";
import { concat, DELIM, FLUSH, parsePackets, pkt } from "../src/pktline";

const fx = inject("fixtures");
const ORIGIN = "https://fugitive.test";
const SECRET = "test-secret";
const [c0, c1, c2] = fx.commits;
const encoder = new TextEncoder();

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const basePack = b64(fx.basePack);
const thinPack = b64(fx.thinPack);

function sshString(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

/** Produce an SSHSIG signature in the same format as `ssh-keygen -Y sign`. */
async function sshsig(message: string, pkcs8: string, publicLine: string, namespace = NAMESPACE): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("pkcs8", b64(pkcs8), { name: "Ed25519" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", encoder.encode(message)));
  const signed = concat([encoder.encode("SSHSIG"), sshString(namespace), sshString(""), sshString("sha512"), sshString(digest)]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, signed));
  const version = new Uint8Array([0, 0, 0, 1]);
  return concat([
    encoder.encode("SSHSIG"),
    version,
    sshString(publicKeyBlob(publicLine)),
    sshString(namespace),
    sshString(""),
    sshString("sha512"),
    sshString(concat([sshString("ssh-ed25519"), sshString(sig)])),
  ]);
}

interface CredOptions {
  challenge?: string;
  stranger?: boolean;
  namespace?: string;
}

async function credentials(repository: string, mode: Mode, opts: CredOptions = {}): Promise<string> {
  const challenge = opts.challenge ?? (await issueChallenge(SECRET, repository, mode, Math.floor(Date.now() / 1000)));
  const [priv, pub] = opts.stranger ? [fx.strangerPrivateKey, fx.strangerKey] : [fx.userPrivateKey, fx.userKey];
  const sig = await sshsig(challenge, priv, pub, opts.namespace);
  return `Basic ${btoa(`x:fgt1.${challenge}.${base64url(sig)}`)}`;
}

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

/** Unwrap a side-band response into the pkt-lines on band 1. */
function unband(body: Uint8Array): string[] {
  const inner = parsePackets(body)
    .packets.filter((p) => p.kind === "data" && p.bytes[0] === 1)
    .map((p) => (p as { bytes: Uint8Array }).bytes.subarray(1));
  return parsePackets(concat(inner))
    .packets.filter((p) => p.kind === "data")
    .map((p) => (p as { line: string }).line);
}

interface PushOptions {
  atomic?: boolean;
  /** No Content-Length, like git's chunked uploads (the pack goes to R2) */
  stream?: boolean;
  auth?: string;
}

async function push(repository: string, commands: string[], pack: Uint8Array | null, opts: PushOptions = {}) {
  const caps = `report-status side-band-64k${opts.atomic ? " atomic" : ""}`;
  const body = concat([
    ...commands.map((c, i) => pkt(i === 0 ? `${c}\0${caps}\n` : `${c}\n`)),
    FLUSH,
    ...(pack ? [pack] : []),
  ]);
  const init: RequestInit = {
    method: "POST",
    headers: { Authorization: opts.auth ?? (await credentials(`tester/${repository}`, "write")) },
    body: opts.stream
      ? new ReadableStream({
          start(c) {
            for (let i = 0; i < body.length; i += 1000) c.enqueue(body.slice(i, i + 1000));
            c.close();
          },
        })
      : body,
  };
  const res = await call(`/tester/${repository}.git/git-receive-pack`, init);
  expect(res.status).toBe(200);
  return unband(new Uint8Array(await res.arrayBuffer()));
}

async function lsRefs(repository: string): Promise<Record<string, string>> {
  const res = await call(`/tester/${repository}.git/git-upload-pack`, {
    method: "POST",
    headers: { Authorization: await credentials(`tester/${repository}`, "read"), "Git-Protocol": "version=2" },
    body: concat([pkt("command=ls-refs\n"), DELIM, pkt("symrefs\n"), FLUSH]),
  });
  expect(res.status).toBe(200);
  const out: Record<string, string> = {};
  for (const p of parsePackets(new Uint8Array(await res.arrayBuffer())).packets) {
    if (p.kind !== "data") continue;
    const [oid, name] = p.line.split(" ");
    out[name] = oid;
  }
  return out;
}

let n = 0;
const fresh = () => `repository${++n}`;

describe("routing and authentication", () => {
  it("serves the installer and the helper", async () => {
    const install = await call("/install.sh");
    expect(install.status).toBe(200);
    expect(await install.text()).toContain(`origin='${ORIGIN}'`);
    expect(await (await call("/git-credential-fugitive")).text()).toContain("ssh-keygen -q -Y sign -n fugitive-git-v1");
  });

  it("asks for credentials with a challenge in WWW-Authenticate", async () => {
    const res = await call("/tester/a.git/info/refs?service=git-upload-pack");
    expect(res.status).toBe(401);
    const header = res.headers.get("WWW-Authenticate")!;
    const challenge = /^Basic realm="fugitive", challenge="([A-Za-z0-9_-]+)"$/.exec(header)?.[1];
    expect(challenge).toBeTruthy();
    // this is exactly what the helper signs
    const ok = await call("/tester/a.git/info/refs?service=git-upload-pack", {
      headers: { Authorization: await credentials("tester/a", "read", { challenge }) },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("application/x-git-upload-pack-advertisement");
  });

  const rejected: [string, () => Promise<string>][] = [
    ["an unknown key", () => credentials("tester/a", "read", { stranger: true })],
    ["a challenge for another repository", () => credentials("tester/b", "read")],
    ["a read challenge used to write", async () => credentials("tester/a", "read")],
    [
      "an expired challenge",
      async () =>
        credentials("tester/a", "read", {
          challenge: await issueChallenge(SECRET, "tester/a", "read", Math.floor(Date.now() / 1000) - 601),
        }),
    ],
    [
      "a challenge not issued by this server",
      async () =>
        credentials("tester/a", "read", {
          challenge: await issueChallenge("other-secret", "tester/a", "read", Math.floor(Date.now() / 1000)),
        }),
    ],
    ["a signature in the wrong namespace", () => credentials("tester/a", "read", { namespace: "git" })],
  ];
  for (const [what, auth] of rejected) {
    it(`rejects ${what}`, async () => {
      const service = what.includes("to write") ? "git-receive-pack" : "git-upload-pack";
      const res = await call(`/tester/a.git/info/refs?service=${service}`, { headers: { Authorization: await auth() } });
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toMatch(/challenge=/);
    });
  }

  it("returns 404 for another owner and 403 for dumb HTTP", async () => {
    expect((await call("/someone/a.git/info/refs?service=git-upload-pack")).status).toBe(404);
    expect((await call("/tester/a.git/info/refs")).status).toBe(403);
    expect((await call("/tester/a.git/HEAD")).status).toBe(404);
  });
});

describe("push", () => {
  it("stores a pack and moves the ref; HEAD follows the first branch", async () => {
    const repository = fresh();
    expect(await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], basePack)).toEqual([
      "unpack ok",
      "ok refs/heads/main",
    ]);
    expect(await lsRefs(repository)).toEqual({ HEAD: c1, "refs/heads/main": c1 });
  });

  it("accepts a thin pack whose delta bases are in an earlier pack", async () => {
    const repository = fresh();
    await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], basePack);
    expect(await push(repository, [`${c1} ${c2} refs/heads/main`], thinPack)).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect((await lsRefs(repository))["refs/heads/main"]).toBe(c2);
  });

  it("stores packs without Content-Length in R2, and thin packs can use them as bases", async () => {
    const repository = fresh();
    expect(await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], basePack, { stream: true })).toEqual([
      "unpack ok",
      "ok refs/heads/main",
    ]);
    expect(await push(repository, [`${c1} ${c2} refs/heads/main`], thinPack)).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect(await push(repository, [`${c2} ${c1} refs/heads/main`, `${ZERO_OID} ${c2} refs/heads/copy`], null, { stream: true })).toEqual([
      "unpack ok",
      "ok refs/heads/main",
      "ok refs/heads/copy",
    ]);
  });

  it("rejects a pack with a bad checksum and leaves refs alone", async () => {
    const repository = fresh();
    const corrupt = basePack.slice();
    corrupt[corrupt.length - 1] ^= 0xff;
    expect(await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], corrupt)).toEqual([
      "unpack pack checksum mismatch",
      "ng refs/heads/main unpacker error",
    ]);
    expect(await lsRefs(repository)).toEqual({});
  });

  it("rejects a thin pack whose base the server does not have", async () => {
    const repository = fresh();
    const [unpack, ref] = await push(repository, [`${ZERO_OID} ${c2} refs/heads/main`], thinPack);
    expect(unpack).toMatch(/^unpack missing delta base/);
    expect(ref).toBe("ng refs/heads/main unpacker error");
    expect(await lsRefs(repository)).toEqual({});
  });

  it("lets only one of two concurrent pushes to the same branch win", async () => {
    const repository = fresh();
    const results = await Promise.all([
      push(repository, [`${ZERO_OID} ${c0} refs/heads/main`], basePack),
      push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], basePack),
    ]);
    const outcomes = results.map((r) => r[1]).sort();
    expect(outcomes).toEqual(["ng refs/heads/main fetch first", "ok refs/heads/main"]);
  });

  it("atomic: one stale ref fails the whole push", async () => {
    const repository = fresh();
    await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], basePack);
    const report = await push(repository, [`${c1} ${c0} refs/heads/main`, `${c0} ${c1} refs/heads/other`], null, { atomic: true });
    expect(report).toEqual(["unpack ok", "ng refs/heads/main atomic transaction failed", "ng refs/heads/other reference is gone"]);
    expect(await lsRefs(repository)).toEqual({ HEAD: c1, "refs/heads/main": c1 });
  });

  it("non-atomic: the other refs still move", async () => {
    const repository = fresh();
    await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], basePack);
    const report = await push(repository, [`${c1} ${c0} refs/heads/main`, `${c0} ${c1} refs/heads/other`], null);
    expect(report).toEqual(["unpack ok", "ok refs/heads/main", "ng refs/heads/other reference is gone"]);
    expect((await lsRefs(repository))["refs/heads/main"]).toBe(c0);
  });

  it("deletes a branch, rejects bad ref names and unknown objects", async () => {
    const repository = fresh();
    await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`, `${ZERO_OID} ${c1} refs/heads/gone`], basePack);
    expect(
      await push(repository, [
        `${c1} ${ZERO_OID} refs/heads/gone`,
        `${ZERO_OID} ${c1} refs/heads/bad..name`,
        `${ZERO_OID} ${"f".repeat(40)} refs/heads/nothing`,
      ], null),
    ).toEqual([
      "unpack ok",
      "ok refs/heads/gone",
      "ng refs/heads/bad..name invalid ref name",
      "ng refs/heads/nothing missing object",
    ]);
    expect(await lsRefs(repository)).toEqual({ HEAD: c1, "refs/heads/main": c1 });
  });
});

describe("review fixes", () => {
  it("answers a garbled password with 401 and a new challenge, not 500", async () => {
    const res = await call("/tester/a.git/info/refs?service=git-upload-pack", {
      headers: { Authorization: `Basic ${btoa("x:fgt1.a.b")}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/challenge=/);
  });

  it("reports a pack with a valid checksum but corrupt zlib data as an unpack error", async () => {
    const repository = fresh();
    const corrupt = basePack.slice();
    // The first object's compressed data starts around byte 14; break its zlib header.
    corrupt[14] ^= 0xff;
    corrupt[15] ^= 0xff;
    const body = corrupt.subarray(0, corrupt.length - 20);
    corrupt.set(new Uint8Array(await crypto.subtle.digest("SHA-1", body)), corrupt.length - 20);
    const [unpack, ref] = await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], corrupt);
    expect(unpack).toMatch(/^unpack (?!ok)/);
    expect(ref).toBe("ng refs/heads/main unpacker error");
  });

  it("does not trust objects from a push that died before finishing", async () => {
    const repository = fresh();
    await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], basePack);
    // Simulate a push that died while indexing: the pack was never marked complete.
    const stub = env.REPOSITORY.getByName(`tester/${repository}`);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE packs SET complete = 0");
    });
    expect(await push(repository, [`${ZERO_OID} ${c1} refs/heads/other`], null)).toEqual([
      "unpack ok",
      "ng refs/heads/other missing object",
    ]);
    // The next push that carries a pack clears the leftovers and takes the objects in again.
    expect(await push(repository, [`${ZERO_OID} ${c1} refs/heads/other`], basePack)).toEqual([
      "unpack ok",
      "ok refs/heads/other",
    ]);
  });

  it("accepts the shallow lines a shallow clone sends when it pushes", async () => {
    const repository = fresh();
    await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], basePack);
    expect(await push(repository, [`${c1} ${c2} refs/heads/main`, `shallow ${c1}`], thinPack)).toEqual([
      "unpack ok",
      "ok refs/heads/main",
    ]);
  });
});
