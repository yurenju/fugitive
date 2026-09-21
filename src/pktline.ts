// git's pkt-line format: each line starts with its length as 4 hex digits (including those 4).
// 0000 is flush, 0001 is delim.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const FLUSH = encoder.encode("0000");
export const DELIM = encoder.encode("0001");

/** Most data a single pkt-line can carry (65520 - 4). */
export const MAX_PKT_DATA = 65516;

export function pkt(data: string | Uint8Array): Uint8Array {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const out = new Uint8Array(bytes.length + 4);
  out.set(encoder.encode((bytes.length + 4).toString(16).padStart(4, "0")));
  out.set(bytes, 4);
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** side-band-64k packets: the first byte is the band (1 data, 2 progress, 3 error). */
export function sideband(band: 1 | 2 | 3, data: string | Uint8Array): Uint8Array[] {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const out: Uint8Array[] = [];
  const max = MAX_PKT_DATA - 1;
  for (let i = 0; i < bytes.length; i += max) {
    const chunk = bytes.subarray(i, i + max);
    const payload = new Uint8Array(chunk.length + 1);
    payload[0] = band;
    payload.set(chunk, 1);
    out.push(pkt(payload));
  }
  return out;
}

export type Packet = { kind: "flush" } | { kind: "delim" } | { kind: "data"; line: string; bytes: Uint8Array };

/** Parse pkt-lines from a buffer that is already in memory. */
export function parsePackets(buf: Uint8Array): { packets: Packet[]; rest: number } {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const len = parseInt(decoder.decode(buf.subarray(pos, pos + 4)), 16);
    if (Number.isNaN(len)) throw new ProtocolError("invalid pkt-line length");
    if (len === 0) {
      packets.push({ kind: "flush" });
      pos += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: "delim" });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) throw new ProtocolError("truncated pkt-line");
    const bytes = buf.subarray(pos + 4, pos + len);
    packets.push({ kind: "data", bytes, line: decoder.decode(bytes).replace(/\n$/, "") });
    pos += len;
  }
  return { packets, rest: pos };
}

export class ProtocolError extends Error {}

/**
 * Reads pkt-lines off a request body stream, then hands over the remaining bytes.
 * A push is commands (pkt-lines) followed directly by the pack, so both happen on one stream.
 */
export class StreamReader {
  private buf: Uint8Array = new Uint8Array(0);
  private done = false;

  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) this.done = true;
      else this.buf = this.buf.length ? concat([this.buf, value]) : value;
    }
    return this.buf.length >= n;
  }

  /** Read one pkt-line; null at end of stream. */
  async readPacket(): Promise<Packet | null> {
    if (!(await this.fill(4))) {
      if (this.buf.length) throw new ProtocolError("truncated pkt-line");
      return null;
    }
    const len = parseInt(decoder.decode(this.buf.subarray(0, 4)), 16);
    if (Number.isNaN(len)) throw new ProtocolError("invalid pkt-line length");
    if (len === 0 || len === 1) {
      this.buf = this.buf.subarray(4);
      return len === 0 ? { kind: "flush" } : { kind: "delim" };
    }
    if (len < 4 || !(await this.fill(len))) throw new ProtocolError("truncated pkt-line");
    const bytes = this.buf.slice(4, len);
    this.buf = this.buf.subarray(len);
    return { kind: "data", bytes, line: decoder.decode(bytes).replace(/\n$/, "") };
  }

  /** The raw bytes left after the pkt-lines. */
  async *rest(): AsyncGenerator<Uint8Array> {
    if (this.buf.length) yield this.buf;
    this.buf = new Uint8Array(0);
    while (!this.done) {
      const { value, done } = await this.reader.read();
      if (done) this.done = true;
      else if (value.length) yield value;
    }
  }
}
