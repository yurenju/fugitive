// A Repository's data (ADR 0003): pushed packs are kept as-is, small ones in SQLite and large ones in R2.
// SQLite also holds the index (which pack and offset each object is at) and the refs.
import { Inflate, inflate } from "pako";
import { applyDelta, CODE_TYPE, type ObjectType } from "./objects";

/** Packs are stored in SQLite as 1 MB rows; reads use 1 MB blocks for both backends. */
export const BLOCK_SIZE = 1024 * 1024;
/** A push with a Content-Length below this stores its pack in SQLite. */
export const SQLITE_PACK_LIMIT = 16 * 1024 * 1024;
/** R2's list and delete both take at most 1000 keys at a time. */
export const R2_BATCH = 1000;
/** R2 multipart part size (every part but the last must be the same size). */
const R2_PART_SIZE = 8 * 1024 * 1024;

const BLOCK_CACHE_BLOCKS = 16;
const OBJECT_CACHE_BYTES = 24 * 1024 * 1024;

export type PackLocation = "sqlite" | "r2";

export type ObjectRow = {
  oid: string;
  pack_id: number;
  /** Resolved object type (1–4) */
  type: number;
  /** Type as stored in the pack: 1–4, or 6 (ofs-delta), 7 (ref-delta) */
  entry_type: number;
  /** Size from the pack entry header (for a delta, the size of the delta data) */
  entry_size: number;
  data_offset: number;
  data_len: number;
  base_oid: string | null;
};

export interface GitObject {
  type: ObjectType;
  data: Uint8Array;
}

