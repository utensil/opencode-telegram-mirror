/**
 * Plugin configuration loading
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"

export interface TelegramPluginConfig {
  botToken?: string
  chatId?: string  // Supergroup ID with topics enabled (e.g., "-1001234567890")
}

export async function loadConfig(directory: string): Promise<TelegramPluginConfig> {
  const config: TelegramPluginConfig = {}
  const homeDir = process.env.HOME || process.env.USERPROFILE || ""

  const configPaths = [
    join(homeDir, ".config", "opencode", "telegram.json"),
    join(directory, ".opencode", "telegram.json"),
  ]

  for (const configPath of configPaths) {
    try {
      const content = await readFile(configPath, "utf-8")
      const fileConfig = JSON.parse(content) as TelegramPluginConfig
      Object.assign(config, fileConfig)
    } catch {
      // Config file doesn't exist or is invalid
    }
  }

  // Environment variables override file config
  if (process.env.TELEGRAM_BOT_TOKEN) config.botToken = process.env.TELEGRAM_BOT_TOKEN
  if (process.env.TELEGRAM_CHAT_ID) config.chatId = process.env.TELEGRAM_CHAT_ID

  return config
}
