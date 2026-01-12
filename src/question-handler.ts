/**
 * Question handler for OpenCode question.asked events
 * Shows Telegram inline keyboard buttons for questions and collects responses
 */

import { TelegramClient, type CallbackQuery } from "./telegram"
import type { LogFn } from "./log"

// Question input schema matching OpenCode's question tool
export type QuestionInput = {
  questions: Array<{
    question: string
    header: string // max 12 chars
    options: Array<{
      label: string
      description: string
    }>
    multiple?: boolean
  }>
}

// Question request from OpenCode event
export type QuestionRequest = {
  id: string
  sessionID: string
  questions: QuestionInput["questions"]
}

type PendingQuestionContext = {
  sessionId: string
  requestId: string
  chatId: number
  threadId: number | null
  questions: QuestionInput["questions"]
  answers: Record<number, string[]> // questionIndex -> selected labels
  totalQuestions: number
  answeredCount: number
  messageIds: number[] // Track sent message IDs for cleanup
}

// Store pending questions by a unique key (chatId:threadId)
const pendingQuestions = new Map<string, PendingQuestionContext>()

function getThreadKey(chatId: number, threadId: number | null): string {
  return `${chatId}:${threadId ?? "main"}`
}

/**
 * Show question buttons in Telegram
 */
export async function showQuestionButtons({
  telegram,
  chatId,
  threadId,
  sessionId,
  request,
  log,
}: {
  telegram: TelegramClient
  chatId: number
  threadId: number | null
  sessionId: string
  request: QuestionRequest
  log: LogFn
}): Promise<void> {
  const threadKey = getThreadKey(chatId, threadId)

  // Cancel any existing pending question for this thread
  const existing = pendingQuestions.get(threadKey)
  if (existing) {
    log("info", "Cancelling existing pending question", { threadKey })
  }

  const context: PendingQuestionContext = {
    sessionId,
    requestId: request.id,
    chatId,
    threadId,
    questions: request.questions,
    answers: {},
    totalQuestions: request.questions.length,
    answeredCount: 0,
    messageIds: [],
  }

  pendingQuestions.set(threadKey, context)

  // Send one message per question with inline keyboard
  for (let i = 0; i < request.questions.length; i++) {
    const q = request.questions[i]
    if (!q) continue

    // Build inline keyboard - max 8 buttons per row, max 100 buttons total
    const options = [
      ...q.options.slice(0, 7).map((opt, optIdx) => ({
        label: opt.label.slice(0, 64), // Telegram button text limit
        callbackData: `q:${threadKey}:${i}:${optIdx}`,
      })),
      {
        label: "Other",
        callbackData: `q:${threadKey}:${i}:other`,
      },
    ]

    const keyboard = TelegramClient.buildInlineKeyboard(options, { columns: 2 })

    const message = await telegram.sendMessage(
      `*${q.header}*\n${q.question}`,
      { replyMarkup: keyboard }
    )

    if (message) {
      context.messageIds.push(message.message_id)
    }
  }

  log("info", "Showed question buttons", {
    threadKey,
    questionCount: request.questions.length,
  })
}

/**
 * Handle callback query from question button press
 * Returns the answer data if all questions are answered, null otherwise
 */
export async function handleQuestionCallback({
  telegram,
  callback,
  log,
}: {
  telegram: TelegramClient
  callback: CallbackQuery
  log: LogFn
}): Promise<{ requestId: string; answers: string[][] } | null> {
  const data = callback.data
  if (!data?.startsWith("q:")) {
    return null
  }

  // Parse callback data: q:chatId:threadId:questionIndex:optionIndex
  const parts = data.split(":")
  if (parts.length < 5) {
    log("warn", "Invalid question callback data", { data })
    return null
  }

  const threadKey = `${parts[1]}:${parts[2]}`
  const questionIndex = Number.parseInt(parts[3] ?? "0", 10)
  const optionValue = parts[4] ?? "0"

  const context = pendingQuestions.get(threadKey)
  if (!context) {
    await telegram.answerCallbackQuery(callback.id, {
      text: "This question has expired",
      showAlert: true,
    })
    return null
  }

  const question = context.questions[questionIndex]
  if (!question) {
    log("error", "Question index not found", { questionIndex, threadKey })
    await telegram.answerCallbackQuery(callback.id)
    return null
  }

  // Acknowledge the button press
  await telegram.answerCallbackQuery(callback.id)

  // Record the answer
  if (optionValue === "other") {
    context.answers[questionIndex] = ["Other (please type your answer)"]
  } else {
    const optIdx = Number.parseInt(optionValue, 10)
    const selectedLabel = question.options[optIdx]?.label ?? `Option ${optIdx + 1}`
    context.answers[questionIndex] = [selectedLabel]
  }

  context.answeredCount++

  // Update the message to show the selection and remove keyboard
  const messageId = context.messageIds[questionIndex]
  if (messageId) {
    const answeredText = context.answers[questionIndex]?.join(", ") ?? ""
    await telegram.editMessage(
      messageId,
      `*${question.header}*\n${question.question}\n\n_${answeredText}_`
    )
  }

  // Check if all questions are answered
  if (context.answeredCount >= context.totalQuestions) {
    // Build answers array
    const answers = context.questions.map((_, i) => context.answers[i] ?? [])

    pendingQuestions.delete(threadKey)

    log("info", "All questions answered", {
      threadKey,
      requestId: context.requestId,
    })

    return {
      requestId: context.requestId,
      answers,
    }
  }

  return null
}

/**
 * Cancel pending question for a thread (e.g., when user sends a new message)
 */
export function cancelPendingQuestion(
  chatId: number,
  threadId: number | null
): { requestId: string; answers: string[][] } | null {
  const threadKey = getThreadKey(chatId, threadId)
  const context = pendingQuestions.get(threadKey)

  if (!context) {
    return null
  }

  // Build answers with cancellation markers for unanswered questions
  const answers = context.questions.map((_, i) => {
    return context.answers[i] ?? ["(cancelled - user sent new message)"]
  })

  pendingQuestions.delete(threadKey)

  return {
    requestId: context.requestId,
    answers,
  }
}

/**
 * Check if there's a pending question for a thread
 */
export function hasPendingQuestion(chatId: number, threadId: number | null): boolean {
  return pendingQuestions.has(getThreadKey(chatId, threadId))
}
