// push (receive-pack): receive the pack, index it, check connectivity, and only then move refs.
import { createHash } from "node:crypto";
import {
  applyDelta,
  bytesToHex,
  CODE_TYPE,
  hashObject,
  isOid,
  objectHeader,
  OFS_DELTA,
  parseCommit,
  REF_DELTA,
  referencedOids,
  TYPE_CODE,
  ZERO_OID,
  type ObjectType,
} from "./objects";
import { concat, FLUSH, pkt, ProtocolError, sideband, StreamReader } from "./pktline";
import { SQLITE_PACK_LIMIT, type Store } from "./store";

/** Cloudflare's request body limit; the platform rejects larger bodies first, this is a backstop. */
export const MAX_PUSH_BYTES = 100 * 1024 * 1024;
/** Blobs larger than this are hashed while inflating and not kept in memory. */
const KEEP_LIMIT = 4 * 1024 * 1024;

export const RECEIVE_CAPABILITIES = "report-status delete-refs side-band-64k ofs-delta atomic object-format=sha1";

export interface Command {
  old: string;
  new: string;
  ref: string;
}

export class UnpackError extends Error {}

/** Check a ref name against git check-ref-format's rules. */
export function isValidRefName(name: string): boolean {
  if (!name.startsWith("refs/") || name.endsWith("/") || name.endsWith(".") || name.includes("..")) return false;
  if (name.includes("@{") || name.includes("//") || /[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return name.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

interface Entry {
  offset: number;
  entryType: number;
  entrySize: number;
  dataOffset: number;
  dataLength: number;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Take in a pushed pack: store it as-is and verify its checksum, then read it back object by
 * object to compute oids and write the index.
 * Returns the pack id, or null when there is no pack (e.g. a delete-only push).
 */
export async function ingestPack(
  store: Store,
  body: AsyncIterable<Uint8Array>,
  contentLength: number | undefined,
  yieldEvery: () => Promise<void> = async () => {},
): Promise<number | null> {
  // Step 1: store the bytes while computing the checksum (the last 20 bytes are the checksum itself).
  const location = contentLength !== undefined && contentLength < SQLITE_PACK_LIMIT ? "sqlite" : "r2";
  const writer = store.createPack(location);
  const sha = createHash("sha1");
  let tail = new Uint8Array(0);
  let total = 0;
  try {
    for await (const chunk of body) {
      total += chunk.length;
      if (total > MAX_PUSH_BYTES) throw new UnpackError(`pack exceeds ${MAX_PUSH_BYTES / 1024 / 1024} MB; push in smaller pieces`);
      await writer.write(chunk);
      const joined = concat([tail, chunk]);
      const keep = Math.min(20, joined.length);
      sha.update(joined.subarray(0, joined.length - keep));
      tail = joined.slice(joined.length - keep);
    }
    if (total === 0) {
      await writer.abort();
      return null;
    }
    if (total < 32) throw new UnpackError("pack too short");
    await writer.close();
    if (sha.digest("hex") !== bytesToHex(tail)) throw new UnpackError("pack checksum mismatch");
    await indexPack(store, writer.id, total - 20, yieldEvery);
    return writer.id;
  } catch (e) {
    await writer.abort();
    throw e;
  }
}

async function indexPack(store: Store, packId: number, end: number, yieldEvery: () => Promise<void>) {
  const header = await store.read(packId, 0, 12);
  if (new TextDecoder().decode(header.subarray(0, 4)) !== "PACK") throw new UnpackError("not a pack");
  const view = new DataView(header.buffer, header.byteOffset);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) throw new UnpackError(`unsupported pack version ${version}`);
  const count = view.getUint32(8);

  await store.startIndexing(packId);
  const oidAt = new Map<number, string>();
  const pending: Entry[] = [];

  const record = (entry: Entry, oid: string, type: ObjectType, data: Uint8Array | null, baseOid: string | null) => {
    oidAt.set(entry.offset, oid);
    store.addObject({
      oid,
      pack_id: packId,
      type: TYPE_CODE[type],
      entry_type: entry.entryType,
      entry_size: entry.entrySize,
      data_offset: entry.dataOffset,
      data_len: entry.dataLength,
      base_oid: baseOid,
    });
    if (data && type !== "blob") {
      let refs: string[];
      try {
        refs = referencedOids(type, data);
      } catch (e) {
        throw new UnpackError(`malformed ${type} ${oid}: ${(e as Error).message}`);
      }
      refs.forEach((ref) => store.addReference(ref));
    }
    if (data) store.remember(oid, { type, data });
  };

  /** Resolve and record a delta if its base is available; otherwise return false to retry later. */
  const resolveDelta = async (entry: Entry, delta: Uint8Array | null): Promise<boolean> => {
    const baseOid = entry.baseOid ?? oidAt.get(entry.baseOffset!);
    if (!baseOid || !store.has(baseOid)) return false;
    delta ??= (await store.inflateAt(packId, entry.dataOffset)).data;
    const base = await store.load(baseOid);
    let data: Uint8Array;
    try {
      data = applyDelta(base.data, delta);
    } catch (e) {
      throw new UnpackError(`corrupt delta at offset ${entry.offset}: ${(e as Error).message}`);
    }
    record(entry, hashObject(base.type, data), base.type, data, baseOid);
    return true;
  };

  // Step 2: one pass in pack order.
  let pos = 12;
  for (let i = 0; i < count; i++) {
    if (pos >= end) throw new UnpackError("pack has fewer objects than its header says");
    const h = await store.read(packId, pos, Math.min(64, end - pos));
    let p = 0;
    let c = h[p++];
    const entryType = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while (c & 0x80) {
      c = h[p++];
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: Entry = { offset: pos, entryType, entrySize: size, dataOffset: 0, dataLength: 0 };
    if (entryType === OFS_DELTA) {
      c = h[p++];
      let rel = c & 0x7f;
      while (c & 0x80) {
        c = h[p++];
        rel = (rel + 1) * 128 + (c & 0x7f);
      }
      entry.baseOffset = pos - rel;
    } else if (entryType === REF_DELTA) {
      entry.baseOid = bytesToHex(h.subarray(p, p + 20));
      p += 20;
    } else if (!CODE_TYPE[entryType]) {
      throw new UnpackError(`bad object type ${entryType} at offset ${pos}`);
    }
    entry.dataOffset = pos + p;

    if (entryType === OFS_DELTA || entryType === REF_DELTA) {
      const { data, consumed } = await store.inflateAt(packId, entry.dataOffset);
      if (data.length !== size) throw new UnpackError(`delta size mismatch at offset ${pos}`);
      entry.dataLength = consumed;
      if (!(await resolveDelta(entry, data))) pending.push(entry);
    } else {
      const type = CODE_TYPE[entryType];
      if (type === "blob" && size > KEEP_LIMIT) {
        // Large blob: hash while inflating instead of keeping it in memory.
        const hash = createHash("sha1").update(objectHeader(type, size));
        let got = 0;
        const { consumed } = await store.inflateAt(packId, entry.dataOffset, (chunk) => {
          hash.update(chunk);
          got += chunk.length;
        });
        if (got !== size) throw new UnpackError(`object size mismatch at offset ${pos}`);
        entry.dataLength = consumed;
        record(entry, hash.digest("hex"), type, null, null);
      } else {
        const { data, consumed } = await store.inflateAt(packId, entry.dataOffset);
        if (data.length !== size) throw new UnpackError(`object size mismatch at offset ${pos}`);
        entry.dataLength = consumed;
        record(entry, hashObject(type, data), type, data, null);
      }
    }
    pos = entry.dataOffset + entry.dataLength;
    if (i % 2000 === 1999) await yieldEvery();
  }
  if (pos !== end) throw new UnpackError("pack has trailing garbage");

  // Step 3: retry deltas whose base hadn't appeared yet, until no progress is made.
  // Thin-pack bases live in other packs on the server, so store.has() finds them in step 2;
  // what's left here are deltas whose base comes later in the same pack.
  let remaining = pending;
  while (remaining.length) {
    const next: Entry[] = [];
    for (const entry of remaining) if (!(await resolveDelta(entry, null))) next.push(entry);
    if (next.length === remaining.length) {
      const e = next[0];
      throw new UnpackError(`missing delta base ${e.baseOid ?? `at offset ${e.baseOffset}`}`);
    }
    remaining = next;
  }

  // Connectivity: everything referenced by objects in this pack must exist in this Repository.
  // Objects from earlier complete packs were already checked, so there is no need to walk further.
  const missing = store.finishIndexing(packId);
  if (missing) throw new UnpackError(`missing object ${missing}`);
}

function parseCommand(line: string): Command {
  const [old, next, ref] = line.split(" ");
  if (!isOid(old) || !isOid(next) || !ref) throw new ProtocolError(`bad command: ${line}`);
  return { old, new: next, ref };
}

/**
 * The single entry point for moving refs: a ref only moves if it still points at the expected object
 * (MCP commits will go through here too). With atomic, every ref is checked first and they are
 * written together only if all pass.
 * Returns each ref's result; null means success.
 */
export function updateRefs(store: Store, commands: Command[], atomic: boolean): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const cmd of commands) {
    if (!isValidRefName(cmd.ref)) result.set(cmd.ref, "invalid ref name");
    else if (cmd.new !== ZERO_OID && !store.has(cmd.new)) result.set(cmd.ref, "missing object");
  }
  return store.transaction(() => {
    for (const cmd of commands) {
      if (result.has(cmd.ref)) continue;
      const current = store.ref(cmd.ref) ?? ZERO_OID;
      if (current !== cmd.old) result.set(cmd.ref, current === ZERO_OID ? "reference is gone" : "fetch first");
    }
    if (atomic && result.size) {
      for (const cmd of commands) if (!result.has(cmd.ref)) result.set(cmd.ref, "atomic transaction failed");
      return result;
    }
    for (const cmd of commands) {
      if (result.has(cmd.ref)) continue;
      store.setRef(cmd.ref, cmd.new === ZERO_OID ? null : cmd.new);
      result.set(cmd.ref, null);
    }
    // First push to an empty Repository: HEAD points at main if it was pushed, else at the first branch pushed.
    if (!store.head()) {
      const created = commands.filter((c) => result.get(c.ref) === null && c.new !== ZERO_OID && c.ref.startsWith("refs/heads/"));
      const head = created.find((c) => c.ref === "refs/heads/main") ?? created[0];
      if (head) store.setHead(head.ref);
    }
    return result;
  });
}

/**
 * Whether moving these refs may have left objects no ref reaches, so GC should run. Only a proof of a fast-forward
 * clears a moved ref: walking back from the new commit through commits this push's pack brought reaches the old one.
 * Anything else (deleted refs, a pack whose refs all failed) counts; a wrong guess only costs one extra GC.
 */
export async function mayLeaveGarbage(
  store: Store,
  commands: Command[],
  results: Map<string, string | null>,
  packId: number | null,
): Promise<boolean> {
  const moved = commands.filter((c) => results.get(c.ref) === null);
  if (packId !== null && !moved.length) return true;
  for (const cmd of moved) {
    if (cmd.old === ZERO_OID) continue;
    if (cmd.new === ZERO_OID || packId === null || !(await fastForward(store, packId, cmd.old, cmd.new))) return true;
  }
  return false;
}

async function fastForward(store: Store, packId: number, old: string, next: string): Promise<boolean> {
  const seen = new Set<string>();
  const stack = [next];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === old) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const row = store.row(oid);
    if (row?.pack_id !== packId || row.type !== TYPE_CODE.commit) continue;
    stack.push(...parseCommit((await store.load(oid)).data).parents);
  }
  return false;
}

