# 所有工具（包括 git）都用 OAuth 發的存取權杖，身分只靠 email 驗證碼證明

取代 [ADR 0002](0002-user-key-signatures-as-http-credentials.md)。

連到這台主機的工具分兩種：有檔案系統、走 `git` 的（使用者自己，或在本機目錄工作的 Claude Code），以及沒有檔案系統的（透過 MCP 的 Claude chat、之後的 web app、呼叫檔案 API 的程式）。ADR 0002 讓前者用 User key 簽章，但後者不可能用 `ssh-keygen` 簽每個請求，MCP 規格也要求 OAuth，所以伺服器本來就得發存取權杖。我們決定不維護兩套：**所有情境都用 OAuth 發的存取權杖**，`git` 也一樣，把權杖當 Basic 密碼送出；證明身分的方式只剩一種，就是在授權頁輸入 email 驗證碼。User key 整個拿掉。

## 考慮過的選項

- **維持 ADR 0002，只有 MCP 用 OAuth**：伺服器確實不必替 `git` 存任何能冒用身分的東西，但系統要同時維護簽章與權杖兩套驗證，使用者也要先準備 Ed25519 key、`ssh-keygen` 與 git 2.41。
- **保留 User key，只拿來換權杖**（JWT bearer grant，RFC 7523）：原本是替無人值守的機器準備的，但滑動期限的 refresh token 已經涵蓋那個情境，而 User key 的登記與管理還是得做。
- **helper 用現成的 Git Credential Manager 或 git-credential-oauth**：兩者都支援自訂的 OAuth 主機與 device flow，Git for Windows 還內建 GCM。我們選擇繼續用自己的 shell script，讓安裝方式維持一行指令、不必另外裝工具。

## 後果

- 伺服器會存權杖（或它的雜湊），要做期限與撤銷。ADR 0002「伺服器不存任何可以拿來冒用身分的東西」這條不再成立。
- 每組權杖都帶權限範圍（scope），例如只讀寫某一個 repo，所以可以只把一部分權限交給 agent。要分哪些 scope、建立或刪除 repo 這類動作要哪個 scope，以及存取權杖與 refresh token 各多久有效，另外決定。
- 無人值守的機器靠 refresh token 續用：每次換新的存取權杖時也換一組新的 refresh token，期限從那一刻重算，所以只要在期限內用過一次就不會失效。helper 換權杖時要加檔案鎖，否則同一台機器上同時跑的兩個 `git` 指令會拿同一組 refresh token 去換，後換的會失敗。
- helper 自己把權杖存在檔案裡，不交給系統的密碼管理工具（例如 macOS 的 Keychain），所以不受 git 版本對 refresh token 支援的限制；權杖當 Basic 密碼送出，任何版本的 git 都收。沒有瀏覽器的機器用 device flow（RFC 8628）核准。
- 授權頁是一個網頁，註冊（email 在註冊白名單上、還沒註冊成使用者時）也在這一頁完成。「帳號流程沒有畫面」改成「只有授權頁這一個畫面」。
- OAuth 伺服器要在第二段（註冊與登入）就做出來，不再等到 MCP 那一段。第一段的 challenge 簽章驗證（`src/auth.ts`）與 helper（`src/scripts.ts`）都會被換掉，README 裡的安裝說明與 git 版本需求也要跟著改。
