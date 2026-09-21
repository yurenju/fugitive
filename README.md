# fugitive

架在 Cloudflare Workers 上的 git 主機。用一般的 `git` 指令透過 HTTPS clone 與 push；驗證用使用者自己的 Ed25519 金鑰簽章，伺服器不發 token（見 [ADR 0002](docs/adr/0002-user-key-signatures-as-http-credentials.md)）。

## 使用

```sh
curl -fsSL https://<主機>/install.sh | sh
git clone https://<主機>/<owner>/<repository>.git
```

需要 git 2.41 以上（helper 要從 git 拿到伺服器的 challenge）。安裝指令會放好 credential helper，並只替這台主機寫 git 設定。helper 用 ssh-agent 裡第一把 Ed25519 金鑰，沒有的話用 `~/.ssh/id_ed25519`；要指定別把，設 `git config --global fugitive.key <路徑>`。

目前（第一段）還沒有註冊與登入：`wrangler.jsonc` 的 `USER_NAME` 與 `USER_KEY` 就是唯一的使用者和他的公鑰，這個名字底下任何名字的儲存庫都可以直接 push。

## 開發

```sh
npm install
npm run typecheck
npm test          # 在 workerd 裡對 Worker 送 HTTP 請求
npm run test:e2e  # 起 wrangler dev，用真的 git 跑驗收清單
```

本機的 `wrangler dev` 需要 `.dev.vars` 裡有 `CHALLENGE_SECRET=<任意字串>`。

## 部署

push 到 `main` 時 GitHub Actions 會跑完測試再 `wrangler deploy`。需要的 repo secrets：

- `CLOUDFLARE_API_TOKEN`：要有 Workers 與 R2 的編輯權限（R2 bucket `fugitive-packs`）。
- `CHALLENGE_SECRET`：伺服器替 challenge 算檢查碼用的秘密，隨機產生一段即可。
