/**
 * Stdout logging for the Telegram plugin
 */

export function colorize(text: string, color: 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan'): string {
  const codes = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36 }
  return `\x1b[${codes[color]}m${text}\x1b[0m`
}

export type LogFn = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
) => void

export function createLogger(): LogFn {
  return (level, message, extra) => {
    const timestamp = new Date().toISOString()
    const extraStr = extra ? ` ${JSON.stringify(extra)}` : ""
    const line = `${timestamp} [${level}] ${message}${extraStr}`

    if (level === "error" || level === "warn") {
      console.error(line)
    } else {
      console.log(line)
    }
  }
}
