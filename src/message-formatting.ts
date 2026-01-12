/**
 * Message formatting for OpenCode parts
 * Converts SDK message parts (text, tools, reasoning) to Telegram-friendly format
 */

// Part types from OpenCode SDK
export type Part = {
  id: string
  sessionID: string
  messageID: string
  type: string
  // Text part
  text?: string
  // Tool part
  tool?: string
  state?: {
    status: "pending" | "running" | "completed" | "error"
    input?: Record<string, unknown>
    output?: string
    title?: string
    error?: string
  }
  // Other fields
  [key: string]: unknown
}

/**
 * Escape Telegram markdown special characters
 */
function escapeMarkdown(text: string): string {
  return text.replace(/([*_`\[\]])/g, "\\$1")
}

/**
 * Get a summary line for tool execution
 */
function getToolSummary(part: Part): string {
  if (part.type !== "tool" || !part.tool) return ""

  const input = part.state?.input ?? {}

  if (part.tool === "edit") {
    const filePath = (input.filePath as string) ?? ""
    const newString = (input.newString as string) ?? ""
    const oldString = (input.oldString as string) ?? ""
    const added = newString.split("\n").length
    const removed = oldString.split("\n").length
    const fileName = filePath.split("/").pop() ?? ""
    return fileName ? `_${escapeMarkdown(fileName)}_ (+${added}-${removed})` : `(+${added}-${removed})`
  }

  if (part.tool === "write") {
    const filePath = (input.filePath as string) ?? ""
    const content = (input.content as string) ?? ""
    const lines = content.split("\n").length
    const fileName = filePath.split("/").pop() ?? ""
    const lineWord = lines === 1 ? "line" : "lines"
    return fileName ? `_${escapeMarkdown(fileName)}_ (${lines} ${lineWord})` : `(${lines} ${lineWord})`
  }

  if (part.tool === "webfetch") {
    const url = (input.url as string) ?? ""
    const urlWithoutProtocol = url.replace(/^https?:\/\//, "")
    return urlWithoutProtocol ? `_${escapeMarkdown(urlWithoutProtocol)}_` : ""
  }

  if (part.tool === "read") {
    const filePath = (input.filePath as string) ?? ""
    const fileName = filePath.split("/").pop() ?? ""
    return fileName ? `_${escapeMarkdown(fileName)}_` : ""
  }

  if (part.tool === "glob") {
    const pattern = (input.pattern as string) ?? ""
    return pattern ? `_${escapeMarkdown(pattern)}_` : ""
  }

  if (part.tool === "grep") {
    const pattern = (input.pattern as string) ?? ""
    return pattern ? `_${escapeMarkdown(pattern)}_` : ""
  }

  if (part.tool === "bash") {
    const command = (input.command as string) ?? ""
    const description = (input.description as string) ?? ""
    const isSingleLine = !command.includes("\n")
    if (isSingleLine && command.length <= 50) {
      return `_${escapeMarkdown(command)}_`
    }
    if (description) {
      return `_${escapeMarkdown(description)}_`
    }
    return ""
  }

  if (part.tool === "task") {
    const description = (input.description as string) ?? ""
    return description ? `_${escapeMarkdown(description)}_` : ""
  }

  return ""
}

/**
 * Format todo list from todowrite tool
 */
function formatTodoList(part: Part): string {
  if (part.type !== "tool" || part.tool !== "todowrite") return ""

  const todos = (part.state?.input?.todos as Array<{
    content: string
    status: "pending" | "in_progress" | "completed" | "cancelled"
  }>) ?? []

  const activeIndex = todos.findIndex((todo) => todo.status === "in_progress")
  const activeTodo = todos[activeIndex]

  if (activeIndex === -1 || !activeTodo) return ""

  // Use circled numbers for task index
  const circledDigits = ["1.", "2.", "3.", "4.", "5.", "6.", "7.", "8.", "9.", "10."]
  const num = circledDigits[activeIndex] ?? `${activeIndex + 1}.`
  const content = activeTodo.content.charAt(0).toLowerCase() + activeTodo.content.slice(1)

  return `${num} *${escapeMarkdown(content)}*`
}

/**
 * Format a single part for Telegram display
 */
export function formatPart(part: Part): string {
  if (part.type === "text") {
    if (!part.text?.trim()) return ""
    return part.text
  }

  if (part.type === "reasoning") {
    if (!part.text?.trim()) return ""
    // Hybrid approach: show "thinking..." with spoiler containing first 200 chars
    const preview = part.text.slice(0, 200)
    const truncated = part.text.length > 200 ? `${preview}...` : preview
    return `thinking... ||${truncated}||`
  }

  if (part.type === "file") {
    const filename = (part.filename as string) ?? "File"
    return `[file] ${filename}`
  }

  if (part.type === "step-start" || part.type === "step-finish" || part.type === "patch") {
    return ""
  }

  if (part.type === "agent") {
    return `[agent] ${part.id}`
  }

  if (part.type === "tool") {
    // Question tool is handled via buttons, not text
    if (part.tool === "question") {
      return ""
    }

    if (part.tool === "todowrite") {
      return formatTodoList(part)
    }

    if (part.tool === "todoread") {
      return ""
    }

    if (part.state?.status === "pending") {
      return ""
    }

    const summary = getToolSummary(part)
    const stateTitle = part.state?.title

    let toolTitle = ""
    if (part.state?.status === "error") {
      toolTitle = part.state.error ?? "error"
    } else if (stateTitle) {
      toolTitle = `_${escapeMarkdown(stateTitle)}_`
    }

    // Choose icon based on tool type and status
    const icon = (() => {
      if (part.state?.status === "error") return "X"
      if (part.tool === "edit" || part.tool === "write") return "[edit]"
      return "[tool]"
    })()

    const parts = [icon, part.tool, toolTitle, summary].filter(Boolean)
    return parts.join(" ")
  }

  return ""
}

/**
 * Format multiple parts into a single message
 */
export function formatParts(parts: Part[]): string {
  const formatted = parts
    .map((p) => formatPart(p))
    .filter((text) => text.trim().length > 0)

  return formatted.join("\n")
}

/**
 * Collect text from assistant message parts
 */
export function collectAssistantText(parts: Part[]): string {
  const textParts: string[] = []

  for (const part of parts) {
    if (part.type === "text" && part.text?.trim()) {
      textParts.push(part.text)
    }
  }

  return textParts.join("\n\n")
}
