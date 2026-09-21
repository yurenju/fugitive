// clone／fetch（upload-pack），v0 與 v2。
import { createHash } from "node:crypto";
import { deflate } from "pako";
import {
  hexToBytes,
  isGitlink,
  isOid,
  packEntryHeader,
  parseCommit,
  parseTag,
  parseTree,
  REF_DELTA,
  TYPE_CODE,
  type Commit,
} from "./objects";
import { concat, DELIM, FLUSH, pkt, ProtocolError, sideband, type Packet } from "./pktline";
import type { Store } from "./store";

export const AGENT = "agent=fugitive/0.1";
export const UPLOAD_CAPABILITIES_V0 =
  "multi_ack_detailed side-band-64k ofs-delta shallow deepen-relative include-tag no-progress object-format=sha1";
export const V2_CAPABILITIES = ["version 2", AGENT, "ls-refs=unborn", "fetch=shallow", "object-format=sha1"];

/** v0 的 deepen 用這個數字代表「全部」（`git fetch --unshallow`）。 */
const INFINITE_DEPTH = 0x7fffffff;

interface FetchRequest {
  wants: string[];
  haves: string[];
  clientShallow: Set<string>;
  depth?: number;
  deepenRelative: boolean;
  includeTag: boolean;
  noProgress: boolean;
  done: boolean;
}

class Walker {
  private commits = new Map<string, Commit>();
  constructor(private store: Store) {}

  async commit(oid: string): Promise<Commit> {
    let c = this.commits.get(oid);
    if (!c) {
      const obj = await this.store.load(oid);
      if (obj.type !== "commit") throw new ProtocolError(`${oid} is not a commit`);
      c = parseCommit(obj.data);
      this.commits.set(oid, c);
    }
    return c;
  }

  /** 沿著 tag 往下剝，回傳途中的 tag 物件和最後指到的物件。 */
  async peel(oid: string): Promise<{ tags: string[]; target: string }> {
    const tags: string[] = [];
    while (this.store.typeOf(oid) === "tag") {
      tags.push(oid);
      oid = parseTag((await this.store.load(oid)).data).object;
    }
    return { tags, target: oid };
  }
}

interface Selection {
  objects: string[];
  shallow: string[];
  unshallow: string[];
}

