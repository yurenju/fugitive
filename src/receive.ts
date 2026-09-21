// push（receive-pack）：收 pack、建目錄、檢查連通性，最後才移動 ref。
import { createHash } from "node:crypto";
import {
  applyDelta,
  bytesToHex,
  CODE_TYPE,
  hashObject,
  isOid,
  objectHeader,
  OFS_DELTA,
  REF_DELTA,
  referencedOids,
  TYPE_CODE,
  ZERO_OID,
  type ObjectType,
} from "./objects";
import { concat, FLUSH, pkt, ProtocolError, sideband, StreamReader } from "./pktline";
import { SQLITE_PACK_LIMIT, type Store } from "./store";

/** Cloudflare 對 request body 的上限；超過的在平台那層就會被擋，這裡再保險一次。 */
export const MAX_PUSH_BYTES = 100 * 1024 * 1024;
/** 比這個大的 blob 解壓時只算 hash、不留在記憶體裡。 */
const KEEP_LIMIT = 4 * 1024 * 1024;

export const RECEIVE_CAPABILITIES = "report-status delete-refs side-band-64k ofs-delta atomic object-format=sha1";

export interface Command {
  old: string;
  new: string;
  ref: string;
}

export class UnpackError extends Error {}

/** 依 git check-ref-format 的規則檢查 ref 名稱。 */
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
 * 把 push 的 pack 收進來：先原樣存好並驗 checksum，
 * 再從存好的地方一個物件一個物件讀回來，算出 oid、寫進目錄。
 * 回傳 pack 的 id；pack 是空的（例如只刪分支）就回傳 null。
 */
export async function ingestPack(
  store: Store,
  body: AsyncIterable<Uint8Array>,
  contentLength: number | undefined,
  yieldEvery: () => Promise<void> = async () => {},
): Promise<number | null> {
  // 第一步：存 bytes，同時算 checksum（最後 20 bytes 是 checksum 本身，不算進去）。
  const location = contentLength !== undefined && contentLength < SQLITE_PACK_LIMIT ? "sqlite" : "r2";
  const writer = await store.createPack(location);
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

  store.startIndexing(packId);
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

  /** delta 的底稿找得到就還原並記下來；找不到就回傳 false，留到後面再試。 */
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

  // 第二步：照順序掃一遍。
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
        // 大 blob：邊解壓邊算 hash，不整個留在記憶體。
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

  // 第三步：底稿之前還沒出現的 delta，反覆試到沒有進展為止。
  // thin pack 的底稿在伺服器上別的 pack 裡，store.has() 找得到，第二步就解掉了；
  // 留到這裡的是底稿排在同一個 pack 後面的。
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

  // 連通性：這個 pack 裡的物件引用到的東西，都要在這個儲存庫裡。
  // 之前存進來的物件已經檢查過，所以不必往下走。
  const missing = store.finishIndexing(packId);
  if (missing) throw new UnpackError(`missing object ${missing}`);
}

function parseCommand(line: string): Command {
  const [old, next, ref] = line.split(" ");
  if (!isOid(old) || !isOid(next) || !ref) throw new ProtocolError(`bad command: ${line}`);
  return { old, new: next, ref };
}

/**
 * 移動 ref 的唯一入口：ref 還指在預期的物件上才准移動（之後 MCP 的 commit 也走這裡）。
 * atomic 時先全部檢查過，全部通過才一起寫。回傳每條 ref 的結果，null 代表成功。
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
    // 空儲存庫第一次 push：有推 main 就讓 HEAD 指向 main，否則指向這次推的第一條分支。
    if (!store.head()) {
      const created = commands.filter((c) => result.get(c.ref) === null && c.new !== ZERO_OID && c.ref.startsWith("refs/heads/"));
      const head = created.find((c) => c.ref === "refs/heads/main") ?? created[0];
      if (head) store.setHead(head.ref);
    }
    return result;
  });
}

export async function receivePack(
  store: Store,
  body: ReadableStream<Uint8Array>,
  contentLength: number | undefined,
  yieldEvery?: () => Promise<void>,
): Promise<Uint8Array> {
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
    // shallow clone push 時會附上自己的 shallow 邊界。伺服器有完整的歷史，所以不需要它；
    // 新的物件引用到伺服器沒有的東西時，連通性檢查會擋下來。
    if (line.startsWith("shallow ")) continue;
    commands.push(parseCommand(line));
  }

  let unpackError: string | null = null;
  if (commands.some((c) => c.new !== ZERO_OID)) {
    try {
      await ingestPack(store, reader.rest(), contentLength, yieldEvery);
    } catch (e) {
      // 壞掉的 pack 不管錯在哪一層，都照協定回報給 git，而不是變成 HTTP 500。
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
  if (!caps.has("side-band-64k")) return concat(report);
  return concat([...sideband(1, concat(report)), FLUSH]);
}
