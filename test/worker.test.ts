// Send HTTP requests straight to the Worker to test cases real git can't easily produce.
// The packs come from real git, generated in global-setup; credentials are access tokens from the real OAuth flow.
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { Inflate } from "pako";
import { beforeAll, describe, expect, inject, it, vi } from "vitest";
import { commitGc, prepareGc } from "../src/gc";
import { applyDelta, bytesToHex, CODE_TYPE, hashObject, ZERO_OID, type ObjectType } from "../src/objects";
import { concat, DELIM, FLUSH, parsePackets, pkt } from "../src/pktline";
import type { RepositoryObject } from "../src/repository";
import type { Store } from "../src/store";
import { basic, call, emails, ORIGIN, signUp, type SignedUp } from "./helpers";

const fx = inject("fixtures");
const [c0, c1, c2] = fx.commits;

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const basePack = b64(fx.basePack);
const thinPack = b64(fx.thinPack);
const gonePack = b64(fx.gonePack);

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

describe("installers", () => {
  // e2e runs install.sh for real; install.ps1 needs Windows, so this is all the coverage it gets.
  it("serve install.ps1 with this host's origin filled in", async () => {
    const res = await call("/install.ps1");
    expect(res.status).toBe(200);
    const script = await res.text();
    expect(script).toContain(`$origin = '${ORIGIN}'`);
    expect(script).not.toContain("__ORIGIN__");
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

/** basePack with its first object's zlib header broken and the checksum fixed up: it fails while being indexed. */
async function corruptZlib(): Promise<Uint8Array> {
  const corrupt = basePack.slice();
  // The first object's compressed data starts around byte 14.
  corrupt[14] ^= 0xff;
  corrupt[15] ^= 0xff;
  const body = corrupt.subarray(0, corrupt.length - 20);
  corrupt.set(new Uint8Array(await crypto.subtle.digest("SHA-1", body)), corrupt.length - 20);
  return corrupt;
}

describe("review fixes", () => {
  it("reports a pack with a valid checksum but corrupt zlib data as an unpack error", async () => {
    const repository = fresh();
    const [unpack, ref] = await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], await corruptZlib());
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

// ---- GC ----

const HOUR = 60 * 60 * 1000;

async function repositoryStub(repository: string): Promise<DurableObjectStub<RepositoryObject>> {
  // Access tokens are `<user id>:<grant id>:<secret>`.
  const id = (await env.USERS.getByName("global").findRepository(owner.access_token.split(":")[0], repository))!;
  return env.REPOSITORIES.get(env.REPOSITORIES.idFromString(id));
}

const r2Keys = async (stub: DurableObjectStub<RepositoryObject>) =>
  (await env.PACKS.list({ prefix: `${stub.id.toString()}/` })).objects.map((o) => o.key);

const sql = (stub: DurableObjectStub<RepositoryObject>, query: string) =>
  runInDurableObject(stub, (_, state) => void state.storage.sql.exec(query));

const alarmAt = (stub: DurableObjectStub<RepositoryObject>) => runInDurableObject(stub, (_, state) => state.storage.getAlarm());

/** Pretend the hour has passed and wake the Repository's alarm. */
async function runGc(stub: DurableObjectStub<RepositoryObject>) {
  await sql(stub, "UPDATE meta SET value = '0' WHERE key = 'gc_at'");
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

/** The oids in a pack as upload-pack sends it (whole objects, or ref-deltas against objects in the same pack). */
function packOids(pack: Uint8Array): string[] {
  const count = new DataView(pack.buffer, pack.byteOffset).getUint32(8);
  const objects = new Map<string, { type: ObjectType; data: Uint8Array }>();
  const deltas: { base: string; delta: Uint8Array }[] = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    let c = pack[pos++];
    const type = (c >> 4) & 7;
    while (c & 0x80) c = pack[pos++];
    let base: string | undefined;
    if (type === 7) {
      base = bytesToHex(pack.subarray(pos, pos + 20));
      pos += 20;
    } else expect(CODE_TYPE[type]).toBeDefined();
    const inflate = new Inflate();
    inflate.push(pack.subarray(pos), false);
    pos += (inflate as unknown as { strm: { total_in: number } }).strm.total_in;
    const data = inflate.result as Uint8Array;
    if (base) deltas.push({ base, delta: data });
    else objects.set(hashObject(CODE_TYPE[type], data), { type: CODE_TYPE[type], data });
  }
  while (deltas.length) {
    const i = deltas.findIndex((d) => objects.has(d.base));
    expect(i).not.toBe(-1);
    const [{ base, delta }] = deltas.splice(i, 1);
    const { type, data } = objects.get(base)!;
    const out = applyDelta(data, delta);
    objects.set(hashObject(type, out), { type, data: out });
  }
  return [...objects.keys()];
}

/** Clone one commit with protocol v2 and return the oids it sends, or the ERR line. */
async function fetchOids(repository: string, want: string): Promise<string[] | string> {
  const res = await call(`/@tester/${repository}.git/git-upload-pack`, {
    method: "POST",
    headers: { Authorization: basic(owner.access_token), "Git-Protocol": "version=2" },
    body: concat([pkt("command=fetch\n"), DELIM, pkt(`want ${want}\n`), pkt("no-progress\n"), pkt("done\n"), FLUSH]),
  });
  const packets = parsePackets(new Uint8Array(await res.arrayBuffer())).packets;
  const first = packets[0];
  if (first.kind === "data" && first.line.startsWith("ERR ")) return first.line;
  const pack = packets.filter((p) => p.kind === "data" && p.bytes[0] === 1).map((p) => (p as { bytes: Uint8Array }).bytes.subarray(1));
  return packOids(concat(pack)).sort();
}

const objectsOf = (commit: string) => [...fx.objects[commit]].sort();

const storeOf = (instance: RepositoryObject) => (instance as unknown as { store: Store }).store;

describe("GC", () => {
  it("is not scheduled by pushes that only create branches or move them forward", async () => {
    const repository = fresh();
    await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`, `${ZERO_OID} ${c0} refs/tags/v0`], basePack);
    expect(await push(repository, [`${c1} ${c2} refs/heads/main`], thinPack)).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect(await alarmAt(await repositoryStub(repository))).toBeNull();
  });

  it("deleting a branch removes what only it reached; a kept delta whose base was only on it still reads", async () => {
    const repository = fresh();
    await push(repository, [`${ZERO_OID} ${fx.kept} refs/heads/main`, `${ZERO_OID} ${fx.gone} refs/heads/gone`], gonePack);
    expect(await fetchOids(repository, fx.gone)).toEqual(objectsOf(fx.gone));
    const stub = await repositoryStub(repository);

    const before = Date.now();
    expect(await push(repository, [`${fx.gone} ${ZERO_OID} refs/heads/gone`], null)).toEqual(["unpack ok", "ok refs/heads/gone"]);
    const at = await alarmAt(stub);
    expect(at).toBeGreaterThanOrEqual(before + HOUR);
    expect(at).toBeLessThanOrEqual(Date.now() + HOUR);

    // Woken before the hour is up, the alarm leaves everything alone.
    await runDurableObjectAlarm(stub);
    expect(await fetchOids(repository, fx.gone)).toEqual(objectsOf(fx.gone));

    await runGc(stub);
    expect(await fetchOids(repository, fx.kept)).toEqual(objectsOf(fx.kept));
    expect(await fetchOids(repository, fx.gone)).toBe(`ERR not our ref ${fx.gone}`);
    expect(await lsRefs(repository)).toEqual({ HEAD: fx.kept, "refs/heads/main": fx.kept });
  });

  it("a force push back to an older commit removes the commits after it; thin packs still resolve afterwards", async () => {
    const repository = fresh();
    await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], basePack);
    await push(repository, [`${c1} ${c0} refs/heads/main`], null);
    await runGc(await repositoryStub(repository));
    expect(await fetchOids(repository, c0)).toEqual(objectsOf(c0));
    expect(await fetchOids(repository, c1)).toBe(`ERR not our ref ${c1}`);

    expect(await push(repository, [`${c0} ${c1} refs/heads/main`], basePack)).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect(await push(repository, [`${c1} ${c2} refs/heads/main`], thinPack)).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect(await fetchOids(repository, c2)).toEqual(objectsOf(c2));
  });

  it("a push the server can't prove is a fast-forward, or one whose refs all fail, schedules GC", async () => {
    const repository = fresh();
    await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], basePack);
    const stub = await repositoryStub(repository);
    // Rejected: main is at c1, not c0. The pack's objects came for nothing.
    expect(await push(repository, [`${c0} ${c2} refs/heads/main`], thinPack)).toEqual(["unpack ok", "ng refs/heads/main fetch first"]);
    expect(await alarmAt(stub)).not.toBeNull();

    const other = fresh();
    await push(other, [`${ZERO_OID} ${c0} refs/heads/main`], basePack);
    // Forward, but with no pack there is nothing to prove it with.
    await push(other, [`${c0} ${c1} refs/heads/main`], null);
    expect(await alarmAt(await repositoryStub(other))).not.toBeNull();
  });

  it("gives up when a push moves a ref between prepare and commit, so a branch pushed back stays whole", async () => {
    const repository = fresh();
    await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], basePack);
    await push(repository, [`${c1} ${c0} refs/heads/main`], null);
    const stub = await repositoryStub(repository);

    const plan = await runInDurableObject(stub, (instance) => prepareGc(storeOf(instance)));
    // The client sends c1's objects again; the index keeps its rows, which point at the packs GC planned to retire.
    expect(await push(repository, [`${c0} ${c1} refs/heads/main`], basePack)).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect(await runInDurableObject(stub, (instance) => commitGc(storeOf(instance), plan))).toBe(false);
    expect(await fetchOids(repository, c1)).toEqual(objectsOf(c1));
  });

  it("also gives up when a rejected push stored a pack meanwhile: its deltas may use objects GC would delete", async () => {
    const repository = fresh();
    await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], basePack);
    await push(repository, [`${c1} ${c0} refs/heads/main`], null);
    const stub = await repositoryStub(repository);

    const plan = await runInDurableObject(stub, (instance) => prepareGc(storeOf(instance)));
    // thinPack's deltas are against c1's objects, which the plan deletes; main is at c0, so the ref update fails.
    expect(await push(repository, [`${c1} ${c2} refs/heads/main`], thinPack)).toEqual(["unpack ok", "ng refs/heads/main fetch first"]);
    expect(await runInDurableObject(stub, (instance) => commitGc(storeOf(instance), plan))).toBe(false);
    // Pointing a ref at the rejected push's commit now works, and it reads back whole.
    expect(await push(repository, [`${ZERO_OID} ${c2} refs/heads/later`], null)).toEqual(["unpack ok", "ok refs/heads/later"]);
    expect(await fetchOids(repository, c2)).toEqual(objectsOf(c2));
  });

  it("a push that dies between prepare and commit leaves the pack GC is writing alone", async () => {
    const repository = fresh();
    await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], basePack);
    await push(repository, [`${c1} ${c0} refs/heads/main`], null);
    const stub = await repositoryStub(repository);

    const plan = await runInDurableObject(stub, (instance) => prepareGc(storeOf(instance)));
    // It clears incomplete packs when it starts indexing; GC's new pack is incomplete until commit.
    const [unpack] = await push(repository, [`${c0} ${c1} refs/heads/main`], await corruptZlib());
    expect(unpack).toMatch(/^unpack (?!ok)/);
    expect(await runInDurableObject(stub, (instance) => commitGc(storeOf(instance), plan))).toBe(true);
    expect(await fetchOids(repository, c0)).toEqual(objectsOf(c0));
  });

  it("deletes a crashed push's R2 pack when the next push starts", async () => {
    const repository = fresh();
    await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], basePack, { stream: true });
    const stub = await repositoryStub(repository);
    const crashed = await r2Keys(stub);
    expect(crashed).toHaveLength(1);
    await sql(stub, "UPDATE packs SET complete = 0");
    expect(await push(repository, [`${ZERO_OID} ${c1} refs/heads/other`], basePack, { stream: true })).toEqual([
      "unpack ok",
      "ok refs/heads/other",
    ]);
    const after = await r2Keys(stub);
    expect(after).toHaveLength(1);
    expect(after).not.toContain(crashed[0]);
  });

  it("deletes R2 keys with no pack behind them, and retired packs an hour after GC", async () => {
    const repository = fresh();
    await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`], basePack, { stream: true });
    await push(repository, [`${c1} ${c0} refs/heads/main`], null);
    const stub = await repositoryStub(repository);
    const [old] = await r2Keys(stub);
    const orphan = `${stub.id.toString()}/packs/999.pack`;
    await env.PACKS.put(orphan, "left by a push that died before this was fixed");

    await runGc(stub);
    // The rewritten pack is small, so it goes to SQLite; the old one stays until clones that started before are done.
    expect(await r2Keys(stub)).toEqual([old]);
    expect(await fetchOids(repository, c0)).toEqual(objectsOf(c0));
    expect(await alarmAt(stub)).toBeGreaterThan(Date.now() + HOUR - 60_000);

    await sql(stub, "UPDATE packs SET retired_at = 0 WHERE retired_at IS NOT NULL");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await r2Keys(stub)).toEqual([]);
    expect(await fetchOids(repository, c0)).toEqual(objectsOf(c0));
    expect(await alarmAt(stub)).toBeNull();
  });

  it("deleting a Repository wins over a GC that is already scheduled", async () => {
    const repository = fresh();
    await push(repository, [`${ZERO_OID} ${c1} refs/heads/main`, `${ZERO_OID} ${c1} refs/heads/gone`], basePack, { stream: true });
    await push(repository, [`${c1} ${ZERO_OID} refs/heads/gone`], null);
    const stub = await repositoryStub(repository);
    expect(await alarmAt(stub)).toBeGreaterThan(Date.now());

    await stub.destroy();
    // The alarm is due at once, so the platform may already be running it; if not, run it now, then wait for it.
    await runDurableObjectAlarm(stub);
    await vi.waitFor(async () => {
      expect(await r2Keys(stub)).toEqual([]);
      expect(await runInDurableObject(stub, (_, s) => s.storage.sql.exec("SELECT name FROM sqlite_master").toArray())).toEqual([]);
    });
  });
});
