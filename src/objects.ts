// git objects: hashing, applying deltas, and finding what a commit/tree/tag references.
import { createHash } from "node:crypto";

export type ObjectType = "commit" | "tree" | "blob" | "tag";

export const ZERO_OID = "0".repeat(40);

export const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
export const OFS_DELTA = 6;
export const REF_DELTA = 7;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function objectHeader(type: ObjectType, size: number): Uint8Array {
  return encoder.encode(`${type} ${size}\0`);
}

export function hashObject(type: ObjectType, data: Uint8Array): string {
  return createHash("sha1").update(objectHeader(type, data.length)).update(data).digest("hex");
}

export function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** The header before each object in a pack: 3 type bits + variable-length size. */
export function packEntryHeader(typeCode: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let byte = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(byte | 0x80);
    byte = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(byte);
  return new Uint8Array(bytes);
}

/** How far back an ofs-delta's base starts, in the pack's encoding (the inverse of the parse in receive.ts). */
export function ofsDistance(distance: number): Uint8Array {
  const bytes = [distance & 0x7f];
  distance = Math.floor(distance / 128);
  while (distance > 0) {
    distance--;
    bytes.unshift(0x80 | (distance & 0x7f));
    distance = Math.floor(distance / 128);
  }
  return new Uint8Array(bytes);
}

export class DeltaError extends Error {}

/** Apply a delta to its base to get the full object. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let pos = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (pos >= delta.length) throw new DeltaError("truncated delta header");
      byte = delta[pos++];
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  };
  if (varint() !== base.length) throw new DeltaError("delta base size mismatch");
  const out = new Uint8Array(varint());
  let outPos = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += delta[pos++] * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size += delta[pos++] * 2 ** (8 * i);
      if (size === 0) size = 0x10000;
      if (offset + size > base.length || outPos + size > out.length) throw new DeltaError("delta copy out of range");
      out.set(base.subarray(offset, offset + size), outPos);
      outPos += size;
    } else if (op > 0) {
      if (pos + op > delta.length || outPos + op > out.length) throw new DeltaError("delta insert out of range");
      out.set(delta.subarray(pos, pos + op), outPos);
      pos += op;
      outPos += op;
    } else {
      throw new DeltaError("delta opcode 0");
    }
  }
  if (outPos !== out.length) throw new DeltaError("delta result size mismatch");
  return out;
}

export interface Commit {
  tree: string;
  parents: string[];
}

/** Header lines of a commit or tag, up to the first blank line. */
function headerLines(data: Uint8Array): string[] {
  const text = decoder.decode(data);
  const blank = text.indexOf("\n\n");
  return (blank === -1 ? text : text.slice(0, blank)).split("\n");
}

export function parseCommit(data: Uint8Array): Commit {
  let tree = "";
  const parents: string[] = [];
  for (const line of headerLines(data)) {
    if (line.startsWith("tree ")) tree = line.slice(5);
    else if (line.startsWith("parent ")) parents.push(line.slice(7));
  }
  if (!isOid(tree)) throw new Error("commit without tree");
  return { tree, parents };
}

export function parseTag(data: Uint8Array): { object: string; type: ObjectType } {
  let object = "";
  let type = "";
  for (const line of headerLines(data)) {
    if (line.startsWith("object ")) object = line.slice(7);
    else if (line.startsWith("type ")) type = line.slice(5);
  }
  if (!isOid(object) || !(type in TYPE_CODE)) throw new Error("malformed tag");
  return { object, type: type as ObjectType };
}

export interface TreeEntry {
  mode: string;
  oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0, space);
    if (space === -1 || nul === -1 || nul + 21 > data.length) throw new Error("malformed tree");
    entries.push({ mode: decoder.decode(data.subarray(pos, space)), oid: bytesToHex(data.subarray(nul + 1, nul + 21)) });
    pos = nul + 21;
  }
  return entries;
}

/** A submodule (gitlink) points at a commit in another repository, not an object of this one. */
export function isGitlink(mode: string): boolean {
  return mode === "160000";
}

/** Objects this object references (for the connectivity check). */
export function referencedOids(type: ObjectType, data: Uint8Array): string[] {
  switch (type) {
    case "commit": {
      const c = parseCommit(data);
      return [c.tree, ...c.parents];
    }
    case "tree":
      return parseTree(data)
        .filter((e) => !isGitlink(e.mode))
        .map((e) => e.oid);
    case "tag":
      return [parseTag(data).object];
    case "blob":
      return [];
  }
}