export class StoreError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS packs (id INTEGER PRIMARY KEY, location TEXT NOT NULL, size INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS pack_chunks (pack_id INTEGER NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (pack_id, seq));
CREATE TABLE IF NOT EXISTS objects (
  oid TEXT PRIMARY KEY, pack_id INTEGER NOT NULL, type INTEGER NOT NULL, entry_type INTEGER NOT NULL,
  entry_size INTEGER NOT NULL, data_offset INTEGER NOT NULL, data_len INTEGER NOT NULL, base_oid TEXT);
CREATE INDEX IF NOT EXISTS objects_pack ON objects (pack_id);
CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, oid TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_references (oid TEXT PRIMARY KEY);
`;

/** GC's bookkeeping in the meta table (see gc.ts). */
const LAST_PACK_ID = "last_pack_id";
const CHANGES = "changes";
const GC_AT = "gc_at";
const DELETING = "deleting";

/** An LRU built on Map insertion order, bounded by total bytes. */
class Lru<V> {
  private map = new Map<string, { value: V; size: number }>();
  private total = 0;
  constructor(private budget: number) {}
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key: string, value: V, size: number) {
    if (size > this.budget / 4) return;
    const old = this.map.get(key);
    if (old) {
      this.total -= old.size;
      this.map.delete(key);
    }
    this.map.set(key, { value, size });
    this.total += size;
    for (const [k, e] of this.map) {
      if (this.total <= this.budget) break;
      this.map.delete(k);
      this.total -= e.size;
    }
  }
  delete(key: string) {
    const e = this.map.get(key);
    if (e) {
      this.total -= e.size;
      this.map.delete(key);
    }
  }
}

export class Store {
  readonly sql: SqlStorage;
  private blocks = new Lru<Uint8Array>(BLOCK_CACHE_BLOCKS * BLOCK_SIZE);
  private objects = new Lru<GitObject>(OBJECT_CACHE_BYTES);
  private packInfo = new Map<number, { location: PackLocation; size: number }>();
  /** The pack being indexed. Its objects must be visible while indexing (as delta bases) but it is not complete yet. */
  private indexing = -1;
  /**
   * The pack GC is writing. It is incomplete like a dead push's, but GC runs outside the push queue, so the next
   * push must leave it alone. Memory is enough: if the Durable Object restarts, GC dies with it.
   */
  gcPack = -1;

  constructor(
    private storage: DurableObjectStorage,
    private bucket: R2Bucket,
    /** R2 key prefix; the Durable Object id keeps Repositories apart */
    private prefix: string,
  ) {
    this.sql = storage.sql;
    this.sql.exec(SCHEMA);
    // Added with GC; Repositories created before it lack the column. null = in use, else when GC retired the pack.
    const packs = this.sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'packs'").one().sql;
    if (!packs.includes("retired_at")) this.sql.exec("ALTER TABLE packs ADD COLUMN retired_at INTEGER");
  }

  r2Key(packId: number): string {
    return `${this.prefix}/packs/${packId}.pack`;
  }

  // ---- ref ----

  refs(): Map<string, string> {
    const out = new Map<string, string>();
    for (const row of this.sql.exec<{ name: string; oid: string }>("SELECT name, oid FROM refs ORDER BY name")) {
      out.set(row.name, row.oid);
    }
    return out;
  }

  ref(name: string): string | undefined {
    return this.sql.exec<{ oid: string }>("SELECT oid FROM refs WHERE name = ?", name).toArray()[0]?.oid;
  }

  head(): string | undefined {
    return this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'HEAD'").toArray()[0]?.value;
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  /** Every ref write goes through here, so it also counts as a change for GC. */
  setRef(name: string, oid: string | null) {
    if (oid === null) this.sql.exec("DELETE FROM refs WHERE name = ?", name);
    else this.sql.exec("INSERT OR REPLACE INTO refs (name, oid) VALUES (?, ?)", name, oid);
    this.countChange();
  }

  setHead(ref: string) {
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('HEAD', ?)", ref);
  }

  // ---- GC bookkeeping ----

  private meta(key: string): number | undefined {
    const value = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value;
    return value === undefined ? undefined : Number(value);
  }

  private setMeta(key: string, value: number) {
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, String(value));
  }

  /**
   * How many times a ref moved (created, updated, deleted) or a pack became complete. GC gives up if this changes
   * while it prepares: a new complete pack can hold a delta against an object GC is about to delete, even if no ref
   * moved (its push was rejected), and a later push that points a ref at it would pass the connectivity check.
   */
  changes(): number {
    return this.meta(CHANGES) ?? 0;
  }

  private countChange() {
    this.setMeta(CHANGES, this.changes() + 1);
  }

  /** When GC is due, if one is scheduled. */
  gcAt(): number | undefined {
    return this.meta(GC_AT);
  }

  setGcAt(time: number) {
    this.setMeta(GC_AT, time);
  }

  /** Unschedule GC, unless a push has pushed it back since `time` was read. */
  clearGcAt(time: number) {
    this.sql.exec("DELETE FROM meta WHERE key = ? AND value = ?", GC_AT, String(time));
  }

  deleting(): boolean {
    return this.meta(DELETING) !== undefined;
  }

  markDeleting() {
    this.setMeta(DELETING, 1);
  }

  /** When the longest-retired pack was retired. */
  oldestRetired(): number | undefined {
    return this.sql.exec<{ t: number | null }>("SELECT min(retired_at) AS t FROM packs").one().t ?? undefined;
  }

  /** Delete the bytes and rows of packs retired at or before `time`, one R2 batch at a time. */
  async deleteRetired(time: number) {
    const due = this.sql
      .exec<{ id: number; location: PackLocation }>(
        "SELECT id, location FROM packs WHERE retired_at <= ? ORDER BY retired_at LIMIT ?",
        time,
        R2_BATCH,
      )
      .toArray();
    const keys = due.filter((p) => p.location === "r2").map((p) => this.r2Key(p.id));
    // R2 first: if it fails, the rows stay and the next alarm tries again.
    if (keys.length) await this.bucket.delete(keys);
    for (const { id } of due) this.forgetPack(id);
  }

  /** Delete the R2 files of this Repository that no row in packs knows about. Returns how many. */
  async deleteOrphanedR2(): Promise<number> {
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const listed = await this.bucket.list({ prefix: `${this.prefix}/packs/`, cursor, limit: R2_BATCH });
      const orphans = listed.objects
        .map((o) => o.key)
        .filter((key) => {
          const id = /\/(\d+)\.pack$/.exec(key)?.[1];
          return id !== undefined && !this.sql.exec("SELECT 1 FROM packs WHERE id = ?", Number(id)).toArray().length;
        });
      if (orphans.length) await this.bucket.delete(orphans);
      deleted += orphans.length;
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return deleted;
  }

  /** The packs GC looks at: complete and not retired. */
  livePacks(): number[] {
    return this.sql
      .exec<{ id: number }>("SELECT id FROM packs WHERE complete = 1 AND retired_at IS NULL ORDER BY id")
      .toArray()
      .map((r) => r.id);
  }

  /** Index rows of the live packs, in pack order. */
  liveRows(): ObjectRow[] {
    return this.sql
      .exec<ObjectRow>(
        `SELECT o.* FROM objects o JOIN packs p ON p.id = o.pack_id
         WHERE p.complete = 1 AND p.retired_at IS NULL ORDER BY o.pack_id, o.data_offset`,
      )
      .toArray();
  }

  /** Point an object's index row at its copy in another pack. */
  moveObject(oid: string, from: number, to: { pack_id: number; entry_type: number; data_offset: number }) {
    this.sql.exec(
      "UPDATE objects SET pack_id = ?, entry_type = ?, data_offset = ? WHERE oid = ? AND pack_id = ?",
      to.pack_id,
      to.entry_type,
      to.data_offset,
      oid,
      from,
    );
  }

  deleteObject(oid: string, packId: number) {
    this.sql.exec("DELETE FROM objects WHERE oid = ? AND pack_id = ?", oid, packId);
    this.objects.delete(oid);
  }

  retirePack(packId: number, time: number) {
    this.sql.exec("UPDATE packs SET retired_at = ? WHERE id = ?", time, packId);
  }

  markComplete(packId: number) {
    this.sql.exec("UPDATE packs SET complete = 1 WHERE id = ?", packId);
  }

  // ---- index ----
  // Only objects in complete packs (fully indexed and connectivity-checked) exist.
  // Index rows left by a push that died midway don't count; the next push clears them.

  row(oid: string): ObjectRow | undefined {
    return this.sql
      .exec<ObjectRow>(
        `SELECT o.* FROM objects o JOIN packs p ON p.id = o.pack_id
         WHERE o.oid = ? AND (p.complete = 1 OR p.id = ?)`,
        oid,
        this.indexing,
      )
      .toArray()[0];
  }

  has(oid: string): boolean {
    return this.row(oid) !== undefined;
  }

  typeOf(oid: string): ObjectType | undefined {
    const t = this.row(oid)?.type;
    return t === undefined ? undefined : CODE_TYPE[t];
  }

  /**
   * Start indexing a pack: clear what pushes that died left behind. Pushes are queued, so any other incomplete pack
   * is dead, except the one GC is writing. Their R2 files go too; if that fails, GC's scan of R2 gets them later.
   */
  async startIndexing(packId: number) {
    const stale = this.sql
      .exec<{ id: number; location: PackLocation }>(
        "SELECT id, location FROM packs WHERE complete = 0 AND id != ? AND id != ?",
        packId,
        this.gcPack,
      )
      .toArray();
    for (const { id } of stale) this.forgetPack(id);
    this.sql.exec("DELETE FROM push_references");
    this.indexing = packId;
    const keys = stale.filter((p) => p.location === "r2").map((p) => this.r2Key(p.id));
    if (keys.length) await this.bucket.delete(keys).catch(() => {});
  }

  /** Delete a pack's rows (not its R2 file). */
  private forgetPack(packId: number) {
    for (const { oid } of this.sql.exec<{ oid: string }>("SELECT oid FROM objects WHERE pack_id = ?", packId).toArray()) {
      this.objects.delete(oid);
    }
    this.sql.exec("DELETE FROM objects WHERE pack_id = ?", packId);
    this.sql.exec("DELETE FROM pack_chunks WHERE pack_id = ?", packId);
    this.sql.exec("DELETE FROM packs WHERE id = ?", packId);
    this.packInfo.delete(packId);
  }

  addObject(row: ObjectRow) {
    this.sql.exec(
      `INSERT OR IGNORE INTO objects (oid, pack_id, type, entry_type, entry_size, data_offset, data_len, base_oid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.oid,
      row.pack_id,
      row.type,
      row.entry_type,
      row.entry_size,
      row.data_offset,
      row.data_len,
      row.base_oid,
    );
  }

  /** Record an object referenced from this pack; they are all checked for existence at the end. */
  addReference(oid: string) {
    this.sql.exec("INSERT OR IGNORE INTO push_references (oid) VALUES (?)", oid);
  }

  /** Mark the pack complete if connectivity holds; return the first missing object, or undefined. */
  finishIndexing(packId: number): string | undefined {
    const missing = this.sql
      .exec<{ oid: string }>(
        `SELECT r.oid FROM push_references r WHERE NOT EXISTS (
           SELECT 1 FROM objects o JOIN packs p ON p.id = o.pack_id
           WHERE o.oid = r.oid AND (p.complete = 1 OR p.id = ?)) LIMIT 1`,
        packId,
      )
      .toArray()[0]?.oid;
    this.sql.exec("DELETE FROM push_references");
    if (!missing) {
      this.markComplete(packId);
      this.countChange();
    }
    this.indexing = -1;
    return missing;
  }

  // ---- pack bytes ----

  private pack(packId: number) {
    let info = this.packInfo.get(packId);
    if (!info) {
      const row = this.sql
        .exec<{ location: PackLocation; size: number }>("SELECT location, size FROM packs WHERE id = ?", packId)
        .toArray()[0];
      if (!row) throw new StoreError(`pack ${packId} not found`);
      info = row;
      this.packInfo.set(packId, info);
    }
    return info;
  }

  private async block(packId: number, index: number): Promise<Uint8Array> {
    const key = `${packId}:${index}`;
    const cached = this.blocks.get(key);
    if (cached) return cached;
    const { location, size } = this.pack(packId);
    let data: Uint8Array;
    if (location === "sqlite") {
      const row = this.sql
        .exec<{ data: ArrayBuffer }>("SELECT data FROM pack_chunks WHERE pack_id = ? AND seq = ?", packId, index)
        .toArray()[0];
      if (!row) throw new StoreError(`pack ${packId} block ${index} missing`);
      data = new Uint8Array(row.data);
    } else {
      const offset = index * BLOCK_SIZE;
      const obj = await this.bucket.get(this.r2Key(packId), {
        range: { offset, length: Math.min(BLOCK_SIZE, size - offset) },
      });
      if (!obj) throw new StoreError(`pack ${packId} missing in R2`);
      data = new Uint8Array(await obj.arrayBuffer());
    }
    this.blocks.set(key, data, data.length);
    return data;
  }

  /** Bytes from offset to the end of its 1 MB block. */
  async readFrom(packId: number, offset: number): Promise<Uint8Array> {
    if (offset >= this.pack(packId).size) return new Uint8Array(0);
    const block = await this.block(packId, Math.floor(offset / BLOCK_SIZE));
    return block.subarray(offset % BLOCK_SIZE);
  }

  async read(packId: number, offset: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const chunk = await this.readFrom(packId, offset + done);
      if (!chunk.length) throw new StoreError("read past end of pack");
      const n = Math.min(chunk.length, length - done);
      out.set(chunk.subarray(0, n), done);
      done += n;
    }
    return out;
  }

  /**
   * Inflate a zlib stream starting at offset. Its compressed length isn't known up front,
   * so feed it block by block until zlib reports the end; return how many bytes it consumed.
   */
  async inflateAt(
    packId: number,
    offset: number,
    onData?: (chunk: Uint8Array) => void,
  ): Promise<{ data: Uint8Array; consumed: number }> {
    const inf = new Inflate({ chunkSize: 16384 });
    if (onData) inf.onData = onData;
    let pos = offset;
    while (!inf.ended) {
      const chunk = await this.readFrom(packId, pos);
      if (!chunk.length) throw new StoreError("truncated pack entry");
      inf.push(chunk, false);
      pos += chunk.length;
    }
    if (inf.err) throw new StoreError(`zlib: ${inf.msg}`);
    // pako's types hide strm, but it is zlib's z_stream; total_in is the compressed bytes consumed.
    const consumed = (inf as unknown as { strm: { total_in: number } }).strm.total_in;
    return { data: onData ? new Uint8Array(0) : inf.result, consumed };
  }

  /** The object's raw compressed data in its pack. */
  async raw(row: ObjectRow): Promise<Uint8Array> {
    return this.read(row.pack_id, row.data_offset, row.data_len);
  }

  /** Same, yielded block by block (clones copy it as-is without holding a large object in memory). */
  async *rawChunks(row: ObjectRow): AsyncGenerator<Uint8Array> {
    let done = 0;
    while (done < row.data_len) {
      const chunk = await this.readFrom(row.pack_id, row.data_offset + done);
      if (!chunk.length) throw new StoreError("read past end of pack");
      const piece = chunk.subarray(0, row.data_len - done);
      done += piece.length;
      yield piece;
    }
  }

  // ---- reading objects ----

  remember(oid: string, obj: GitObject) {
    this.objects.set(oid, obj, obj.data.length);
  }

  // ponytail: holds the whole object in memory; tight for single objects of tens of MB, stream it then.
  async load(oid: string): Promise<GitObject> {
    const cached = this.objects.get(oid);
    if (cached) return cached;
    const row = this.row(oid);
    if (!row) throw new StoreError(`object ${oid} not found`);
    const raw = inflate(await this.raw(row));
    let data: Uint8Array;
    if (row.entry_type <= 4) {
      data = raw;
    } else {
      if (!row.base_oid) throw new StoreError(`delta ${oid} without base`);
      data = applyDelta((await this.load(row.base_oid)).data, raw);
    }
    const obj = { type: CODE_TYPE[row.type], data };
    this.remember(oid, obj);
    return obj;
  }

  // ---- writing packs ----

  /**
   * Create a pack and return its writer. The caller picks the location by size.
   * Ids are never reused: R2 keys are made from them, and a retired pack's file is only deleted an hour later.
   */
  createPack(location: PackLocation): PackWriter {
    const id = Math.max(this.meta(LAST_PACK_ID) ?? 0, this.sql.exec<{ id: number | null }>("SELECT max(id) AS id FROM packs").one().id ?? 0) + 1;
    this.sql.exec("INSERT INTO packs (id, location, size) VALUES (?, ?, 0)", id, location);
    this.setMeta(LAST_PACK_ID, id);
    return location === "sqlite" ? new SqlitePackWriter(this, id) : new R2PackWriter(this, id, this.bucket);
  }

  finishPack(packId: number, size: number) {
    this.sql.exec("UPDATE packs SET size = ? WHERE id = ?", size, packId);
    this.packInfo.delete(packId);
  }

  /** Clean up what a failed push left behind (best effort). */
  async discardPack(packId: number) {
    const location = this.sql.exec<{ location: string }>("SELECT location FROM packs WHERE id = ?", packId).toArray()[0]?.location;
    this.forgetPack(packId);
    if (this.indexing === packId) this.indexing = -1;
    if (this.gcPack === packId) this.gcPack = -1;
    if (location === "r2") await this.bucket.delete(this.r2Key(packId)).catch(() => {});
  }
}

