/**
 * File-based logging for the Telegram plugin
 */

import { appendFile } from "node:fs/promises"

export type LogFn = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
) => void

const LOG_FILE = "/tmp/opencode-telegram.log"

export function createLogger(): LogFn {
  return (level, message, extra) => {
    const timestamp = new Date().toISOString()
    const extraStr = extra ? ` ${JSON.stringify(extra)}` : ""
    const line = `${timestamp} [${level}] ${message}${extraStr}\n`
    appendFile(LOG_FILE, line).catch(() => {})
  }
}
