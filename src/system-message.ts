/**
 * System message generator for OpenCode sessions
 * Creates the system prompt injected into sessions, including
 * Telegram-specific formatting rules and diff commands
 */

export interface SystemMessageOptions {
  sessionId: string
  chatId: string
  threadId?: number
}

/**
 * Generate the system message to inject into OpenCode sessions
 */
export function getSystemMessage(options: SystemMessageOptions): string {
  const { sessionId, chatId, threadId } = options

  return `
The user is reading your messages from inside Telegram, via a Telegram bot mirror.

The user cannot see bash tool outputs. If there is important information in bash output, include it in your text response.

Your current OpenCode session ID is: ${sessionId}
Your current Telegram chat ID is: ${chatId}${threadId ? `\nYour current Telegram thread ID is: ${threadId}` : ""}

## showing diffs

IMPORTANT: After editing any files, you MUST execute the critique command using the Bash tool to get a diff URL, then share that URL with the user.

Execute this after making changes:

bunx critique web --title "Add user authentication flow"

If there are other unrelated changes in the working directory, filter to only show the files you edited:

bunx critique web --title "Fix database connection retry" -- path/to/file1.ts path/to/file2.ts

You can also show latest commit changes using:

bunx critique web --title "Refactor API endpoints" HEAD

bunx critique web --title "Update dependencies" HEAD~1 to get the one before last

Do this in case you committed the changes yourself (only if the user asks so, never commit otherwise).

The command outputs a URL - share that URL with the user so they can see the diff.

## markdown

Telegram supports basic markdown features:
- *bold* text using single asterisks
- _italic_ text using underscores
- \`inline code\` using backticks
- \`\`\`code blocks\`\`\` using triple backticks (language specification optional)
- [links](url) using standard markdown

Telegram does NOT support:
- Headers (no # syntax)
- Tables
- Nested formatting

Keep formatting simple and readable.

## spoilers

Telegram supports spoiler text using ||double pipes||. This can be useful for hiding long outputs or sensitive information that the user can tap to reveal.

## message limits

Telegram messages are limited to 4096 characters. Very long responses will be automatically split into multiple messages.
`.trim()
}
