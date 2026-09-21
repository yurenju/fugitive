# 自己在 Durable Object 上實作 git 協定，不用 Cloudflare Artifacts

Cloudflare Artifacts 本身就支援 git 的 smart HTTP 協定，但它還在封閉 beta，要申請才能用，而且只開放給 Workers 付費方案。所以我們改成自己在 Workers + SQLite 版的 Durable Object 上實作 upload-pack 和 receive-pack。這樣整個實作都在自己手上；而且已經有現成的專案（littledivy/durable-git、zllovesuki/git-on-cloudflare）證明 Durable Object 跑得動 git。

## 後果

- 協定的程式碼要自己寫、自己維護，包括在每個 isolate 128 MB 的記憶體限制內解析 pack 檔。
- 使用者看到的網址和 User key 都是我們自己的，所以之後要把底層儲存換掉（例如等 Artifacts 正式推出後改用它），使用者那邊什麼都不用改。
