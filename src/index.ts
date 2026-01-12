/**
 * OpenCode Telegram Mirror Plugin
 *
 * Bidirectionally mirrors messages between OpenCode sessions and Telegram topics.
 * Each OpenCode session gets its own Telegram topic in a supergroup forum.
 *
 * Features:
 * - Question handling via inline keyboard buttons
 * - Permission handling via inline keyboard buttons
 * - Typing indicator while bot is working
 * - System message injection for critique diff URLs
 * - Thinking text in collapsible spoiler format
 */

import type { Plugin } from "@opencode-ai/plugin"
import type { Session } from "@opencode-ai/sdk"

// Event type for OpenCode events - using generic type since
// question.asked and permission.asked may not be in SDK types yet
interface OpenCodeEvent {
  type: string
  properties: Record<string, unknown>
}
import { spawn } from "node:child_process"
import { join } from "node:path"

import { TelegramClient, type CallbackQuery } from "./telegram"
import { loadConfig } from "./config"
import { createLogger, type LogFn } from "./log"
import {
  getEventsSince,
  getSessionByThread,
  getThreadBySession,
  setSessionThread,
  type TelegramEvent,
} from "./database"
import {
  showQuestionButtons,
  handleQuestionCallback,
  cancelPendingQuestion,
  type QuestionRequest,
} from "./question-handler"
import {
  showPermissionButtons,
  handlePermissionCallback,
  cancelPendingPermission,
  type PermissionRequest,
} from "./permission-handler"
import { formatPart, type Part } from "./message-formatting"
import { getSystemMessage } from "./system-message"

const POLLER_PORT = 18433

// ============================================================================
// Types
// ============================================================================

// Telegram message limits
const TELEGRAM_MAX_LENGTH = 4096
const TELEGRAM_FLUSH_THRESHOLD = Math.floor(TELEGRAM_MAX_LENGTH * 0.9) // 3686 chars

interface PluginState {
  telegram: TelegramClient
  botToken: string
  chatId: string
  log: LogFn
  botUserId: number | null
  pollerReady: boolean
  lastEventTimestamp: number

  // Track assistant message parts for sending to Telegram
  assistantMessageIds: Set<string>
  pendingParts: Map<string, Part[]> // sessionId:messageId -> parts
  pendingText: Map<string, string> // sessionId -> accumulated text awaiting flush
  sentMessages: Set<string>

  // Typing indicator per session
  typingStopFunctions: Map<string, () => void>
}

// ============================================================================
// Poller management
// ============================================================================

