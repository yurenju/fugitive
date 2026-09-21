# Fugitive

架在 Cloudflare 上、給多人使用的 git 主機。一般的 `git` 指令就能透過 HTTPS clone 和 push；之後 agent 也能透過 MCP 瀏覽檔案、執行 git 操作。

## 名詞定義

程式碼裡的命名一律用括號中的英文名稱。

### 使用者與金鑰 (Users and Keys)

**使用者 (User)**：
在這台 git 主機上有帳號的人。將來開放給任何人註冊，一開始只有註冊白名單上的 email 能註冊。
_避免使用_：帳號 (Account)、會員 (Member)、客戶 (Customer)

**註冊白名單 (Registration Allowlist)**：
可以註冊成為使用者的 email 清單。不在清單上的 email 一律不能註冊。
_避免使用_：Whitelist、邀請名單 (Invite List)、測試名單 (Beta List)

**使用者金鑰 (User Key)**：
使用者登記在這裡、用來證明自己身分的公鑰，格式是 OpenSSH 的 Ed25519 公鑰。私鑰只在使用者自己手上，主機從頭到尾都看不到。一個使用者可以登記好幾把，但每一把只能屬於一個使用者。
_避免使用_：SSH 金鑰 (SSH Key，這裡沒有任何東西走 SSH)、部署金鑰 (Deploy Key)、API 金鑰 (API Key)

### 儲存庫與擁有權 (Repositories and Ownership)

**儲存庫 (Repository)**：
放在這台主機上的 git 儲存庫，一般的 `git` 指令透過 HTTPS 就能存取。
_避免使用_：專案 (Project)。平常講話和文件裡說 repo 沒問題，但程式碼命名一律用 `Repository`，不縮寫成 `Repo`。

**擁有者 (Owner)**：
儲存庫所屬的那個使用者。網址 `/<owner>/<repository>.git` 的第一段就是擁有者的名字。之後的組織也會共用這一段命名空間。
_避免使用_：Namespace（不拿來稱呼擁有者本身）、作者 (Author)

**私有儲存庫 (Private Repository)**：
只有擁有者能讀寫的儲存庫。目前所有儲存庫都是私有的。
