# 現有 Durable Object git 伺服器調查

Fugitive 決定自己在 Workers + SQLite 版 Durable Object 上實作 git 的 smart HTTP 協定（見 [ADR 0001](../adr/0001-own-git-protocol-on-durable-objects.md)），第一段的目標是：寫死一個使用者和一把金鑰，讓 `git push`／`git clone` 透過 HTTPS 能動。網路上已經有四個專案做過同樣的事，這份筆記逐一讀它們的原始碼，回答 [issue #3](https://github.com/yurenju/fugitive/issues/3) 的六個問題，最後比較並給出建議。

**結論先講**：第一段以 **littledivy/durable-git** 為起點（MIT、核心 git 程式約四千行、唯一依賴是 `pako`、不綁 R2 也能跑、ref 更新在 `transactionSync` 裡做 CAS、附一支拿真的 `git` 指令跑的端對端腳本）。測試手法和少數協定細節向 alchemy PR #1187 借；等 repository 大到 SQLite 撐不住時，再參考 git-on-cloudflare 的「pack 串流進 R2、Worker 建 idx」做法。Edge-Git 不建議當起點。

<details>
<summary>調查方法與版本</summary>

全部讀原始碼（用 `gh api` 下載 tarball），沒有部署或執行任何一個專案。所有連結都釘在下列 commit：

| 專案 | commit | 最後 commit 時間 |
| --- | --- | --- |
| [littledivy/durable-git](https://github.com/littledivy/durable-git) | `d5eba04eda584b855a1bde1f86a836b751c378c0` | 2026-08-21 |
| [zllovesuki/git-on-cloudflare](https://github.com/zllovesuki/git-on-cloudflare) | `007a96eae94c8f562d223f81eb7548c8f7c38673` | 2026-05-13 |
| [Rexezuge-CloudflareWorkers/Edge-Git](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git) | `ce78df0726f89b8fb29bafd245402833976af228` | 2026-09-21 |
| [alchemy-run/alchemy PR #1187](https://github.com/alchemy-run/alchemy/pull/1187) | head `cd5073b4c1c5c0fc5ba8eba368360facd388cdae`（2026-09-13 合併為 `9e2f885`） | — |

</details>

## 名詞

- **pack（packfile）**：git 把一堆物件壓在一起傳輸的格式。push 時 client 送一個 pack 上來，clone 時 server 組一個 pack 送下去。
- **delta（ofs-delta／ref-delta）**：pack 裡的物件可以只存「跟另一個物件（base）的差異」。`ofs-delta` 用「往前幾個 byte」指 base，`ref-delta` 用 base 的 oid 指。
- **thin pack**：push 時 client 送的 pack 裡，delta 的 base 可以是 server 本來就有、pack 裡沒附的物件。server 必須去自己的儲存裡找 base 才解得開。
- **idx**：pack 的索引檔（oid → pack 內 offset），標準 git 格式。
- **v0／v2**：smart HTTP 協定版本。v0 是「server 先廣告所有 ref 加 capability」；v2 改成 client 下指令（`ls-refs`、`fetch`）。**push（receive-pack）在實務上只有 v0**；v2 只影響 clone／fetch（upload-pack）。
- **CAS（compare-and-swap）**：push 帶著 `<old-oid> <new-oid> <ref>`，server 只在 ref 目前真的等於 `old-oid` 時才改成 `new-oid`。
- **`transactionSync`**：SQLite 版 DO 的同步交易 API，裡面不能 `await`，但保證整段一起成功或一起失敗。
- **side-band-64k**：把 pack 資料、進度訊息、錯誤訊息分三個頻道多工在同一個回應裡。

---

## 1. littledivy/durable-git（dgit）

一個 repository 就是一個 SQLite 版 DO（`RepoCell`），用 `env.REPO.getByName(repo)` 定址（[src/mod.ts:547](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/mod.ts#L547)）。另有一個全域 `Registry` DO 當 repository 清單（[wrangler.jsonc:15-24](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/wrangler.jsonc#L15-L24)）。它同時是一個 npm 套件 `durable-git`，可以當函式庫用（[README.md:96-128](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/README.md#L96-L128)）。

### 1.1 物件與 ref 怎麼存

- **整個 pack 原樣保存 + 每個物件一列索引。** client push 上來的 pack 不拆，原封不動存起來；另外在 `pack_objects` 表為每個物件記一列：`oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid`（[src/git/packstore.ts:214-251](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/packstore.ts#L214-L251)）。README 的說法是「client 的壓縮被保留，而不是重算」（[README.md:23-31](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/README.md#L23-L31)）。
- **pack 的 bytes 放哪由大小決定。** 沒綁 R2 時，pack 切成 1 MB 一列存在 `pack_data(pack_id, seq, data)`；有綁 `PACK_CACHE` R2 且 pack ≥ 16 MB（或長度未知的 chunked 上傳）時，bytes 走 R2 multipart，SQLite 只留索引（[src/git/packstore.ts:8-12](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/packstore.ts#L8-L12)、[:536-551](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/packstore.ts#L536-L551)）。R2 是選配，拿掉就全走 SQLite（[README.md:57-60](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/README.md#L57-L60)）。
- 另有舊式的 loose 物件表 `objects` + `chunks`，GC 後小 repository 會把物件搬過去（[src/git/store.ts:46-57](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/store.ts#L46-L57)）。
- **ref**：`refs(name TEXT PRIMARY KEY, target TEXT)`；HEAD 指向哪個分支存在 `meta` 表（[src/git/store.ts:58-65](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/store.ts#L58-L65)）。
- 完整 clone 組出來的 pack 會快取到 R2，之後 Worker 直接從 R2 串給 client，不喚醒 DO（[README.md:28-31](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/README.md#L28-L31)）。

### 1.2 協定版本與 capability

- **upload-pack（clone／fetch）支援 v0 和 v2。** 看 `Git-Protocol` header 有沒有 `version=2` 決定（[src/repo.ts:196](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/repo.ts#L196)）。v2 廣告 `ls-refs`、`fetch=shallow`；v0 廣告 `multi_ack_detailed no-done shallow side-band-64k symref=HEAD:… agent=dgit/0.3`（[src/git/protocol.ts:39-53](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/protocol.ts#L39-L53)）。
- **receive-pack（push）只有 v0**，廣告 `report-status delete-refs ofs-delta side-band-64k agent=…`（[src/git/protocol.ts:53](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/protocol.ts#L53)）。**沒有** `atomic`、`report-status-v2`、`push-options`、`quiet`。
- **shallow**：支援 `--depth`、加深、`--unshallow`（[README.md:35-37](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/README.md#L35-L37)、[src/git/protocol.ts:550-570](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/protocol.ts#L550-L570)）。
- **thin pack**：push 時接受（ingest 第三階段會去既有 pack／loose 物件找 base，見 1.3）。clone 時 server 送出的 pack **不含 ofs-delta**，delta 一律改寫成 ref-delta（[src/git/protocol.ts:696-700](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/protocol.ts#L696-L700)）。
- 只有 smart HTTP，其他 `service` 回 400（[src/repo.ts:192-195](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/repo.ts#L192-L195)）。

### 1.3 push 的 pack 怎麼在限制內處理

**串流，不整包緩衝。** Worker 把 request 轉給 DO，DO 用 `req.body.getReader()` 一邊收一邊處理（[src/repo.ts:715-722](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/repo.ts#L715-L722)）；只有 gzip 過的小 body 會整包讀，且解壓有上限（同段）。`ingest` 分三個階段（[src/git/packstore.ts:471-888](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/packstore.ts#L471-L888)）：

1. **A：存 bytes、驗 checksum。** 1 MB 固定 buffer 寫進 `pack_data` 或 R2，同時對所有 byte 算 SHA-1，最後比對 pack 尾巴的 20 byte（[:553-645](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/packstore.ts#L553-L645)）。
2. **B：循序掃描、當場解 delta。** 用 16 MB（Workers 上）的 LRU 快取最近解開的物件當 delta base，另外記最近 15 萬個 offset→oid 給 ofs-delta 查；base 不在手上的 delta 先丟進 `pack_pending` 表（[:647-820](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/packstore.ts#L647-L820)、快取預算 [src/repo.ts:768-783](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/repo.ts#L768-L783)）。
3. **C：補解剩下的 delta。** 反覆掃 `pack_pending`，每頁 500 列，base 找得到就解；一整輪都沒進展就判定缺 base、整個 push 失敗（[:822-879](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/packstore.ts#L822-L879)）。thin pack 的 base 就是在這裡從既有儲存裡找到的。

控制資源的做法：

- 每 2000 個物件 `setTimeout(0)` 讓出 event loop，並呼叫 `ctx.storage.sync()`，因為「workerd 把一個 request 的 dirty page 留在 128 MB 的 isolate heap 裡」（[src/git/packstore.ts:489-492](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/packstore.ts#L489-L492)、[:809-814](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/packstore.ts#L809-L814)）。
- pako 的輸出 chunk 從預設 64 KiB 降到 16 KiB，註解說預設值讓「一個 53 MB 的 pack 的 buffer 衝到接近 250 MB」（[src/git/packstore.ts:35-42](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/packstore.ts#L35-L42)）。
- 單一物件 > 8 MB 時不整個放進記憶體，改成邊解壓邊算 hash（[src/git/packstore.ts:13-15](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/packstore.ts#L13-L15)）。
- 同一個 repository 的 push 用 `receiveChain` 串成一個接一個，避免兩個 ingest 搶同一個 pack id（[src/repo.ts:162-163](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/repo.ts#L162-L163)、[:658-667](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/repo.ts#L658-L667)）。
- `wrangler.jsonc` 把 CPU 開到上限 `cpu_ms: 300000`（[wrangler.jsonc:12-15](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/wrangler.jsonc#L12-L15)）。push 大小上限 `MAX_PUSH_MB` 預設 512（[src/repo.ts:53-54](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/repo.ts#L53-L54)），**比平台的 100 MB body 限制還大**，實際上限由平台決定；README 也說很大的歷史要分幾次 push（[README.md:69-76](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/README.md#L69-L76)）。
- 連通性檢查：push 完先確認新物件引用到的子物件都存在，用 SQL anti-join 分批檢查，記憶體不隨物件數成長（[src/git/protocol.ts:1182-1223](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/protocol.ts#L1182-L1223)）。

### 1.4 ref 更新的 CAS

分兩段，兩段都檢查：

1. `validatePush`（async，會讀 R2 上的物件）：`store.getRef(ref) !== cmd.old` 就回 `ng … fetch first`；另外檢查 ref 名稱合法性、連通性、是否 fast-forward（非 fast-forward 仍允許，標記為 forced 並排 GC）（[src/git/protocol.ts:1225-1290](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/protocol.ts#L1225-L1290)）。
2. `commitPush` 在 `ctx.storage.transactionSync` 裡**再比一次**每個 ref 的現值，對了才寫（[src/git/protocol.ts:1292-1347](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/protocol.ts#L1292-L1347)、呼叫處 [src/repo.ts:801-808](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/repo.ts#L801-L808)）。

拆成兩段的原因寫在註解：讀 R2 需要 `await`，而 `transactionSync` 裡不能 `await`（[src/git/protocol.ts:1150-1163](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/git/protocol.ts#L1150-L1163)）。多個 ref 的 push 若中途 throw，整批回滾；但**個別 ref 的 CAS 失敗只拒絕那一個**，其他照常更新（沒有 `atomic` 語意）。

### 1.5 測試

- **沒有單元測試**，repository 裡沒有 test 目錄。CI 只跑 `typecheck` 然後發 npm（[.github/workflows/publish.yml:23-24](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/.github/workflows/publish.yml#L23-L24)）。
- **有一支拿真的 `git` 指令跑的端對端腳本** [scripts/e2e.sh](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/scripts/e2e.sh)，對一個 URL（預設 `wrangler dev` 的 `127.0.0.1:8787`）跑。涵蓋：
  - push → clone → `git fsck --strict` → 內容比對（[:50-57](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/scripts/e2e.sh#L50-L57)）
  - `--depth 1`、加深、`--unshallow`（[:59-67](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/scripts/e2e.sh#L59-L67)）
  - 增量 fetch 只送少量物件、side-band 進度（[:69-78](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/scripts/e2e.sh#L69-L78)）
  - force push + GC、建／刪分支、非 fast-forward 被拒（[:80-96](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/scripts/e2e.sh#L80-L96)）

  但這支腳本沒有接進 CI。

### 1.6 授權

**MIT**，Copyright (c) 2026 Divy Srivastava（[LICENSE:1-3](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/LICENSE#L1-L3)）。可以直接複製修改，保留版權聲明即可。唯一的 runtime 依賴是 `pako`（[package.json](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/package.json)）。

其他值得知道的：預設**讀是公開的**，只有 push 要驗證（Basic auth，密碼比對 `GIT_TOKEN`／`GIT_TOKENS`）；push 到不存在的名字會自動建立 repository（[README.md:12-14](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/README.md#L12-L14)、[src/mod.ts:70-110](https://github.com/littledivy/durable-git/blob/d5eba04eda584b855a1bde1f86a836b751c378c0/src/mod.ts#L70-L110)）。Fugitive 的 repository 全部是 Private repository，這兩點要改。

---

## 2. zllovesuki/git-on-cloudflare

一個 repository 一個 SQLite 版 DO，用 `idFromName(repoId)` 定址，`repoId` 是 D1 `repositories.do_name` 欄位（[src/worker/common/stub.ts:8-11](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/common/stub.ts#L8-L11)）。它的特點是**分工**：Worker 無狀態，負責所有吃資料的工作（解 pack、建索引、組 fetch 的 pack）；DO 只管中繼資料（[docs/streaming-push.md:9](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/docs/streaming-push.md?plain=1#L9)、[AGENTS.md:18-27](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/AGENTS.md?plain=1#L18-L27)）。另外用 D1（使用者、PAT）、KV（路由快取）、R2、Queue（compaction）（[wrangler.jsonc](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/wrangler.jsonc)）。

### 2.1 物件與 ref 怎麼存

- **整個 pack + 標準 git idx v2，全部放 R2，沒有逐物件的列。** key 是 `do/<doId>/objects/pack/<name>.pack`，同名 `.idx`，再加一個 `.refs` 側檔（[src/worker/keys.ts:6-28](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/keys.ts#L6-L28)）。idx 是在 Worker 裡產生、依 oid 排序的 v2 格式（[src/worker/git/pack/indexer/writeIdx.ts:12-53](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/pack/indexer/writeIdx.ts#L12-L53)）。文件明說 R2 上的 `.pack`／`.idx` 是唯一的正確性來源（[docs/streaming-push.md:57-80](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/docs/streaming-push.md?plain=1#L57-L80)）。
- DO 的 SQLite 只有一張 `pack_catalog` 表，記錄有哪些 pack、是否已被 compaction 取代（[src/worker/do/repo/db/schema.ts:4-31](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/do/repo/db/schema.ts#L4-L31)）。
- **ref 不是 SQL 表**，而是 DO key-value storage 裡一個叫 `refs` 的整包陣列 `{name, oid}[]`，每次整包讀寫；HEAD 是另一個 key `head`（[src/worker/do/repo/refs.ts:17-56](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/do/repo/refs.ts#L17-L56)、key 型別 [repoState.ts:14-24](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/do/repo/repoState.ts#L14-L24)）。
- pack 會用分層的方式定期合併（LSM 式，每層 4 個合一），在 Queue consumer 裡跑（[src/worker/do/repo/catalog/compaction/plan.ts:10](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/do/repo/catalog/compaction/plan.ts#L10)）。不可達物件不做 GC（[docs/streaming-push.md:49](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/docs/streaming-push.md?plain=1#L49)）。

### 2.2 協定版本與 capability

- **upload-pack 只有 v2**，不管 `Git-Protocol` header 一律回 v2 廣告：`version 2`、`ls-refs`、`fetch`、`side-band-64k`、`ofs-delta`、`object-format=sha1`（[src/worker/git/core/protocol.ts:25-44](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/core/protocol.ts#L25-L44)）。沒帶 v2 的 POST 會拿到 400 "Expected Git protocol v2"（[src/worker/routes/git.ts:107-114](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/routes/git.ts#L107-L114)）。
- `fetch` 指令**只解析 `want`／`have`／`done`**，其餘（`shallow`、`deepen`、`filter`、`thin-pack`、`include-tag`、`no-progress`）默默忽略（[src/worker/git/operations/args.ts:10-33](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/operations/args.ts#L10-L33)）。所以**不支援 shallow clone**，clone 拿到的是 thick pack（[README.md:151](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/README.md?plain=1#L151)）。
- 協商時它回 `ACK <oid> common`，最後一個是 `ACK <oid> ready`（[src/worker/git/operations/fetch/protocol.ts:34-55](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/operations/fetch/protocol.ts#L34-L55)）。依 git 的 v2 規格（非本 repository 資料），v2 的 ACK 行不帶 `common`，`ready` 是獨立一行，這裡的格式看起來不標準。
- **receive-pack 是 v0**，廣告 `report-status delete-refs side-band-64k quiet atomic ofs-delta agent=…`（[src/worker/git/core/protocol.ts:58-66](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/core/protocol.ts#L58-L66)）。`atomic` 只解析不使用，實際上一律全有或全無（見 2.4）。
- **push 時接受 thin pack**：缺的 ref-delta base 從現有 pack 目錄裡找（[src/worker/git/pack/indexer/resolve/index.ts:309-345](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/pack/indexer/resolve/index.ts#L309-L345)），有測試（[test/streaming-receive.worker.test.ts:412](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/test/streaming-receive.worker.test.ts#L412)）。

### 2.3 push 的 pack 怎麼在限制內處理

這個專案**改寫過一次**，理由值得看。舊做法「把整個 receive-pack body 緩衝在記憶體，用 isomorphic-git 在記憶體檔案系統上建索引，再拆成 loose 物件存進 DO、同步到 R2」（[docs/streaming-push.md:23-29](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/docs/streaming-push.md?plain=1#L23-L29)），問題是 DO 在做吃資料的工作、isomorphic-git 需要整個 pack 在記憶體（[:310](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/docs/streaming-push.md?plain=1#L310)）。設計目標是約 7 萬物件、40 MB pack、3 MB idx，「不把整個 pack 緩衝在記憶體」（[:929](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/docs/streaming-push.md?plain=1#L929)）。文件沒有記錄舊做法實際 OOM 或超時的數字。

新流程（[src/worker/git/receive/pipeline.ts:195-387](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/receive/pipeline.ts#L195-L387)）：

1. 先向 DO 要一個 **receive lease**（同一時間一個 repository 只允許一個 push），拿不到回 503（[streamReceivePack.ts:261-273](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/receive/streamReceivePack.ts#L261-L273)）。
2. **pack 原樣串流進 R2**：有 `Content-Length` 就用 `FixedLengthStream` 一次 `put`，chunked 就用 8 MiB 一段的 multipart；邊傳邊驗 `PACK` magic 和尾端 SHA-1（[src/worker/git/receive/r2Upload.ts:89-221](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/receive/r2Upload.ts#L89-L221)）。
3. **第一輪 scan**：用 1 MiB 的 R2 range read 循序讀，算出每個物件的位置、hash 非 delta 物件，記在 typed array 裡（[src/worker/git/pack/indexer/scan.ts](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/pack/indexer/scan.ts)）。
4. **第二輪解 delta**：依 offset 順序解 ofs-delta，ref-delta 延後處理，最後找外部 base；base 快取 32 MiB LRU，被踢掉的從 R2 重讀（[resolve/index.ts:55-140](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/pack/indexer/resolve/index.ts#L55-L140)）。
5. 產生 idx 寫回 R2，做淺層連通性檢查（commit 的 tree 和 parent 存在即可，不是完整閉包）（[connectivity.ts:160-176](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/pack/indexer/connectivity.ts#L160-L176)），然後呼叫 DO 的 `finalizeReceive`。

硬上限：25 萬個物件、pack 不超過 4 GiB（idx 不用 64-bit offset）（[scan.ts:33-39](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/pack/indexer/scan.ts#L33-L39)）；`cpu_ms: 300000`（[wrangler.jsonc:20-22](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/wrangler.jsonc#L20-L22)），跟 README 寫的「30 秒 CPU 限制」矛盾（[README.md:148](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/README.md?plain=1#L148)）。程式碼裡**沒有**明確的 pack／body 大小上限。receive lease 30 分鐘且不續約（[catalog/shared.ts:5-7](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/do/repo/catalog/shared.ts#L5-L7)）。

### 2.4 ref 更新的 CAS

- 並行控制靠 **lease**：`beginReceiveLease` 在已有未過期 lease 時失敗，否則寫入一個隨機 token（[catalog/leases.ts:33-65](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/do/repo/catalog/leases.ts#L33-L65)）。
- CAS 在 DO 的 `finalizeReceiveState` 裡做：重新確認 lease token → 對**目前**的 `refs` 重跑驗證（刪除要 old-oid 相符、建立要 old-oid 為零、更新要 old-oid 相符，否則 `ng … stale old-oid`）→ 任何一個失敗就全部不套用 → 套用、更新 pack 目錄、寫回 `refs`、刪 lease（[catalog/receive.ts:52-159](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/do/repo/catalog/receive.ts#L52-L159)、規則 [operations/validation.ts:27-85](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/operations/validation.ts#L27-L85)）。
- **沒有用 `transaction()` 或 `transactionSync()`**，是一串 `await ctx.storage.get/put` 加一個 drizzle upsert。正確性靠 DO 單執行緒、input/output gate 和 lease。這串寫入在當機時是否原子，是平台行為，從原始碼判斷不了。
- 問題一：admin 的 `PUT /:owner/:repo/admin/refs` 直接整包覆寫 `refs`，繞過 lease 和 CAS（[src/worker/routes/admin.ts:111-123](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/routes/admin.ts#L111-L123)）。
- 問題二：多 ref push 時，若只有部分 ref 連通性檢查失敗，其他 ref 仍回 `ok`，但 `finalizeReceive` 根本沒被呼叫，ref 並沒有更新（[pipeline.ts:256-294](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/src/worker/git/receive/pipeline.ts#L256-L294)）。client 會以為成功了。測試只涵蓋單一 ref 的情況。

### 2.5 測試

- Vitest 4 + `@cloudflare/vitest-pool-workers`（Miniflare）（[package.json](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/package.json)、[vitest.config.ts](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/vitest.config.ts)）。測試很多（串流 receive、thin pack、stale oid、lease 503、indexer、compaction）。
- **沒有任何測試執行真的 `git` 指令。** 協定測試手工組 pkt-line 丟進 Worker 的 `fetch`，pack 用 TypeScript 產生（[test/util/git-pack.ts:121](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/test/util/git-pack.ts#L121)）。唯一碰到真 git 產物的是一個選配的 42 MiB 真實 pack，用來逐 byte 比對 idx，但這個 fixture 不在 repository 裡（[test/pack-indexer-fixture.worker.test.ts:1-35](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/test/pack-indexer-fixture.worker.test.ts#L1-L35)）。
- tarball 裡沒有 `.github/`，所以看不出上游有沒有 CI。

### 2.6 授權

**MIT**，Copyright (c) 2025 zllovesuki（[LICENSE:1-3](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/LICENSE#L1-L3)）。可直接使用。indexer 和 delta 的程式是手寫的（isomorphic-git 已移除，[MIGRATION-STREAMING-PUSH.md:226](https://github.com/zllovesuki/git-on-cloudflare/blob/007a96eae94c8f562d223f81eb7548c8f7c38673/MIGRATION-STREAMING-PUSH.md?plain=1#L226)），但整體綁了 Hono、drizzle、D1、KV、Queue、OIDC，要抽出來比較費工。

---

## 3. Rexezuge-CloudflareWorkers/Edge-Git

一個 Worker（Hono + Chanfana），git 路由在 API 層做完驗證、分支保護、secret 掃描後，交給每個 repository 一個的 `RepoWorker` DO（[apps/api/src/workers/routes/GitRoutes.ts:24-201](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/apps/api/src/workers/routes/GitRoutes.ts#L24-L201)）。DO 裡用 `dofs`（一個以 DO SQLite 模擬的檔案系統）放一個 bare repository，再用 **isomorphic-git** 操作它（[apps/background/src/RepoWorkerFactory.ts:34-36](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/apps/background/src/RepoWorkerFactory.ts#L34-L36)）。README 說 git 協定部分移植自 Gitflare（[README.md:3](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/README.md?plain=1#L3)）。功能面很廣（PR、issue、webhook、checks），git 核心反而最薄。

### 3.1 物件與 ref 怎麼存

- **普通的 git 檔案，放在 DO SQLite 上的虛擬檔案系統。** 每次 push 把整個 pack 寫成 `/repo/objects/pack/pack-<uuid>.pack`，再用 isomorphic-git 的 `indexPack` 產生 `.idx`（[apps/background/src/PushHandler.ts:98-103](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/apps/background/src/PushHandler.ts#L98-L103)、[packages/git-service/src/PackCollector.ts:38-46](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/packages/git-service/src/PackCollector.ts#L38-L46)）。沒有 R2。
- dofs 以 512 KiB 分塊（[packages/git-service/src/DofsFsAdapter.ts:18-24](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/packages/git-service/src/DofsFsAdapter.ts#L18-L24)），裝置大小預設 5 GB。dofs 是外部 npm 套件 `dofs@0.1.0`，它的表結構從這個 repository 看不到。
- **ref 和 HEAD 是檔案**（`/repo/HEAD`、`refs/...`），由 isomorphic-git 的 `writeRef`／`deleteRef` 處理，沒有 SQL 的 ref 表（[packages/git-service/src/RefService.ts:24-38](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/packages/git-service/src/RefService.ts#L24-L38)、[:329-342](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/packages/git-service/src/RefService.ts#L329-L342)）。

### 3.2 協定版本與 capability

- **upload-pack 只有 v2**，一律回固定的 v2 廣告：`version 2`、`ls-refs`、`fetch=wait-for-done shallow filter`、`side-band-64k`、`object-format=sha1`（[packages/git-protocol/src/AdvertiseBuilder.ts:8-27](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/packages/git-protocol/src/AdvertiseBuilder.ts#L8-L27)）。沒有任何程式讀 `Git-Protocol` header。`fetch` 參數有解析 `shallow`／`deepen*`／`filter`（`blob:none`、`tree:0`、`blob:limit`）（[packages/git-protocol/src/FetchParser.ts:43-79](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/packages/git-protocol/src/FetchParser.ts#L43-L79)、[:269-286](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/packages/git-protocol/src/FetchParser.ts#L269-L286)），但 `thin-pack`／`ofs-delta` 解析後沒被用到。shallow 的實作深度沒有逐行驗證。
- **receive-pack 是 v0**，廣告 `report-status delete-refs atomic no-thin agent=… symref=HEAD:…`（[AdvertiseBuilder.ts:30-36](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/packages/git-protocol/src/AdvertiseBuilder.ts#L30-L36)）。**明確廣告 `no-thin`**，所以 client 不會送 thin pack。push 沒有 side-band、沒有 ofs-delta 廣告、`push-options` 收到只記 log（[PushHandler.ts:74-76](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/apps/background/src/PushHandler.ts#L74-L76)）。

### 3.3 push 的 pack 怎麼在限制內處理

**整包緩衝。** API 層 `await c.req.arrayBuffer()`（[GitRoutes.ts:101](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/apps/api/src/workers/routes/GitRoutes.ts#L101)），掃 secret、解析分支保護，再整個 `Uint8Array` 用 RPC 丟給 DO（[:156](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/apps/api/src/workers/routes/GitRoutes.ts#L156)）。解 pack、解 delta 全交給 isomorphic-git 的 `indexPack`，repository 本身沒有 delta 程式碼。它用**上限**而不是串流來控制風險：`MAX_PACK_BYTES` 50 MB（先看 Content-Length，讀完再看實際大小）、最多 100 個 push 指令（[apps/api/wrangler.template.jsonc:78-84](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/apps/api/wrangler.template.jsonc#L78-L84)、[GitRoutes.ts:94-104](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/apps/api/src/workers/routes/GitRoutes.ts#L94-L104)）。沒有設定 `cpu_ms`，沒有 Queue／背景處理。fetch 端也是 `git.packObjects({write:false})` 在記憶體組好整個 pack（[PackCollector.ts:308-319](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/packages/git-service/src/PackCollector.ts#L308-L319)）。

### 3.4 ref 更新的 CAS

`RefService.applyRefUpdates` 先驗證、再寫入（[packages/git-service/src/RefService.ts:230-354](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/packages/git-service/src/RefService.ts#L230-L354)）：

- 驗證：`resolveRef` 讀現值，不等於 old-oid 就回 "old OID mismatch"（[:250-257](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/packages/git-service/src/RefService.ts#L250-L257)）；建立已存在的 ref、刪除不存在的 ref 都拒絕。**所有更新都必須 fast-forward，force push 永遠被拒**（[:289-304](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/packages/git-service/src/RefService.ts#L289-L304)）。
- 寫入：`git.writeRef({force: true})` 逐一寫，**寫入本身是無條件的，沒有交易**（[:323-351](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/packages/git-service/src/RefService.ts#L323-L351)）。`atomic` 模式只做到「驗證有一個失敗就全部標失敗」；寫到一半出錯時前面的不會回滾。
- 並行：只靠「一個 repository 一個 DO」，刻意不用 `blockConcurrencyWhile`（[apps/background/src/RepoWorker.ts:62-66](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/apps/background/src/RepoWorker.ts#L62-L66)）。兩個 push 會不會在「檢查」和「寫入」之間交錯，取決於 dofs 的 storage 呼叫與 DO input gate 的互動，從原始碼判斷不了。

### 3.5 測試

- 單元測試用純 vitest（node 環境、mock 掉 `cloudflare:*`）；整合測試用 `@cloudflare/vitest-pool-workers`，跑真的 D1 和 DO（[test/integration/vitest.config.mts](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/test/integration/vitest.config.mts)）。CI 跑 typecheck、lint、單元、整合（[.github/workflows/continuous-integration.yml:21-53](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/.github/workflows/continuous-integration.yml#L21-L53)）。
- **沒有執行真 `git` 的測試。** 整合層的 push 測試只送垃圾或超大 body 檢查 401／413（[test/integration/api/GitPushLifecycle.int.test.ts:44-75](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/test/integration/api/GitPushLifecycle.int.test.ts#L44-L75)）；唯一的真 pack 來回是 isomorphic-git 自己 `packObjects`→`indexPack`（[test/git-service-hardening-fill.test.ts:285-381](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/test/git-service-hardening-fill.test.ts#L285-L381)）。它自己的文件也承認 RepoWorker 的 pack／fetch 內部「需要 DO harness」還沒測（[docs/agents/testing/AGENTS.md:12](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/docs/agents/testing/AGENTS.md?plain=1#L12)）。

### 3.6 授權

**MIT**，Copyright (c) 2026 Rexezuge（[LICENSE:1-3](https://github.com/Rexezuge-CloudflareWorkers/Edge-Git/blob/ce78df0726f89b8fb29bafd245402833976af228/LICENSE#L1-L3)）。可以用，但 git 核心依賴 isomorphic-git 和 dofs，能借的自有程式不多。

---

## 4. alchemy-run/alchemy PR #1187（`alchemy/Git`）

已合併進 alchemy 的 `./Git` 匯出。設計文件 [packages/alchemy/src/Git/DESIGN.md](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md) 有兩千多行、附大量實測數字，但分好幾層改版，前面的 Part I 已經過時（例如 [DESIGN.md:45-46](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L45-L46) 寫的「pack body 緩衝、上限 50 MiB」已不是現況），以程式碼為準。整套用 Effect 寫成可替換的 `Layer` 積木；不含任何驗證，驗證是使用者自己掛的 middleware（見 [PR 描述](https://github.com/alchemy-run/alchemy/pull/1187)）。

### 4.1 物件與 ref 怎麼存

- **一個 repository 一個 DO**，用 ULID `repoId` 定址（[DESIGN.md:94](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L94)）；`owner/name → repoId` 由單例 `GitRegistry` DO（或替代的 D1）管理（[RegistryObject.ts](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/RegistryObject.ts)、[RegistryD1.ts:1-35](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/RegistryD1.ts#L1-L35)）。
- **每個物件一列，bytes 依位置分三種。** `objects` 表：`oid, type, size, zsize, location, zdata, r2_key, pack_id, pack_offset, staged_push`（[Store/Sql.ts:59-71](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/Store/Sql.ts#L59-L71)）。`location` 是：
  - `'row'`：壓縮後的內容直接存在 `zdata`；
  - `'r2'`：壓縮後 > 1 MiB 的物件放 R2（[Store/ObjectStore.ts:53](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/Store/ObjectStore.ts#L53)）；
  - `'pack'`：compaction 後的 R2 pack 加 offset。compaction 只搬 blob，commit／tree／tag 留在 SQLite 以便快速走訪（[DESIGN.md:854-865](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L854-L865)）。
- **ref**：`refs(name TEXT PRIMARY KEY, oid TEXT) WITHOUT ROWID`；HEAD 不存列，是指向 `config.default_branch` 的虛擬 symref（[Store/Sql.ts:51-56](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/Store/Sql.ts#L51-L56)）。還有 commit graph 表 `commits`／`commit_parents`、`pushes` 表等（[:73-97](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/Store/Sql.ts#L73-L97)）。
- 每次 ref 變動後 DO 會把 ref 快照寫進 R2 的 `{repoId}/head`，讓 Worker 不喚醒 DO 就能回廣告、送預先算好的 clone bundle（[DESIGN.md:1467-1476](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L1467-L1476)、[Jobs/Bundle.ts](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/Jobs/Bundle.ts)）。

### 4.2 協定版本與 capability

- **只有 v0**（upload-pack 和 receive-pack 都是），靠 client 在 server 回 v0 時自動退回；v2 列在「之後再做」清單（[DESIGN.md:17](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L17)、[:758](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L758)）。
- upload-pack：`multi_ack_detailed no-done side-band-64k shallow ofs-delta agent=git-service/1 symref=HEAD:… object-format=sha1`；receive-pack：`report-status report-status-v2 delete-refs side-band-64k atomic ofs-delta object-format=sha1 agent=…`（[Protocol/Advertise.ts:36-45](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/Protocol/Advertise.ts#L36-L45)）。
- shallow 只支援 `deepen <n>`；`deepen-since`／`deepen-not`／`filter` 直接回錯（[Protocol/UploadPack.ts:111-126](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/Protocol/UploadPack.ts#L111-L126)）。
- thin-pack 沒廣告（只影響 fetch），但 **push 時接受 thin pack**，ref-delta 的 base 從既有物件找（[Protocol/PackParser.ts:9-14](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/Protocol/PackParser.ts#L9-L14)）。clone 送出的 pack **完全不含 delta**，所以 clone 下來的量約是 push 上去的 2.2 倍（[DESIGN.md:1515-1525](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L1515-L1525)）。

### 4.3 push 的 pack 怎麼在限制內處理

**pack 永遠不進 DO。** 無狀態的 Worker 串流 body、驗證、解 delta；DO 只透過四個 RPC 收「列」：`beginPush`、`stagePush`、`readPushBase`（查 thin pack 的 base）、`commitPush`（[Server.ts:1580-1588](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/Server.ts#L1580-L1588)、[RepoObject.ts:4596-4626](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/RepoObject.ts#L4596-L4626)）。

- body 以 8 MiB slab 讀進來，最多保留 16 MiB、超過 24 MiB 就施加背壓（[Store/StreamingSource.ts:24-26](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/Store/StreamingSource.ts#L24-L26)）。超過 4 MiB 的 push 溢寫到 R2，這個門檻從 50 → 32 → 24 → 4 MiB 一路調低（[RepoObject.ts:183-193](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/RepoObject.ts#L183-L193)）。
- 整個 isolate 共用一個 push 准入號誌（64 × 1 MiB），等 30 秒拿不到就回 503（[RepoObject.ts:241-280](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/RepoObject.ts#L241-L280)）。起因是一次 OOM：多個 DO 實例共用同一個 isolate，各自的快取加起來爆掉（[DESIGN.md:1626-1637](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L1626-L1637)）。
- **CPU 是真正的瓶頸。** 驗證（解壓 + 每個物件 SHA-1）很吃 CPU，正式環境的 Workers CPU 約比筆電慢 10 倍（[DESIGN.md:1671-1677](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L1671-L1677)）。所以做了可替換的 Hasher：同 isolate 內算（預設）、AWS Lambda、或最多 4 個動態載入的 Worker isolate 平行算（[Hasher/Hasher.ts:1-24](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/Hasher/Hasher.ts#L1-L24)、[DESIGN.md:1972-2000](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L1972-L2000)）。用 service binding 呼叫自己沒有平行效果，因為會跑在呼叫者的執行緒上（[DESIGN.md:1868-1885](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L1868-L1885)）。
- `cpuMs: 300_000`（[Server.ts:401-406](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/Server.ts#L401-L406)）；edge 的 100 MB body 上限代表更大的 push 得在 client 端拆開（[DESIGN.md:1111-1113](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L1111-L1113)）。Workers 的 zlib 有截斷 bug，程式用宣告的大小驗證並退回備援（[DESIGN.md:1265-1271](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L1265-L1271)）。

有話要說的實測數字：

| 情境 | 數字 | 出處 |
| --- | --- | --- |
| alchemy 整個 `main`（44,051 物件、67 MiB thin pack），較早的架構 | push 92 秒（server ingest 76.8 秒，其中 SQL 5.7 秒）；clone 回來 50.6 秒、152.8 MiB，`fsck --strict` 乾淨 | [DESIGN.md:1106-1109](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L1106-L1109) |
| 在 DO 裡 ingest 的時期 | 2.10 ms／物件，91% 是 CPU、9% 是 SQL | [DESIGN.md:1232-1249](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L1232-L1249) |
| 最終版（loose 情境） | 最佳 5.9 秒、中位 6.5 秒；增量 push 0.24 秒；同情境 GitHub 3.3 秒 | [DESIGN.md:2079](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L2079)、[:1851-1859](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L1851-L1859) |

<details>
<summary>其他數字</summary>

- depth-1 快照 13,699 物件／38.1 MiB：push 20.6 秒；從 loose 列 clone 19.5 秒，compaction 後 3.4 秒（[DESIGN.md:1027-1033](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L1027-L1033)）。
- push ingest 調校，15.6k 物件／40 MiB：63.6 秒 → promoted wire pack 24 秒 → 同步快路徑 16–18 秒（[DESIGN.md:1662-1667](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L1662-L1667)）。
- Hasher 比較：Inline 9.9–13.5 秒、Lambda 6.8–7.9 秒、WorkerLoader 7.1–7.8 秒（[DESIGN.md:1851-1859](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L1851-L1859)、[:1953-1955](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L1953-L1955)、[:2006-2009](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L2006-L2009)）。
- 44k 物件的正式環境診斷：動態路徑 3.1 MB/s（[DESIGN.md:1515-1525](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L1515-L1525)）。

</details>

### 4.4 ref 更新的 CAS

所有 ref 變動都走 `finalizeRefTxn`，在 `storage.transactionSync` 裡同步完成（[RepoObject.ts:3303-3480](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/RepoObject.ts#L3303-L3480)）：

- 讀每個 ref 的現值（不存在視為 `ZERO_OID`）；
- **`atomic` push**：寫任何東西之前先檢查所有 CAS，一個不符就全部 `ng`（"fetch first" 或 "atomic transaction failed"），什麼都不寫；
- 非 atomic：逐一 CAS，刪除用 `DELETE`，建立／更新用 `INSERT … ON CONFLICT DO UPDATE`（[:3336-3387](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/RepoObject.ts#L3336-L3387)）；
- 同一個交易裡把這次 push 的狀態標成 `committed`，它 stage 的物件才算「活的」，並寫入 commit graph（[:3390-3431](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/RepoObject.ts#L3390-L3431)）。

並行 push 會在 R2／網路的 `await` 之間交錯，正確性靠「stage 的列用 `staged_push = pushId` 隔開」加上同步的 finalize；設計原則是「不跨 `await` 重新驗證任何東西」（[DESIGN.md:98](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/src/Git/DESIGN.md?plain=1#L98)）。有測試「並行 CAS 競爭只有一個贏家」（[test/Git/GitProtocol.e2e.test.ts:362-363](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/test/Git/GitProtocol.e2e.test.ts#L362-L363)）。

### 4.5 測試

四個專案裡最完整。

- **本機、不需要雲端**：`GitService.local.test.ts` 是「主要的測試組」，用本機 workerd + R2 模擬器，**直接跑真的 `git` 指令**對 `localhost`（[test/Git/GitService.local.test.ts:1-20](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/test/Git/GitService.local.test.ts#L1-L20)）。
- **部署到 Cloudflare 後用真 `git` 跑**：
  - `GitProtocol.e2e`：12 個情境，含 shallow、CAS 競爭、fork、R2 大物件（[:107](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/test/Git/GitProtocol.e2e.test.ts#L107)）
  - `GitConformance.e2e`：push、rebase、merge、cherry-pick、tag、atomic、gc，每一步都 `fsck --strict`（[:1-16](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/test/Git/GitConformance.e2e.test.ts#L1-L16)）
  - `GitRealWorld.e2e`：把 alchemy 自己 push 上去再 clone 回來（[:1-21](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/test/Git/GitRealWorld.e2e.test.ts#L1-L21)）

  44k 物件那次完整歷史的 push **不是自動化測試**，只是 DESIGN.md 裡的量測。
- **純單元測試**用 `bun:sqlite` 跑同一份 DDL，配記憶體版 BlobStore（[test/Git/harness/store.ts:1-6](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/test/Git/harness/store.ts#L1-L6)）。
- **fixture**：六個用真的 `git pack-objects` 產生後 commit 進去的 pack（`empty`、`simple`、`ofs-delta`、`ref-delta`、`base`、`thin`），加上列出預期 oid 的 `manifest.json`（[test/Git/fixtures/packs/README.md](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/test/Git/fixtures/packs/README.md)）。這套做法直接可以照抄。

### 4.6 授權

**Apache-2.0**（[LICENSE](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/LICENSE)、[packages/alchemy/package.json:6](https://github.com/alchemy-run/alchemy/blob/cd5073b4c1c5c0fc5ba8eba368360facd388cdae/packages/alchemy/package.json#L6)），可以使用和修改，但要保留授權與 NOTICE，並標示修改過的檔案。實際上難抽出來：`Protocol/*` 只依賴 `effect`、`node:zlib`、`node:crypto`，沒有 alchemy 內部 import，但 `PackParser`、`Zlib` 等都是 `Effect.gen` 寫法，要嘛帶上 `effect`、要嘛重寫；Store／Server／DO 層則緊密綁在 alchemy 的 `Cloudflare`、`Http`、`RuntimeContext` 模組上。`Advertise.ts` 是純 TS。DO 的 DDL 和 CAS 邏輯是純 SQL 字串，最容易照抄。

---

## 比較

| | durable-git | git-on-cloudflare | Edge-Git | alchemy #1187 |
| --- | --- | --- | --- | --- |
| 物件存法 | client 原樣的 pack（SQLite 1 MB 分塊，或 ≥16 MB 放 R2）+ 每物件一列索引 | pack + idx v2 全放 R2，DO 只有 pack 目錄 | git 檔案（pack + idx）放在 DO SQLite 模擬的檔案系統 | 每物件一列；小的放 SQLite、>1 MiB 放 R2；blob 之後 compaction 成 R2 pack |
| ref 存在哪 | DO SQLite `refs` 表 | DO KV 的一個 `refs` 陣列 | 檔案系統裡的 ref 檔 | DO SQLite `refs` 表 |
| 需要 R2 嗎 | 選配 | 必須（外加 D1、KV、Queue） | 不需要 | 必須 |
| upload-pack 協定 | v0 + v2 | 只有 v2 | 只有 v2 | 只有 v0 |
| push 接受 thin pack | 是 | 是 | 否（廣告 `no-thin`） | 是 |
| shallow clone | 是（depth／deepen／unshallow） | 否 | 有廣告和解析（未逐行驗證） | 只有 `deepen <n>` |
| `atomic` push | 否 | 有廣告；實際一律全有或全無 | 有廣告；寫入不回滾 | 是 |
| push body | 串流進 DO | 串流進 R2，由 Worker 處理 | 整包緩衝，上限 50 MB | 串流，由 Worker 處理，>4 MiB 溢寫到 R2 |
| CAS | 兩段檢查，寫入在 `transactionSync` 裡 | lease + DO 裡重新驗證，沒有交易 | 先檢查、再無條件寫，沒有交易 | `transactionSync` 裡做 |
| 用真 `git` 做端對端測試 | 有（shell 腳本，未進 CI） | 無 | 無 | 有（本機 workerd + 部署環境） |
| 授權 | MIT | MIT | MIT | Apache-2.0 |
| 依賴／耦合 | 只有 `pako` | Hono、drizzle、D1、KV、Queue、OIDC | isomorphic-git、dofs | Effect + alchemy 框架 |

## 建議：第一段從 durable-git 開始

第一段只要做到：寫死一個 User 和一把金鑰，標準 `git` 透過 HTTPS 能 push、能 clone。拿這個標準衡量：

- **durable-git 最接近「剛好夠用」。** 不綁 R2 也能跑（純 SQLite 路徑），push 串流進 DO，寫入前在 `transactionSync` 裡重新做 CAS。它還接受 thin pack（git 預設就會送）、同時支援 v0／v2 clone，也有一支現成的真 `git` 端對端腳本。MIT、只依賴 `pako`，git 核心（`src/git/*` + `src/repo.ts` 的協定部分）可以直接搬，UI、blame、snapshot 之類先不帶。
- **向 alchemy 借兩件事**：
  - 測試手法：本機 workerd + 真 `git` 指令，加上 commit 進去的 `git pack-objects` fixture，外加一個並行 CAS 競爭測試。
  - `atomic` 的「先全部檢查、再寫」寫法：durable-git 目前沒有 `atomic`，`git push --atomic` 會被 client 端拒絕。

  它的 Effect 架構和 CPU 分流（Hasher）等到真的量到 CPU 不夠再說。
- **git-on-cloudflare 留作之後的參考**：等 repository 大到 10 GB SQLite 或單次 ingest 的 CPU 撐不住，它的「pack 原樣串流進 R2、Worker 兩輪建 idx、DO 只記目錄」是現成的藍圖。它 v2-only、不支援 shallow，還有上面提到的「連通性部分失敗卻回 `ok`」問題，不適合直接拿來當起點。
- **Edge-Git 不建議**：整包緩衝、git 核心交給 isomorphic-git、ref 寫入沒有交易、不接受 force push，也沒有真 `git` 測試。

從 durable-git 搬過來時要改的地方：

- 讀取改成也要驗證：它預設公開讀，而 Fugitive 全部是 Private repository。
- 決定 push 到不存在的 repository 時要不要自動建立。
- `MAX_PUSH_MB` 預設 512，要調到平台 100 MB body 上限以內，超過時回明確的錯誤訊息。
- 把 e2e 腳本接進 CI。

## 從原始碼答不出來的問題

- Edge-Git 的 dofs 表結構（外部套件，不在 repository 裡），以及兩個並行 push 會不會在它的「檢查」和「寫入」之間交錯。
- git-on-cloudflare 的一連串 `ctx.storage.put` 在當機時是否原子（屬於平台行為）；上游有沒有 CI（tarball 裡沒有 `.github/`）；舊做法實際遇到的 OOM／CPU 數字（文件沒寫）。
- Edge-Git 的 shallow／filter 在 `fetch` 裡實作到什麼程度，這次沒有逐行驗證。
- 這四個專案的實際效能都沒有親自量測；除了 alchemy DESIGN.md 裡作者自己量的數字，這份筆記沒有任何效能數據。
