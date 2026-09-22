# git 客戶端怎麼送超過 100 MB 的內容

回答 [#28](https://github.com/yurenju/fugitive/issues/28)。只整理事實與出處，不做選擇。查詢日期：2026-09-22。

## 前提

- git 的 smart HTTP push 是先 `GET info/refs?service=git-receive-pack`，再用**一個** `POST $GIT_URL/git-receive-pack` 把「要更新的 ref 清單 + 一整個 PACK」送出去（[gitprotocol-http](https://github.com/git/git/blob/master/Documentation/gitprotocol-http.adoc)，〈Smart Service git-receive-pack〉）。
- 請求大於 `http.postBuffer`（預設 1 MiB）時，git 改用 `Transfer-Encoding: chunked`，但**還是同一個請求**；文件明說調高這個值「一般不是 push 問題的有效解法」（[git-config http.postBuffer](https://github.com/git/git/blob/master/Documentation/config/http.adoc)）。
- `pack.packSizeLimit` 只在 repack 寫檔時生效，不會把 push 拆成好幾個 pack（[git-config pack.packSizeLimit](https://github.com/git/git/blob/master/Documentation/config/pack.adoc)）。
- Cloudflare 對進站請求本體的上限看**帳號方案**、不看 Workers 方案：Free／Pro 100 MB、Business 200 MB、Enterprise 可自行調到 5 GB；超過回 `413`。回應本體沒有上限（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)）。
- R2：單一請求上傳上限 5 GiB（multipart 的每一段也是），multipart 最多 10,000 段、物件最大約 4.995 TiB；經過 Worker 的上傳仍受上面那條請求上限限制，但從 Worker 發出的 subrequest 不受 R2 這條限制（[R2 limits](https://developers.cloudflare.com/r2/platform/limits/)）。

## 名詞

- **Git LFS**：git 的擴充。被追蹤的檔案在 commit 裡只存一個幾百 byte 的 pointer 檔（`version` / `oid sha256:…` / `size`），檔案本體另外透過 LFS 伺服器的 HTTP API 傳。
- **Batch API**：LFS 客戶端問伺服器「這些物件要怎麼傳」的 JSON 端點。
- **transfer adapter**：Batch API 回應裡「實際怎麼傳」的方式，例如 `basic`（一個 PUT）。
- **remote helper**：名為 `git-remote-<transport>` 的外部程式，git 遇到不認得的 URL 協定時交給它處理傳輸。
- **presigned URL**：S3／R2 的簽章網址，拿到的人不需要其他憑證就能對單一物件做一次指定操作。

---

## 1. Git LFS

### Batch API 的請求與回應

出處：[docs/api/batch.md](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)

- 端點：LFS 伺服器 URL + `/objects/batch`，`POST`，`Accept` 與 `Content-Type` 都是 `application/vnd.git-lfs+json`。
- 請求：`operation`（`upload`／`download`）、`transfers`（客戶端支援的 adapter 清單，省略即視為 `basic`）、`ref.name`（選填，v2.4 起，讓伺服器可以依 ref 判斷權限）、`objects[]`（`oid`、`size`）、`hash_algo`（預設 `sha256`）。
- 回應：永遠 200（除非整個請求有問題）。`transfer`（伺服器選的 adapter）、`objects[]`，每個物件帶 `actions.upload` / `actions.verify` / `actions.download`，每個 action 有 `href`、選填的 `header`、`expires_in` / `expires_at`。
- 伺服器已經有的物件：**整個省略 `actions`**，客戶端就視為已上傳、不再傳。
- 單一物件的錯誤放在該物件的 `error`（404、409、410、422）；整體錯誤用 HTTP 狀態碼：401（要帶 `LFS-Authenticate` 標頭，沒帶就假設 Basic）、403（有讀沒寫）、404、422，選填 406／413／429／501／507／509。500／502／503／504 會讓客戶端重試。
- 找伺服器的方式：預設是 git remote URL 後面加 `.git/info/lfs`（remote 已經以 `.git` 結尾就只加 `/info/lfs`）；可以用 `lfs.url`、`remote.<name>.lfsurl`，或 repo 根目錄的 `.lfsconfig` 覆寫（[server-discovery.md](https://github.com/git-lfs/git-lfs/blob/main/docs/api/server-discovery.md)）。以這個 repo 的網址 `/@<owner>/<repository>.git` 來說，推得的端點是 `/@<owner>/<repository>.git/info/lfs/objects/batch`。

### 上傳能不能直接導向 presigned URL（例如 R2）

- 可以。規格寫明 basic adapter「可以把物件存放卸載給 S3 之類的雲端服務，或原生實作這個 API」；upload action 就是對 `href` 發一個 `PUT`，`header` 由伺服器指定（[basic-transfers.md](https://github.com/git-lfs/git-lfs/blob/main/docs/api/basic-transfers.md)）。
- 物件上的 `authenticated: true` 表示這個 action 已經帶好授權；省略或 false 時，git-lfs 會**另外去找這個 URL 的憑證**（[batch.md](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)）。所以 `href` 指向另一個主機（例如 `<ACCOUNT_ID>.r2.cloudflarestorage.com`）時，要設 `authenticated: true`，否則客戶端會對那個主機叫 credential helper。
- 上傳完可選的 `verify` action：客戶端對它 `POST {"oid","size"}`，200 表示伺服器確認物件存在。伺服器可以藉此確認 R2 上真的有了。
- R2 presigned URL：支援 `GET`、`PUT`、`HEAD`、`DELETE`，期限 1 秒到 7 天；在伺服器端用 R2 API 金鑰做 SigV4 簽章產生，不需要跟 R2 連線；**只能用 S3 API 網域，不能用自訂網域**；簽章時指定了 `Content-Type` 的話，客戶端送的不一樣會 `403 SignatureDoesNotMatch`（[R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)）。
  - git-lfs 的 basic 上傳預設會自己偵測並送 `Content-Type`，`lfs.<url>.contenttype=false` 才固定送 `application/octet-stream`（[git-lfs-config](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-config.adoc)）。
- 直傳 R2 的 PUT 不經過 Cloudflare zone，所以不受上面「方案 100 MB」那條限制，受的是 R2 的單一請求 5 GiB（[R2 limits](https://developers.cloudflare.com/r2/platform/limits/)）。
- 現成例子：[milkey-mouse/git-lfs-s3-proxy](https://github.com/milkey-mouse/git-lfs-s3-proxy)（Cloudflare Pages，回傳 S3 相容儲存的 presigned URL）；GitHub 上另有數個 Workers + R2 的 LFS 伺服器（例如 [ken109/r2-lfs](https://github.com/ken109/r2-lfs)、[gpailler/gitLFSflare](https://github.com/gpailler/gitLFSflare)），都是個人小專案。
- 對照：Gitea 的 LFS 上傳**不**直傳物件儲存，upload action 指回 Gitea 自己並加上 `Transfer-Encoding: chunked`；只有下載在 `SERVE_DIRECT` 時會給物件儲存的直連網址（[gitea services/lfs/server.go](https://github.com/go-gitea/gitea/blob/main/services/lfs/server.go) `buildObjectResponse`）。

### transfer adapter 與支援程度

| adapter | 狀態 | 行為 | 出處 |
| --- | --- | --- | --- |
| `basic` | 唯一的正式 adapter，所有客戶端與伺服器 SHOULD 支援 | 每個物件一個 `PUT`（整個檔案一個請求）；下載是 `GET`，客戶端會用 `Range` 續傳下載 | [api/README.md](https://github.com/git-lfs/git-lfs/blob/main/docs/api/README.md)、[basic-transfers.md](https://github.com/git-lfs/git-lfs/blob/main/docs/api/basic-transfers.md) |
| `tus` | 實驗性、只有上傳；客戶端要設 `lfs.tustransfers=true` 才會開 | 先 `HEAD` 取 `Upload-Offset`，再用**一個** `PATCH` 把剩下的位元組全部送出；不支援 tus 的 Creation 與 Concatenation，所以不分塊、不平行 | [git-lfs-config](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-config.adoc)、[tq/tus_upload.go](https://github.com/git-lfs/git-lfs/blob/main/tq/tus_upload.go) |
| `multipart` | 只是提案，官方客戶端（v3.8.0，2026-08-28）沒有實作；`tq/` 目錄只有 basic、tus、ssh、custom | 伺服器回多個 part 的 URL，分段上傳、可只重傳失敗的段；源自 giftless 的 `multipart-basic` | [proposals/multipart_transfer_mode.md](https://github.com/git-lfs/git-lfs/blob/main/docs/proposals/multipart_transfer_mode.md)、[tq/](https://github.com/git-lfs/git-lfs/tree/main/tq) |
| `ssh` | 純 SSH 傳輸，只適用 SSH remote | — | [git-lfs-config `lfs.sshtransfer`](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-config.adoc) |
| custom | 使用者在 `lfs.customtransfer.<name>.path` 設定一個程式，git-lfs 透過 stdin/stdout 跟它溝通；`lfs.standalonetransferagent` 可以完全不問 Batch API | 要在每台客戶端另外安裝程式與設定 | [custom-transfers.md](https://github.com/git-lfs/git-lfs/blob/main/docs/custom-transfers.md) |

注意：batch.md 自己也寫「Git LFS 目前只支援 `basic` transfer adapter」，其他 adapter 是為未來相容保留的欄位。

**對 fugitive 的直接含意（依上表推得）**：basic 與 tus 都是「一個檔案一個請求」，若 PUT 打到 Worker，單一檔案仍卡在方案的 100 MB；要讓單檔超過 100 MB，upload `href` 必須指向不經過 zone 的地方（例如 R2 的 presigned URL）。

### 認證怎麼接現在的 OAuth 權杖與 credential helper

- LFS API 用 HTTP Basic，憑證來源依序是 SSH 的 `git-lfs-authenticate`、git credential helper、寫死在 URL 裡（[authentication.md](https://github.com/git-lfs/git-lfs/blob/main/docs/api/authentication.md)）。HTTPS remote 走的是 git credential helper，也就是 `git credential fill` 的那套。
- 現在的安裝腳本設定的是 `credential.<origin>.helper`（以主機為單位，見 `src/scripts/install.sh`），LFS 端點在同一個 origin 底下，所以 helper 會被叫到，回的權杖當 Basic 密碼送出，跟 git push 一樣。沒有設 `credential.useHttpPath` 時，憑證只以網域區分（[authentication.md](https://github.com/git-lfs/git-lfs/blob/main/docs/api/authentication.md)）。
- 伺服器對 Batch API 回的 upload／verify action 可以在 `header` 裡放自己的短期授權（例如 verify 端點用），並設 `expires_in`；presigned URL 本身就帶授權，不需要 header。

### 客戶端預設有沒有 `git-lfs`

| 平台 | 預設有沒有 | 出處 |
| --- | --- | --- |
| Git for Windows | **有**。安裝程式的 `gitlfs` 元件屬於 `Types: default`，預設勾選 | [install.iss](https://github.com/git-for-windows/build-extra/blob/main/installer/install.iss)；git-lfs README「Git LFS is included in the distribution of Git for Windows」 |
| macOS Homebrew | **沒有**。`git` formula 的相依裡沒有 git-lfs；要另外 `brew install git-lfs`，formula 的 caveats 要求再跑 `git lfs install` | [Formula/g/git.rb](https://github.com/Homebrew/homebrew-core/blob/main/Formula/g/git.rb)、[Formula/g/git-lfs.rb](https://github.com/Homebrew/homebrew-core/blob/main/Formula/g/git-lfs.rb) |
| macOS Xcode／Command Line Tools 的 git | 找不到一手資料說有附；GitHub 與 git-lfs 自己的安裝說明在 macOS 上都只給 Homebrew／MacPorts／下載安裝包 | [GitHub docs 原始檔](https://github.com/github/docs/blob/main/content/repositories/working-with-files/managing-large-files/installing-git-large-file-storage.md)、[git-lfs README](https://github.com/git-lfs/git-lfs#installing)（**未直接驗證 Apple 的套件內容**） |
| Ubuntu 26.04 | **沒有**。`git-lfs` 是 universe 裡的獨立套件（3.7.1-1），`git` 套件的 Depends／Recommends／Suggests 都沒有它 | 本機 `apt-cache depends git`、`apt-cache policy git-lfs`（Ubuntu 26.04 LTS） |
| Debian、Fedora 等 | git-lfs 官方說 Linux 用 packagecloud 上的 deb／rpm；發行版自己的套件頁這次連不到，**未驗證** | [git-lfs README](https://github.com/git-lfs/git-lfs#installing)、[INSTALLING.md](https://github.com/git-lfs/git-lfs/blob/main/INSTALLING.md) |

### 使用者要多跑的指令

- `git lfs install`（每台機器一次）：在全域 git 設定裝 `lfs` 的 clean／smudge filter；在目前 repo 裝 pre-push hook（[git-lfs-install](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-install.adoc)）。Git for Windows 的安裝程式與 `install.sh` 會替使用者跑。
- `git lfs track "<pattern>"`（每個 repo）：把規則寫進 `.gitattributes`，這個檔要 commit（[git-lfs-track](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-track.adoc)）。**規則要在大檔 commit 之前就存在**；GitHub 的說明也要求先把 `.gitattributes` 放好再加其他檔案（[troubleshooting-the-2-gb-push-limit](https://github.com/github/docs/blob/main/content/get-started/using-git/troubleshooting-the-2-gb-push-limit.md)）。已經 commit 進歷史的大檔要另外改寫歷史（`git lfs migrate`）。
- push 時，pre-push hook 先把這次 push 涉及的 LFS 物件傳到 LFS API，然後 git 才送 pack（[git-lfs-pre-push](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-pre-push.adoc)）。
- pre-push 還會打 File Locking 的驗證端點；`lfs.<url>.locksverify` 未設定時失敗只警告，伺服器回 `501` 則客戶端自動把它設成 false（[git-lfs-config](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-config.adoc)、[locking.md](https://github.com/git-lfs/git-lfs/blob/main/docs/api/locking.md)）。

### 中斷後能不能接著傳

- 物件層級：Batch API 對已經有的物件不給 `actions`，所以重跑 push 時已傳完的檔案不會重傳（[batch.md](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)）。
- 單一檔案內：basic 上傳失敗會整檔重來（`ResetProgress` 後重試，`lfs.transfer.maxretries` 預設 8 次）（[tq/basic_upload.go](https://github.com/git-lfs/git-lfs/blob/main/tq/basic_upload.go)、[git-lfs-config](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-config.adoc)）；tus 可以從伺服器回報的 `Upload-Offset` 接著傳（[tq/tus_upload.go](https://github.com/git-lfs/git-lfs/blob/main/tq/tus_upload.go)）；下載可以用 `Range` 接著傳。

### 伺服器要實作什麼（規格要求的部分）

`POST …/info/lfs/objects/batch`（upload 與 download）、依回應的 action 提供 PUT／GET 的目的地（自己收或 presigned URL）、選配的 verify 端點、401 時的 `LFS-Authenticate`，以及 locks verify（至少回 501）。另外 pack 裡只會有 pointer，下載端 clone 時要能用同一套 API 取回檔案本體。

---

## 2. 把一次 push 拆成好幾次

- GitHub 官方的做法（針對它的 2 GiB 上限）：用 `git log --oneline --reverse refs/heads/BRANCH | awk 'NR % 1000 == 0'` 挑出歷史上每隔 N 個 commit，逐一 `git push REMOTE +<sha>:refs/heads/BRANCH`；遇到 `pack exceeds maximum allowed size` 就縮小間隔；最後 `git push --mirror` 補剩下的 ref。文件直接給了一段兩行的 shell 迴圈把它自動化（[troubleshooting-the-2-gb-push-limit](https://github.com/github/docs/blob/main/content/get-started/using-git/troubleshooting-the-2-gb-push-limit.md)）。
- 同一份文件承認單一 commit 本身太大時，拆 push 沒用，只能用 interactive rebase 把那個 commit 拆開，或砍掉歷史重來、分批 commit 檔案。
- **單一大 blob 救不了**：一個 blob 只能整個放進某一個 pack，而 push 一次只送一個 pack（見〈前提〉），所以任何超過請求上限的單一檔案，不論怎麼分段都送不上去。這是從協定推得，沒有找到另一份文件逐字寫出。
- 使用者成本：手動指令，或自己包成 script；git 沒有內建「分段 push」的選項。能包裝的地方：一般 shell script、git alias，或第 3 節的 remote helper。
- 中斷續傳：每一段成功後遠端 ref 就更新了，重跑時 git 只會送遠端還沒有的東西，所以粒度是「一段」；段內中斷要整段重送（receive-pack 在整個請求收完後才更新 ref，見 [gitprotocol-http](https://github.com/git/git/blob/master/Documentation/gitprotocol-http.adoc)）。
- 伺服器：不必多做什麼，但每一段都是一次完整的 receive-pack，而且中間的 ref 狀態會被其他人看到。

---

## 3. 自己的 remote helper（`git-remote-<name>`）

出處：[gitremote-helpers](https://github.com/git/git/blob/master/Documentation/gitremote-helpers.adoc)

- 觸發方式：URL 是 `<transport>://…` 且 git 不認得這個協定、URL 是 `<transport>::<address>`，或 remote 設了 `remote.<name>.vcs`。`https://` 由 git 內建的 `git-remote-https` 處理，**所以 helper 不能直接接手現在的 `https://` remote**，URL 要改成例如 `fugitive::https://…`。
- `url.<base>.insteadOf` 可以把 URL 自動改寫，`url.<base>.pushInsteadOf` 只改寫 push 用的 URL；改寫成自訂協定時可能要調 `protocol.*.allow`（[git-config url.*](https://github.com/git/git/blob/master/Documentation/config/url.adoc)）。也就是說可以用一行全域設定，讓 fetch 照走 https、只有 push 走 helper。
- push 相關的 capability：`connect`（接 git 原生協定，要全雙工連線）、`push`（git 給 `push <src>:<dst>` 清單，helper 自己把物件送到遠端，完成後回 `ok <dst>` / `error <dst>`）、`export`（吃 fast-import 串流）。用 `push` 時物件怎麼打包、怎麼分塊上傳完全由 helper 決定，所以**技術上可以把 pack 切成多個請求上傳**，伺服器要有對應的接收與組裝端點（不是標準 receive-pack）。
- 安裝成本：一個可執行檔放在 `PATH` 上，名字是 `git-remote-<name>`；helper 是獨立行程，不必重新編譯 git。
- 現成例子：
  - [spwhitton/git-remote-gcrypt](https://github.com/spwhitton/git-remote-gcrypt)：用 **shell script** 寫的 helper（加密 remote），證明 helper 可以跟現在的 credential helper 一樣是 shell script。
  - [awslabs/git-remote-s3](https://github.com/awslabs/git-remote-s3)：把 S3 當 remote，push 時對每個 ref 做 `git bundle create` 再上傳；同時提供 git-lfs custom transfer（`git-lfs-s3`）。安裝是 `pip install git-remote-s3`，要 Python ≥ 3.9 與 AWS CLI。
  - [aws/git-remote-codecommit](https://github.com/aws/git-remote-codecommit)（Python，`codecommit://`）、[anishathalye/git-remote-dropbox](https://github.com/anishathalye/git-remote-dropbox)（Python，`dropbox://`）。
- 單一大檔：只要 helper 自己分塊上傳，就不受單一請求上限限制。中斷續傳也由 helper 自己決定。

---

## 4. 其他 git host 的上限與建議

| host | 單一檔案（一般 git） | 單次 push | LFS 單檔 | 官方建議 | 出處 |
| --- | --- | --- | --- | --- | --- |
| GitHub | 50 MiB 警告，100 MiB 擋 | 2 GiB（`pack exceeds maximum allowed size`） | Free／Pro 2 GB、Team 4 GB、Enterprise Cloud 5 GB | 超過 100 MiB 必須用 Git LFS；push 太大就分段 | [about-large-files-on-github](https://github.com/github/docs/blob/main/content/repositories/working-with-files/managing-large-files/about-large-files-on-github.md)、[large_files.yml](https://github.com/github/docs/blob/main/data/variables/large_files.yml)、[repository-limits](https://github.com/github/docs/blob/main/content/repositories/creating-and-managing-repositories/repository-limits.md)、[about-git-large-file-storage](https://github.com/github/docs/blob/main/content/repositories/working-with-files/managing-large-files/about-git-large-file-storage.md) |
| GitLab.com | 預設不擋；push rule（付費）可設「Maximum file size」，LFS 追蹤的檔案例外 | 5 GiB；文件特別註明 `git push` 經過 **Cloudflare** 每個請求上限 5 GiB | repo 含 LFS 共 10 GB | 大檔用 Git LFS；push size 設定不套用在 LFS 物件 | [gitlab_com/_index.md](https://github.com/gitlabhq/gitlabhq/blob/master/doc/user/gitlab_com/_index.md)、[account_and_limit_settings.md](https://github.com/gitlabhq/gitlabhq/blob/master/doc/administration/settings/account_and_limit_settings.md)、[push_rules.md](https://github.com/gitlabhq/gitlabhq/blob/master/doc/user/project/repository/push_rules.md) |
| Gitea（自架） | 沒有預設上限（網頁上傳 `FILE_MAX_SIZE` 50 MB） | 沒有預設上限 | `LFS_MAX_FILE_SIZE` 預設 0（不限）；LFS 預設關閉（`LFS_START_SERVER=false`） | — | [app.example.ini](https://github.com/go-gitea/gitea/blob/main/custom/conf/app.example.ini) |
| Forgejo（自架） | 與 Gitea 同源，LFS 設定鍵相同（`LFS_START_SERVER`、`LFS_MAX_FILE_SIZE` 預設 0） | — | 同左 | 大量上傳時建議調長 `LFS_HTTP_AUTH_EXPIRY` | [Forgejo config cheat sheet](https://forgejo.org/docs/latest/admin/config-cheat-sheet/)（**僅透過搜尋摘要，頁面本身連不到，未直接驗證**） |
| Bitbucket Cloud | 預設開啟「Block pushes with files over 100 MB」，可由管理員關閉 | 沒找到單次 push 的上限；repo 總量 4 GB 為硬上限 | 文件說不限，但有 KB 提到 10 GB 單檔會 `413` | 大檔用 Git LFS | [reduce-repository-size](https://support.atlassian.com/bitbucket-cloud/docs/reduce-repository-size/)、[repository and file size limits](https://confluence.atlassian.com/bbkb/what-are-the-repository-and-file-size-limits-1167700604.html)、[HTTP 413 KB](https://support.atlassian.com/bitbucket-cloud/kb/troubleshooting-git-lfs-push-failure-http-413-error-message/)（**僅透過搜尋摘要，未直接驗證**） |

共同點：四家都沒有「讓一般 git push 突破單一請求上限」的客戶端方案；單一大檔一律導向 Git LFS，單次 push 太大一律叫使用者分段。

## 未能驗證的部分

這台機器的對外白名單擋掉了 docs.github.com、docs.gitlab.com、forgejo.org、support.atlassian.com、packages.debian.org、formulae.brew.sh 等網域。GitHub 與 GitLab 的內容改從它們放在 GitHub 上的文件原始檔讀取（GitLab 用 `gitlabhq/gitlabhq` 鏡像）；Forgejo 與 Bitbucket 只拿到搜尋摘要；Debian／Fedora 的套件資訊與 Apple Command Line Tools 是否附 git-lfs 沒有驗證。
