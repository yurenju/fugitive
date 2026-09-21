# push 上來的 pack 原樣保存，小的放 SQLite、大的放 R2

git push 時，client 會把伺服器還沒有的物件打成一個 pack 送上來。我們把這個 pack 原封不動存起來（保留 client 已經做好的壓縮和 delta），另外在儲存庫的 Durable Object 的 SQLite 裡記「目錄」：每個物件在哪個 pack 的哪個位置，以及每個 ref（分支、tag）指到哪個物件。pack 的內容放哪看大小：有 `Content-Length` 而且小於 16 MB 的放 SQLite（切成 1 MB 一列），其他的放 R2。git 的 request body 只要超過 `http.postBuffer`（預設 1 MB）就不帶 `Content-Length`，改用串流傳送，所以實際上約 1 MB 以下的小 push 放 SQLite，其餘放 R2。

分兩邊放，是因為日常的小 push 最多：它們的內容和目錄在同一個 SQLite 裡，一個 transaction 就寫完，不用多一趟 R2，也不會在 R2 留下沒人用的東西。大的 pack 則交給 R2，不去佔每個 Durable Object 只有 10 GB 的 SQLite 空間。

## 考慮過的選項

- **全部放 R2**：只有一條讀寫路徑，要寫和要測的比較少。沒選，因為小 push 也得多一趟 R2，而且每次失敗都可能留下沒人用的 pack。
- **全部放 SQLite**：最簡單，但一個儲存庫最多 10 GB。
- **一個物件一列、不保留原始 pack**：要把 client 的壓縮拆開重做，push 時 CPU 花得更多，而 CPU 正是 Workers 上最先碰到的限制。

## 後果

- 讀物件有兩條路徑（SQLite、R2），兩條都要測。
- git push 預設送 thin pack：pack 裡的 delta 可以拿伺服器上別的 pack 裡的物件當底稿。原樣保存就代表讀物件時要能跨 pack 解 delta，而且底稿可能在 SQLite，也可能在 R2。
- R2 不在 SQLite 的 transaction 裡，所以大 push 的順序必須是：pack 寫進 R2 → 寫目錄 → 在 transaction 裡確認 ref 還指在預期的物件上才移動它。中途失敗會在 R2 留下沒人用的 pack，以及指向它的目錄紀錄，目前不清理。
- 目前也不做 GC：刪分支或 force push 之後，沒人用的物件和 pack 還是佔著空間。
- 部署用的 Cloudflare token 除了 Workers，還要能用 R2（或事先手動建好 bucket）。
