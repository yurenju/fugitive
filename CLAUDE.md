## 語言

跟使用者對話一律用繁體中文，包括進度回報、要使用者決定的問題、最後的總結。讀了英文的文件、git 原始碼或子 agent 的英文報告之後，最容易不知不覺跟著換成英文，這時候也一樣要用中文寫。

## Agent skills 的設定

### Issue tracker

issue 放在 GitHub 的 `yurenju/fugitive`，一律用 `gh` 操作。細節見 `docs/agents/issue-tracker.md`。

### Triage 標籤

用預設的五個標籤：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。各自的意思見 `docs/agents/triage-labels.md`。

### 領域文件

整個 repo 只有一個領域：名詞定義在根目錄的 `CONTEXT.md`，決策紀錄放在 `docs/adr/`。細節見 `docs/agents/domain.md`。
