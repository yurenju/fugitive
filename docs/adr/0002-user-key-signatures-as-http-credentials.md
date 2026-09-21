# git 連線用 User key 的簽章當憑證，不發 access token

`git` 透過 HTTPS 連線時，每一次指令只能帶一個固定的 `Authorization` 值。常見的做法是發一組 personal access token，但那是一個長期有效的秘密，伺服器得保存它。我們的做法是：git 的 credential helper 用 User 的私鑰（Ed25519，透過 `ssh-keygen -Y sign`）簽「使用者 + 時間 + repo」，把簽章當成 Bearer 憑證交給 git；伺服器每收到一個請求，就用登記過的 User key 驗一次。伺服器不發 token，也不存任何可以拿來冒用使用者身分的東西。

## 後果

- 使用者的 git 要 2.46 以上（credential helper 才能回傳 `authtype=Bearer`），而且要裝我們的 credential helper。
- header 如果被人截走，在時間容許範圍內可以被拿去重送；擋住截取靠的是 HTTPS。
- 這個做法只管 `git` 透過 HTTPS 的連線。MCP 不用它，改用 OAuth 登入：OAuth 是 MCP 規格裡標準的授權方式，MCP 客戶端都支援，不需要另外裝 helper。
- 所以「伺服器不存任何可以拿來冒用身分的東西」只對 git 成立。MCP 那邊會有伺服器發出去的 access token，它們的有效期限與撤銷方式要在做 MCP 時另外決定。