export async function receivePack(
  store: Store,
  body: ReadableStream<Uint8Array>,
  contentLength: number | undefined,
  yieldEvery?: () => Promise<void>,
): Promise<{ report: Uint8Array; garbage: boolean }> {
  const reader = new StreamReader(body.getReader());
  const commands: Command[] = [];
  let caps = new Set<string>();
  for (;;) {
    const p = await reader.readPacket();
    if (!p || p.kind === "flush") break;
    if (p.kind !== "data") throw new ProtocolError("unexpected delim");
    let line = p.line;
    const nul = line.indexOf("\0");
    if (nul !== -1) {
      caps = new Set(line.slice(nul + 1).trim().split(" "));
      line = line.slice(0, nul);
    }
    // A shallow clone sends its shallow boundary when pushing. The server has full history and doesn't
    // need it; if new objects reference something the server lacks, the connectivity check rejects them.
    if (line.startsWith("shallow ")) continue;
    commands.push(parseCommand(line));
  }

  let unpackError: string | null = null;
  let packId: number | null = null;
  if (commands.some((c) => c.new !== ZERO_OID)) {
    try {
      packId = await ingestPack(store, reader.rest(), contentLength, yieldEvery);
    } catch (e) {
      // Whatever layer a bad pack fails in, report it to git through the protocol rather than as HTTP 500.
      unpackError = e instanceof Error ? e.message : String(e);
    }
  } else {
    for await (const _ of reader.rest());
  }

  const results = unpackError
    ? new Map(commands.map((c) => [c.ref, "unpacker error"]))
    : updateRefs(store, commands, caps.has("atomic"));

  const report = [pkt(`unpack ${unpackError ?? "ok"}\n`)];
  for (const cmd of commands) {
    const err = results.get(cmd.ref);
    report.push(pkt(err ? `ng ${cmd.ref} ${err}\n` : `ok ${cmd.ref}\n`));
  }
  report.push(FLUSH);
  const garbage = await mayLeaveGarbage(store, commands, results, packId);
  if (!caps.has("side-band-64k")) return { report: concat(report), garbage };
  return { report: concat([...sideband(1, concat(report)), FLUSH]), garbage };
}