/** 決定要送哪些物件：wants 能走到、而 client 手上還沒有的。 */
async function select(store: Store, req: FetchRequest): Promise<Selection> {
  const walk = new Walker(store);
  const wantCommits: string[] = [];
  const send: string[] = [];
  const sending = new Set<string>();
  const add = (oid: string) => {
    if (!sending.has(oid)) {
      sending.add(oid);
      send.push(oid);
    }
  };
  const rootTrees: string[] = [];
  for (const want of req.wants) {
    const { tags, target } = await walk.peel(want);
    tags.forEach(add);
    const type = store.typeOf(target);
    if (type === "commit") wantCommits.push(target);
    else if (type === "tree") rootTrees.push(target);
    else if (type === "blob") add(target);
  }

  // shallow：新的邊界在哪、哪些原本的邊界要往下補。
  const shallowNew = new Set<string>();
  const unshallow: string[] = [];
  const extraWants: string[] = [];
  if (req.depth !== undefined) {
    const starts = req.deepenRelative ? [...req.clientShallow].filter((o) => store.has(o)) : wantCommits;
    const limit = req.deepenRelative ? req.depth + 1 : req.depth;
    const depthOf = new Map<string, number>();
    const queue: [string, number][] = starts.map((o) => [o, 1]);
    for (let i = 0; i < queue.length; i++) {
      const [oid, d] = queue[i];
      if (depthOf.has(oid)) continue;
      depthOf.set(oid, d);
      const c = await walk.commit(oid);
      if (d >= limit) {
        if (c.parents.length) shallowNew.add(oid);
      } else {
        for (const p of c.parents) queue.push([p, d + 1]);
      }
    }
    for (const s of req.clientShallow) {
      if (store.has(s) && depthOf.has(s) && !shallowNew.has(s)) {
        unshallow.push(s);
        extraWants.push(...(await walk.commit(s)).parents);
      }
    }
  }
  const unshallowed = new Set(unshallow);
  /** client 那邊這個 commit 沒有 parent（原本的 shallow 邊界，或這次新的邊界）。 */
  const cutOff = (oid: string) => shallowNew.has(oid) || (req.clientShallow.has(oid) && !unshallowed.has(oid));

  // client 已經有的 commit。client 的 shallow 邊界以下它沒有，所以不往下走。
  // ponytail: 每次都走完 haves 的整段歷史；儲存庫大到這裡變慢時，改成照 commit 時間同時走兩邊。
  const theirs = new Set<string>();
  const stack = req.haves.filter((o) => store.typeOf(o) === "commit");
  while (stack.length) {
    const oid = stack.pop()!;
    if (theirs.has(oid)) continue;
    theirs.add(oid);
    if (req.clientShallow.has(oid)) continue;
    for (const p of (await walk.commit(oid)).parents) if (store.has(p)) stack.push(p);
  }

  // 要送的 commit。
  const commits: string[] = [];
  const boundary = new Set<string>();
  const seen = new Set<string>();
  const todo = [...wantCommits, ...extraWants];
  while (todo.length) {
    const oid = todo.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (theirs.has(oid)) {
      boundary.add(oid);
      continue;
    }
    commits.push(oid);
    add(oid);
    if (!cutOff(oid)) todo.push(...(await walk.commit(oid)).parents);
  }

  // tree 和 blob：client 手上那幾個 commit 的 tree 裡有的就不送。
  const excluded = new Set<string>();
  const walkTree = async (oid: string, visit: (oid: string) => boolean) => {
    if (!visit(oid)) return;
    for (const e of parseTree((await store.load(oid)).data)) {
      if (isGitlink(e.mode)) continue;
      if (e.mode === "40000") await walkTree(e.oid, visit);
      else visit(e.oid);
    }
  };
  const exclude = (oid: string) => {
    if (excluded.has(oid)) return false;
    excluded.add(oid);
    return true;
  };
  for (const b of boundary) await walkTree((await walk.commit(b)).tree, exclude);
  const include = (oid: string) => {
    if (excluded.has(oid) || sending.has(oid)) return false;
    add(oid);
    return true;
  };
  for (const c of commits) await walkTree((await walk.commit(c)).tree, include);
  for (const t of rootTrees) await walkTree(t, include);

  // include-tag：附註 tag 指到的東西這次有送，就把 tag 一起送。
  if (req.includeTag) {
    for (const [name, oid] of store.refs()) {
      if (!name.startsWith("refs/tags/") || sending.has(oid)) continue;
      const { tags, target } = await walk.peel(oid);
      if (tags.length && sending.has(target)) tags.forEach(add);
    }
  }

  return {
    objects: send,
    shallow: [...shallowNew].filter((s) => !req.clientShallow.has(s)),
    unshallow,
  };
}

/**
 * 組 pack。原本就不是 delta 的物件，直接複製 pack 裡的壓縮資料；
 * delta 的底稿這次也有送的話，改寫成 ref-delta 照樣複製；其他的還原成完整物件再壓縮。
 */
async function* packStream(store: Store, oids: string[]): AsyncGenerator<Uint8Array> {
  const sha = createHash("sha1");
  const emit = (b: Uint8Array) => {
    sha.update(b);
    return b;
  };
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, oids.length);
  yield emit(header);
  const sending = new Set(oids);
  for (const oid of oids) {
    const row = store.row(oid);
    if (!row) throw new Error(`object ${oid} vanished`);
    if (row.entry_type <= 4) {
      yield emit(packEntryHeader(row.entry_type, row.entry_size));
      for await (const chunk of store.rawChunks(row)) yield emit(chunk);
    } else if (row.base_oid && sending.has(row.base_oid)) {
      yield emit(packEntryHeader(REF_DELTA, row.entry_size));
      yield emit(hexToBytes(row.base_oid));
      for await (const chunk of store.rawChunks(row)) yield emit(chunk);
    } else {
      const obj = await store.load(oid);
      yield emit(packEntryHeader(TYPE_CODE[obj.type], obj.data.length));
      yield emit(deflate(obj.data));
    }
  }
  yield new Uint8Array(sha.digest());
}

