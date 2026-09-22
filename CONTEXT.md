# Fugitive

架在 Cloudflare 上、給多人使用的 git 主機。一般的 `git` 指令就能透過 HTTPS clone 和 push；之後 agent 也能透過 MCP 瀏覽檔案、直接 commit，或透過檔案 API 讀取檔案。

## 名詞定義

程式碼裡的命名一律用括號中的英文名稱。

### 使用者 (User)

在這台 git 主機上有帳號的人。將來開放給任何人註冊，一開始只有註冊白名單上的 email 能註冊。

每個使用者有一個名稱，註冊之後就不能改；另外還有一個主機自動產生、永遠不會變的使用者編號 (User ID)，用來辨認是誰。名稱是給人看、放在網址裡的；認身分靠的是編號。

_避免使用_：帳號 (Account)、會員 (Member)、客戶 (Customer)

### 註冊白名單 (Registration Allowlist)

可以註冊成為使用者的 email 清單。不在清單上的 email 一律不能註冊。

_避免使用_：Whitelist、邀請名單 (Invite List)、測試名單 (Beta List)

### 驗證碼 (Verification Code)

寄到使用者 email 的一次性代碼，在授權頁輸入它，證明這個信箱是自己的。這是證明身分唯一的方式：註冊、登入、授權 agent 都靠它。

_避免使用_：密碼 (Password)、OTP、登入碼 (Login Code)

### 授權頁 (Authorization Page)

使用者在瀏覽器裡輸入驗證碼、核准某個工具的那一頁，也是整個主機唯一的畫面。第一次來、還沒註冊的人也在這一頁成為使用者。

_避免使用_：登入頁 (Login Page)、同意頁 (Consent Page)

### 存取權杖 (Access Token)

使用者在授權頁核准之後，主機發給某個工具的憑證，每個工具各拿一組。每組都有期限、可以撤銷，並且帶著權限範圍，只能做被允許的那些事。

_避免使用_：Session、API 金鑰 (API Key)、Personal Access Token

### 儲存庫 (Repository)

放在這台主機上的 git 儲存庫，一般的 `git` 指令透過 HTTPS 就能存取。

_避免使用_：專案 (Project)。平常講話和文件裡說 repo 沒問題，但程式碼命名一律用 `Repository`，不縮寫成 `Repo`。

### 擁有者 (Owner)

儲存庫所屬的那個使用者。網址 `/<owner>/<repository>.git` 的第一段就是擁有者的名字。之後的組織也會共用這一段命名空間。

_避免使用_：Namespace（不拿來稱呼擁有者本身）、作者 (Author)

### 私有儲存庫 (Private Repository)

只有擁有者能讀寫的儲存庫。目前所有儲存庫都是私有的。
