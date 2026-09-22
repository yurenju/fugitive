# Cloudflare 上超過 100 MB 的上傳：平台這一側的限制

回答 [#27](https://github.com/yurenju/fugitive/issues/27)。只列有出處的事實，不做選擇。查詢日期：2026-09-22，出處都是 Cloudflare 官方文件當天的版本。

**背景**：現在 `git push` 是一個 HTTP POST 把整個 pack 送進 Worker，Worker 轉給儲存庫的 Durable Object，由它串流寫進 R2（`src/store.ts` 用 R2 binding 的 multipart upload，每個 part 8 MB），寫完再用 1 MB 一塊的 range read 把 pack 讀回來，逐個物件解壓、算 SHA-1、寫目錄（`src/receive.ts`，見 ADR 0003）。程式自己在 `MAX_PUSH_BYTES = 100 MB` 擋一次，但實際上 Cloudflare 在請求進 Worker 之前就先擋了。

名詞：

- **zone 方案**：`fugitive.yurenju.info` 所屬網域在 Cloudflare 的方案（Free／Pro／Business／Enterprise），跟 Workers 的 Free／Paid 是兩件事。
- **presigned URL**：伺服器用 R2 的 S3 API 金鑰簽出來、有期限的網址，拿到的人不需要金鑰就能做那一個操作。
- **multipart upload**：把一個物件切成多個 part 分別上傳，最後再「complete」合成一個物件。

## 1. 請求 body 上限

| Cloudflare 方案 | 最大請求 body |
| --- | --- |
| Free | 100 MB |
| Pro | 100 MB |
| Business | 200 MB |
| Enterprise | 預設 500 MB，可自己在 zone 的 **Network → Maximum Upload Size** 調到 5 GB；超過 5 GB 要找 account team |

- **看的是 zone（帳號）方案，不是 Workers 方案**：「Request body size limits depend on your Cloudflare account plan, not your Workers plan. Requests exceeding these limits return a 413」。出處：[Workers limits › Request and response limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits)。同一張表也在 [Error 413](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/#cloudflare-specific-information) 與 [Default cache behavior › Upload limits](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/#upload-limits)。
- **Enterprise 的 500 MB 預設與 5 GB 自助**：changelog 2026-09-04〈Enterprise customers can self-serve CDN upload limits up to 5 GB〉：「The default maximum upload size remains 500 MB.」出處：[Workers changelog](https://developers.cloudflare.com/changelog/product/workers/)。
- **非 Enterprise 能不能調**：413 頁寫「customers can adjust the Maximum Upload Size from the zone's Network page」，但同一句接著說只有 Enterprise 能自助調到 5 GB；文件沒有說 Free／Pro 能調高到超過表上的值。官方給的替代做法是「break up requests into smaller chunks, change your DNS record to DNS-only, or upgrade your plan」。DNS-only 對 Worker 不適用（Worker 必須在 Cloudflare 代理後面才跑得到），這是推論，不是文件原句。
- **`*.workers.dev`**：官方文件沒有另外列 `workers.dev` 的 body 上限；[workers.dev 頁](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)的 Limitations 只談 Worker 名稱長度。**查不到出處**，不能假設它比 100 MB 大。
- **沒有 `Content-Length` 的 chunked 串流**：官方文件**沒有明說**上限是看 `Content-Length` 還是看實際收到的位元組。可以確定的只有專案自己的觀察：git 的 body 超過 `http.postBuffer`（預設 1 MB）就改用 chunked、不帶 `Content-Length`（ADR 0003），而 #27 描述的 440 MB push 仍然拿到 413，也就是 chunked 的請求一樣被擋。這是實際觀察，不是文件保證。
- **另一個相關數字**：Cloudflare 的 Proxy Idle Timeout 900 秒、Proxy Read Timeout 125 秒等是 Cloudflare 對**來源伺服器**的連線限制（[Connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)），見第 4 節。

**要使用者確認**：`fugitive.yurenju.info` 所屬 zone（`yurenju.info`）現在是哪個方案。這台機器沒有 Cloudflare API 的授權，查不到。在 dashboard 的 zone Overview 右側可以看到方案名稱；若是 Enterprise，也順便看 **Network → Maximum Upload Size** 目前設多少。另外 `wrangler.jsonc` 設了 `limits.cpu_ms: 300000`，這只有 Workers Paid 能用，所以 Workers 方案應該是 Paid（但如上所述，body 上限跟這個無關）。

## 2. 繞過 Worker、直接用 presigned URL 傳到 R2

| 項目 | 數字 | 出處 |
| --- | --- | --- |
| 單次 PUT 上限 | 5 GiB（實際 4.995 GiB，即 5 GiB 減 5 MiB） | [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) |
| multipart 物件上限 | 4.995 TiB | 同上 |
| part 數上限 | 10,000 | 同上；[Upload objects › Multipart upload details](https://developers.cloudflare.com/r2/objects/upload-objects/#multipart-upload-details) |
| part 大小 | 最小 5 MiB（最後一個除外）、最大 5 GiB | [Upload objects](https://developers.cloudflare.com/r2/objects/upload-objects/#part-size-limits) |
| part 大小一致 | 除了最後一個，所有 part 必須一樣大（違反回 `10048 InvalidPart`） | 同上；[Error codes](https://developers.cloudflare.com/r2/api/error-codes/) |
| 沒完成的 multipart | 預設 7 天後自動 abort，可用 lifecycle 規則調 | [Upload objects › Incomplete upload lifecycles](https://developers.cloudflare.com/r2/objects/upload-objects/#incomplete-upload-lifecycles) |
| presigned URL 期限 | 1 秒到 7 天（604,800 秒） | [Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) |
| presigned 支援的方法 | `GET`、`HEAD`、`PUT`、`DELETE`；`POST`（HTML 表單上傳）不支援 | 同上 |
| presigned 的網域 | 只能用 S3 API 網域 `<ACCOUNT_ID>.r2.cloudflarestorage.com`，不能用 custom domain | 同上 |

- **是否不受第 1 節的 100 MB 限制**：第 1 節的上限是 zone 的設定（在 zone 的 Network 頁調），而 presigned URL 走的是 `<ACCOUNT_ID>.r2.cloudflarestorage.com`，不是我們的 zone。R2 文件對這條路給的上限是單次 PUT 5 GiB。R2 limits 頁另外寫「If you have a Worker, its inbound request size is constrained by Workers request limits」，也就是說 100 MB 是**經過 Worker** 時的限制。文件沒有一句話直接寫「S3 端點不受 zone 上限」，上述是由這幾句組合出來的。
- **presigned multipart**：R2 的 S3 相容 API 支援 `CreateMultipartUpload`、`UploadPart`、`CompleteMultipartUpload`、`AbortMultipartUpload`、`ListParts`、`ListMultipartUploads`（[S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)）。`UploadPart` 本身是 `PUT`，而 presigned 支援 `PUT`，但官方文件的範例只示範 `PutObject`，**沒有明文示範對 `UploadPart` 簽 URL**。社群有人這樣用（例如 [datopian/r2-bucket-uploader](https://github.com/datopian/r2-bucket-uploader)），屬次要來源。
- **斷線後只補沒傳完的 part**：官方〈Upload objects〉的比較表寫 multipart「Resumable: Yes — only failed parts need to be retried」，單次 PUT 則是「No — must restart the entire upload」。`UploadPart` 對同一個 part number 再傳會覆蓋前一次；`ListParts` 可以查已經傳上去的 part。Worker binding 那邊也有 `resumeMultipartUpload(key, uploadId)`，但它「doesn't validate the uploadId」（[Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)）。
- **注意**：S3 API 的 R2 權杖要另外建（[R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/)），現在的部署只用 binding，沒有 S3 金鑰。

## 3. 伺服器端處理一個 440 MB 的物件

| 限制 | 數字 | 出處 |
| --- | --- | --- |
| CPU 時間（Workers Paid 預設） | 30 秒 | [Workers limits › CPU time](https://developers.cloudflare.com/workers/platform/limits/) |
| CPU 時間上限（`limits.cpu_ms`） | 300,000 ms（5 分鐘）；fugitive 已經設成最大值 | 同上；`wrangler.jsonc` |
| Durable Object 的 CPU 重算 | 「Each incoming HTTP request or WebSocket message resets the remaining available CPU time」 | [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| CPU 計算範圍 | 等待網路、R2、storage 的時間不算 CPU | 同上；Workers limits |
| 記憶體 | 每個 isolate 128 MB（含 JS heap 與 WASM），是 per-isolate 不是 per-request；同一個 class 的多個 DO 可能跑在同一個 isolate、共用 128 MB | [Workers limits › Memory](https://developers.cloudflare.com/workers/platform/limits/#memory)；[Workers pricing 註 5](https://developers.cloudflare.com/workers/platform/pricing/) |
| DO 的 wall time（RPC／HTTP） | 「No hard limit while the caller stays connected」；DO 在 request、RPC、response stream 或 I/O 還在進行時保持活著 | [Workers limits › Duration](https://developers.cloudflare.com/workers/platform/limits/) |
| DO alarm 的 wall time | 15 分鐘 | 同上 |
| 子請求（R2 呼叫也算） | Workers Paid 每次 invocation 預設 10,000，可調到 1,000 萬（`limits.subrequests`） | [Workers limits › Subrequests](https://developers.cloudflare.com/workers/platform/limits/#subrequests) |
| R2 讀取 | `get()` 支援 range（offset/length、suffix）；body 是 `ReadableStream`；文件沒有列單次讀取的大小上限 | [R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) |
| R2 寫入同一個 key | 每秒 1 次 | [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) |

- **440 MB 要花多少 CPU**：官方文件**沒有**解壓與 SHA-1 的吞吐量數字，只能實測。能確定的是上限：一次 invocation 最多 5 分鐘 CPU，而且 DO 每收到一個新的 request 會重算。
- **記憶體**：官方的建議是用 Streams 處理大 body：「allows your Worker to handle multi-gigabyte payloads or files within its memory limits」（[Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)）。一個 440 MB 的 blob 如果整個放進記憶體就一定超過 128 MB；#27 提到超過 4 MB 的 blob 已經是邊解壓邊算 SHA-1。
- **子請求的粗估**（由程式常數推算，不是文件數字）：`src/store.ts` 每次讀 R2 是 1 MB 的 range read，寫是 8 MB 一個 part。440 MB 的 pack 寫一次約 55 個 `uploadPart`，完整讀一遍約 440 次 `get`，都遠小於 10,000。
- **clone 時串流回去**：「Cloudflare does not enforce response body size limits」；只要 Worker 還在串流 response，就算還活著，wall time 沒有上限（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)）。CDN 快取有 512 MB（非 Enterprise）／5 GB（Enterprise）的上限，但只影響「能不能快取」，git 的回應本來就不快取。

## 4. 慢速上傳要花幾十分鐘時的時間限制

- **Worker 的 HTTP 請求**：wall time「Unlimited」，「No hard limit while the client remains connected」（[Workers limits › Duration](https://developers.cloudflare.com/workers/platform/limits/)）。文件沒有列出「請求總時間上限」或「上傳過程中的閒置時間上限」。
- **Cloudflare 的連線限制表**（[Connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)）列的是 Cloudflare 與**來源伺服器**之間的逾時：Proxy Idle Timeout 900 秒（520）、Proxy Read Timeout 125 秒（524，Enterprise 可調到 6,000 秒）、Proxy Write Timeout 30 秒、TCP ACK Timeout 90 秒。Worker 本身就是回應者、沒有另外的來源，文件沒有說這些值會套在 Worker 路由上；它們會不會影響「client 慢慢送 body 給 Worker」這段，**文件沒有交代**。
- **Cache 文件的一句提醒**：「Very large uploads take longer to transfer. Requests that exceed the connection or read timeout can fail mid-upload before reaching the size limit」（[Default cache behavior › Upload limits](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/#upload-limits)）。這句是在講經過 Cloudflare 代理的上傳，沒有給具體秒數。
- **R2 presigned URL 這條路**：唯一有文件的時間限制是 URL 本身的期限（最長 7 天）與沒完成的 multipart 7 天後自動 abort。單一 part 的 PUT 有沒有連線時間上限，文件沒寫。

## 查不到、要實測或要確認的事

1. `yurenju.info` zone 的方案（要使用者在 dashboard 看）。
2. `*.workers.dev` 的 body 上限（文件沒列）。
3. 沒有 `Content-Length` 的 chunked body 是在收到第 100 MB 時被切斷，還是在別的時機回 413（文件沒寫；目前只知道最後是 413）。
4. Workers／DO 解壓與 SHA-1 的實際吞吐量，也就是 440 MB 會用掉多少 CPU（要實測）。
5. 一個要傳幾十分鐘的 request body，在 Worker 路由上會不會碰到閒置或讀取逾時（文件沒寫，要實測）。
6. 對 `UploadPart` 簽 presigned URL 在 R2 上是否正式支援（文件只寫支援 `PUT`，沒示範 `UploadPart`）。