/** 把 pack 包進 side-band（頻道 1），順便在頻道 2 送進度訊息。 */
async function* sidebandPack(store: Store, objects: string[], progress: boolean): AsyncGenerator<Uint8Array> {
  if (progress) yield* sideband(2, `Enumerating objects: ${objects.length}, done.\n`);
  // 小塊合併起來再送，避免每個物件都變成一個封包。
  let buf: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of packStream(store, objects)) {
    buf.push(chunk);
    size += chunk.length;
    if (size >= 60000) {
      yield* sideband(1, concat(buf));
      buf = [];
      size = 0;
    }
  }
  if (size) yield* sideband(1, concat(buf));
  if (progress) yield* sideband(2, `Total ${objects.length} (fugitive)\n`);
}

function checkWants(store: Store, wants: string[]) {
  if (!wants.length) throw new ProtocolError("no wants");
  for (const w of wants) if (!isOid(w) || !store.has(w)) throw new ProtocolError(`not our ref ${w}`);
}

/** 找出 haves 裡伺服器也有的 commit。 */
function commonCommits(store: Store, haves: string[]): string[] {
  return haves.filter((h) => store.typeOf(h) === "commit");
}

function shallowLines(sel: Selection): Uint8Array[] {
  return [...sel.shallow.map((s) => pkt(`shallow ${s}\n`)), ...sel.unshallow.map((s) => pkt(`unshallow ${s}\n`))];
}

function parseDepth(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new ProtocolError(`bad depth ${value}`);
  return n >= INFINITE_DEPTH ? Infinity : n;
}

// ---- v0 ----

export async function* uploadPackV0(store: Store, packets: Packet[]): AsyncGenerator<Uint8Array> {
  const req: FetchRequest = {
    wants: [],
    haves: [],
    clientShallow: new Set(),
    deepenRelative: false,
    includeTag: false,
    noProgress: false,
    done: false,
  };
  let caps = new Set<string>();
  let i = 0;
  for (; i < packets.length; i++) {
    const p = packets[i];
    if (p.kind === "flush") break;
    if (p.kind !== "data") throw new ProtocolError("unexpected delim");
    const [cmd, arg, ...rest] = p.line.split(" ");
    if (cmd === "want") {
      if (!req.wants.length) caps = new Set(rest);
      req.wants.push(arg);
    } else if (cmd === "shallow") req.clientShallow.add(arg);
    else if (cmd === "deepen") req.depth = parseDepth(arg);
    else throw new ProtocolError(`unsupported: ${p.line}`);
  }
  req.deepenRelative = caps.has("deepen-relative");
  req.includeTag = caps.has("include-tag");
  req.noProgress = caps.has("no-progress");
  checkWants(store, req.wants);
  const hasHaveSection = i + 1 < packets.length;
  for (i++; i < packets.length; i++) {
    const p = packets[i];
    if (p.kind === "data" && p.line.startsWith("have ")) req.haves.push(p.line.slice(5));
    else if (p.kind === "data" && p.line === "done") req.done = true;
  }

  const sel = req.depth !== undefined || req.done ? await select(store, req) : undefined;
  // 無狀態的 HTTP 上，client 每一輪都重送 deepen，所以每一輪的回應都先附上 shallow 清單。
  if (req.depth !== undefined) yield* [...shallowLines(sel!), FLUSH];
  if (!hasHaveSection) return;

  const common = commonCommits(store, req.haves);
  if (!req.done) {
    for (const c of common) yield pkt(`ACK ${c} common\n`);
    if (common.length) yield pkt(`ACK ${common[common.length - 1]} ready\n`);
    yield pkt("NAK\n");
    return;
  }
  yield pkt(common.length ? `ACK ${common[common.length - 1]}\n` : "NAK\n");
  if (caps.has("side-band-64k")) {
    yield* sidebandPack(store, sel!.objects, !req.noProgress);
    yield FLUSH;
  } else {
    yield* packStream(store, sel!.objects);
  }
}

