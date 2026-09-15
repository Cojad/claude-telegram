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
<channel source="plugin:telegram:telegram" chat_id="-1004427695342" message_id="100" user="Cojad" user_id="137438526" ts="2026-09-15T04:10:00.000Z" reply_to_message_id="55" reply_to_text="earlier question">
here is my answer
</channel>
```

| 屬性 | 何時出現 |
|---|---|
| `reply_to_message_id` | 這則是回覆某一則舊訊息時, 被回覆那則的 message_id |
| `reply_to_text` | 被回覆那則的文字或 caption, 超過 200 字元會截斷並加 `…`. 純貼圖/無文字的訊息會有 id 沒有這個欄位 |

**已知限制 (已解決, 有備援):** Telegram 只在**該則訊息夠新**, 或原本就有文字/caption 時, 才會在更新裡給得到 `reply_to_text`. `handleInbound` 現在會自動補位: 只要有 `reply_to_message_id` 卻沒有 `reply_to_text`, 就自動去 `store.lookup()` 查本機紀錄, 查到就補上. 唯一還是會缺席的情況是那則被回覆的訊息**從沒被這支 plugin 經手過** (太早, 在這支 plugin 開始記錄之前), 這時 Claude 還是可以手動呼叫 `lookup_message` 試試看 (行為跟自動補位查的是同一份資料, 只是再查一次通常也不會查到更多), 但已經沒有更好的資料來源了.

邏輯在 `inbound.ts` 的 `buildReplyMeta()`, 純函式, 見 `test/inbound.test.ts`.

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

目前 `bun test` 55 條全過. 尚未實作 (不在原本四階段之內, 見 plan.html §03 的 TODO): 讓 inbound 不必只認得 Claude Code 的可插拔 sink 介面, 以及讓自訂的 `mentionPatterns` regex 在設定時就能被驗證 (避免像 CJK `\b` 那種從設定當天就失效卻沒人發現的坑再次發生).
