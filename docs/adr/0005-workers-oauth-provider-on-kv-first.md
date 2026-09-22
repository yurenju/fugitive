# OAuth 伺服器先用 `workers-oauth-provider` 0.10.3 加 KV，1.0 發布後改用它的 Durable Object 儲存

部分取代 [ADR 0004](0004-oauth-tokens-for-every-client.md)：沒有瀏覽器的機器不用 device flow，改成手動貼碼。

ADR 0004 決定所有工具都用 OAuth 發的存取權杖，但沒定 OAuth 伺服器怎麼做。我們**現在就用** Cloudflare 官方的 `@cloudflare/workers-oauth-provider` 0.10.3，授權、權杖、授權碼照它的設計存在 KV；等 1.0 發布，再換成它的 Durable Object 儲存。理由是這個套件替我們維護 MCP 用戶端要求的整套 OAuth 規格（用戶端自己註冊、CIMD、PKCE 等等），而 MCP 規格還一直在改，自己寫就得自己追。

## 考慮過的選項

- **自己寫，全部存在 Durable Object**：一致性最好，撤銷馬上生效，device flow 也照 ADR 0004 做得出來，但 MCP 那一整套規格要自己寫、自己追更新。
- **等 1.0 加 Durable Object 儲存發布了才開始**：沒有下面 KV 的兩個代價，但第二段要等 Cloudflare 的時程。
- **Cloudflare Access 的 Managed OAuth**：權杖沒有自訂的權限範圍、沒有 device flow，而且 Access 照人頭計費，不適合之後開放任何人註冊。

## 後果

- **KV 的兩個代價，升級之後消失。** KV 改了之後要過一陣子各地機房才看得到，也沒辦法保證只有一個請求搶得到，所以：撤銷權杖之後，其他機房最多還會用到約 60 秒；兩個請求剛好同時拿同一組授權碼來換，兩個都可能成功（套件強制 PKCE，事後發現重複使用也會撤銷整組授權，所以實際上很難被利用）。套件的 Durable Object 儲存（2026 年 9 月還是未合併的 PR #312，屬於 1.0 的工作）沒有這兩個問題；它沿用 KV 版本的 key 結構，1.0 之前發的權杖也會繼續有效，所以換的時候不必搬資料。
- **沒有 device flow。** 0.10.3 的 token 端點只認它自己支援的幾種 grant type，device flow（RFC 8628）不在裡面，不 fork 套件就加不進去。沒有瀏覽器的機器改成**手動貼碼**：helper 印出網址，使用者用手機打開、輸入驗證碼、核准，頁面最後顯示授權碼，使用者再把它貼回終端機。這是一般的 authorization code 流程，只是 redirect 到我們自己顯示授權碼的那一頁。
- **使用者與驗證碼由我們自己存，放在一個全站共用的使用者 Durable Object。** 套件不管這兩樣。「驗證碼正確 → 這個 email 還沒註冊 → 建立使用者 → 把碼標成已用」要當成一件事做完，Durable Object 一次只處理一個請求，包在一個 transaction 裡就安全。驗證碼只存 SHA-256 雜湊，再靠效期與錯誤次數上限擋猜測；位數、效期、次數由規格決定。
- **使用者名稱不能改，每個使用者另有一個自動產生、不會變的使用者編號。** 核准授權時，套件讓我們在權杖上附一小包自己的資料（`props`），驗權杖時一起拿回來。這包資料放使用者編號與名稱，所以 Worker 用 `unwrapToken()` 驗 `git` 送來的 Basic 密碼，就知道是誰，每個 `git` 請求只查 KV、不經過使用者 Durable Object。名稱不能改，是因為權杖上帶著名稱，而且儲存庫的 Durable Object 照舊用 `<owner>/<repo>` 這個名字找，Durable Object 沒辦法改名。