export interface PackWriter {
  readonly id: number;
  write(chunk: Uint8Array): Promise<void>;
  /** Finish writing; returns the total size. */
  close(): Promise<number>;
  abort(): Promise<void>;
}

class SqlitePackWriter implements PackWriter {
  private buf = new Uint8Array(BLOCK_SIZE);
  private filled = 0;
  private seq = 0;
  private size = 0;
  constructor(
    private store: Store,
    readonly id: number,
  ) {}

  private flush() {
    if (!this.filled) return;
    this.store.sql.exec(
      "INSERT INTO pack_chunks (pack_id, seq, data) VALUES (?, ?, ?)",
      this.id,
      this.seq++,
      this.buf.slice(0, this.filled),
    );
    this.filled = 0;
  }

  async write(chunk: Uint8Array) {
    this.size += chunk.length;
    let pos = 0;
    while (pos < chunk.length) {
      const n = Math.min(BLOCK_SIZE - this.filled, chunk.length - pos);
      this.buf.set(chunk.subarray(pos, pos + n), this.filled);
      this.filled += n;
      pos += n;
      if (this.filled === BLOCK_SIZE) this.flush();
    }
  }

  async close() {
    this.flush();
    this.store.finishPack(this.id, this.size);
    return this.size;
  }

  async abort() {
    await this.store.discardPack(this.id);
  }
}

