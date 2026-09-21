// 一個儲存庫對應一個 Durable Object。驗證在 Worker 那層做完，進到這裡的請求都已經通過。
import { DurableObject } from "cloudflare:workers";
import { ZERO_OID } from "./objects";
import { concat, FLUSH, parsePackets, pkt, ProtocolError } from "./pktline";
import { receivePack, RECEIVE_CAPABILITIES } from "./receive";
import { Store } from "./store";
import { AGENT, UPLOAD_CAPABILITIES_V0, uploadPackV0, uploadPackV2, V2_CAPABILITIES } from "./upload";

/** upload-pack 的 request 只有 want／have 這些短行，不該很大。 */
const MAX_UPLOAD_REQUEST = 10 * 1024 * 1024;

export class Repository extends DurableObject<Env> {
  private store: Store;
  /** 同一個儲存庫的 push 一個接一個處理，免得兩個 push 同時在寫目錄。 */
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

  /** 大 push 每處理一批物件就讓出一下，並把寫入送出去，免得未寫出的資料一直堆在記憶體裡。 */
  private async breathe() {
    await this.ctx.storage.sync();
    await new Promise((r) => setTimeout(r, 0));
  }

  private advertise(service: string, v2: boolean): Uint8Array {
    if (service === "git-upload-pack" && v2) {
      return concat([...V2_CAPABILITIES.map((c) => pkt(`${c}\n`)), FLUSH]);
    }
    const refs = this.store.refs();
    const head = this.store.head();
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
}

function contentLength(request: Request): number | undefined {
  const v = request.headers.get("Content-Length");
  return v && !request.headers.get("Content-Encoding") ? Number(v) : undefined;
}

/** git 送 upload-pack 的 request 時，body 大於 1 KB 就會 gzip。 */
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
 * 先跑到第一個 chunk，讓協定錯誤在回應開始之前就丟出來（變成 ERR），
 * 之後的部分再邊產生邊送。
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

function gitResponse(kind: string, body: BodyInit, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": `application/x-${kind}`, "Cache-Control": "no-cache" },
  });
}
