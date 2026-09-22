// One Durable Object per Repository, found by its Repository ID (ADR 0008). The Worker has already authenticated
// every request that gets here. The class is not called `Repository`: stage 1's class of that name was deleted
// together with its data (spec #24).
import { DurableObject } from "cloudflare:workers";
import { ZERO_OID } from "./objects";
import { concat, FLUSH, parsePackets, pkt, ProtocolError } from "./pktline";
import { receivePack, RECEIVE_CAPABILITIES } from "./receive";
import { Store } from "./store";
import { AGENT, UPLOAD_CAPABILITIES_V0, uploadPackV0, uploadPackV2, V2_CAPABILITIES } from "./upload";

/** upload-pack requests are just short want/have lines; they should never be large. */
const MAX_UPLOAD_REQUEST = 10 * 1024 * 1024;

/** R2's list and delete both take at most 1000 keys at a time. */
const DELETE_BATCH = 1000;

export class RepositoryObject extends DurableObject<Env> {
  private store: Store;
  /** Pushes to one Repository run one at a time, so two pushes never write the index at once. */
  private pushes: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage, env.PACKS, ctx.id.toString());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const v2 = /(^|:)version=2(:|$)/.test(request.headers.get("Git-Protocol") ?? "");
    try {
      if (url.pathname.endsWith("/info/refs")) {
        const service = url.searchParams.get("service")!;
        return gitResponse(`${service}-advertisement`, this.advertise(service, v2));
      }
      if (url.pathname.endsWith("/git-upload-pack")) {
        const { packets } = parsePackets(await readBody(request, MAX_UPLOAD_REQUEST));
        const body = v2 ? uploadPackV2(this.store, packets) : uploadPackV0(this.store, packets);
        return gitResponse("git-upload-pack-result", await startStream(body));
      }
      if (url.pathname.endsWith("/git-receive-pack")) {
        const run = this.pushes.then(() =>
          receivePack(this.store, decoded(request), contentLength(request), () => this.breathe()),
        );
        this.pushes = run.catch(() => {});
        return gitResponse("git-receive-pack-result", await run);
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      if (e instanceof ProtocolError) return gitResponse("git-error", concat([pkt(`ERR ${e.message}\n`), FLUSH]), 200);
      throw e;
    }
  }

  isEmpty(): boolean {
    return this.store.refs().size === 0;
  }

  /** Deleting a Repository: returns at once; the alarm clears R2 in batches, then this object's own storage. */
  async destroy(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const listed = await this.env.PACKS.list({ prefix: `${this.ctx.id.toString()}/`, limit: DELETE_BATCH });
    if (listed.objects.length) await this.env.PACKS.delete(listed.objects.map((o) => o.key));
    // The platform retries a failed alarm, so a crash part way through picks up where it stopped.
    if (listed.truncated) await this.ctx.storage.setAlarm(Date.now());
    else await this.ctx.storage.deleteAll();
  }

  /** During a large push, yield after each batch and flush writes so unwritten data doesn't pile up in memory. */
  private async breathe() {
    await this.ctx.storage.sync();
    await new Promise((r) => setTimeout(r, 0));
  }

  private advertise(service: string, v2: boolean): Uint8Array {
    if (service === "git-upload-pack" && v2) {
      return concat([...V2_CAPABILITIES.map((c) => pkt(`${c}\n`)), FLUSH]);
    }
    return advertiseRefs(service, this.store.refs(), this.store.head());
  }
}

/** The Durable Object of the Repository with this Repository ID. */
export function repositoryObject(env: Pick<Env, "REPOSITORIES">, id: string) {
  return env.REPOSITORIES.get(env.REPOSITORIES.idFromString(id));
}

/** The v0 ref advertisement. The Worker also sends it with no refs, for a push to a Repository that doesn't exist yet. */
export function advertiseRefs(service: string, refs: Map<string, string>, head?: string): Uint8Array {
  let caps = `${service === "git-upload-pack" ? UPLOAD_CAPABILITIES_V0 : RECEIVE_CAPABILITIES} ${AGENT}`;
  const lines: [string, string][] = [];
  if (service === "git-upload-pack" && head && refs.has(head)) {
    caps += ` symref=HEAD:${head}`;
    lines.push([refs.get(head)!, "HEAD"]);
  }
  for (const [name, oid] of refs) lines.push([oid, name]);
  if (!lines.length) lines.push([ZERO_OID, "capabilities^{}"]);
  return concat([
    pkt(`# service=${service}\n`),
    FLUSH,
    ...lines.map(([oid, name], i) => pkt(i === 0 ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`)),
    FLUSH,
  ]);
}

function contentLength(request: Request): number | undefined {
  const v = request.headers.get("Content-Length");
  return v && !request.headers.get("Content-Encoding") ? Number(v) : undefined;
}

/** git gzips upload-pack request bodies larger than 1 KB. */
function decoded(request: Request): ReadableStream<Uint8Array> {
  const body = request.body ?? new ReadableStream({ start: (c) => c.close() });
  return request.headers.get("Content-Encoding") === "gzip" ? body.pipeThrough(new DecompressionStream("gzip")) : body;
}

async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of decoded(request)) {
    size += chunk.length;
    if (size > limit) throw new ProtocolError("request too large");
    chunks.push(chunk);
  }
  return concat(chunks);
}

/**
 * Run up to the first chunk so protocol errors surface before the response starts (and become ERR),
 * then stream the rest as it is produced.
 */
async function startStream(gen: AsyncGenerator<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const first = await gen.next();
  return new ReadableStream({
    start(controller) {
      if (first.done) controller.close();
      else controller.enqueue(first.value);
    },
    async pull(controller) {
      const next = await gen.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}

export function gitResponse(kind: string, body: BodyInit, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": `application/x-${kind}`, "Cache-Control": "no-cache" },
  });
}
