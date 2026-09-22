// GC (ADR 0009): delete the objects no ref reaches. Prepare runs beside pushes and writes the objects to keep
// into one new pack; commit runs in the push queue and swaps the index over, unless something changed in between.
import { createHash } from "node:crypto";
import { concat } from "./pktline";
import { hexToBytes, OFS_DELTA, ofsDistance, packEntryHeader, REF_DELTA } from "./objects";
import { SQLITE_PACK_LIMIT, type ObjectRow, type Store } from "./store";
import { reachableObjects } from "./upload";

export interface GcStats {
  reachable: number;
  deletedObjects: number;
  deletedBytes: number;
  rewrittenPacks: number;
  retiredPacks: number;
  newPackBytes: number;
  r2Deleted: number;
}

export interface GcPlan {
  /** Store.changes() when prepare started */
  changes: number;
  /** The pack with the kept objects of the rewritten packs, not yet complete; null if nothing needed rewriting. */
  newPack: number | null;
  moved: { oid: string; from: number; entry_type: number; data_offset: number }[];
  garbage: { oid: string; pack_id: number }[];
  /** Rewritten packs, and packs with nothing left to keep */
  retire: number[];
  stats: GcStats;
}

export async function prepareGc(store: Store): Promise<GcPlan> {
  const changes = store.changes();
  const r2Deleted = await store.deleteOrphanedR2();

  // ponytail: every live index row in memory at once; fine up to a few hundred thousand objects, page it after that.
  const rows = store.liveRows();
  const byOid = new Map(rows.map((r) => [r.oid, r]));
  const reachable = new Set(await reachableObjects(store));
  const reachableFromRefs = reachable.size;
  // A kept delta needs its base, even one no ref reaches. A Set visits what is added while iterating it.
  for (const oid of reachable) {
    const base = byOid.get(oid)?.base_oid;
    if (base) reachable.add(base);
  }

  const byPack = new Map<number, ObjectRow[]>(store.livePacks().map((id) => [id, []]));
  for (const row of rows) byPack.get(row.pack_id)!.push(row);
  const toCopy: ObjectRow[] = [];
  const garbage: GcPlan["garbage"] = [];
  const retire: number[] = [];
  let rewrittenPacks = 0;
  let deletedBytes = 0;
  for (const [id, packRows] of byPack) {
    const kept = packRows.filter((r) => reachable.has(r.oid));
    if (kept.length === packRows.length && kept.length) continue;
    retire.push(id);
    if (kept.length) rewrittenPacks++;
    toCopy.push(...kept);
    for (const r of packRows) {
      if (reachable.has(r.oid)) continue;
      garbage.push({ oid: r.oid, pack_id: r.pack_id });
      deletedBytes += r.data_len;
    }
  }

  const { newPack, moved, size } = toCopy.length ? await writePack(store, toCopy) : { newPack: null, moved: [], size: 0 };
  return {
    changes,
    newPack,
    moved,
    garbage,
    retire,
    stats: {
      reachable: reachableFromRefs,
      deletedObjects: garbage.length,
      deletedBytes,
      rewrittenPacks,
      retiredPacks: retire.length - rewrittenPacks,
      newPackBytes: size,
      r2Deleted,
    },
  };
}

/**
 * Copy the objects into a new pack, compressed data untouched; only the entry headers are rewritten. An ofs-delta
 * whose base is already in the new pack gets its distance recomputed; any other delta becomes a ref-delta.
 */
async function writePack(store: Store, rows: ObjectRow[]) {
  // Headers are at most ~30 bytes; the estimate only picks the location, like a push's Content-Length does.
  const estimate = 32 + rows.reduce((n, r) => n + r.data_len + 32, 0);
  // Synchronous from creating the row to marking it, so no push's startIndexing can run in between.
  const writer = store.createPack(estimate < SQLITE_PACK_LIMIT ? "sqlite" : "r2");
  store.gcPack = writer.id;
  const sha = createHash("sha1");
  const write = async (b: Uint8Array) => {
    sha.update(b);
    await writer.write(b);
  };
  try {
    const header = new Uint8Array(12);
    header.set(new TextEncoder().encode("PACK"));
    new DataView(header.buffer).setUint32(4, 2);
    new DataView(header.buffer).setUint32(8, rows.length);
    await write(header);
    let pos = 12;
    const offsetOf = new Map<string, number>();
    const moved: GcPlan["moved"] = [];
    for (const row of rows) {
      let entryType = row.entry_type;
      let head: Uint8Array;
      const baseAt = row.base_oid ? offsetOf.get(row.base_oid) : undefined;
      if (entryType === OFS_DELTA && baseAt !== undefined) {
        head = concat([packEntryHeader(OFS_DELTA, row.entry_size), ofsDistance(pos - baseAt)]);
      } else if (entryType === OFS_DELTA || entryType === REF_DELTA) {
        entryType = REF_DELTA;
        head = concat([packEntryHeader(REF_DELTA, row.entry_size), hexToBytes(row.base_oid!)]);
      } else {
        head = packEntryHeader(entryType, row.entry_size);
      }
      offsetOf.set(row.oid, pos);
      await write(head);
      for await (const chunk of store.rawChunks(row)) await write(chunk);
      moved.push({ oid: row.oid, from: row.pack_id, entry_type: entryType, data_offset: pos + head.length });
      pos += head.length + row.data_len;
    }
    const checksum = new Uint8Array(sha.digest());
    await writer.write(checksum);
    return { newPack: writer.id, moved, size: await writer.close() };
  } catch (e) {
    await writer.abort();
    throw e;
  }
}

/**
 * Swap the index over to the plan, in one transaction. Call it from the push queue. If a ref moved or a pack
 * completed since prepare started (Store.changes), give up and discard the new pack: a ref pushed back meanwhile
 * may need objects the plan deletes (the index keeps the first row for an oid, so re-sent objects still point at
 * the packs the plan retires).
 */
export async function commitGc(store: Store, plan: GcPlan, now = Date.now()): Promise<boolean> {
  if (store.changes() !== plan.changes) {
    if (plan.newPack !== null) await store.discardPack(plan.newPack);
    return false;
  }
  store.transaction(() => {
    if (plan.newPack !== null) {
      store.markComplete(plan.newPack);
      for (const m of plan.moved) store.moveObject(m.oid, m.from, { pack_id: plan.newPack, ...m });
    }
    for (const g of plan.garbage) store.deleteObject(g.oid, g.pack_id);
    for (const id of plan.retire) store.retirePack(id, now);
  });
  store.gcPack = -1;
  return true;
}
