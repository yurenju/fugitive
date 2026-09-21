// 一個儲存庫的資料（ADR 0003）：pack 原樣保存，小的放 SQLite、大的放 R2；
// SQLite 另外記「目錄」（每個物件在哪個 pack 的哪個位置）和 ref。
import { Inflate, inflate } from "pako";
import { applyDelta, CODE_TYPE, type ObjectType } from "./objects";

/** pack 在 SQLite 裡切成 1 MB 一列；讀的時候兩邊都以 1 MB 為單位。 */
export const BLOCK_SIZE = 1024 * 1024;
/** 有 Content-Length 而且比這個小的 push，pack 放 SQLite。 */
export const SQLITE_PACK_LIMIT = 16 * 1024 * 1024;
/** R2 multipart 每一段的大小（除了最後一段，每段要一樣大）。 */
const R2_PART_SIZE = 8 * 1024 * 1024;

const BLOCK_CACHE_BLOCKS = 16;
const OBJECT_CACHE_BYTES = 24 * 1024 * 1024;

export type PackLocation = "sqlite" | "r2";

export type ObjectRow = {
  oid: string;
  pack_id: number;
  /** 還原之後的型別（1–4） */
  type: number;
  /** pack 裡記的型別：1–4，或 6（ofs-delta）、7（ref-delta） */
  entry_type: number;
  /** pack 標頭裡的長度（delta 的話是 delta 資料的長度） */
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

/** 用 Map 的插入順序做的 LRU，依 byte 數限制大小。 */
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
  /** 正在建目錄的 pack。它的物件在建目錄時就要查得到（delta 的底稿），但還不算完整。 */
  private indexing = -1;

  constructor(
    private storage: DurableObjectStorage,
    private bucket: R2Bucket,
    /** R2 key 的前綴，用 Durable Object 的 id 分開各個儲存庫 */
    private prefix: string,
  ) {
    this.sql = storage.sql;
    this.sql.exec(SCHEMA);
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

  setRef(name: string, oid: string | null) {
    if (oid === null) this.sql.exec("DELETE FROM refs WHERE name = ?", name);
    else this.sql.exec("INSERT OR REPLACE INTO refs (name, oid) VALUES (?, ?)", name, oid);
  }

  setHead(ref: string) {
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('HEAD', ?)", ref);
  }

  // ---- 目錄 ----
  // 只有「完整」的 pack（建完目錄、通過連通性檢查）裡的物件才算存在。
  // push 做到一半當掉時留下的目錄紀錄不算，下一次 push 開始時清掉。

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

  /** 開始替一個 pack 建目錄：清掉之前當掉的 push 留下的紀錄（R2 上的 pack 本身不清）。 */
  startIndexing(packId: number) {
    const stale = this.sql.exec<{ id: number }>("SELECT id FROM packs WHERE complete = 0 AND id != ?", packId).toArray();
    for (const { id } of stale) {
      this.sql.exec("DELETE FROM objects WHERE pack_id = ?", id);
      this.sql.exec("DELETE FROM pack_chunks WHERE pack_id = ?", id);
      this.sql.exec("DELETE FROM packs WHERE id = ?", id);
    }
    this.sql.exec("DELETE FROM push_references");
    this.indexing = packId;
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

  /** 記下這個 pack 裡的物件引用到的物件，最後一次檢查是否都存在。 */
  addReference(oid: string) {
    this.sql.exec("INSERT OR IGNORE INTO push_references (oid) VALUES (?)", oid);
  }

  /** 連通性檢查通過就把 pack 標成完整；回傳第一個找不到的物件，全部都在就回傳 undefined。 */
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
    if (!missing) this.sql.exec("UPDATE packs SET complete = 1 WHERE id = ?", packId);
    this.indexing = -1;
    return missing;
  }

  // ---- pack 的內容 ----

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

  /** 從 offset 開始、到那個 1 MB 區塊結尾為止的 bytes。 */
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
   * 從 offset 開始解壓一段 zlib 資料。壓縮後的長度事先不知道，
   * 所以一個區塊一個區塊餵進去，直到 zlib 說結束；回傳實際吃掉的 bytes 數。
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
    // pako 的型別沒有公開 strm，但它就是 zlib 的 z_stream；total_in 是吃掉的壓縮 bytes 數。
    const consumed = (inf as unknown as { strm: { total_in: number } }).strm.total_in;
    return { data: onData ? new Uint8Array(0) : inf.result, consumed };
  }

  /** 這個物件在 pack 裡的原始壓縮資料。 */
  async raw(row: ObjectRow): Promise<Uint8Array> {
    return this.read(row.pack_id, row.data_offset, row.data_len);
  }

  /** 同上，但一個區塊一個區塊交出來（clone 時直接複製，大物件也不必整個放進記憶體）。 */
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

  // ---- 讀物件 ----

  remember(oid: string, obj: GitObject) {
    this.objects.set(oid, obj, obj.data.length);
  }

  // ponytail: 整個物件放進記憶體；單一物件大到幾十 MB 時會吃緊，到時改成串流還原。
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

  // ---- 寫 pack ----

  /** 開一個新的 pack 並回傳寫入器。放哪裡由呼叫的人依大小決定。 */
  async createPack(location: PackLocation): Promise<PackWriter> {
    const id = this.sql.exec<{ id: number }>("INSERT INTO packs (location, size) VALUES (?, 0) RETURNING id", location).one().id;
    return location === "sqlite" ? new SqlitePackWriter(this, id) : new R2PackWriter(this, id, this.bucket);
  }

  finishPack(packId: number, size: number) {
    this.sql.exec("UPDATE packs SET size = ? WHERE id = ?", size, packId);
    this.packInfo.delete(packId);
  }

  /** 一次 push 失敗時，把它留下的東西清掉（能清多少清多少）。 */
  async discardPack(packId: number) {
    const location = this.sql.exec<{ location: string }>("SELECT location FROM packs WHERE id = ?", packId).toArray()[0]?.location;
    for (const { oid } of this.sql.exec<{ oid: string }>("SELECT oid FROM objects WHERE pack_id = ?", packId).toArray()) {
      this.objects.delete(oid);
    }
    this.sql.exec("DELETE FROM objects WHERE pack_id = ?", packId);
    this.sql.exec("DELETE FROM pack_chunks WHERE pack_id = ?", packId);
    this.sql.exec("DELETE FROM packs WHERE id = ?", packId);
    this.packInfo.delete(packId);
    if (this.indexing === packId) this.indexing = -1;
    if (location === "r2") await this.bucket.delete(this.r2Key(packId)).catch(() => {});
  }
}

export interface PackWriter {
  readonly id: number;
  write(chunk: Uint8Array): Promise<void>;
  /** 寫完，回傳總長度。 */
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
      // 整個 pack 不到一段，直接 put 就好。
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
