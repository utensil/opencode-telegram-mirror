/**
 * Telegram poller - singleton process that polls getUpdates and writes to SQLite
 * Only one poller runs per bot token, multiple OpenCode instances read from SQLite
 */

import { Database } from "bun:sqlite"
import { createServer } from "node:http"

const DB_PATH = "/tmp/telegram-events.db"
const POLLER_PORT = 18433
const MAX_EVENTS = 500
const POLL_INTERVAL = 1000 // 1 second

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: { id: number; username?: string; first_name?: string }
    chat: { id: number; type: string }
    message_thread_id?: number
    date: number
    text?: string
    reply_to_message?: { message_id: number; text?: string }
  }
  callback_query?: {
    id: string
    from: { id: number }
    message?: { chat: { id: number }; message_thread_id?: number }
    data?: string
  }
}

// Initialize database
function initDb(): Database {
  const db = new Database(DB_PATH, { create: true })
  db.run(
    "CREATE TABLE IF NOT EXISTS events (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "timestamp INTEGER NOT NULL, " +
    "type TEXT NOT NULL, " +
    "chat_id INTEGER, " +
    "thread_id INTEGER, " +
    "data TEXT NOT NULL)"
  )
  db.run("CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)")
  db.run("CREATE INDEX IF NOT EXISTS idx_events_chat ON events(chat_id, thread_id)")
  
  // Store last update_id to avoid duplicates
  db.run(
    "CREATE TABLE IF NOT EXISTS poller_state (" +
    "key TEXT PRIMARY KEY, " +
    "value TEXT NOT NULL)"
  )
  return db
}

function getLastUpdateId(db: Database): number {
  const row = db.query<{ value: string }, []>("SELECT value FROM poller_state WHERE key = 'last_update_id'").get()
  return row ? Number.parseInt(row.value, 10) : 0
}

function setLastUpdateId(db: Database, updateId: number): void {
  db.run(
    "INSERT OR REPLACE INTO poller_state (key, value) VALUES ('last_update_id', ?)",
    [String(updateId)]
  )
}

function appendEvent(db: Database, event: { timestamp: number; type: string; chatId: number | null; threadId: number | null; data: unknown }): void {
  db.run(
    "INSERT INTO events (timestamp, type, chat_id, thread_id, data) VALUES (?, ?, ?, ?, ?)",
    [event.timestamp, event.type, event.chatId, event.threadId, JSON.stringify(event.data)]
  )
  
  // Cleanup old events
  const countResult = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM events").get()
  const count = countResult?.count ?? 0
  if (count > MAX_EVENTS) {
    const deleteCount = count - MAX_EVENTS
    db.run("DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY timestamp ASC LIMIT ?)", [deleteCount])
  }
}

async function pollTelegram(botToken: string, db: Database, log: (msg: string) => void): Promise<void> {
  const baseUrl = `https://api.telegram.org/bot${botToken}`
  let lastUpdateId = getLastUpdateId(db)
  
  log(`Starting poll loop, last_update_id: ${lastUpdateId}`)
  
  while (true) {
    try {
      const params = new URLSearchParams({
        offset: String(lastUpdateId + 1),
        timeout: "30",
        allowed_updates: JSON.stringify(["message", "callback_query"]),
      })
      
      const response = await fetch(`${baseUrl}/getUpdates?${params}`)
      const data = await response.json() as { ok: boolean; result?: TelegramUpdate[]; error_code?: number; description?: string }
      
      if (!data.ok) {
        log(`getUpdates error: ${data.description}`)
        if (data.error_code === 409) {
          log("Conflict error - another instance is polling. Exiting.")
          process.exit(1)
        }
        if (data.error_code === 401) {
          log("Unauthorized - invalid bot token. Exiting.")
          process.exit(1)
        }
        await Bun.sleep(5000)
        continue
      }
      
      const updates = data.result ?? []
      
      for (const update of updates) {
        lastUpdateId = update.update_id
        
        let eventType: "message" | "callback_query" | "unknown" = "unknown"
        let chatId: number | null = null
        let threadId: number | null = null
        
        if (update.message) {
          eventType = "message"
          chatId = update.message.chat.id
          threadId = update.message.message_thread_id ?? null
          log(`Message from chat ${chatId}: ${update.message.text?.slice(0, 50) ?? "(no text)"}`)
        } else if (update.callback_query) {
          eventType = "callback_query"
          chatId = update.callback_query.message?.chat.id ?? null
          threadId = update.callback_query.message?.message_thread_id ?? null
          log(`Callback query: ${update.callback_query.data}`)
        }
        
        appendEvent(db, {
          timestamp: Date.now(),
          type: eventType,
          chatId,
          threadId,
          data: update,
        })
        
        setLastUpdateId(db, lastUpdateId)
      }
      
      if (updates.length > 0) {
        log(`Processed ${updates.length} updates, last_update_id: ${lastUpdateId}`)
      }
    } catch (error) {
      log(`Poll error: ${error}`)
      await Bun.sleep(5000)
    }
    
    await Bun.sleep(POLL_INTERVAL)
  }
}

function startHealthServer(log: (msg: string) => void): void {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, type: "poller" }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  
  server.listen(POLLER_PORT, "127.0.0.1", () => {
    log(`Health server listening on port ${POLLER_PORT}`)
  })
}

// Main
const botToken = process.env.TELEGRAM_BOT_TOKEN
if (!botToken) {
  console.error("TELEGRAM_BOT_TOKEN environment variable required")
  process.exit(1)
}

const log = (msg: string) => {
  const timestamp = new Date().toISOString()
  console.log(`${timestamp} [poller] ${msg}`)
}

log("Initializing poller...")
const db = initDb()
startHealthServer(log)
pollTelegram(botToken, db, log)
