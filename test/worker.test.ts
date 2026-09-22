// Send HTTP requests straight to the Worker to test cases real git can't easily produce.
// The packs come from real git, generated in global-setup; credentials are access tokens from the real OAuth flow.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { ZERO_OID } from "../src/objects";
import { concat, DELIM, FLUSH, parsePackets, pkt } from "../src/pktline";
import { basic, call, emails, signUp, type SignedUp } from "./helpers";

const fx = inject("fixtures");
const [c0, c1, c2] = fx.commits;

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const basePack = b64(fx.basePack);
const thinPack = b64(fx.thinPack);

let owner: SignedUp;
beforeAll(async () => {
  owner = await signUp(emails(50)(), { name: "tester" });
});

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
    headers: { Authorization: opts.auth ?? basic(owner.access_token) },
    body: opts.stream
      ? new ReadableStream({
          start(c) {
            for (let i = 0; i < body.length; i += 1000) c.enqueue(body.slice(i, i + 1000));
            c.close();
          },
        })
      : body,
  };
  const res = await call(`/@tester/${repository}.git/git-receive-pack`, init);
  expect(res.status).toBe(200);
  return unband(new Uint8Array(await res.arrayBuffer()));
}

async function lsRefs(repository: string): Promise<Record<string, string>> {
  const res = await call(`/@tester/${repository}.git/git-upload-pack`, {
    method: "POST",
    headers: { Authorization: basic(owner.access_token), "Git-Protocol": "version=2" },
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
    // Access tokens are `<user id>:<grant id>:<secret>`.
    const id = (await env.USERS.getByName("global").findRepository(owner.access_token.split(":")[0], repository))!;
    const stub = env.REPOSITORIES.get(env.REPOSITORIES.idFromString(id));
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