class R2PackWriter implements PackWriter {
  private upload?: R2MultipartUpload;
  private parts: R2UploadedPart[] = [];
  private buf = new Uint8Array(R2_PART_SIZE);
  private filled = 0;
  private size = 0;
  constructor(
    private store: Store,
    readonly id: number,
    private bucket: R2Bucket,
  ) {}

  private async flush() {
    if (!this.filled) return;
    this.upload ??= await this.bucket.createMultipartUpload(this.store.r2Key(this.id));
    this.parts.push(await this.upload.uploadPart(this.parts.length + 1, this.buf.slice(0, this.filled)));
    this.filled = 0;
  }

  async write(chunk: Uint8Array) {
    this.size += chunk.length;
    let pos = 0;
    while (pos < chunk.length) {
      const n = Math.min(R2_PART_SIZE - this.filled, chunk.length - pos);
      this.buf.set(chunk.subarray(pos, pos + n), this.filled);
      this.filled += n;
      pos += n;
      if (this.filled === R2_PART_SIZE) await this.flush();
    }
  }

  async close() {
    if (!this.upload) {
      // The whole pack fits in one part, so a plain put will do.
      await this.bucket.put(this.store.r2Key(this.id), this.buf.slice(0, this.filled));
    } else {
      await this.flush();
      await this.upload.complete(this.parts);
    }
    this.store.finishPack(this.id, this.size);
    return this.size;
  }

  async abort() {
    await this.upload?.abort().catch(() => {});
    await this.store.discardPack(this.id);
  }
}