// ---- v2 ----

async function* lsRefs(store: Store, args: string[]): AsyncGenerator<Uint8Array> {
  const symrefs = args.includes("symrefs");
  const peel = args.includes("peel");
  const unborn = args.includes("unborn");
  const prefixes = args.filter((a) => a.startsWith("ref-prefix ")).map((a) => a.slice(11));
  const match = (name: string) => !prefixes.length || prefixes.some((p) => name.startsWith(p));
  const refs = store.refs();
  const walk = new Walker(store);
  const head = store.head();
  if (head && match("HEAD")) {
    const oid = refs.get(head);
    if (oid) yield pkt(`${oid} HEAD${symrefs ? ` symref-target:${head}` : ""}\n`);
    else if (unborn) yield pkt(`unborn HEAD${symrefs ? ` symref-target:${head}` : ""}\n`);
  }
  for (const [name, oid] of refs) {
    if (!match(name)) continue;
    let line = `${oid} ${name}`;
    if (peel && store.typeOf(oid) === "tag") line += ` peeled:${(await walk.peel(oid)).target}`;
    yield pkt(`${line}\n`);
  }
  yield FLUSH;
}

async function* fetchV2(store: Store, args: string[]): AsyncGenerator<Uint8Array> {
  const req: FetchRequest = {
    wants: [],
    haves: [],
    clientShallow: new Set(),
    deepenRelative: false,
    includeTag: false,
    noProgress: false,
    done: false,
  };
  for (const a of args) {
    const [cmd, arg] = a.split(" ");
    if (cmd === "want") req.wants.push(arg);
    else if (cmd === "have") req.haves.push(arg);
    else if (cmd === "done") req.done = true;
    else if (cmd === "shallow") req.clientShallow.add(arg);
    else if (cmd === "deepen") req.depth = parseDepth(arg);
    else if (cmd === "deepen-relative") req.deepenRelative = true;
    else if (cmd === "include-tag") req.includeTag = true;
    else if (cmd === "no-progress") req.noProgress = true;
    else if (cmd === "thin-pack" || cmd === "ofs-delta") continue;
    else throw new ProtocolError(`unsupported fetch argument: ${cmd}`);
  }
  checkWants(store, req.wants);

  if (!req.done) {
    const common = commonCommits(store, req.haves);
    yield pkt("acknowledgments\n");
    if (common.length) for (const c of common) yield pkt(`ACK ${c}\n`);
    else yield pkt("NAK\n");
    if (!common.length) {
      yield FLUSH;
      return;
    }
    yield pkt("ready\n");
    yield DELIM;
  }
  const sel = await select(store, req);
  if (req.depth !== undefined) yield* [pkt("shallow-info\n"), ...shallowLines(sel), DELIM];
  yield pkt("packfile\n");
  yield* sidebandPack(store, sel.objects, !req.noProgress);
  yield FLUSH;
}

export async function* uploadPackV2(store: Store, packets: Packet[]): AsyncGenerator<Uint8Array> {
  let command = "";
  const args: string[] = [];
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === "flush") break;
    if (p.kind === "delim") {
      inArgs = true;
      continue;
    }
    if (inArgs) args.push(p.line);
    else if (p.line.startsWith("command=")) command = p.line.slice(8);
  }
  if (command === "ls-refs") yield* lsRefs(store, args);
  else if (command === "fetch") yield* fetchV2(store, args);
  else throw new ProtocolError(`unknown command ${command}`);
}
