# 用 User key 的簽章當 HTTP 憑證，不發 access token

`git` 透過 HTTPS 連線時，每一次指令只能帶一個固定的 `Authorization` 值。常見的做法是發一組 personal access token，但那是一個長期有效的秘密，伺服器得保存它。我們的做法是：git 的 credential helper 用 User 的私鑰（Ed25519，透過 `ssh-keygen -Y sign`）簽「使用者 + 時間 + repo」，把簽章當成 Bearer 憑證交給 git；伺服器每收到一個請求，就用登記過的 User key 驗一次。伺服器不發 token，也不存任何可以拿來冒用使用者身分的東西。

## 後果

- 使用者的 git 要 2.46 以上（credential helper 才能回傳 `authtype=Bearer`），而且要裝我們的 credential helper。
- header 如果被人截走，在時間容許範圍內可以被拿去重送；擋住截取靠的是 HTTPS。
- MCP 客戶端需要自己的方式帶上同一種簽章（例如 Claude Code 的 `headersHelper`），或者另外走一條路，例如 OAuth。
