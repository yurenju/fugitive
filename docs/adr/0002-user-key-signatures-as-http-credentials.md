# git 連線用 User key 的簽章當憑證，不發 access token

`git` 透過 HTTPS 連線時，一個指令只會向 credential helper 要一次憑證，之後每個請求都帶同一組。常見的做法是發一組 personal access token，但那是一個長期有效的秘密，伺服器得保存它。我們的做法是：伺服器在 401 回應裡出一段 challenge（repo、讀或寫、伺服器時間、亂數，加上伺服器用自己的秘密算的檢查碼），我們的 credential helper 用 User 的私鑰（Ed25519，透過 `ssh-keygen -Y sign`）簽這段 challenge，把「challenge + 簽章」當成 Basic 驗證的密碼交給 git；伺服器每收到一個請求，就驗檢查碼、時效，再用簽章裡的公鑰對照登記過的 User key。伺服器不發 token，也不存任何可以拿來冒用使用者身分的東西。

## 考慮過的選項

- **Personal access token**：使用者不必裝任何東西，系統內建的 Keychain 會記住它。但伺服器要保存 token 的雜湊，token 外洩就能被冒用，還要另外做撤銷。而且我們沒有網頁，領 token 一樣要打 API，換到的「免設定」沒有看起來那麼多。
- **Bearer 而非 Basic**：credential helper 要到 git 2.46 才能回傳 Bearer，而 Ubuntu 24.04（2.43）、Debian 12（2.39）內建的 git 都比這個版本舊。Basic 本身任何版本都支援；我們實際的下限是 helper 讀得到 challenge 所需的 2.41（見後果），這個版本 Ubuntu 24.04 已經符合。
- **由 helper 自己組簽的內容（使用者 + 時間 + repo）**：helper 從 git 拿到的資訊分不出這次是讀還是寫，而且要依賴使用者電腦的時鐘。改由伺服器出題之後，這兩個問題都不存在，伺服器也不必記住發過哪些 challenge。

## 後果

- 使用者要裝我們的 credential helper（一支只需要 `ssh-keygen` 的 shell script，透過一行安裝指令裝好），而且 git 要 2.41 以上：git 從 2.41 才會把 401 回應裡的 `WWW-Authenticate` 以 `wwwauth[]` 轉給 credential helper，helper 靠它拿到 challenge。Ubuntu 24.04、Debian 13、Homebrew、Git for Windows 與 GitHub Actions 的 runner 都符合；Ubuntu 22.04（2.34）、Debian 12（2.39）以及以 Debian 12 為底的 Docker image 不符合，要另外升級（Ubuntu 用 git-core 的 PPA，Debian 改用 13）。macOS 內建的 git 看 Command Line Tools 的版本，舊版是 2.39，不符合時改用 Homebrew 的 git。
- 用 Basic 的話，git 會把「密碼」交給所有設定好的 helper 去存，Keychain 這類 helper 會把已經過期的簽章存起來、下次拿出來用。所以安裝指令在我們主機的設定裡，會先寫一行空的 `credential.helper` 清掉其他 helper，再寫我們自己的。
- 一把 User key 只能登記給一個 User，因為伺服器是從簽章裡的公鑰判斷使用者是誰。
- 密碼字串在 challenge 的有效期間內（10 分鐘）被截走的話，可以被拿去重送，但只限同一個 repo、同一種讀或寫。擋住截取靠的是 HTTPS。
- 這個做法只管 `git` 透過 HTTPS 的連線。MCP 不用它，改用 OAuth 登入：OAuth 是 MCP 規格裡標準的授權方式，MCP 客戶端都支援，不需要另外裝 helper。
- 所以「伺服器不存任何可以拿來冒用身分的東西」只對 git 成立。MCP 那邊會有伺服器發出去的 access token，它們的有效期限與撤銷方式要在做 MCP 時另外決定。
