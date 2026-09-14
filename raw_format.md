# Claude 這端實際收到的 raw format

記錄 Claude Code (透過這個 plugin 的 channel 機制) 從 Telegram 收到一則訊息時, 實際能看到的資料長什麼樣子, 以及對應到 `server.ts` 原始碼的哪一段. 2026-09-15 從 v0.0.7 (含本機套用的 PR #5604 patch) 實測整理.

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

## 三, 對應到原始碼: server.ts 實際送出的 JSON-RPC 通知

`handleInbound()` (server.ts, 約 887 行起) 組出的通知大致是這個形狀:

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

這段是**回推重建**, 不是 Claude 直接觀察到的原始 JSON — Claude 沒有管道去確認欄位順序或是否還有其他從未在 `<channel>` 標籤裡出現過的隱藏欄位.

## 四, 已確認完全沒有的資訊 (功能缺口, 非隱藏)

- **被回覆訊息的任何資訊**: `ctx.message.reply_to_message` 在 server.ts 裡整支程式**只用過一次** (isMentioned() 裡拿來判斷「這算不算點名我」的布林值), 判斷完就丟棄, 完全沒有任何欄位 (原文內容, message_id, 發送者, 時間) 被包進送給 Claude 的通知裡. 換句話說 Claude 沒有辦法知道使用者回覆的是哪一則.
- **Telegram message entities** (如 @mention, hashtag, url 等結構化標註) 本身不會轉發, 只在 server 端內部用來判斷點名, 不出現在 Claude 收到的 meta 裡.
- **群組成員名單, 訊息歷史**: Telegram Bot API 本身就不提供群組歷史查詢, plugin 也沒有另外快取, Claude 只看得到自己在線期間新進來的訊息.
- **被 gate() 丟棄的訊息**: 完全不留紀錄, 連 debug log 都沒有, 不只 Claude 看不到, 連事後用 `--debug` 查都查不到.

## 五, 與此 repo 的關係

本 repo 是 `anthropics/claude-plugins-official` 底下 `external_plugins/telegram` 的 fork, 起點是 v0.0.7 原始碼 (與上游 main 逐位元組相同). Git history:

1. 第一個 commit: 原封不動匯入 v0.0.7, 保留與上游比對的基準
2. 後續 commit: 套用上游 PR #5604 (合作式 poller, 不再 SIGTERM 活著的持有者) 與本機自製的 `TELEGRAM_STANDBY_ONLY` 補丁 (見 `~/.claude/projects/-x-code/memory/telegram-upstream-prs.md`)

改進方向 (規劃中, 尚未實作) 至少包含: 把被回覆訊息的原文一併送出, 把 gate() 丟棄的訊息留一份可查詢的紀錄 (供除錯用, 不代表要違反使用者未點名就不處理的存取控制原則), 以及讓自訂的 `mentionPatterns` regex 在設定時就能被驗證, 避免像 CJK `\b` 那種從設定當天就失效卻沒人發現的坑再次發生.