async function isPollerRunning(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${POLLER_PORT}/health`, {
      signal: AbortSignal.timeout(1000),
    })
    const data = (await response.json()) as { ok?: boolean; type?: string }
    return data.ok === true && data.type === "poller"
  } catch {
    return false
  }
}

async function startPoller(botToken: string, log: LogFn): Promise<boolean> {
  try {
    if (await isPollerRunning()) {
      log("info", "Poller already running")
      return true
    }

    log("info", "Starting poller process...")

    const pollerPath = join(import.meta.dir, "poller.ts")

    const child = spawn("bun", ["run", pollerPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: botToken,
      },
    })

    child.unref()
    log("info", "Poller process spawned", { pid: child.pid })

    await new Promise((resolve) => setTimeout(resolve, 1000))

    if (await isPollerRunning()) {
      log("info", "Poller started successfully")
      return true
    }

    log("error", "Poller did not start")
    return false
  } catch (error) {
    log("error", "Failed to start poller", { error: String(error) })
    return false
  }
}

// ============================================================================
// Helpers
// ============================================================================

function startTypingForSession(state: PluginState, sessionId: string): void {
  // Don't start if already typing
  if (state.typingStopFunctions.has(sessionId)) {
    return
  }

  // Find the thread for this session
  const mapping = getThreadBySession(sessionId, state.log)
  if (!mapping) {
    return
  }

  // Create a client for this specific thread
  const threadClient = new TelegramClient({
    botToken: state.botToken,
    chatId: String(mapping.chatId),
    threadId: mapping.threadId,
    log: state.log,
  })

  const stopTyping = threadClient.startTyping()
  state.typingStopFunctions.set(sessionId, stopTyping)
  state.log("debug", "Started typing indicator", { sessionId })
}

function stopTypingForSession(state: PluginState, sessionId: string): void {
  const stopFn = state.typingStopFunctions.get(sessionId)
  if (stopFn) {
    stopFn()
    state.typingStopFunctions.delete(sessionId)
    state.log("debug", "Stopped typing indicator", { sessionId })
  }
}

/**
 * Find a good point to flush text, preferring paragraph > sentence > word boundaries
 * Returns the index to split at, or 0 if no good break point found
 */
function findFlushPoint(text: string, threshold: number): number {
  // Look for a double newline (paragraph break) before the threshold
  const paragraphBreak = text.lastIndexOf("\n\n", threshold)
  if (paragraphBreak > threshold * 0.5) {
    return paragraphBreak + 2 // Include the newlines
  }

  // Look for a single newline
  const lineBreak = text.lastIndexOf("\n", threshold)
  if (lineBreak > threshold * 0.5) {
    return lineBreak + 1
  }

  // Look for sentence end (. ! ?)
  const sentenceMatch = text.slice(0, threshold).match(/[.!?]\s+/g)
  if (sentenceMatch) {
    const lastSentenceEnd = text.lastIndexOf(sentenceMatch[sentenceMatch.length - 1] ?? "", threshold)
    if (lastSentenceEnd > threshold * 0.5) {
      return lastSentenceEnd + (sentenceMatch[sentenceMatch.length - 1]?.length ?? 0)
    }
  }

  // Look for a space (word boundary)
  const spaceBreak = text.lastIndexOf(" ", threshold)
  if (spaceBreak > threshold * 0.5) {
    return spaceBreak + 1
  }

  // No good break point found, return threshold to force split
  return threshold
}

// ============================================================================
// Plugin
// ============================================================================

export const TelegramMirrorPlugin: Plugin = async (ctx) => {
  const log = createLogger()

  log("info", "Plugin initializing", { directory: ctx.directory })

  const config = await loadConfig(ctx.directory)

  if (!config.botToken || !config.chatId) {
    log("info", "Plugin disabled - missing botToken or chatId")
    return {}
  }

  const state: PluginState = {
    telegram: new TelegramClient({
      botToken: config.botToken,
      chatId: config.chatId,
      log,
    }),
    botToken: config.botToken,
    chatId: config.chatId,
    log,
    botUserId: null,
    pollerReady: false,
    lastEventTimestamp: Date.now(),
    assistantMessageIds: new Set(),
    pendingParts: new Map(),
    pendingText: new Map(),
    sentMessages: new Set(),
    typingStopFunctions: new Map(),
  }

  // Verify bot token
  const botInfo = await state.telegram.getMe()
  if (!botInfo.ok || !botInfo.result) {
    log("error", "Invalid bot token")
    return {}
  }

  state.botUserId = botInfo.result.id
  log("info", "Bot verified", { username: botInfo.result.username, id: botInfo.result.id })

  // ============================================================================
  // Telegram → OpenCode
  // ============================================================================

  const handleTelegramMessage = async (event: TelegramEvent) => {
    const update = event.data as {
      message?: {
        text?: string
        from?: { id: number; username?: string; first_name?: string }
      }
    }
    const msg = update.message
    if (!msg?.text) return
    if (msg.from?.id === state.botUserId) return
    if (event.chatId === null || event.threadId === null) return

    const sender = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name ?? "Unknown"
    log("info", "Received Telegram message", {
      sender,
      chatId: event.chatId,
      threadId: event.threadId,
      preview: msg.text.slice(0, 50),
    })

    // Cancel any pending questions/permissions for this thread
    const cancelledQuestion = cancelPendingQuestion(event.chatId, event.threadId)
    if (cancelledQuestion) {
      log("info", "Cancelled pending question due to new message", { requestId: cancelledQuestion.requestId })
      // Reply to OpenCode with cancellation
      // Note: We'd need the SDK client to call question.reply here
    }

    const cancelledPermission = cancelPendingPermission(event.chatId, event.threadId)
    if (cancelledPermission) {
      log("info", "Auto-rejected pending permission due to new message", { requestId: cancelledPermission.requestId })
      // Reply to OpenCode with rejection
      // Note: We'd need the SDK client to call permission.reply here
    }

    // Look up session by thread
    const mapping = getSessionByThread(event.chatId, event.threadId, log)

    if (mapping) {
      // Existing session for this thread
      log("info", "Found session for thread", { sessionId: mapping.sessionId, threadId: event.threadId })
      await ctx.client.session.prompt({
        path: { id: mapping.sessionId },
        body: { parts: [{ type: "text", text: msg.text }] },
      })
    } else {
      // New thread without a session - create one
      const newSession = await ctx.client.session.create({
        body: { title: `Telegram thread ${event.threadId}` },
      })
      if (newSession.data) {
        setSessionThread(newSession.data.id, event.chatId, event.threadId, newSession.data.title ?? null, log)
        log("info", "Created new session for thread", { sessionId: newSession.data.id, threadId: event.threadId })
        await ctx.client.session.prompt({
          path: { id: newSession.data.id },
          body: { parts: [{ type: "text", text: msg.text }] },
        })
      }
    }
  }

  const handleCallbackQuery = async (event: TelegramEvent) => {
    const update = event.data as { callback_query?: CallbackQuery }
    const callback = update.callback_query
    if (!callback) return

    log("info", "Received callback query", { data: callback.data })

    // Try handling as question callback
    const questionResult = await handleQuestionCallback({
      telegram: state.telegram,
      callback,
      log,
    })
    if (questionResult) {
      log("info", "Question answered", { requestId: questionResult.requestId })
      // TODO: Call ctx.client to reply to the question
      // This requires the SDK to support question.reply
      return
    }

    // Try handling as permission callback
    const permissionResult = await handlePermissionCallback({
      telegram: state.telegram,
      callback,
      log,
    })
    if (permissionResult) {
      log("info", "Permission responded", { requestId: permissionResult.requestId, reply: permissionResult.reply })
      // TODO: Call ctx.client to reply to the permission
      // This requires the SDK to support permission.reply
      return
    }
  }

  const processEvents = async () => {
    const events = getEventsSince(
      {
        sinceTimestamp: state.lastEventTimestamp,
        chatId: Number(state.chatId),
      },
      log
    )

    for (const event of events) {
      state.lastEventTimestamp = event.timestamp

      if (event.type === "message") {
        await handleTelegramMessage(event)
      } else if (event.type === "callback_query") {
        await handleCallbackQuery(event)
      }
    }
  }

  // Start poller
  startPoller(config.botToken, log).then((success) => {
    state.pollerReady = success
    if (success) {
      setInterval(() => {
        processEvents().catch((err) => log("error", "Event processing error", { error: String(err) }))
      }, 1000)
    }
  })

  // ============================================================================
  // OpenCode → Telegram
  // ============================================================================

  const sendToTelegram = async (sessionId: string, text: string) => {
    let mapping = getThreadBySession(sessionId, log)

    // Upsert: if no mapping exists, create a topic for this session
    if (!mapping) {
      log("info", "No thread mapping for session, creating topic on-demand", { sessionId })

      // Get session info for the title
      const sessionResponse = await ctx.client.session.get({ path: { id: sessionId } })
      const sessionTitle = sessionResponse.data?.title ?? `Session ${sessionId.slice(0, 8)}`

      const topic = await state.telegram.createForumTopic(state.chatId, sessionTitle)
      if (topic) {
        setSessionThread(sessionId, Number(state.chatId), topic.threadId, sessionTitle, log)
        mapping = {
          sessionId,
          chatId: Number(state.chatId),
          threadId: topic.threadId,
          sessionTitle,
          createdAt: Date.now(),
        }
        log("info", "Created topic on-demand for session", { sessionId, threadId: topic.threadId })
      } else {
        log("error", "Failed to create topic for session", { sessionId })
        return
      }
    }

    await state.telegram.sendMessageToThread(String(mapping.chatId), mapping.threadId, text)
  }

  const getThreadClientForSession = async (sessionId: string): Promise<{ telegram: TelegramClient; chatId: number; threadId: number } | null> => {
    const mapping = getThreadBySession(sessionId, log)
    if (!mapping) return null

    const threadClient = new TelegramClient({
      botToken: state.botToken,
      chatId: String(mapping.chatId),
      threadId: mapping.threadId,
      log,
    })

    return { telegram: threadClient, chatId: mapping.chatId, threadId: mapping.threadId }
  }

  return {
    // System message injection
    "experimental.chat.system.transform": async (input, output) => {
      const sessionId = input.sessionID
      const mapping = getThreadBySession(sessionId, log)

      if (mapping) {
        const systemMsg = getSystemMessage({
          sessionId,
          chatId: String(mapping.chatId),
          threadId: mapping.threadId,
        })
        output.system.push(systemMsg)
        log("debug", "Injected system message", { sessionId })
      }
    },

    event: async ({ event }) => {
      const ev = event as OpenCodeEvent
      log("debug", "Received OpenCode event", { type: ev.type })

      // Handle session status changes for typing indicator
      if (ev.type === "session.status") {
        const props = ev.properties as { sessionID: string; status: { type: string } }
        if (props.status.type === "busy") {
          startTypingForSession(state, props.sessionID)
        } else {
          stopTypingForSession(state, props.sessionID)
        }
      }

      // Handle new session creation - create a topic for it
      if (ev.type === "session.created") {
        const props = ev.properties as { info: Session }
        const sessionId = props.info.id
        const sessionTitle = props.info.title ?? `Session ${sessionId.slice(0, 8)}`

        // Check if this session already has a thread
        const existing = getThreadBySession(sessionId, log)
        if (!existing) {
          log("info", "Creating Telegram topic for new session", { sessionId, title: sessionTitle })
          const topic = await state.telegram.createForumTopic(state.chatId, sessionTitle)
          if (topic) {
            setSessionThread(sessionId, Number(state.chatId), topic.threadId, sessionTitle, log)
            log("info", "Created topic for session", { sessionId, threadId: topic.threadId })
          }
        }
      }

      // Handle question.asked events
      if (ev.type === "question.asked") {
        const props = ev.properties as QuestionRequest
        log("info", "Question requested", { requestId: props.id, questionCount: props.questions.length })

        const threadInfo = await getThreadClientForSession(props.sessionID)
        if (threadInfo) {
          await showQuestionButtons({
            telegram: threadInfo.telegram,
            chatId: threadInfo.chatId,
            threadId: threadInfo.threadId,
            sessionId: props.sessionID,
            request: props,
            log,
          })
        }
      }

      // Handle permission.asked events
      if (ev.type === "permission.asked") {
        const props = ev.properties as PermissionRequest
        log("info", "Permission requested", { requestId: props.id, permission: props.permission })

        const threadInfo = await getThreadClientForSession(props.sessionID)
        if (threadInfo) {
          await showPermissionButtons({
            telegram: threadInfo.telegram,
            chatId: threadInfo.chatId,
            threadId: threadInfo.threadId,
            sessionId: props.sessionID,
            request: props,
            log,
          })
        }
      }

      // Track assistant messages
      if (ev.type === "message.updated") {
        const props = ev.properties as {
          info: { id: string; sessionID: string; role: "user" | "assistant" }
        }
        if (props.info.role === "assistant") {
          const key = `${props.info.sessionID}:${props.info.id}`
          state.assistantMessageIds.add(key)
        }
      }

      // Accumulate parts from assistant messages
      if (ev.type === "message.part.updated") {
        const props = ev.properties as { part: Part }
        const part = props.part

        const messageKey = `${part.sessionID}:${part.messageID}`
        const isAssistant = state.assistantMessageIds.has(messageKey)

        if (isAssistant) {
          const existing = state.pendingParts.get(messageKey) ?? []
          // Update or add the part
          const partIndex = existing.findIndex((p) => p.id === part.id)
          if (partIndex >= 0) {
            existing[partIndex] = part
          } else {
            existing.push(part)
          }
          state.pendingParts.set(messageKey, existing)

          // Format and accumulate text for potential early flush
          const formattedPart = formatPart(part)
          if (formattedPart.trim()) {
            const currentText = state.pendingText.get(part.sessionID) ?? ""
            const separator = currentText ? "\n" : ""
            const newText = currentText + separator + formattedPart
            state.pendingText.set(part.sessionID, newText)

            // Check if we should flush early (approaching 4096 limit)
            if (newText.length >= TELEGRAM_FLUSH_THRESHOLD) {
              // Find a good break point (paragraph > sentence > word)
              const flushPoint = findFlushPoint(newText, TELEGRAM_FLUSH_THRESHOLD)
              if (flushPoint > 0) {
                const toFlush = newText.slice(0, flushPoint).trim()
                const remaining = newText.slice(flushPoint).trim()

                if (toFlush) {
                  log("info", "Early flush to Telegram (approaching limit)", {
                    sessionId: part.sessionID,
                    length: toFlush.length,
                    preview: toFlush.slice(0, 50),
                  })
                  await sendToTelegram(part.sessionID, toFlush)
                }

                state.pendingText.set(part.sessionID, remaining)
              }
            }
          }
        }
      }

      // Send to Telegram when session goes idle
      if (ev.type === "session.idle") {
        const props = ev.properties as { sessionID: string }

        // Stop typing
        stopTypingForSession(state, props.sessionID)

        // Flush any remaining pending text
        const pendingText = state.pendingText.get(props.sessionID)
        if (pendingText?.trim()) {
          log("info", "Sending to Telegram (session idle)", {
            sessionId: props.sessionID,
            preview: pendingText.slice(0, 100),
          })
          await sendToTelegram(props.sessionID, pendingText)
        }
        state.pendingText.delete(props.sessionID)

        // Clean up part tracking for this session
        const toDelete: string[] = []
        for (const key of state.pendingParts.keys()) {
          if (key.startsWith(`${props.sessionID}:`)) {
            state.sentMessages.add(key)
            toDelete.push(key)
          }
        }
        for (const key of toDelete) {
          state.pendingParts.delete(key)
        }
      }
    },
  }
}

export default TelegramMirrorPlugin
