# Claude 這端實際收到的 raw format

記錄 Claude Code (透過這個 plugin 的 channel 機制) 從 Telegram 收到一則訊息時, 實際能看到的資料長什麼樣子, 以及對應到原始碼的哪一段. 2026-09-15 從 v0.0.7 (含本機套用的 PR #5604 patch) 實測整理.

**版本說明:** 一, 二節的範例是柯姊當晚在**正式部署的 channel** (跟這個 fork 起點相同的 v0.0.7 + #5604 + STANDBY_ONLY) 裡實際收到的原始標籤, 逐字照抄. 三節 (reply_to) 是這個 fork 在模組化之後才新增的功能, 目前**只存在這個 repo, 尚未部署到正式 channel**, 範例是照程式邏輯手寫建構的, 不是真的線上截圖, 已在 `test/inbound.test.ts` 用同樣的資料形狀驗證過.

自 2026-09-15 模組化後, 邏輯分散在多個檔案, 不再是單一 server.ts:
- 存取判斷 (gate/isMentioned): `policy.ts`
- 收到訊息後怎麼組成通知送給 Claude: `inbound.ts` 的 `handleInbound()` / `buildReplyMeta()`
- 怎麼從 Telegram 接原始事件, 怎麼下載附件: `transport.ts`
- 對外的 4 個工具: `outbound.ts`
- 誰在跟 Telegram 排隊收信: `poller.ts`
- 純文字分段: `format.ts`
- `server.ts` 現在只是把以上幾塊組裝起來的進入點

## 兩個層次

Claude 拿到的不是原始網路封包, 也不是 Telegram Bot API 的原始 JSON, 而是 **Claude Code 這個殼 (harness) 把 MCP 通知轉譯後的一段標籤文字**, 格式類似 XML. 這是 Claude 唯一接觸得到的東西, 底層 MCP server 真正送出的 JSON-RPC 訊息, Claude 沒有直接存取權.

```
┌──────────────┐   notifications/claude/channel   ┌─────────────┐   <channel ...>   ┌────────┐
│ server.ts    │ ────────────────────────────────▶│ Claude Code │ ─────────────────▶│ Claude │
│ (MCP server) │        (JSON-RPC over stdio)      │   (harness) │   (轉譯成標籤文字)  │        │
└──────────────┘                                    └─────────────┘                    └────────┘
```

## 一, Claude 實際看到的標籤 (逐字, 純文字訊息範例)

```xml
<channel source="plugin:telegram:telegram" chat_id="-1004427695342" message_id="739" user="Cojad" user_id="137438526" ts="2026-09-14T23:31:37.000Z">
cc 請你用raw format給我, 你收到的meta跟content整包長甚麼樣子就丟甚麼樣子給我看
</channel>
```

標籤屬性依序:

| 屬性 | 範例值 | 說明 |
|---|---|---|
| `source` | `plugin:telegram:telegram` | 固定值, 標示這是哪個 plugin/MCP server 送來的 |
| `chat_id` | `-1004427695342` | Telegram 的 chat id, 負數代表群組/超級群組, 正數是 DM |
| `message_id` | `739` | **這則訊息**自己的 id (不是被回覆的那則) |
| `user` | `Cojad` | 發送者的 Telegram username, 沒有的話 fallback 成 user_id 字串 |
| `user_id` | `137438526` | 發送者的 Telegram user id, 協定層保證, 無法偽造 |
| `ts` | `2026-09-14T23:31:37.000Z` | 訊息時間, UTC, ISO 格式 |
| 標籤內文 | 訊息文字本體 | 對應 `content` 欄位 |

## 二, 有附件時多出來的屬性 (實測: 貼圖訊息)

```xml
<channel source="plugin:telegram:telegram" chat_id="-1004427695342" message_id="711" user="Cojad" user_id="137438526" ts="2026-09-14T23:07:00.000Z" attachment_kind="sticker" attachment_file_id="CAACAgUAAyEFAAMBB-lE7gACAsRqqH3PVEjbUOU4P1ori4ty1amIVwAC6QEAApt2BBpbsuJ3KPYMKT0E" attachment_size="14260">
(sticker 😳)
</channel>
```

多出來的欄位, 全部可選, 只有相應情境才出現:

| 屬性 | 何時出現 |
|---|---|
| `image_path` | 訊息是圖片 (photo), 已被下載到本機的路徑 (自動下載, 不需要呼叫工具) |
| `attachment_kind` | 有附件時: `sticker` / `document` / `voice` / `audio` / `video` / `video_note` 等 |
| `attachment_file_id` | Telegram 的 file_id, 要另外呼叫 `download_attachment` 工具才能真的拿到檔案內容 |
| `attachment_size` | 檔案大小 (bytes), 不一定存在 |
| `attachment_mime` | MIME type, 不一定存在 |
| `attachment_name` | 原始檔名, 不一定存在 |

`image_path` 和 `attachment_*` 是互斥的兩種路徑: 圖片走自動下載 (`downloadImage` callback), 其他附件類型只給 `file_id`, 要 Claude 自己主動呼叫 `download_attachment` 才會落地成檔案.

## 三, 回覆訊息時多出來的屬性 (此 fork 新增, 尚未部署到正式 channel)

```xml
<channel source="plugin:telegram:telegram" chat_id="-1004427695342" message_id="100" user="Cojad" user_id="137438526" ts="2026-09-15T04:10:00.000Z" reply_to_message_id="55" reply_to_text="earlier question" reply_to_user_id="137438526">
here is my answer
</channel>
```

| 屬性 | 何時出現 |
|---|---|
| `reply_to_message_id` | 這則是回覆某一則舊訊息時, 被回覆那則的 message_id |
| `reply_to_text` | 被回覆那則的文字或 caption, 超過 200 字元會截斷並加 `…`. 純貼圖/無文字的訊息會有 id 沒有這個欄位 |
| `reply_to_user_id` | 被回覆那則的**發送者** uid(不是這一輪發訊息的人, 是被引用那則的原作者). 2026-09-15 補上, 之前一直漏掉 — Telegram 跟 `text`/`caption` 一起內附在同一個 `reply_to_message.from` 物件裡, 舊版 `buildReplyMeta()` 的型別簽章沒宣告這個欄位, 沒被讀進來, 不是刻意不送. 跟 `reply_to_text` 一樣, 只在 Telegram 有內附時才有; 目前沒有 store 補查的備援(那個備援只查得到文字內容, store 沒特別記「被回覆訊息的發送者」這件事單獨查詢用的索引).

**已知限制 (已解決, 有備援):** Telegram 只在**該則訊息夠新**, 或原本就有文字/caption 時, 才會在更新裡給得到 `reply_to_text`. `handleInbound` 現在會自動補位: 只要有 `reply_to_message_id` 卻沒有 `reply_to_text`, 就自動去 `store.lookup()` 查本機紀錄, 查到就補上. 唯一還是會缺席的情況是那則被回覆的訊息**從沒被這支 plugin 經手過** (太早, 在這支 plugin 開始記錄之前), 這時 Claude 還是可以手動呼叫 `lookup_message` 試試看 (行為跟自動補位查的是同一份資料, 只是再查一次通常也不會查到更多), 但已經沒有更好的資料來源了.

邏輯在 `inbound.ts` 的 `buildReplyMeta()`, 純函式, 見 `test/inbound.test.ts`.

## 六之一, 來源標記: `rich_message`

```xml
<channel source="plugin:telegram:telegram" chat_id="-1001068509881" message_id="154860" user="BaldEagleBot" user_id="133770478" ts="2026-09-16T04:07:47.000Z" rich_message="true">
**🦞 OpenClaw 2026.8.2**\n\n| Item | Value |\n| --- | --- |
</channel>
```

| 屬性 | 何時出現 |
|---|---|
| `rich_message` | 值固定是字串 `"true"`(meta 物件裡其他每個欄位都是字串, 見下面第四節的 JSON 形狀, 這裡保持一致). 只在這則訊息的內容原本是 Bot API 10.x 的 Rich Message(`message.rich_message.blocks`, 不是 `message.text`/`caption`)才有這個屬性. `content` 欄位此時已經是 `rich.ts` 攤平過的 Markdown 文字, 不是原始 block 結構. |

**為什麼需要這個:** 2026-09-16 發現 OpenClaw 現在幾乎所有回覆(不只 `/status`, 連打招呼)都走 rich_message 格式. 攤平後的文字讀起來跟一般訊息沒有視覺差異, 但攤平是有損的(媒體 block 變成 `[photo]` 這種佔位符, 某些 inline mark 沒有乾淨的 Markdown 對應), 這個標記讓讀者知道「這段文字是重建出來的, 不是對方原始打的字」, 需要對照原始結構時知道要往哪個方向查.

邏輯在 `policy.ts` 的 `InboundContext.message.rich_message` 型別, `transport.ts` 的 `bot.on('message:rich_message', ...)` handler 攤平內容, `inbound.ts` 的 `handleInbound()` 讀出並塞進 `meta.rich_message`, 見 `test/rich.test.ts` 跟 `test/policy.test.ts` 裡對應的 regression test.

**跟 `lookup_message` 的關係:** `rich_message` 從 2026-09-16 起也持久化進 `store.ts` 的 `messages` 表(一個 nullable `INTEGER` 欄位), `formatMessageRow` 會在 meta 方括號裡顯示(有才顯示), 例如:

```
#154860 in  09-16 04:07:47 133770478  [undelivered, rich_message]
**🦞 OpenClaw 2026.8.2**\n\n...
```

(這個repo曾經還有 `mtproto`/`raw` 兩個同類欄位, 2026-09-16 隨 MTProto 監聽器一起移除, 見第六節.)

## 四, 對應到原始碼: 實際送出的 JSON-RPC 通知

`inbound.ts` 的 `createHandleInbound()` 組出的通知大致是這個形狀:

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "<訊息文字本體>",
    "meta": {
      "chat_id": "<string>",
      "message_id": "<string, 可能不存在>",
      "user": "<username 或 user_id 字串>",
      "user_id": "<string>",
      "ts": "<ISO8601 UTC>",
      "rich_message": "<固定字串 \"true\", 只在原始內容是 Bot API 10.x Rich Message 時才存在>",
      "reply_to_message_id": "<string, 可選>",
      "reply_to_text": "<string, 可選, 最長 200 字元>",
      "image_path": "<string, 可選>",
      "attachment_kind": "<string, 可選>",
      "attachment_file_id": "<string, 可選>",
      "attachment_size": "<string, 可選>",
      "attachment_mime": "<string, 可選>",
      "attachment_name": "<string, 可選>"
    }
  }
}
```

跟前一版不同: 這段現在**不是回推重建**, 而是 `test/inbound.test.ts` 直接斷言過的真實結構 (攔截 `mcp.notification` 呼叫, 檢查送出的物件). 唯一還是回推的部分是欄位在真正的 JSON-RPC wire format 裡的順序, Claude 看到的 `<channel>` 標籤本身也不會透露這點.

## 五, 已確認完全沒有的資訊 (功能缺口, 非隱藏)

- **Telegram message entities** (如 @mention, hashtag, url 等結構化標註) 本身不會轉發, 只在 server 端內部用來判斷點名, 不出現在 Claude 收到的 meta 裡.
- **Telegram 官方的完整群組歷史**: Bot API 本身就不提供群組歷史查詢, plugin 也沒有另外去抓. `lookup_message` 只看得到**這支 plugin 自己在線期間經手過**的訊息 (進或出, 含被丟棄的), 不是這個群組從創立以來的完整記錄, 也不會補回這支 plugin 上線之前的舊訊息.
以下三項已解決, 記錄於此當作歷史對照:

- ~~被回覆訊息的任何資訊~~ → Stage C (見第三節), `buildReplyMeta()` 已補上.
- ~~被 gate() 丟棄的訊息完全不留紀錄~~ → Stage D, `inbound.ts` 現在把每一則看到的訊息都寫進 `store.ts` (SQLite), 包含 `delivered: false` 的丟棄紀錄, 可以用 `lookup_message` 查. 唯一還是查不到的是**這支 plugin 根本沒跑起來的那段時間** (例如重啟空窗), 那段時間的訊息 Telegram 端本身就不會補送.
- ~~太舊訊息的 reply_to_text 要手動查~~ → Stage E, `handleInbound` 現在自動查, 見上面第三節.

## 六, 與此 repo 的關係

本 repo 是 `anthropics/claude-plugins-official` 底下 `external_plugins/telegram` 的 fork, 起點是 v0.0.7 原始碼 (與上游 main 逐位元組相同). Git history 概要 (詳細看 `git log --oneline`):

1. 匯入原封不動的 v0.0.7, 當作跟上游比對的基準
2. 套上游 PR #5604 (合作式 poller) 與本機自製的 `TELEGRAM_STANDBY_ONLY` 補丁 (見 `~/.claude/projects/-x-code/memory/telegram-upstream-prs.md`)
3. 模組化: 拆成 policy / format / poller / outbound / transport / inbound 六個檔案, 每步都補了對應測試
4. 加 `reply_to_message_id` / `reply_to_text` (Stage C, 本文件第三節)
5. 加 `store.ts` (SQLite) 與 `lookup_message` 工具 (Stage D, 本文件第三, 五節): 進出雙向訊息都記錄, 含被丟棄的, `(chat_id, message_id)` 唯一索引
6. `reply_to_text` 缺席時自動查 store 補齊 (Stage E, 本文件第三節). plan.html §06 的四個階段到此全部完成.

目前 `bun test` 105 條全過(持續增加中, 不要照這個數字更新, 以實際跑出來的為準). 尚未實作 (不在原本四階段之內, 見 plan.html §03 的 TODO): 讓 inbound 不必只認得 Claude Code 的可插拔 sink 介面, 以及讓自訂的 `mentionPatterns` regex 在設定時就能被驗證 (避免像 CJK `\b` 那種從設定當天就失效卻沒人發現的坑再次發生).

2026-09-16: CJK `\b` 那個坑本身(`^cc\b` 對 "cc，" 這種後面接全形標點的情況判斷失效)已經在 access.json 裡把 `mentionPatterns` 從 `["^柯柯", "^cc\\b"]` 改成 `["柯柯", "cc"]` 解決(柯姊指示: 不再要求開頭或邊界, 只要文字裡出現這兩個字串就算 mention, 換成更寬鬆但可靠的判斷). 但「設定時驗證 regex」這個系統性的 TODO 本身還沒做, 之後如果又設定了帶 `\b` 的 pattern, 一樣會複製這個坑.

**MTProto 監聽器: 加入又移除(2026-09-15 → 2026-09-16).** `mtproto.ts`(GramJS 補充監聽器, 讓拍拍能看到其他 bot 的訊息)2026-09-15 加入, 2026-09-16 整個移除, 理由: (1) Bot-to-Bot Communication Mode(BotFather 設定)讓 Bot API 本身也能看到其他 bot 訊息, 原本的用途變得多餘; (2) 它完全解不了 Bot API 10.x 的 Rich Message, 收到的永遠是空殼(`MessageMediaUnsupported`); (3) 兩條 transport 並存時, MTProto 常常搶先進 dedup, 把它的空殼記錄下來, 反而擋掉 Bot API 那邊本來會正確攤平出的內容 — 這是一個真的 bug, 不是理論風險, 2026-09-16 當晚實測抓到. 連帶移除: `store.ts` 的 `raw`/`mtproto` 兩個欄位(`raw` 本來就只有 mtproto.ts 會填, 移除監聽器後永遠不會再有新資料)、`package.json` 的 `telegram`(GramJS)依賴、`TELEGRAM_MTPROTO_ENABLED` 這個 `.env` flag、對應的 session 檔案. 完整脈絡見 git history 的移除 commit, 或本節上方「六之一」小節現在只剩 `rich_message` 的原因.
