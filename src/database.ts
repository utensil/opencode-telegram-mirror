/**
 * SQLite database for Telegram events and session↔thread mapping
 */

import { Database } from "bun:sqlite"
import type { LogFn } from "./log"

const DB_PATH = "/tmp/telegram-events.db"
const MAX_EVENTS = 500

export interface TelegramEvent {
  id: number
  timestamp: number
  type: "message" | "callback_query" | "unknown"
  chatId: number | null
  threadId: number | null
  data: unknown
}

// Singleton database connection
let db: Database | null = null

export function getDb(log: LogFn): Database {
  if (!db) {
    log("debug", "Opening SQLite database", { path: DB_PATH })
    db = new Database(DB_PATH, { create: true })

    // Events table (for Telegram updates from poller)
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

    // Session↔Thread bidirectional mapping
    // In forum mode: each OpenCode session maps to a Telegram topic (thread)
    db.run(
      "CREATE TABLE IF NOT EXISTS session_threads (" +
        "session_id TEXT PRIMARY KEY, " +
        "chat_id INTEGER NOT NULL, " +
        "thread_id INTEGER NOT NULL, " +
        "session_title TEXT, " +
        "created_at INTEGER NOT NULL)"
    )
    db.run("CREATE INDEX IF NOT EXISTS idx_session_threads_thread ON session_threads(chat_id, thread_id)")

    log("info", "SQLite database initialized", { path: DB_PATH })
  }
  return db
}

// ============================================================================
// Event operations (used by plugin to read events written by poller)
// ============================================================================

interface EventFilter {
  sinceTimestamp: number
  chatId?: number
  threadId?: number | null // null = no thread (DM or main group), undefined = any
}

export function getEventsSince(filter: EventFilter, log: LogFn): TelegramEvent[] {
  const database = getDb(log)

  let sql = "SELECT id, timestamp, type, chat_id, thread_id, data FROM events WHERE timestamp > ?"
  const params: (number | null)[] = [filter.sinceTimestamp]

  if (filter.chatId !== undefined) {
    sql += " AND chat_id = ?"
    params.push(filter.chatId)
  }

  if (filter.threadId !== undefined) {
    if (filter.threadId === null) {
      sql += " AND thread_id IS NULL"
    } else {
      sql += " AND thread_id = ?"
      params.push(filter.threadId)
    }
  }

  sql += " ORDER BY timestamp ASC"

  type Row = {
    id: number
    timestamp: number
    type: string
    chat_id: number | null
    thread_id: number | null
    data: string
  }
  const rows = database.query<Row, (number | null)[]>(sql).all(...params)

  const events = rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    type: row.type as TelegramEvent["type"],
    chatId: row.chat_id,
    threadId: row.thread_id,
    data: JSON.parse(row.data),
  }))

  if (events.length > 0) {
    log("debug", "Found events since timestamp", {
      sinceTimestamp: filter.sinceTimestamp,
      chatId: filter.chatId,
      threadId: filter.threadId,
      count: events.length,
    })
  }

  return events
}

// ============================================================================
// Session↔Thread mapping (bidirectional)
// ============================================================================

export interface SessionThread {
  sessionId: string
  chatId: number
  threadId: number
  sessionTitle: string | null
  createdAt: number
}

/**
 * Get session info by Telegram thread
 */
export function getSessionByThread(
  chatId: number,
  threadId: number,
  log: LogFn
): SessionThread | null {
  const database = getDb(log)

  type Row = {
    session_id: string
    chat_id: number
    thread_id: number
    session_title: string | null
    created_at: number
  }

  const row = database
    .query<Row, [number, number]>(
      "SELECT session_id, chat_id, thread_id, session_title, created_at FROM session_threads WHERE chat_id = ? AND thread_id = ?"
    )
    .get(chatId, threadId)

  if (!row) return null

  return {
    sessionId: row.session_id,
    chatId: row.chat_id,
    threadId: row.thread_id,
    sessionTitle: row.session_title,
    createdAt: row.created_at,
  }
}

/**
 * Get thread info by OpenCode session ID
 */
export function getThreadBySession(
  sessionId: string,
  log: LogFn
): SessionThread | null {
  const database = getDb(log)

  type Row = {
    session_id: string
    chat_id: number
    thread_id: number
    session_title: string | null
    created_at: number
  }

  const row = database
    .query<Row, [string]>(
      "SELECT session_id, chat_id, thread_id, session_title, created_at FROM session_threads WHERE session_id = ?"
    )
    .get(sessionId)

  if (!row) return null

  return {
    sessionId: row.session_id,
    chatId: row.chat_id,
    threadId: row.thread_id,
    sessionTitle: row.session_title,
    createdAt: row.created_at,
  }
}

/**
 * Store a session↔thread mapping
 */
export function setSessionThread(
  sessionId: string,
  chatId: number,
  threadId: number,
  sessionTitle: string | null,
  log: LogFn
): void {
  const database = getDb(log)

  database.run(
    "INSERT OR REPLACE INTO session_threads (session_id, chat_id, thread_id, session_title, created_at) VALUES (?, ?, ?, ?, ?)",
    [sessionId, chatId, threadId, sessionTitle, Date.now()]
  )

  log("info", "Stored session↔thread mapping", { sessionId, chatId, threadId, sessionTitle })
}

/**
 * Update session title in the mapping
 */
export function updateSessionTitle(
  sessionId: string,
  sessionTitle: string,
  log: LogFn
): void {
  const database = getDb(log)

  database.run(
    "UPDATE session_threads SET session_title = ? WHERE session_id = ?",
    [sessionTitle, sessionId]
  )

  log("debug", "Updated session title", { sessionId, sessionTitle })
}

/**
 * Get all session mappings for a chat (useful for listing)
 */
export function getSessionsForChat(
  chatId: number,
  log: LogFn
): SessionThread[] {
  const database = getDb(log)

  type Row = {
    session_id: string
    chat_id: number
    thread_id: number
    session_title: string | null
    created_at: number
  }

  const rows = database
    .query<Row, [number]>(
      "SELECT session_id, chat_id, thread_id, session_title, created_at FROM session_threads WHERE chat_id = ? ORDER BY created_at DESC"
    )
    .all(chatId)

  return rows.map((row) => ({
    sessionId: row.session_id,
    chatId: row.chat_id,
    threadId: row.thread_id,
    sessionTitle: row.session_title,
    createdAt: row.created_at,
  }))
}
