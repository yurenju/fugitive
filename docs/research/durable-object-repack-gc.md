# 在儲存庫的 Durable Object 裡重寫 pack：時間上限、成本，以及別人怎麼做 GC 與 repack

回答 [#32](https://github.com/yurenju/fugitive/issues/32)。只列有出處的事實，不做選擇。查詢日期：2026-09-22。Cloudflare 的出處是官方文件當天的版本；git 的出處釘在 [git/git@`d38352c`](https://github.com/git/git/tree/d38352cd43ab9745686d697872408bc3249a153f)（2026-09-17）；另外兩個專案釘在 [#3 的研究](https://github.com/yurenju/fugitive/blob/research/do-git-servers/docs/research/do-git-servers.md)用過的同一個 commit。

**背景**：push 上來的 pack 原樣保存，小的切成 1 MB 一列放 SQLite，大的放 R2；SQLite 的 `objects` 表為每個物件記一列，包括它在哪個 pack、壓縮資料從哪個位置開始（`data_offset`）、壓縮後多長（`data_len`）、delta 的底稿是誰（`base_oid`）（`src/store.ts` 的 `SCHEMA`，ADR 0003）。現在不做 GC：刪分支、force push 之後走不到的物件和 pack 還佔著空間。要做 GC 或 repack，就得讀舊 pack、把要留的物件寫進新 pack、換掉目錄、刪掉舊 pack。[#27](https://github.com/yurenju/fugitive/issues/27) 已經查過的平台數字這裡不重複：CPU 每個 request 預設 30 秒、上限 5 分鐘（fugitive 已設成 5 分鐘）；記憶體每個 isolate 128 MB；等 R2 的時間不算 CPU；子請求預設每次 10,000 個。

名詞：

- **alarm**：Durable Object 自己排定「某個時間叫醒我」的機制，時間到了平台會呼叫它的 `alarm()` 方法，不需要外面有 request 進來。
- **GC（garbage collection）**：刪掉從任何 ref 都走不到的物件。
- **repack**：把多個 pack 合成較少的 pack；不一定會刪物件。
- **寬限期（grace period）**：git 刪走不到的物件時，只刪「夠舊」的，新的先留著，免得刪到另一個程序剛寫進來、還沒掛上 ref 的物件。
- **cruft pack**：git 把「走不到但還在寬限期內」的物件集中放進一個特別的 pack，旁邊另存每個物件的時間戳。
- **geometric repack**：git 的一種 repack 策略，只合併小的 pack，讓 pack 大小維持等比數列，大 pack 不用每次都重寫。
- **delta 重用**：產生新 pack 時，舊 pack 裡已經壓好的資料（包括 delta）直接複製過去，不解壓、不重新算 delta。

## 1. 背景工作的時間上限

| 項目 | 數字／行為 | 出處 |
| --- | --- | --- |
| alarm handler 的 wall time | 15 分鐘 | [Workers limits › Duration](https://developers.cloudflare.com/workers/platform/limits/)、[DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| alarm handler 的 CPU | 文件沒有另外列。DO limits 表上寫的是「CPU per request: 30 seconds (default) / configurable to 5 minutes」，而「Each incoming HTTP request or WebSocket message resets the remaining available CPU time」，沒提到 alarm | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| 每個 DO 同時能排幾個 alarm | 一個：「Each Durable Object is able to schedule a single alarm at a time」 | [Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/) |
| 同時跑幾個 `alarm()` | 「Only one instance of `alarm()` will ever run at a given time per Durable Object instance」 | 同上 |
| 失敗怎麼重試 | handler 丟出例外就重試，「exponential backoff starting at a 2 second delay from the first failure with up to 6 retries」；保證 at-least-once | 同上；[DO Base › alarm](https://developers.cloudflare.com/durable-objects/api/base/) |
| 重試次數用完之後 | 官方範例在 `retryCount >= 5` 時自己 `setAlarm()` 排下一次再 return，因為「a sufficiently long outage … can exhaust the limited number of retries」 | [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)、[Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/) |
| 可能跑不只一次 | 「In rare cases, alarms may fire more than once. Your `alarm()` handler should be safe to run multiple times」 | [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) |
| 跟其他 request 會不會交錯 | 「Alarms can run concurrently with other requests to the same Durable Object」 | [2026-08-25 changelog](https://developers.cloudflare.com/changelog/post/2026-08-25-durable-object-alarm-abort-no-retry/) |
| `blockConcurrencyWhile` | 擋住其他所有事件直到 callback 結束，但有 30 秒逾時：「If this timeout is exceeded, the Durable Object will be reset」；官方建議只在建構子或 migration 用 | [DO State API](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile)、[Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) |
| DO 被重啟 | 部署新版本、runtime 更新等都會重啟 DO；runtime 更新時進行中的 request 最多再給 30 秒。Agents 文件列出程式或 runtime 更新「1–2x per day」、alarm handler 逾時 15 分鐘，都是被收掉的原因 | [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)、[Agents › Durable execution](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/) |

**一次做不完、分成幾次 alarm 接著做，是不是常見的做法**：

- 官方文件沒有一段專門講「把長工作切成多次 alarm」。有的是兩個零件：`setAlarm()` 可以在 `alarm()` 裡再呼叫，用來排下一次（[Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/)）；Workers limits 在 CPU 超時的處理建議裡寫「process data in smaller chunks across multiple requests」（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)）。
- **fugitive 自己已經這樣做**：刪除儲存庫時，`alarm()` 每次列出並刪一批 R2 物件，還有剩就 `setAlarm(Date.now())` 排下一次，註解寫「The platform retries a failed alarm, so a crash part way through picks up where it stopped」（`src/repository.ts` 的 `destroy()`／`alarm()`）。
- 下面第 3 節的 git-on-cloudflare 也是：compaction 的狀態記在 DO，alarm 只負責在需要時重新把工作丟進 Queue（見 3.2）。
- 平台上另一個切段的選項是 **Workflows**：每個 step 的 CPU 上限跟 Workers 一樣（預設 30 秒、可調到 5 分鐘），wall time 不限，一個 instance 預設最多 10,000 個 step、可調到 25,000，每個 step 回傳值（非串流）上限 1 MiB（[Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)）。**Queue consumer** 每次呼叫的 wall time 也是 15 分鐘（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)）。

## 2. 重寫的成本

### 2.1 官方有沒有數字

- Cloudflare 文件**沒有** Workers 上 zlib 解壓、壓縮或 SHA-1 的吞吐量數字。`node:zlib` 在 Workers 上可以用，但文件頁只把細節指回 Node.js 文件，沒寫是原生實作還是 JS、有多快（[Workers › zlib](https://developers.cloudflare.com/workers/runtime-apis/nodejs/zlib/)）。
- fugitive 現在用的是 `pako`（純 JS 的 zlib）：`src/store.ts` 的 `inflateAt()` 解壓，`src/upload.ts` 用 `deflate`。
- pako 的 README 自己附的 benchmark（node v24、1 MB 的輸入樣本；硬體沒寫，不是 Workers）：`inflate-pako` 每秒 138 次、`inflate-zlib`（Node 原生）每秒 397 次、`deflate-pako` 每秒 14.27 次、`deflate-zlib` 每秒 30.30 次（[pako README › Benchmarks](https://github.com/nodeca/pako/blob/32be8f8e0ead1e6e8a74a1586a34f84734382d01/README.md#benchmarks)）。換算起來大約是解壓每秒一百多 MB、壓縮每秒十幾 MB（以未壓縮的大小計）。**這是別的機器上的數字**，只能看出「壓縮比解壓慢約十倍」這個量級差。
- 由這組數字推算（推論，不是量測）：如果重寫時要把 1 GB 的內容**重新壓縮**，以 pako 每秒約 14 MB 算要七十秒上下，而且未壓縮的大小通常比 pack 大好幾倍；再加上 delta 要重算的話會更多。**直接複製壓縮資料**則不必解壓也不必壓縮，只剩讀 R2、寫 R2、對輸出算一次 SHA-1（pack 結尾的 checksum）。

### 2.2 git 自己怎麼避免重算

- `git pack-objects` 預設就會重用：「When creating a packed archive in a repository that has existing packs, the command reuses existing deltas.」要關掉得明講 `--no-reuse-delta`；`--no-reuse-object` 則連非 delta 的物件也不重用，「forcing recompression of everything」，文件說這「Useful only in the obscure case」想統一壓縮等級時才用（[git-pack-objects.adoc:235-247](https://github.com/git/git/blob/d38352cd43ab9745686d697872408bc3249a153f/Documentation/git-pack-objects.adoc?plain=1#L235-L247)）。`git repack` 的 `-f`／`-F` 就是把這兩個旗標傳下去（[git-repack.adoc](https://github.com/git/git/blob/d38352cd43ab9745686d697872408bc3249a153f/Documentation/git-repack.adoc)）。
- 為什麼重要：「the server can avoid inflating most objects at all and just send the bytes directly from disk」；只有 delta 的底稿不在輸出裡時，才要「break」那個 delta 重新找，「which has a high CPU cost」（[git-pack-objects.adoc › DELTA ISLANDS](https://github.com/git/git/blob/d38352cd43ab9745686d697872408bc3249a153f/Documentation/git-pack-objects.adoc?plain=1#L414-L426)）。
- **直接複製時怎麼防止把壞資料抄過去**：`write_reuse_object()` 在複製前，若舊 pack 的 `.idx` 是 v2 就比對 `.idx` 裡記的 CRC32，不對就改走不重用的路徑；`.idx` 是 v1（沒有 CRC）則把資料實際解壓一遍，確認長度對得上（[builtin/pack-objects.c:455-483](https://github.com/git/git/blob/d38352cd43ab9745686d697872408bc3249a153f/builtin/pack-objects.c#L455-L483)、[:635-690](https://github.com/git/git/blob/d38352cd43ab9745686d697872408bc3249a153f/builtin/pack-objects.c#L635-L690)）。
- 複製時要改的只有每個物件的標頭：`OBJ_OFS_DELTA` 記的是「往前幾個 byte 是底稿」，在新 pack 裡位置變了，所以要重算這段距離再寫（同一段程式）。

### 2.3 對照 fugitive 現有的資料

- `objects` 表每一列已經有壓縮資料的起點（`data_offset`）和長度（`data_len`），`store.raw()` 可以直接讀出「The object's raw compressed data in its pack」，而且註解寫 clone 已經在用這條路「copy it as-is」（`src/store.ts`）。也就是說，要做 2.2 那種複製，需要的位置資訊已經在目錄裡。這是讀程式碼的結果，不是實測。
- fugitive 沒有 `.idx` 檔，也沒有記每個物件的 CRC32；複製時要不要驗、怎麼驗，現有資料給不出來。

## 3. 別人怎麼做

### 3.1 durable-git：刪分支或 force push 後排 alarm，整批搬成 loose

出處都在 [littledivy/durable-git@`d5eba04`](https://github.com/littledivy/durable-git/tree/d5eba04eda584b855a1bde1f86a836b751c378c0)。

- **觸發**：push 裡有刪 ref 或非 fast-forward 的更新時設 `needsGc`（[src/git/protocol.ts:1314-1319](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/protocol.ts#L1314-L1319)），push 完寫 `gc-pending=1` 並排一個 5 分鐘後的 alarm（[src/repo.ts:818-824](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/repo.ts#L818-L824)）。另有 `POST /<repo>/gc` 手動觸發。
- **跟 push、clone 錯開**：alarm 醒來時若還有上傳在跑（`activeUploads > 0`），就 30 秒後再排一次；否則先把 `gc-pending` 清成 0（註解：「at-most-once, so a throwing sweep can't trigger a retry storm」）再跑（[src/repo.ts:277-300](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/repo.ts#L277-L300)）。GC 本身接在 push 用的同一條 promise 鏈後面，並包在 `blockConcurrencyWhile` 裡（[src/repo.ts:302-319](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/repo.ts#L302-L319)）。
- **做法**（[src/repo.ts:346-420](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/repo.ts#L346-L420)）：
  - 物件超過 30 萬個就整個跳過。
  - 從所有 ref 和 HEAD 走一遍標出走得到的物件；另外把所有 delta 的底稿都當成要留（thin pack 的底稿常常是走不到的物件）。
  - 沒有另寫一個新 pack：把每個走得到的 pack 物件讀出來（delta 會被解開），重新 `deflate` 後寫成 SQLite 裡的 loose 物件（[src/git/store.ts:136-150](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/store.ts#L136-L150)），然後把所有 pack 清掉、刪 R2 上的 pack，最後刪走不到的 loose 物件。
  - 複製前先檢查：SQLite 大小加上 pack 大小超過 10 GB（DO 的儲存上限）就不搬。
  - **沒有寬限期**：走不到就刪。
- 對照第 1 節：`blockConcurrencyWhile` 有 30 秒逾時，逾時 DO 會被重設；durable-git 的註解與程式沒有處理 GC 超過 30 秒的情況。

### 3.2 git-on-cloudflare：只合併、不刪物件，重寫在 Queue consumer 裡做

出處都在 [zllovesuki/git-on-cloudflare@`007a96e`](https://github.com/zllovesuki/git-on-cloudflare/tree/007a96eae94c8f562d223f81eb7548c8f7c38673)。它的 pack 全放 R2，每個 pack 旁邊有標準的 `.idx`，DO 的 SQLite 只記有哪些 pack（`pack_catalog`）。

- **明說不做 GC**：「The design does not implement full Git garbage collection of unreachable objects. Compaction preserves the union of source-pack objects … avoids a repo-wide mark phase」；compaction「does not … delete unreachable objects from within a pack」（[docs/streaming-push.md:45-49](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/docs/streaming-push.md?plain=1#L45-L49)、[:636-642](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/docs/streaming-push.md?plain=1#L636-L642)）。新 pack 的內容就是來源 pack 所有物件 id 的聯集（[src/worker/git/compaction/plan.ts](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/compaction/plan.ts)）。
- **挑哪幾個 pack 合**：每個 pack 有一個層級（tier）；某一層超過 4 個 pack，就拿那層最舊的 4 個合成一個、放到下一層（`COMPACTION_FAN_IN = 4`，[src/worker/do/repo/catalog/compaction/plan.ts:10](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/do/repo/catalog/compaction/plan.ts#L10)、[:125-143](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/do/repo/catalog/compaction/plan.ts#L125-L143)）。所以一次只重寫 4 個同層的 pack，不重寫整個儲存庫。
- **不重新壓縮**：重寫引擎「preserve compressed payload bytes unchanged」，只重算 OFS delta 的距離與標頭（[docs/better-fetch.md:405-414](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/docs/better-fetch.md?plain=1#L405-L414)）。例外是找不到合適底稿的物件，會把完整內容解出來再 `deflate` 一次，單一物件上限 8 MB、合計上限 32 MB（[src/worker/git/pack/rewrite/selectionResolve.ts:35-36](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/pack/rewrite/selectionResolve.ts#L35-L36)、[:487](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/pack/rewrite/selectionResolve.ts#L487)）。
- **在哪裡跑**：push 結束時如果需要合併，DO 記下 `compactionWantedAt` 並排一個 5 秒後的 alarm；alarm 只負責把工作丟進 Queue（[docs/architecture.md › Background processing and alarms](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/docs/architecture.md?plain=1#L87-L98)）。真正讀 R2、寫新 pack 的是 Queue consumer（一般的 Worker，不是 DO），每批一則訊息（`max_batch_size: 1`），`cpu_ms` 同樣設到 300,000（[wrangler.jsonc](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/wrangler.jsonc)）。它自己設了子請求的軟上限 7,500（[src/worker/tasks/compaction.ts:25](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/tasks/compaction.ts#L25)）。
- **跟 push 怎麼錯開**：
  - push 與 compaction 各有一個有期限的 lease（`receiveLease` 30 分鐘、`compactLease` 20 分鐘，[src/worker/do/repo/catalog/shared.ts:5-9](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/do/repo/catalog/shared.ts#L5-L9)）。
  - 同時只允許一個 push，第二個拿到 `503 Retry-After: 10`（[docs/data-flows.md:8](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/docs/data-flows.md?plain=1#L8)）。
  - push 進來時**不會**因為 compaction 在跑而被擋；反過來，compaction 開始時若有 push 在跑就 10 秒後重試，提交時再檢查一次：有 push 在跑、或 pack 集合的版本號變了，就放棄這次結果重來（[src/worker/do/repo/catalog/compaction/lease.ts:66-90](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/do/repo/catalog/compaction/lease.ts#L66-L90)、[:160-180](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/do/repo/catalog/compaction/lease.ts#L160-L180)）。
- **舊 pack 什麼時候刪**：提交成功後，被取代的 pack 在目錄裡標成 superseded，再丟一則延遲 60 秒的 Queue 訊息去刪 R2 上的 `.pack`、`.idx`、`.refs`（[src/worker/tasks/compaction.ts:28](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/tasks/compaction.ts#L28)、[:336-347](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/tasks/compaction.ts#L336-L347)、[:401-407](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/tasks/compaction.ts#L401-L407)）。程式碼沒有說明 60 秒這個數字的理由。

### 3.3 git 本身：寬限期、cruft pack、geometric repack

- **寬限期**：`git gc` 預設呼叫 `prune --expire 2.weeks.ago`（用 cruft pack 時是 `repack --cruft --cruft-expiration 2.weeks.ago`），可用 `gc.pruneExpire` 改；設 `now` 就是不留寬限期。文件說這個設定「helps prevent corruption when 'git gc' runs concurrently with another process writing to the repository」（[config/gc.adoc:96-105](https://github.com/git/git/blob/d38352cd43ab9745686d697872408bc3249a153f/Documentation/config/gc.adoc?plain=1#L96-L105)）。
- **寬限期為什麼有效、為什麼不完全有效**：`git gc` 的 NOTES 寫，跟另一個程序同時跑時，可能刪到「the other process is using but hasn't created a reference to」的物件，對方之後掛上 ref 就壞了。兩個緩解辦法：比 `--prune` 時間新的物件（和從它走得到的物件）都留著；大多數寫入物件的操作遇到物件已存在時會更新它的修改時間。但「these features fall short of a complete solution … have to live with some risk of corruption (which seems to be low in practice)」（[git-gc.adoc:138-169](https://github.com/git/git/blob/d38352cd43ab9745686d697872408bc3249a153f/Documentation/git-gc.adoc?plain=1#L138-L169)）。
- **cruft pack**：以前走不到的物件要拆成 loose 檔，才記得住每個物件各自的時間；物件一多會拖慢檔案系統、也無法用 delta 壓縮。cruft pack 把它們收進一個 pack，另存 `.mtimes` 檔記每個物件的時間。git 格式文件寫：「Unreachable objects aren't removed immediately, since doing so could race with an incoming push which may reference an object which is about to be deleted」（[gitformat-pack.adoc:611-680](https://github.com/git/git/blob/d38352cd43ab9745686d697872408bc3249a153f/Documentation/gitformat-pack.adoc?plain=1#L611-L690)）。git 2.37 加入（[RelNotes/2.37.0](https://github.com/git/git/blob/d38352cd43ab9745686d697872408bc3249a153f/Documentation/RelNotes/2.37.0.adoc?plain=1#L51-L53)），2.41 起 `gc.cruftPacks` 預設為 true（[RelNotes/2.41.0](https://github.com/git/git/blob/d38352cd43ab9745686d697872408bc3249a153f/Documentation/RelNotes/2.41.0.adoc?plain=1#L75-L79)、[config/gc.adoc:85-88](https://github.com/git/git/blob/d38352cd43ab9745686d697872408bc3249a153f/Documentation/config/gc.adoc?plain=1#L85-L88)）。
- **geometric repack**：`--geometric=<factor>` 讓「each successive pack contains at least `<factor>` times the number of objects as the next-largest pack」；它挑「the smallest set of packfiles such that as many of the larger packfiles … may be left intact」，要打包的物件只由被合併的那幾個 pack 決定，loose 物件一律併入「without respect to their reachability」（[git-repack.adoc:266-285](https://github.com/git/git/blob/d38352cd43ab9745686d697872408bc3249a153f/Documentation/git-repack.adoc?plain=1#L266-L285)）。也就是說 geometric repack 本身**不刪**走不到的物件。
- **兩者合起來**：`git maintenance` 的 `geometric` 策略平常做 geometric repack；只有當它判斷要全部合成一個時，才「generates a cruft pack for all unreachable objects. Objects that are already part of a cruft pack will be expired」。文件說它「recommended for large repositories」，而且是手動 maintenance 的預設策略；等比係數 `maintenance.geometric-repack.splitFactor` 預設 2（[config/maintenance.adoc:34-43](https://github.com/git/git/blob/d38352cd43ab9745686d697872408bc3249a153f/Documentation/config/maintenance.adoc?plain=1#L34-L43)、[:107-110](https://github.com/git/git/blob/d38352cd43ab9745686d697872408bc3249a153f/Documentation/config/maintenance.adoc?plain=1#L107-L110)）。

### 3.4 GitLab（Gitaly）

出處：GitLab 官方文件〈Housekeeping〉。`docs.gitlab.com` 在這台機器連不到，讀的是 GitLab 在 GitHub 上的官方鏡像 [gitlabhq/gitlabhq `doc/administration/housekeeping.md`](https://github.com/gitlabhq/gitlabhq/blob/b3d0d0b18b3b07143fd6ecb79f66613a195b0ad3/doc/administration/housekeeping.md)，內容相同。

- **兩種策略**：「eager」不管儲存庫狀態、照指定的工作做，手動觸發與「每 N 次 push 觸發」用這個；「heuristical」先看 loose 物件數、pack 數、loose ref 數、有沒有 commit-graph，只做需要的部分，排程觸發用這個。越大的儲存庫物件 repack 得越頻繁；ref 則是越多越少做。
- **寬限期**：排程的 housekeeping 刪走不到的物件時寬限期是**兩週**；手動按「Prune unreachable objects」時縮成 **30 分鐘**。文件的警告：同時有 `git push` 建了物件但還沒建 ref 時，「your repository can become corrupted if a reference to the object is added after the object is deleted. The grace period exists to reduce the likelihood of such race conditions」，並舉例常透過慢線路推大量大物件的專案風險比較高。
- **時間上限**：排程 housekeeping 預設每天中午跑 10 分鐘，到時間就「gracefully canceled」，下一輪把儲存庫順序隨機打散再做。
- **fork 共用的 object pool 永遠不刪走不到的物件**，因為可能有別的 fork 在用。
- Gitaly 實際用哪些 `git repack` 參數（有沒有 geometric、cruft）要看 Gitaly 原始碼；`gitlab.com` 在這台機器連不到，**這次沒有查到**。

### 3.5 GitHub

GitHub 工程部落格有兩篇相關文章（〈Scaling Git's garbage collection〉講 cruft pack，〈Scaling monorepo maintenance〉講 geometric repack），但 `github.blog` 在這台機器連不到，**這次沒有讀到原文**，不列入事實。git 文件裡 cruft pack 與 geometric repack 的說明（3.3）是目前唯一有讀到的一手出處。

## 4. R2 的清理

| 項目 | 數字／行為 | 出處 |
| --- | --- | --- |
| `list()` 一次最多幾筆 | 預設 1,000、上限 1,000，可能回得比較少；要看 `truncated` 決定有沒有下一頁，用 `cursor` 接著列 | [R2 Workers API › R2ListOptions](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions) |
| `delete()` 一次最多幾個 key | 1,000；強一致，resolve 之後全世界都讀不到 | [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) |
| 列出的費用 | `ListObjects` 是 Class A：每百萬次 4.50 美元（Standard），每月前 100 萬次免費 | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| 刪除的費用 | `DeleteObject`、`AbortMultipartUpload` 免費 | 同上 |
| 儲存費 | Standard 每 GB-月 0.015 美元，每月前 10 GB-月免費；以每天的**最高**用量平均計算 | 同上 |
| 子請求 | R2 呼叫算子請求，預設每次 invocation 10,000 個（見 #27）；刪 1,000 個 key 是一次 `delete()` 呼叫 | [Workers limits › Subrequests](https://developers.cloudflare.com/workers/platform/limits/#subrequests) |
| 沒完成的 multipart upload | 「Uncompleted multipart uploads will be automatically aborted after 7 days」；這是 bucket 預設的 lifecycle 規則，可以改 | [R2 Workers API › R2MultipartUpload](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[Upload objects](https://developers.cloudflare.com/r2/objects/upload-objects/#incomplete-upload-lifecycles)、[Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) |
| lifecycle 規則 | 可以依前綴設「N 天後刪除」、「N 天後轉 Infrequent Access」、「N 天後 abort 沒完成的 multipart」；每個 bucket 最多 1,000 條；到期後「typically be removed from a bucket within 24 hours」 | [Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) |
| lifecycle 規則怎麼設 | dashboard、`wrangler r2 bucket lifecycle`、S3 API；文件沒有提到能從 Workers binding 設 | 同上 |

- lifecycle 規則看的是物件的**建立時間**和**前綴**，不知道物件還有沒有被目錄引用；它能自動清的是「過了 N 天就一定沒用」的東西（例如沒完成的 multipart）。這是從規則的欄位推出來的，文件沒有這樣明講。
- fugitive 現在的 R2 key 是 `<DO id>/packs/<pack id>.pack`（`src/store.ts` 的 `r2Key()`；刪除儲存庫時以 `${this.ctx.id}/` 為前綴列出）。

## 查不到、要實測或要確認的事

1. **alarm handler 的 CPU 上限**：文件只寫了 alarm 的 wall time 15 分鐘，CPU 上限（是不是跟 `cpu_ms` 一樣 5 分鐘、alarm 算不算一個「request」會重算 CPU）沒有明文。要實測。
2. **alarm 超過 15 分鐘會怎樣**：算失敗而重試，還是直接丟掉，文件沒寫。
3. **Workers 上 pako 解壓、壓縮、SHA-1 的實際吞吐量**：只有 pako 自己在 Node 上的 benchmark。要在 Workers 上實測，才知道一次 alarm 能處理多少 MB。
4. **直接複製壓縮資料時怎麼驗證**：git 靠 `.idx` v2 的 CRC32，fugitive 沒有存 CRC。
5. **GitHub 與 Gitaly 的實際做法**：`github.blog`、`docs.gitlab.com`、`gitlab.com`、`git-scm.com` 這次都連不到，已提出放行申請；git 文件改讀 GitHub 上的 git/git 原始碼，GitLab 文件改讀 GitHub 上的官方鏡像。
