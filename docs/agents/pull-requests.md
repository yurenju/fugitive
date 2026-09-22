# Pull requests

PR 的寫法（第一段先補前提、判讀用的放外面、輔助資料收進 `<details>`）照全域的 `~/.claude/CLAUDE.md`，這裡只寫這個 repo 自己的部分：**動到畫面的 PR 要附截圖**。做法是從 tidemarks 的 `docs/agents/pull-requests.md` 搬過來再縮小的，第一次照這份做的是 #25。

## 什麼時候要截圖

動到主機輸出的 HTML 或 CSS 的時候：`src/pages.ts`（版面、配色）、`src/authorize.ts`（授權頁與 `/authorize/done`）、`src/settings.ts`（設定頁），或它們共用的 `src/sign-in.ts` 裡會顯示在頁面上的文字。其他改動不用，`npm test` 與 `npm run test:e2e` 已經蓋到了。

截**這次動到的每一頁**，手機寬度（390×844）與桌機（1000×700）各一張。規格要求畫面在手機上也能用，而版面出問題幾乎都是在窄的那一邊：#25 的設定頁在桌機正常，在手機寬度下「Revoke」按鈕被切掉一半，只有截圖看得出來。

**截完由開 PR 的 agent 自己把圖讀進來看**，看到問題就修、重截，PR 裡放修好之後的那一套。要逐項檢查哪些缺陷，之後再定。

## 截圖怎麼產

在 host 上起一個本機的主機和假的 Resend，用 `playwright-cli` 走一遍流程。假的 Resend 就是 e2e 用的那支，它把每封信記成 `<收件人> <驗證碼>` 一行，腳本從那裡拿驗證碼。

```bash
S=$(mktemp -d)                    # 圖落在 repo 外面：它們要傳上去，不是 commit 進來
: >"$S/mail.log"
node test/fake-resend.mjs 8794 "$S/mail.log" &
npx wrangler dev --ip 127.0.0.1 --port 8793 --persist-to "$S/state" \
  --var "RESEND_API_URL:http://127.0.0.1:8794" --var "RESEND_API_KEY:x" \
  --var "EMAIL_FROM:fugitive <noreply@fugitive.test>" --var "SESSION_SECRET:shots" \
  --var "REGISTRATION_ALLOWLIST:tester@example.com" >"$S/wrangler.log" 2>&1 &

P="playwright-cli -s=shots"
$P open --browser chromium        # 一定要帶 --browser chromium，見全域 CLAUDE.md
$P goto "<授權頁網址>"             # open 的網址參數吃不到，先 open 再 goto
$P fill '#email' tester@example.com
$P click 'button[type=submit]'
# ……這次要走的操作……
$P resize 390 844  && $P screenshot --filename="$S/settings-phone.png"
$P resize 1000 700 && $P screenshot --filename="$S/settings-desktop.png"
```

授權頁要一個已註冊的工具才開得起來：先 `curl` 打 `POST /register`，拿回的 `client_id` 組成 `/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256`。#25 的 PR 內文 `<details>` 裡有一支完整走過授權頁與設定頁的腳本，可以從那裡改。

幾件會踩到的事：

- **同一個 email 一分鐘只寄一次驗證碼。** 授權頁走完馬上去設定頁登入，第二封信不會寄出，頁面也不會說（刻意的，見 #25）。中間 `sleep 61`，或截圖只用一個 email 走一趟。
- **收掉伺服器時用 PID，不要 `pkill -f "port 8793"`**：那個字串也出現在你正在跑的那行指令裡，會連自己的 shell 一起砍掉。
- `wrangler dev` 會自己重新載入改過的程式，設定頁的 cookie 30 分鐘內也還有效，所以改完版面只要 `goto` 同一頁重截，不必從頭走。

## 圖怎麼放

用 `pr-image` 傳上去，印出來的 Markdown 直接貼進 PR 內文：

```bash
pr-image upload --markdown "$S"/*.png
```

- **檔名就是 alt text**，截圖時就取好（`settings-phone`、`authorize-3-approve-desktop`）。
- **傳上去的圖是公開的**，畫面上只能有測試用的資料（`tester@example.com`、本機的 `127.0.0.1`），不要用真的 email 或正式環境截。
- **圖 30 天後會被刪**，沒有東西會提醒你。所以截圖的腳本要收進 PR 的 `<details>`，圖不在了還能照著重截。
- 截圖**放在 PR 內文外面，不收進 `<details>`**：看了圖才發現跟預期不一樣，那正是要人判斷的部分。

全域 `CLAUDE.md` 說「一次性的報告頁不要截圖」，那條管的是交給使用者自己開的報告；這裡截的是產品的畫面，版面對不對只有看圖才知道，兩件事不衝突。
