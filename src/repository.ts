// One Durable Object per Repository, found by its Repository ID (ADR 0008). The Worker has already authenticated
// every request that gets here. The class is not called `Repository`: stage 1's class of that name was deleted
// together with its data (spec #24).
import { DurableObject } from "cloudflare:workers";
import { commitGc, prepareGc } from "./gc";
import { errorText, logFailure } from "./log";
import { ZERO_OID } from "./objects";
import { concat, FLUSH, parsePackets, pkt, ProtocolError } from "./pktline";
import { receivePack, RECEIVE_CAPABILITIES } from "./receive";
import { R2_BATCH, Store } from "./store";
import { AGENT, UPLOAD_CAPABILITIES_V0, uploadPackV0, uploadPackV2, V2_CAPABILITIES } from "./upload";

/** upload-pack requests are just short want/have lines; they should never be large. */
const MAX_UPLOAD_REQUEST = 10 * 1024 * 1024;

/** GC runs this long after the last push that may have left garbage. */
const GC_DELAY = 60 * 60 * 1000;
/** The platform retries a failed alarm up to 6 times; retryCount counts from 0. */
const LAST_RETRY = 5;
/** A retired pack stays this long, so clones that started before GC committed can finish. */
const RETIRED_FOR = 60 * 60 * 1000;

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
        const report = await this.queue(async () => {
          const { report, garbage } = await receivePack(this.store, decoded(request), contentLength(request), () =>
            this.breathe(),
          );
          if (garbage) {
            this.store.setGcAt(Date.now() + GC_DELAY);
            await this.reschedule();
          }
          return report;
        });
        return gitResponse("git-receive-pack-result", report);
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
    this.store.markDeleting();
    await this.reschedule();
  }

  /**
   * One alarm serves three jobs, most urgent first: deleting the Repository (nothing else then), deleting packs
   * retired over an hour ago, and GC once it is due. Then it is set for whichever job comes next.
   * The platform retries a failed alarm, so a crash part way through starts that job again.
   */
  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    if (this.store.deleting()) {
      const listed = await this.env.PACKS.list({ prefix: `${this.ctx.id.toString()}/`, limit: R2_BATCH });
      if (listed.objects.length) await this.env.PACKS.delete(listed.objects.map((o) => o.key));
      if (listed.truncated) await this.ctx.storage.setAlarm(Date.now());
      else await this.ctx.storage.deleteAll();
      return;
    }
    await this.store.deleteRetired(Date.now() - RETIRED_FOR);
    const gcAt = this.store.gcAt();
    if (gcAt !== undefined && gcAt <= Date.now()) {
      try {
        await this.gc();
      } catch (e) {
        // Let the platform retry; after the last retry, wait for the next trigger but keep the other jobs scheduled.
        if ((info?.retryCount ?? 0) < LAST_RETRY) throw e;
      }
      this.store.clearGcAt(gcAt);
    }
    await this.reschedule();
  }

  private async reschedule() {
    if (this.store.deleting()) return this.ctx.storage.setAlarm(Date.now());
    const retired = this.store.oldestRetired();
    const times = [this.store.gcAt(), retired === undefined ? undefined : retired + RETIRED_FOR].filter(
      (t) => t !== undefined,
    );
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }

  /** Prepare beside pushes, commit in their queue, and log one line either way (spec #34). */
  private async gc() {
    const log: Record<string, unknown> = { event: "gc", repository: this.ctx.id.toString() };
    const start = Date.now();
    try {
      const plan = await prepareGc(this.store);
      log.prepareMs = Date.now() - start;
      const committing = Date.now();
      const committed = await this.queue(() => commitGc(this.store, plan));
      log.commitMs = Date.now() - committing;
      log.result = committed ? "done" : "abandoned: a push moved a ref";
      Object.assign(log, plan.stats);
    } catch (e) {
      log.result = "failed";
      log.error = errorText(e);
      throw e;
    } finally {
      console.log(JSON.stringify(log));
    }
  }

  /** Run after the pushes already queued; GC's commit takes its turn here too. */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.pushes.then(fn);
    this.pushes = run.catch(() => {});
    return run;
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
      try {
        const next = await gen.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (e) {
        // The response already started, so git only sees it stop; this line is the only trace left.
        logFailure("upload-pack-stream", e);
        controller.error(e);
      }
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
