#!/usr/bin/env bun
/**
 * OpenCode Telegram Mirror
 *
 * Polls for Telegram updates from a Cloudflare Durable Object endpoint,
 * runs opencode serve, and sends responses back.
 *
 * Usage: bun run src/main.ts [directory] [session-id]
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN   - Bot token for sending messages
 *   TELEGRAM_CHAT_ID     - Chat ID to operate in
 *   TELEGRAM_UPDATES_URL - URL to poll for updates (CF DO endpoint)
 */

import {
	startServer,
	connectToServer,
	stopServer,
	getServer,
	setOnOpencodeRestart,
	setOnOpencodeStderr,
	type OpenCodeServer,
} from "./opencode"
import { TelegramClient, type TelegramVoice } from "./telegram"
import { loadConfig } from "./config"
import { createLogger, colorize } from "./log"
import {
	getSessionId,
	setSessionId,
	getLastUpdateId,
	setLastUpdateId,
} from "./database"
import { formatPart, type Part } from "./message-formatting"
import {
	showQuestionButtons,
	handleQuestionCallback,
	handleFreetextAnswer,
	isAwaitingFreetext,
	cancelPendingQuestion,
	type QuestionRequest,
} from "./question-handler"
import {
	showPermissionButtons,
	handlePermissionCallback,
	cancelPendingPermission,
	type PermissionRequest,
} from "./permission-handler"
import {
	uploadDiff,
	createDiffFromEdit,
	generateInlineDiffPreview,
} from "./diff-service"
import {
	isVoiceTranscriptionAvailable,
	transcribeVoice,
	getVoiceNotSupportedMessage,
} from "./voice"
import * as ICloudCoordination from "./icloud-integration"
import { execSync } from "node:child_process"
import * as yaml from "yaml"

const log = createLogger()

/**
 * Get current commit information using jj
 */
function getCurrentCommitInfo(): string {
	try {
		const output = execSync(
			'jj log -r @- -T \'committer.timestamp() ++ " " ++ change_id.short() ++ " " ++ commit_id.short() ++ " " ++ local_bookmarks ++ " " ++ description\'',
			{ encoding: 'utf8', cwd: process.cwd() }
		).trim()
		// Remove the first line which contains the commit symbol and formatting
		const lines = output.split('\n')
		return lines[0].replace(/^◆\s+/, '')
	} catch (error) {
		log("warn", "Failed to get commit info", { error: String(error) })
		return "commit info unavailable"
	}
}

/**
 * Update the pinned status message with a new state
 * Format: -----\n**Task**: taskName\nstate\n-----
 */
async function updateStatusMessage(
  telegram: TelegramClient,
  state: string
): Promise<void> {
  const statusMessageId = process.env.STATUS_MESSAGE_ID
  const taskDescription = process.env.TASK_DESCRIPTION
  const branchName = process.env.BRANCH_NAME

  if (!statusMessageId) {
    log("debug", "No STATUS_MESSAGE_ID, skipping status update")
    return
  }

  const taskName = taskDescription || branchName || "sandbox"
  const text = `-----\n**Task**: ${taskName}\n${state}\n-----`

  const messageId = Number.parseInt(statusMessageId, 10)
  const editResult = await telegram.editMessage(messageId, text)
  const success = editResult.status === "ok" && editResult.value
  log("debug", "Status message update", { messageId, state, success })
}

/**
 * Generate a session title using OpenCode with a lightweight model.
 * Returns { type: "title", value: string } if successful,
 * or { type: "unknown", value: string } if more context is needed.
 */
type TitleResult =
  | { type: "unknown"; value: string }
  | { type: "title"; value: string }

async function generateSessionTitle(
  server: OpenCodeServer,
  userMessage: string
): Promise<TitleResult> {
  const tempSession = await server.client.session.create({ title: "title-gen" })

  if (!tempSession.data) {
    return { type: "unknown", value: "failed to create temp session" }
  }

  try {
    const response = await server.client.session.prompt({
      sessionID: tempSession.data.id,
      model: { providerID: "opencode", modelID: "glm-4.7-free" },
      system: `You generate short titles for coding sessions based on user messages.

If the message provides enough context to understand the task, respond with:
{"type":"title","value":"<title here>"}

If the message is just a branch name, file path, or lacks context to understand what the user wants to do, respond with:
{"type":"unknown","value":"<brief reason>"}

Title rules (when generating):
- max 50 characters
- summarize the user's intent
- one line, no quotes or colons
- if a Linear ticket ID exists in the message (e.g. APP-550, ENG-123), always prefix the title with it

Examples:
- "feat/add-login" -> {"type":"unknown","value":"branch name only, need task description"}
- "fix the auth bug in login.ts" -> {"type":"title","value":"Fix auth bug in login"}
- "src/components/Button.tsx" -> {"type":"unknown","value":"file path only, need task description"}
- "add dark mode toggle to settings" -> {"type":"title","value":"Add dark mode toggle to settings"}
- "APP-550: fix auth bug" -> {"type":"title","value":"APP-550: Fix auth bug"}
- "feat/APP-123-add-user-profile" -> {"type":"unknown","value":"branch name only, need task description"}
- "working on APP-123 to add user profiles" -> {"type":"title","value":"APP-123: Add user profiles"}
- "https://linear.app/team/issue/ENG-456/fix-button" -> {"type":"title","value":"ENG-456: Fix button"}

Respond with only valid JSON, nothing else.`,
      parts: [{ type: "text", text: userMessage }],
    })

    const textPart = response.data?.parts?.find(
      (p: { type: string }) => p.type === "text"
    ) as { type: "text"; text: string } | undefined
    const text = textPart?.text?.trim() || ""

    try {
      return JSON.parse(text) as TitleResult
    } catch {
      // If LLM didn't return valid JSON, treat response as title
      return { type: "title", value: text.slice(0, 50) }
    }
  } finally {
    await server.client.session.delete({ sessionID: tempSession.data.id })
  }
}

interface BotState {
	server: OpenCodeServer;
	telegram: TelegramClient;
	botToken: string;
	directory: string;
	chatId: string;
	threadId: number | null;
	threadTitle: string | null;
	updatesUrl: string | null;
	botUserId: number | null;
	sessionId: string | null;
	needsTitle: boolean;

	// iCloud device coordination
	deviceId: string;
	useICloudCoordination: boolean;
	becameActiveAt: number | null; // Timestamp when device became active

	assistantMessageIds: Set<string>;
	bufferedParts: Map<string, Part[]>; // Buffer parts until message is registered
	pendingParts: Map<string, Part[]>;
	sentPartIds: Set<string>;
	reasoningMessages?: Map<string, { messageId: number; content: string; lastUpdate: number; timeoutId?: NodeJS.Timeout }>;
	textMessages?: Map<string, { messageId: number; content: string; lastUpdate: number; timeoutId?: NodeJS.Timeout; usedMarkdown?: boolean }>;
	typingIndicators: Map<
		string,
		{ stop: () => void; timeout: ReturnType<typeof setTimeout> | null; mode: "idle" | "tool" }
	>;
	runningBashProcesses: Map<number, { process: any; command: string; startTime: number }>; // Track multiple bash processes by PID
	selectedModel?: { providerID: string; modelID: string }; // Per-session model selection
}

async function main() {
	const path = await import("node:path")
	const directory = path.resolve(process.argv[2] || process.cwd())
	const sessionIdArg = process.argv[3]

	log("info", "=== Telegram Mirror Bot Starting ===")
	log("info", "Startup parameters", {
		directory,
		sessionIdArg: sessionIdArg || "(none)",
		nodeVersion: process.version,
		platform: process.platform,
		pid: process.pid,
	})

	log("info", "Loading configuration...")
	const configResult = await loadConfig(directory, log)
	if (configResult.status === "error") {
		log("error", "Configuration load failed", {
			error: configResult.error.message,
			path: configResult.error.path,
		})
		console.error("Failed to load Telegram config")
		process.exit(1)
	}

	const config = configResult.value

	log("info", "Configuration loaded", {
		hasBotToken: !!config.botToken,
		chatId: config.chatId || "(not set)",
		threadId: config.threadId ?? "(none)",
		hasUpdatesUrl: !!config.updatesUrl,
		hasSendUrl: !!config.sendUrl,
	})

	if (!config.botToken || !config.chatId) {
		log("error", "Missing required configuration", {
			hasBotToken: !!config.botToken,
			hasChatId: !!config.chatId,
		})
		console.error("Missing botToken or chatId in config")
		console.error(
			"Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID environment variables"
		)
		process.exit(1)
	}

	// Connect to OpenCode server (external URL or start our own)
	const openCodeUrl = process.env.OPENCODE_URL
	let server: OpenCodeServer

	if (openCodeUrl) {
		log("info", "Connecting to external OpenCode server...", {
			url: openCodeUrl,
		})
		const serverResult = await connectToServer(openCodeUrl, directory)
		if (serverResult.status === "error") {
			log("error", "Failed to connect to OpenCode server", {
				error: serverResult.error.message,
			})
			console.error("Failed to connect to OpenCode server")
			process.exit(1)
		}
		server = serverResult.value
		log("info", "Connected to OpenCode server", {
			baseUrl: server.baseUrl,
			directory,
		})

		// Fetch server config
		try {
			const configResponse = await fetch(`${server.baseUrl}/config`)
			if (configResponse.ok) {
				const serverConfig = await configResponse.json()
				log("info", "OpenCode server config:\n" + yaml.stringify(serverConfig))
			} else {
				log("warn", "Failed to fetch server config", { 
					status: configResponse.status,
					statusText: configResponse.statusText 
				})
			}
		} catch (error) {
			log("warn", "Error fetching server config", { error: String(error) })
		}
	} else {
		log("info", "Starting OpenCode server...")
		const serverResult = await startServer(directory)
		if (serverResult.status === "error") {
			log("error", "Failed to start OpenCode server", {
				error: serverResult.error.message,
			})
			console.error("Failed to start OpenCode server")
			process.exit(1)
		}
		server = serverResult.value
		log("info", "OpenCode server started", {
			port: server.port,
			baseUrl: server.baseUrl,
			directory,
		})

		// Fetch providers config
		try {
			const configResponse = await fetch(`${server.baseUrl}/config`)
			if (configResponse.ok) {
				const serverConfig = await configResponse.json()
				log("info", "OpenCode server config:\n" + yaml.stringify(serverConfig))
			} else {
				log("warn", "Failed to fetch server config", { 
					status: configResponse.status,
					statusText: configResponse.statusText 
				})
			}
		} catch (error) {
			log("warn", "Error fetching server config", { error: String(error) })
		}
	}

	// Initialize Telegram client for sending messages
	const telegram = new TelegramClient({
		botToken: config.botToken,
		chatId: config.chatId,
		threadId: config.threadId,
		log,
		baseUrl: config.sendUrl,
	})

	// Verify bot
	log("info", "Verifying bot token...")
	const botInfoResult = await telegram.getMe()
	if (botInfoResult.status === "error") {
		log("error", "Bot verification failed - invalid token", {
			error: botInfoResult.error.message,
		})
		console.error("Invalid bot token")
		process.exit(1)
	}
	const botInfo = botInfoResult.value
	log("info", "Bot verified successfully", {
		username: botInfo.username,
		botId: botInfo.id,
	})

	const commandsResult = await telegram.setMyCommands([
		{ command: "interrupt", description: "Stop operation or kill bash PID" },
		{ command: "plan", description: "Switch to plan mode" },
		{ command: "build", description: "Switch to build mode" },
		{ command: "review", description: "Review changes [commit|branch|pr]" },
		{ command: "rename", description: "Rename the session" },
		{ command: "model", description: "Set AI model (provider/model)" },
		{ command: "cap", description: "Capture bash command output" },
		{ command: "ps", description: "Show running bash processes" },
		{ command: "version", description: "Show mirror bot version" },
		{ command: "dev", description: "List all devices" },
		{ command: "use", description: "Activate device by number" },
		{ command: "restart", description: "Restart the active bot safely" },
		{ command: "start", description: "Start a new mirror instance" },
		{ command: "stop", description: "Stop a device by number or name" },
	])
	if (commandsResult.status === "error") {
		log("warn", "Failed to set bot commands", { error: commandsResult.error.message })
	}

	// Initialize device coordination
	log("info", "Initializing device coordination...")
	const coordination = await ICloudCoordination.initializeCoordination(
		directory,
		config.threadId ?? null,
		log
	)

	log("info", "Device coordination initialized", {
		deviceId: coordination.deviceId,
		useICloud: coordination.useICloud,
		mode: coordination.useICloud ? "iCloud shared state" : "local database",
	})

	// Set up OpenCode restart notification
	setOnOpencodeRestart((message: string) => {
		telegram.sendMessage(message).catch((err) => {
			log("error", "Failed to send OpenCode restart notification", { error: String(err) })
		})
	})

	// Set up OpenCode stderr forwarding
	setOnOpencodeStderr((message: string) => {
		telegram.sendMessage(`🔴 OpenCode Error:\n\`\`\`\n${message.replace('OpenCode stderr: ', '')}\n\`\`\``).catch((err) => {
			log("error", "Failed to send OpenCode stderr message", { error: String(err) })
		})
	})

	// Determine session ID
	log("info", "Checking for existing session...")
	let sessionId: string | null = sessionIdArg || getSessionId(log)

	let initialThreadTitle: string | null = null
	if (sessionId) {
		log("info", "Found existing session ID, validating...", { sessionId })
		const sessionCheck = await server.client.session.get({
			sessionID: sessionId,
		})
		if (!sessionCheck.data) {
			log("warn", "Stored session not found on server, will create new", {
				oldSessionId: sessionId,
			})
			sessionId = null
		} else {
			log("info", "Session validated successfully", { sessionId })
			initialThreadTitle = sessionCheck.data.title || null
		}
	} else {
		log("info", "No existing session found, will create on first message")
	}

	const state: BotState = {
		server,
		telegram,
		botToken: config.botToken,
		directory,
		chatId: config.chatId,
		threadId: config.threadId ?? null,
		threadTitle: initialThreadTitle,
		updatesUrl: config.updatesUrl || null,
		botUserId: botInfo.id,
		sessionId,
		needsTitle: !initialThreadTitle,
		deviceId: coordination.deviceId,
		useICloudCoordination: coordination.useICloud,
		becameActiveAt: null,
		assistantMessageIds: new Set(),
		pendingParts: new Map(),
		sentPartIds: new Set(),
		typingIndicators: new Map(),
		runningBashProcesses: new Map(),
		selectedModel: undefined,
	}

	if (initialThreadTitle && config.threadId) {
		const renameResult = await telegram.editForumTopic(config.threadId, initialThreadTitle)
		if (renameResult.status === "ok") {
			log("info", "Synced thread title from session", { title: initialThreadTitle })
		} else {
			log("warn", "Failed to sync thread title", { error: renameResult.error.message })
		}
	}

	log("info", "Bot state initialized", {
		directory: state.directory,
		chatId: state.chatId,
		threadId: state.threadId ?? "(none)",
		threadTitle: state.threadTitle ?? "(unknown)",
		sessionId: state.sessionId || "(pending)",
		pollSource: state.updatesUrl ? "Cloudflare DO" : "Telegram API",
	})

	log("info", "Starting updates poller...")
	startUpdatesPoller(state)

	// Subscribe to OpenCode events
	log("info", "Starting event subscription...")
	subscribeToEvents(state)

	process.on("SIGINT", async () => {
		log("info", "Received SIGINT, shutting down gracefully...")
		const stopResult = await stopServer()
		if (stopResult.status === "error") {
			log("error", "Shutdown failed", { error: stopResult.error.message })
		}
		log("info", "Shutdown complete")
		process.exit(0)
	})

	process.on("SIGTERM", async () => {
		log("info", "Received SIGTERM, shutting down gracefully...")
		const stopResult = await stopServer()
		if (stopResult.status === "error") {
			log("error", "Shutdown failed", { error: stopResult.error.message })
		}
		log("info", "Shutdown complete")
		process.exit(0)
	})

	log("info", "=== Bot Startup Complete ===")
	log("info", "Bot is running", {
		sessionId: state.sessionId || "(will create on first message)",
		pollSource: state.updatesUrl ? "Cloudflare DO" : "Telegram API",
		updatesUrl: state.updatesUrl || "(using Telegram API)",
	})

	// Signal the worker that we're ready - it will update the status message with tunnel URL
	const workerWsUrl = process.env.WORKER_WS_URL
	if (workerWsUrl && state.chatId && state.threadId) {
		const workerBaseUrl = workerWsUrl
			.replace("wss://", "https://")
			.replace("ws://", "http://")
			.replace(/\/ws$/, "")
			.replace(/\/sandbox-ws$/, "")

		const readyUrl = `${workerBaseUrl}/session-ready`
		log("info", "Signaling worker that mirror is ready", { readyUrl })

		try {
			const response = await fetch(readyUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chatId: state.chatId,
					threadId: state.threadId,
				}),
			})
			log("info", "Worker ready signal response", {
				status: response.status,
				ok: response.ok,
			})
		} catch (error) {
			log("error", "Failed to signal worker", { error: String(error) })
		}
	}

	// Send initial prompt to OpenCode if context was provided
	const initialContext = process.env.INITIAL_CONTEXT
	const taskDescription = process.env.TASK_DESCRIPTION
	const branchName = process.env.BRANCH_NAME

	if (initialContext || taskDescription) {
		log("info", "Sending initial context to OpenCode", {
			hasContext: !!initialContext,
			hasTask: !!taskDescription,
			branchName,
		})

		// Build the instruction prompt
		let prompt = `You are now connected to a Telegram thread for branch "${branchName || "unknown"}".\n\n`

		if (initialContext) {
			prompt += `## Task Context\n${initialContext}\n\n`
		}

		if (taskDescription && !initialContext) {
			prompt += `## Task\n${taskDescription}\n\n`
		}

		prompt += `Read any context/description (if present). Then:
1. If a clear task or action is provided, ask any clarifying questions you need before implementing.
2. If no clear action/context is provided, ask how to proceed.

Do not start implementing until you have clarity on what needs to be done.`

		try {
			const sessionResult = await state.server.client.session.create({
				title: `Telegram: ${branchName || "session"}`,
			})

			if (sessionResult.data?.id) {
				state.sessionId = sessionResult.data.id
				state.needsTitle = true
				setSessionId(sessionResult.data.id, log)
				log("info", "Created OpenCode session", { sessionId: state.sessionId })

				await state.server.client.session.prompt({
					sessionID: state.sessionId,
					parts: [{ type: "text", text: prompt }],
					...(state.selectedModel && { model: state.selectedModel })
				})
				log("info", "Sent initial prompt to OpenCode")
			}
		} catch (error) {
			log("error", "Failed to send initial context to OpenCode", {
				error: String(error),
			})
		}
	}
}

// =============================================================================
// Updates Polling (from CF DO or Telegram directly)
// =============================================================================

interface TelegramUpdate {
	update_id: number
	message?: {
		message_id: number
		message_thread_id?: number
		date?: number
		text?: string
		caption?: string
		photo?: Array<{
			file_id: string
			file_unique_id: string
			width: number
			height: number
		}>
		voice?: {
			file_id: string
			file_unique_id: string
			duration: number
			mime_type?: string
			file_size?: number
		}
		video?: {
			file_id: string
			file_unique_id: string
			duration: number
		}
		video_note?: {
			file_id: string
			file_unique_id: string
			duration: number
		}
		from?: { id: number; username?: string }
		chat: { id: number }
	}
	callback_query?: import("./telegram").CallbackQuery
}

async function startUpdatesPoller(state: BotState) {
	const pollSource = state.updatesUrl ? "Cloudflare DO" : "Telegram API"

	// Only process messages after startup time to avoid replaying history
	const startupTimestamp = process.env.STARTUP_TIMESTAMP
		? Number.parseInt(process.env.STARTUP_TIMESTAMP, 10)
		: Math.floor(Date.now() / 1000)

	log("info", "Updates poller started", {
		source: pollSource,
		chatId: state.chatId,
		threadId: state.threadId ?? "(none)",
		deviceId: state.deviceId,
		useICloudCoordination: state.useICloudCoordination,
		startupTimestamp,
		startupTime: new Date(startupTimestamp * 1000).toISOString(),
	})

	let pollCount = 0
	let totalUpdatesProcessed = 0

	// Initialize heartbeat timers with randomized intervals
	let nextDeviceHeartbeat = Date.now() + 
		ICloudCoordination.getRandomizedStandbyHeartbeatInterval()
	
	let nextActiveHeartbeat = Date.now() + 
		ICloudCoordination.getRandomizedActiveHeartbeatInterval()
	
	// Initialize cleanup timer (every 24 hours)
	const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
	let nextCleanup: number | null = null
	
	let wasActive = false

		while (true) {
			try {
				pollCount++
				const now = Date.now()
				
				// Initialize cleanup timer on first iteration
				if (nextCleanup === null) {
					nextCleanup = now + CLEANUP_INTERVAL_MS
				}

			// ═══════════════════════════════════════════════════════════
			// Check if this device should be active (includes failover)
			// ═══════════════════════════════════════════════════════════
			
			const isActive = await ICloudCoordination.checkIfActiveWithFailover(
				state.deviceId,
				state.useICloudCoordination,
				log
			)

			// ═══════════════════════════════════════════════════════════
			// Detect state transitions and reset timers
			// ═══════════════════════════════════════════════════════════
			
			if (isActive && !wasActive) {
				// Just became active - reset to FAST heartbeat
				log("info", colorize("🟢 Device became active, switching to fast heartbeat", "green"), {
					deviceId: state.deviceId,
				})
				state.becameActiveAt = now
				nextDeviceHeartbeat = now + 
					ICloudCoordination.getRandomizedActiveHeartbeatInterval()
				nextActiveHeartbeat = now + 
					ICloudCoordination.getRandomizedActiveHeartbeatInterval()
				
				// Notify Telegram that this device is now active
				const commitInfo = getCurrentCommitInfo()
				await state.telegram.sendMessage(`✅ Device "${state.deviceId}" is now ACTIVE and ready! On the following commit:

${commitInfo}`)
			} else if (!isActive && wasActive) {
				// Just became standby - reset to SLOW heartbeat
				log("info", "🔴 Device became standby, switching to slow heartbeat", {
					deviceId: state.deviceId,
				})
				nextDeviceHeartbeat = now + 
					ICloudCoordination.getRandomizedStandbyHeartbeatInterval()
			}
			wasActive = isActive

			// ═══════════════════════════════════════════════════════════
			// Send heartbeats based on state
			// ═══════════════════════════════════════════════════════════
			
			if (isActive) {
				// ACTIVE DEVICE: Fast heartbeats (30-40s)
				
				// Device heartbeat (devices/<id>.json)
				if (now >= nextDeviceHeartbeat) {
					await ICloudCoordination.sendDeviceHeartbeat(
						state.deviceId,
						state.useICloudCoordination,
						log
					)
					nextDeviceHeartbeat = now + 
						ICloudCoordination.getRandomizedActiveHeartbeatInterval()
					
					log("debug", "Active device heartbeat sent", {
						nextIn: Math.round((nextDeviceHeartbeat - now) / 1000) + "s",
					})
				}
				
				// Active heartbeat (state.json)
				if (now >= nextActiveHeartbeat) {
					await ICloudCoordination.sendActiveHeartbeat(
						state.deviceId,
						state.useICloudCoordination,
						log
					)
					nextActiveHeartbeat = now + 
						ICloudCoordination.getRandomizedActiveHeartbeatInterval()
					
					log("debug", "Active state heartbeat sent", {
						nextIn: Math.round((nextActiveHeartbeat - now) / 1000) + "s",
					})
				}
				
				// Cleanup stale devices (every 24 hours)
				if (now >= nextCleanup) {
					const cleanupResult = await ICloudCoordination.cleanupStaleDevices(log)
					if (cleanupResult.status === "ok" && cleanupResult.value > 0) {
						log("info", "Cleaned up stale devices", { count: cleanupResult.value })
					}
					nextCleanup = now + CLEANUP_INTERVAL_MS
				}
			} else {
				// STANDBY DEVICE: Slow heartbeats (5-6 min)
				
				// Device heartbeat (devices/<id>.json) - INFREQUENT
				if (now >= nextDeviceHeartbeat) {
					await ICloudCoordination.sendDeviceHeartbeat(
						state.deviceId,
						state.useICloudCoordination,
						log
					)
					nextDeviceHeartbeat = now + 
						ICloudCoordination.getRandomizedStandbyHeartbeatInterval()
					
					log("debug", "Standby device heartbeat sent", {
						nextIn: Math.round((nextDeviceHeartbeat - now) / 1000) + "s",
					})
				}
				
				// Standby: Sleep for CHECK interval (30-40s) - FREQUENT
				const sleepMs = ICloudCoordination.getRandomizedCheckInterval()
				
				log("debug", "Standby mode, checking again soon", {
					deviceId: state.deviceId,
					pollCount,
					nextCheckIn: Math.round(sleepMs / 1000) + "s",
				})
				
				await Bun.sleep(sleepMs)
				continue
			}

			// ═══════════════════════════════════════════════════════════
			// ACTIVE MODE: Poll Telegram and process messages
			// ═══════════════════════════════════════════════════════════

			const pollStart = Date.now()

			let updates = state.updatesUrl
				? await pollFromDO(state)
				: await pollFromTelegram(state)

			const pollDuration = Date.now() - pollStart

			// Filter out messages from before startup (they're included in initial context)
			// For callback_query updates, use the embedded message date
			const beforeFilter = updates.length
			updates = updates.filter((u) => {
				const messageDate =
					u.message?.date ?? u.callback_query?.message?.date ?? 0
				return messageDate >= startupTimestamp
			})

			if (beforeFilter > updates.length) {
				log("debug", "Filtered old messages", {
					before: beforeFilter,
					after: updates.length,
					startupTimestamp,
				})
			}

			if (updates.length > 0) {
				totalUpdatesProcessed += updates.length
				log("info", "📨 Received updates", {
					count: updates.length,
					totalProcessed: totalUpdatesProcessed,
					pollDuration: `${pollDuration}ms`,
					updateIds: updates.map((u) => u.update_id),
				})
			} else if (state.updatesUrl) {
				// Add delay between polls when using DO (no long-polling)
				await Bun.sleep(1000)
			}

			for (const update of updates) {
				try {
					const updateType = update.message
						? "message"
						: update.callback_query
							? "callback_query"
							: "unknown"
					log("debug", "Processing update", {
						updateId: update.update_id,
						type: updateType,
						raw: JSON.stringify(update),
					})

					if (update.message) {
						await handleTelegramMessage(state, update.message)
					} else if (update.callback_query) {
						await handleTelegramCallback(state, update.callback_query)
					}

					log("debug", "Update processed successfully", {
						updateId: update.update_id,
					})
				} catch (err) {
					log("error", "Error processing update", {
						updateId: update.update_id,
						error: String(err),
					})
				}
			}
			
			// Active device polls frequently
			await Bun.sleep(1000)
			
		} catch (error) {
			log("error", "Poll error, retrying in 5s", {
				pollNumber: pollCount,
				error: String(error),
			})
			await Bun.sleep(5000)
		}
	}
}

async function pollFromDO(state: BotState): Promise<TelegramUpdate[]> {
	if (!state.updatesUrl) return []

	const since = getLastUpdateId(log)
	const parsed = new URL(state.updatesUrl)
	parsed.searchParams.set("since", String(since))
	parsed.searchParams.set("chat_id", state.chatId)
	if (state.threadId !== null) {
		parsed.searchParams.set("thread_id", String(state.threadId))
	}

	const headers: Record<string, string> = {}

	if (parsed.username || parsed.password) {
		const credentials = btoa(`${parsed.username}:${parsed.password}`)
		headers.Authorization = `Basic ${credentials}`
		parsed.username = ""
		parsed.password = ""
	}

	const response = await fetch(parsed.toString(), { headers })

	if (!response.ok) {
		log("error", "DO poll failed", {
			status: response.status,
			statusText: response.statusText,
		})
		throw new Error(`DO poll failed: ${response.status}`)
	}

	const data = (await response.json()) as {
		updates?: Array<{ payload: TelegramUpdate; update_id: number }>
	}
	// DO wraps Telegram updates in { payload: {...}, update_id, chat_id, received_at }
	// Extract the actual Telegram update from payload
	const allUpdates = (data.updates ?? []).map(
		(u) => u.payload ?? u
	) as TelegramUpdate[]
	
	// Filter to our chat and track foreign chats
	const updates: TelegramUpdate[] = []
	const foreignChatIds: Set<number> = new Set()
	
	for (const update of allUpdates) {
		const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id
		if (String(chatId) === state.chatId) {
			updates.push(update)
		} else if (chatId) {
			foreignChatIds.add(chatId)
		}
	}
	
	// Handle foreign chat attempts
	if (foreignChatIds.size > 0 && state.useICloudCoordination) {
		let newForeignAdded = false
		
		for (const chatId of foreignChatIds) {
			log("warn", "Ignoring message from foreign chat", {
				foreignChatId: chatId,
				expectedChatId: state.chatId,
			})
			const addResult = await ICloudCoordination.addForeignChatId(chatId, log)
			if (addResult.status === "ok" && addResult.value === true) {
				newForeignAdded = true
			}
		}
		
		// Only send warning when NEW foreign chat IDs are detected
		if (newForeignAdded) {
			const allForeignResult = await ICloudCoordination.getForeignChatIds(log)
			if (allForeignResult.status === "ok") {
				const allForeign = allForeignResult.value
				const total = allForeign.length
				// Show last 5 (most recent) foreign chat IDs
				const recent = allForeign.slice(-5)
				const foreignList = recent.map(id => `• ${id}`).join("\n")
				await state.telegram.sendMessage(
					`⚠️ Warning: This bot received messages from ${total} foreign chat ID(s).\n\n` +
					`Last 5:\n${foreignList}\n\n` +
					`This bot only responds to configured chat (ID: ${state.chatId}).`
				)
			}
		}
	}

	if (updates.length > 0) {
		const lastUpdate = updates[updates.length - 1]
		log("info", "DO poll returned updates", {
			previousId: since,
			newId: lastUpdate.update_id,
			updateCount: updates.length,
			threadIds: updates.map((u) => u.message?.message_thread_id ?? "none"),
		})
		setLastUpdateId(lastUpdate.update_id, log)
	}

	return updates
}

async function pollFromTelegram(state: BotState): Promise<TelegramUpdate[]> {
	const lastUpdateId = getLastUpdateId(log)
	const baseUrl = `https://api.telegram.org/bot${state.botToken}`

	const params = new URLSearchParams({
		offset: String(lastUpdateId + 1),
		timeout: "30",
		allowed_updates: JSON.stringify(["message", "callback_query"]),
	})

	const response = await fetch(`${baseUrl}/getUpdates?${params}`)
	const data = (await response.json()) as {
		ok: boolean
		result?: TelegramUpdate[]
	}

	if (!data.ok || !data.result) {
		return []
	}

	// Filter to our chat and update last ID
	const updates: TelegramUpdate[] = []
	const foreignChatIds: Set<number> = new Set()
	
	for (const update of data.result) {
		setLastUpdateId(update.update_id, log)

		const chatId =
			update.message?.chat.id || update.callback_query?.message?.chat.id
		if (String(chatId) === state.chatId) {
			updates.push(update)
		} else if (chatId) {
			foreignChatIds.add(chatId)
		}
	}
	
	// Handle foreign chat attempts
	if (foreignChatIds.size > 0 && state.useICloudCoordination) {
		let newForeignAdded = false
		
		for (const chatId of foreignChatIds) {
			log("warn", "Ignoring message from foreign chat", {
				foreignChatId: chatId,
				expectedChatId: state.chatId,
			})
			const addResult = await ICloudCoordination.addForeignChatId(chatId, log)
			if (addResult.status === "ok" && addResult.value === true) {
				newForeignAdded = true
			}
		}
		
		// Only send warning when NEW foreign chat IDs are detected
		if (newForeignAdded) {
			const allForeignResult = await ICloudCoordination.getForeignChatIds(log)
			if (allForeignResult.status === "ok") {
				const allForeign = allForeignResult.value
				const total = allForeign.length
				// Show last 5 (most recent) foreign chat IDs
				const recent = allForeign.slice(-5)
				const foreignList = recent.map(id => `• ${id}`).join("\n")
				await state.telegram.sendMessage(
					`⚠️ Warning: This bot received messages from ${total} foreign chat ID(s).\n\n` +
					`Last 5:\n${foreignList}\n\n` +
					`This bot only responds to configured chat (ID: ${state.chatId}).`
				)
			}
		}
	}

	return updates
}

async function handleTelegramMessage(
	state: BotState,
	msg: NonNullable<TelegramUpdate["message"]>,
) {
	const messageText = msg.text || msg.caption
	if (!messageText && !msg.photo && !msg.voice && !msg.video && !msg.video_note) return

	// Ignore all bot messages - context is sent directly via OpenCode API
	if (msg.from?.id === state.botUserId) {
		log("debug", "Ignoring bot message")
		return
	}

	// Ignore messages sent before this device became active (prevents race conditions)
	if (state.becameActiveAt && msg.date * 1000 < state.becameActiveAt) {
		log("debug", "Ignoring message sent before device became active", {
			messageDate: new Date(msg.date * 1000).toISOString(),
			becameActiveAt: new Date(state.becameActiveAt).toISOString(),
		})
		return
	}

	if (state.threadId && msg.message_thread_id !== state.threadId) {
		log("debug", "Ignoring message from different thread", {
			msgThreadId: msg.message_thread_id,
			stateThreadId: state.threadId,
		})
		return
	}

	// Handle "x" as interrupt (like double-escape in opencode TUI)
	if (messageText?.trim().toLowerCase() === "x") {
		log("info", "Received interrupt command 'x'")
		if (state.sessionId) {
			const abortResult = await state.server.client.session.abort({
				sessionID: state.sessionId,
				directory: state.directory,
			})
			if (abortResult.data) {
				log("info", "Abort request sent", { sessionId: state.sessionId })
			} else {
				log("error", "Failed to abort session", {
					sessionId: state.sessionId,
					error: abortResult.error,
				})
				await state.telegram.sendMessage("Failed to interrupt the session.")
			}
		} else {
			await state.telegram.sendMessage("No active session to interrupt.")
		}
		return
	}

	if (messageText?.trim() === "/connect") {
		const publicUrl = process.env.OPENCODE_PUBLIC_URL
		if (publicUrl) {
			const sendResult = await state.telegram.sendMessage(
				`OpenCode server is ready:\n${publicUrl}`
			)
			if (sendResult.status === "error") {
				log("error", "Failed to send connect response", {
					error: sendResult.error.message,
				})
			}
		} else {
			const sendResult = await state.telegram.sendMessage(
				"OpenCode URL is not available yet."
			)
			if (sendResult.status === "error") {
				log("error", "Failed to send connect response", {
					error: sendResult.error.message,
				})
			}
		}
		return
	}

	if (messageText?.trim() === "/version") {
		const pkg = await import("../package.json")
		const sendResult = await state.telegram.sendMessage(
			`opencode-telegram-mirror v${pkg.version}`
		)
		if (sendResult.status === "error") {
			log("error", "Failed to send version response", {
				error: sendResult.error.message,
			})
		}
		return
	}

	const modelMatch = messageText?.trim().match(/^\/model(?:\s+(.+))?$/)
	if (modelMatch) {
		const modelArg = modelMatch[1]?.trim()
		
		if (!modelArg) {
			// Show current model
			if (state.selectedModel) {
				await state.telegram.sendMessage(`Current model: ${state.selectedModel.providerID}/${state.selectedModel.modelID}`)
			} else {
				await state.telegram.sendMessage("No model selected (using server default)")
			}
			return
		}
		
		if (modelArg === "list") {
			// Fetch and show available models
			try {
				const response = await fetch(`${state.server.baseUrl}/config/providers`)
				if (response.ok) {
					const config = await response.json()
					const providers = config.providers || []
					let modelList = "Available models:\n"
					for (const provider of providers) {
						const models = Object.keys(provider.models || {})
						for (const model of models) {
							modelList += `• ${provider.id}/${model}\n`
						}
					}
					await state.telegram.sendMessage(modelList || "No models available")
				} else {
					await state.telegram.sendMessage("Failed to fetch available models")
				}
			} catch (error) {
				await state.telegram.sendMessage("Error fetching models: " + String(error))
			}
			return
		}
		
		if (modelArg === "reset") {
			// Clear model selection
			state.selectedModel = undefined
			await state.telegram.sendMessage("✅ Model reset to server default")
			return
		}
		
		// Parse provider/model format
		const [providerID, modelID] = modelArg.split("/")
		if (providerID && modelID) {
			state.selectedModel = { providerID, modelID }
			await state.telegram.sendMessage(`✅ Model set to ${providerID}/${modelID}`)
		} else {
			await state.telegram.sendMessage("Usage: /model provider/model\nExample: /model openai/gpt-4\n\nOther commands:\n• /model - Show current\n• /model list - Show available\n• /model reset - Use server default")
		}
		return
	}

	if (messageText?.trim() === "/ps") {
		log("info", "Received /ps command")
		if (state.runningBashProcesses.size > 0) {
			const now = Date.now()
			const processes = Array.from(state.runningBashProcesses.entries())
				.map(([pid, info]) => {
					const elapsed = Math.round((now - info.startTime) / 1000)
					return `• PID ${pid}: ${info.command} (${elapsed}s)`
				})
				.join('\n')
			await state.telegram.sendMessage(`🔄 Running bash processes:\n${processes}`)
		} else {
			await state.telegram.sendMessage("No running bash processes")
		}
		return
	}

	const capMatch = messageText?.trim().match(/^\/cap\s+(.+)$/)
	if (capMatch) {
		const bashCode = capMatch[1].trim()
		if (!bashCode) {
			await state.telegram.sendMessage("Usage: /cap <bash command>\nExample: /cap ls -la")
			return
		}
		log("info", "Received /cap command", { bashCode })
		
		try {
			const { spawn } = await import("node:child_process")
			const process = spawn("bash", ["-c", bashCode], { 
				cwd: state.directory,
				stdio: "pipe"
			})
			
			const pid = process.pid!
			log("info", "Started bash process", { pid, command: bashCode })
			state.runningBashProcesses.set(pid, {
				process,
				command: bashCode,
				startTime: Date.now()
			})
			
			let output = ""
			let errorOutput = ""
			
			process.stdout?.on("data", (data) => {
				output += data.toString()
			})
			
			process.stderr?.on("data", (data) => {
				errorOutput += data.toString()
			})
			
			process.on("close", async (code) => {
				log("info", "Bash process closed", { pid, code })
				state.runningBashProcesses.delete(pid)
				const fullOutput = output + (errorOutput ? `\nSTDERR:\n${errorOutput}` : "")
				if (code === 0) {
					await state.telegram.sendMessage(`\`\`\`\n${fullOutput || "(no output)"}\`\`\``)
				} else {
					await state.telegram.sendMessage(`❌ Command failed (exit code ${code}):\n\`\`\`\n${fullOutput}\`\`\``)
				}
			})
			
			// 3 minute timeout
			setTimeout(() => {
				if (state.runningBashProcesses.has(pid)) {
					process.kill("SIGTERM")
					state.runningBashProcesses.delete(pid)
					state.telegram.sendMessage("❌ Command timed out after 3 minutes")
				}
			}, 180000)
			
		} catch (error: any) {
			const errorMsg = error.message || String(error)
			await state.telegram.sendMessage(`❌ Command failed:\n\`\`\`\n${errorMsg}\`\`\``)
		}
		return
	}

	if (messageText?.trim() === "/restart") {
		log("info", "Received /restart command")
		await state.telegram.sendMessage("Restarting the active bot safely with automatic rollback...")
		const { spawn } = await import("node:child_process")
		spawn(".agents/scripts/safe-restart.sh", {
			detached: true,
			stdio: "ignore",
		})
		return
	}

	if (messageText?.trim() === "/upgrade") {
		log("info", "Received /upgrade command")
		await state.telegram.sendMessage("Fetching latest changes and restarting...")
		const { spawn } = await import("node:child_process")
		
		// First run jj f (fetch)
		const jjProcess = spawn("jj", ["f"], {
			stdio: "pipe",
		})
		
		jjProcess.on("close", (code) => {
			if (code === 0) {
				// If fetch succeeded, restart
				spawn(".agents/scripts/safe-restart.sh", {
					detached: true,
					stdio: "ignore",
				})
			} else {
				// If fetch failed, notify user
				state.telegram.sendMessage("❌ Failed to fetch changes. Restart cancelled.")
			}
		})
		
		return
	}

	const startMatch = messageText?.trim().match(/^\/start\s+(.+)$/)
	if (startMatch) {
		const directory = startMatch[1].trim()
		if (!directory) {
			await state.telegram.sendMessage("Usage: /start <directory>\nExample: /start /Users/me/project")
			return
		}
		log("info", "Received /start command", { directory })
		await state.telegram.sendMessage(`Starting new mirror instance in: ${directory}`)
		const { spawn } = await import("node:child_process")
		spawn(".agents/scripts/start-new-instance.sh", [directory], {
			detached: true,
			stdio: "ignore",
			env: process.env,
		})
		return
	}

	const stopMatch = messageText?.trim().match(/^\/stop\s+(.+)$/)
	if (stopMatch) {
		const selection = stopMatch[1].trim()
		
		if (!selection) {
			await state.telegram.sendMessage("Usage: /stop <number>\nExample: /stop 2")
			return
		}
		
		log("info", "Received /stop command", { selection })
		
		if (!state.useICloudCoordination) {
			await state.telegram.sendMessage("❌ iCloud coordination is required for /stop")
			return
		}
		
		// Get device status to find device by number or name
		const statusResult = await ICloudCoordination.getDeviceStatus(true, log)
		
		if (!statusResult.success || !statusResult.devices) {
			await state.telegram.sendMessage("❌ Failed to get device list")
			return
		}
		
		// Find device by number or name
		let targetDevice = statusResult.devices.find(d => d.number === parseInt(selection))
		
		if (!targetDevice) {
			// Try matching by name (exact or partial)
			targetDevice = statusResult.devices.find(d => 
				d.name === selection || 
				d.name.includes(selection)
			)
		}
		
		if (!targetDevice) {
			await state.telegram.sendMessage(
				`❌ Device "${selection}" not found. Use /dev to see available devices.`
			)
			return
		}
		
		// Don't allow stopping the current device
		if (targetDevice.isActive) {
			await state.telegram.sendMessage(
				`❌ Cannot stop the active device. Use /restart instead, or switch to another device first.`
			)
			return
		}
		
		// Remove the device
		const removeResult = await ICloudCoordination.removeDevice(targetDevice.name, log)
		
		if (removeResult.status === "ok" && removeResult.value.success) {
			const killedMsg = removeResult.value.processKilled 
				? "Process killed." 
				: "Process was already stopped."
			await state.telegram.sendMessage(
				`✅ Stopped device "${targetDevice.name}".\n${killedMsg}`
			)
		} else {
			await state.telegram.sendMessage(
				`❌ Failed to stop device "${targetDevice.name}"`
			)
		}
		return
	}

	// ═══════════════════════════════════════════════════════════
	// DEVICE MANAGEMENT COMMANDS
	// ═══════════════════════════════════════════════════════════

	if (messageText?.trim() === "/dev") {
		log("info", "Received /dev command")
		
		const result = await ICloudCoordination.getDeviceStatus(
			state.useICloudCoordination,
			log
		)
		
		await state.telegram.sendMessage(result.message)
		return
	}

	if (messageText?.startsWith("/use ")) {
		const selection = messageText.slice(5).trim()
		
		if (!selection) {
			await state.telegram.sendMessage("Usage: /use <number>\nExample: /use 2")
			return
		}
		
		log("info", "Received /use command", { selection })
		
		const result = await ICloudCoordination.activateDeviceByNumberOrName(
			selection,
			state.useICloudCoordination,
			log
		)
		
		await state.telegram.sendMessage(result.message)
		return
	}

	const interruptMatch = messageText?.trim().match(/^\/(?:interrupt|int)(?:\s+(\d+))?$/)
	if (interruptMatch) {
		log("info", "Received /interrupt command")
		
		const targetPid = interruptMatch[1] ? parseInt(interruptMatch[1]) : null
		
		if (targetPid) {
			// Kill specific PID (only if it's our tracked bash process)
			if (state.runningBashProcesses.has(targetPid)) {
				const info = state.runningBashProcesses.get(targetPid)!
				log("info", "Killing specific bash process", { pid: targetPid, command: info.command })
				try {
					info.process.kill("SIGKILL") // Use SIGKILL for immediate termination
					state.runningBashProcesses.delete(targetPid)
					await state.telegram.sendMessage(`✅ Interrupted bash process PID ${targetPid}`)
				} catch (error) {
					log("error", "Failed to kill process", { pid: targetPid, error: String(error) })
					await state.telegram.sendMessage(`❌ Failed to kill PID ${targetPid}: ${error}`)
				}
			} else {
				await state.telegram.sendMessage(`❌ PID ${targetPid} not found in tracked bash processes`)
			}
			return
		}
		
		// Kill all running bash processes
		if (state.runningBashProcesses.size > 0) {
			const pids = Array.from(state.runningBashProcesses.keys())
			log("info", "Killing all bash processes", { pids })
			let killedCount = 0
			for (const pid of pids) {
				const info = state.runningBashProcesses.get(pid)
				if (info) {
					try {
						info.process.kill("SIGKILL") // Use SIGKILL for immediate termination
						state.runningBashProcesses.delete(pid)
						killedCount++
					} catch (error) {
						log("error", "Failed to kill process", { pid, error: String(error) })
					}
				}
			}
			await state.telegram.sendMessage(`✅ Interrupted ${killedCount} running bash command(s)`)
			return
		}
		
		if (state.sessionId) {
			const abortResult = await state.server.client.session.abort({
				sessionID: state.sessionId,
				directory: state.directory,
			})
			if (abortResult.data) {
				log("info", "Abort request sent", { sessionId: state.sessionId })
			} else {
				log("error", "Failed to abort session", {
					sessionId: state.sessionId,
					error: abortResult.error,
				})
				await state.telegram.sendMessage("Failed to interrupt.")
			}
		} else {
			await state.telegram.sendMessage("No active session.")
		}
		return
	}

	const renameMatch = messageText?.trim().match(/^\/rename(?:\s+(.+))?$/)
	if (renameMatch) {
		const newTitle = renameMatch[1]?.trim()
		if (!newTitle) {
			await state.telegram.sendMessage("Usage: /rename <new title>")
			return
		}
		if (!state.sessionId) {
			await state.telegram.sendMessage("No active session to rename.")
			return
		}

		const updateResult = await state.server.client.session.update({
			sessionID: state.sessionId,
			title: newTitle,
		})
		if (updateResult.data) {
			state.threadTitle = newTitle
			if (state.threadId) {
				await state.telegram.editForumTopic(state.threadId, newTitle)
			}
			await state.telegram.sendMessage(`Session renamed to: ${newTitle}`)
		} else {
			await state.telegram.sendMessage("Failed to rename session.")
		}
		return
	}

	const commandMatch = messageText?.trim().match(/^\/(build|plan|review)(?:\s+(.*))?$/)
	if (commandMatch) {
		const [, command, args] = commandMatch
		log("info", "Received command", { command, args })

		if (!state.sessionId) {
			const result = await state.server.client.session.create({
				title: "Telegram",
			})
			if (result.data) {
				state.sessionId = result.data.id
				state.needsTitle = true
				setSessionId(result.data.id, log)
				log("info", "Created session for command", { sessionId: result.data.id })
			} else {
				log("error", "Failed to create session for command")
				await state.telegram.sendMessage("Failed to create session.")
				return
			}
		}

		state.server.client.session
			.command({
				sessionID: state.sessionId,
				directory: state.directory,
				command,
				arguments: args || "",
			})
			.catch((err) => {
				log("error", "Command failed", { command, error: String(err) })
			})

		log("info", "Command sent", { command, sessionId: state.sessionId })
		return
	}

	log("info", "💬 Received message", {
		from: msg.from?.username,
		preview: messageText?.slice(0, 50) ?? (msg.voice ? "[voice]" : "[photo]"),
	})

	// Check for freetext answer
	const threadId = state.threadId ?? null

	if (isAwaitingFreetext(msg.chat.id, threadId) && messageText) {
		const result = await handleFreetextAnswer({
			telegram: state.telegram,
			chatId: msg.chat.id,
			threadId,
			text: messageText,
			log,
		})

		if (result) {
			await state.server.client.question.reply({
				requestID: result.requestId,
				answers: result.answers,
			})
		}
		return
	}

	// Cancel pending questions/permissions
	const cancelledQ = cancelPendingQuestion(msg.chat.id, threadId)
	if (cancelledQ) {
		await state.server.client.question.reject({
			requestID: cancelledQ.requestId,
		})
	}

	const cancelledP = cancelPendingPermission(msg.chat.id, threadId)
	if (cancelledP) {
		await state.server.client.permission.reply({
			requestID: cancelledP.requestId,
			reply: "reject",
		})
	}

	if (!state.sessionId) {
		const result = await state.server.client.session.create({
			title: "Telegram",
		})

		if (result.data) {
			state.sessionId = result.data.id
			state.needsTitle = true
			setSessionId(result.data.id, log)
			log("info", "Created session", { sessionId: result.data.id })
		} else {
			log("error", "Failed to create session")
			return
		}
	}

	if (msg.video || msg.video_note) {
		log("info", "Rejecting video message - not supported")
		await state.telegram.sendMessage(
			"Video files are not supported. Please send screenshots or audio files instead."
		)
		return
	}

	// Build prompt parts
	const parts: Array<
		| { type: "text"; text: string }
		| { type: "file"; mime: string; url: string; filename?: string }
	> = []

	if (msg.photo && msg.photo.length > 0) {
		const stopTyping = state.telegram.startTyping()
		const bestPhoto = msg.photo[msg.photo.length - 1]
		const dataUrlResult = await state.telegram.downloadFileAsDataUrl(
			bestPhoto.file_id,
			"image/jpeg"
		)
		stopTyping()
		if (dataUrlResult.status === "ok") {
			parts.push({
				type: "file",
				mime: "image/jpeg",
				url: dataUrlResult.value,
				filename: `photo_${bestPhoto.file_unique_id}.jpg`,
			})
		} else {
			log("error", "Failed to download photo", {
				error: dataUrlResult.error.message,
				fileId: bestPhoto.file_id,
			})
		}
	}

	if (msg.voice) {
		if (!isVoiceTranscriptionAvailable()) {
			await state.telegram.sendMessage(getVoiceNotSupportedMessage())
			return
		}

		const stopTyping = state.telegram.startTyping()

		log("info", "Processing voice message", {
			duration: msg.voice.duration,
			fileId: msg.voice.file_id,
		})

		const fileUrlResult = await state.telegram.getFileUrl(msg.voice.file_id)
		if (fileUrlResult.status === "error") {
			stopTyping()
			log("error", "Failed to get voice file URL", {
				error: fileUrlResult.error.message,
			})
			await state.telegram.sendMessage("Failed to download voice message.")
			return
		}

		const audioResponse = await fetch(fileUrlResult.value)
		if (!audioResponse.ok) {
			stopTyping()
			log("error", "Failed to download voice file", { status: audioResponse.status })
			await state.telegram.sendMessage("Failed to download voice message.")
			return
		}

		const audioBuffer = await audioResponse.arrayBuffer()
		const transcriptionResult = await transcribeVoice(audioBuffer, log)
		stopTyping()

		if (transcriptionResult.status === "error") {
			log("error", "Voice transcription failed", {
				error: transcriptionResult.error.message,
			})
			await state.telegram.sendMessage(
				`Failed to transcribe voice message: ${transcriptionResult.error.message}`
			)
			return
		}

		const transcribedText = transcriptionResult.value
		log("info", "Voice transcribed", { preview: transcribedText.slice(0, 50) })
		const voiceContext = `[Voice message transcript - may contain transcription inaccuracies]\n\n${transcribedText}`
		parts.push({ type: "text", text: voiceContext })
	}

	if (messageText) {
		parts.push({ type: "text", text: messageText })
	}

	if (parts.length === 0) return

	// Send to OpenCode
	state.server.client.session
		.prompt({
			sessionID: state.sessionId,
			directory: state.directory,
			parts,
			...(state.selectedModel && { model: state.selectedModel })
		})
		.catch((err) => {
			log("error", "Prompt failed", { error: String(err) })
		})

	log("info", "🚀 Prompt sent", { sessionId: state.sessionId })

	if (state.needsTitle && state.sessionId) {
		const textContent = parts
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => p.text)
			.join("\n")

		if (textContent) {
			generateSessionTitle(state.server, textContent)
				.then(async (result) => {
					if (result.type === "title" && state.sessionId) {
						log("info", "Generated session title", { title: result.value })
						const updateResult = await state.server.client.session.update({
							sessionID: state.sessionId,
							title: result.value,
						})
						if (updateResult.data) {
							state.threadTitle = result.value
							state.needsTitle = false
							if (state.threadId) {
								await state.telegram.editForumTopic(state.threadId, result.value)
							}
						}
					} else {
						log("debug", "Title generation deferred", { reason: result.value })
					}
				})
				.catch((err) => {
					log("error", "Title generation failed", { error: String(err) })
				})
		}
	}
}

async function handleTelegramCallback(
	state: BotState,
	callback: import("./telegram").CallbackQuery,
) {
	log("info", "Received callback", { data: callback.data })

	if (
		state.threadId &&
		callback.message?.message_thread_id !== state.threadId
	) {
		return
	}

	const questionResult = await handleQuestionCallback({
		telegram: state.telegram,
		callback,
		log,
	})

	if (questionResult) {
		if ("awaitingFreetext" in questionResult) return

		await state.server.client.question.reply({
			requestID: questionResult.requestId,
			answers: questionResult.answers,
		})
		return
	}

	const permResult = await handlePermissionCallback({
		telegram: state.telegram,
		callback,
		log,
	})

	if (permResult) {
		await state.server.client.permission.reply({
			requestID: permResult.requestId,
			reply: permResult.reply,
		})
	}
}



// =============================================================================
// OpenCode Events
// =============================================================================

interface OpenCodeEvent {
	type: string
	properties: {
		sessionID?: string
		info?: { id: string; sessionID: string; role: string }
		part?: Part
		session?: { id: string; title?: string }
		[key: string]: unknown
	}
}

async function subscribeToEvents(state: BotState) {
	log("info", "🔌 Subscribing to OpenCode events", {
		directory: state.directory,
		sessionId: state.sessionId,
		chatId: state.chatId,
		threadId: state.threadId,
	})

	try {
		const eventsResult = await state.server.client.event.subscribe(
			{ directory: state.directory },
			{}
		)

		const stream = eventsResult.stream
		if (!stream) throw new Error("No event stream")

		log("info", "✅ Event stream connected", {
			directory: state.directory,
			sessionId: state.sessionId,
		})

		for await (const event of stream) {
			try {
				await handleOpenCodeEvent(state, event as OpenCodeEvent)
			} catch (error) {
				log("error", "❌ Event handling error", { 
					eventType: event.type,
					error: String(error),
					stack: error instanceof Error ? error.stack : undefined,
				})
			}
		}

		log("warn", "⚠️ Event stream ended unexpectedly", {
			directory: state.directory,
			sessionId: state.sessionId,
		})
	} catch (error) {
		log("error", "❌ Event subscription error", { 
			directory: state.directory,
			error: String(error),
			stack: error instanceof Error ? error.stack : undefined,
		})
	}

	// Retry
	if (getServer()) {
		log("info", "🔄 Retrying event subscription in 5 seconds")
		await Bun.sleep(5000)
		subscribeToEvents(state)
	}
}

async function handleOpenCodeEvent(state: BotState, ev: OpenCodeEvent) {
	const sessionId =
		ev.properties?.sessionID ??
		ev.properties?.info?.sessionID ??
		ev.properties?.part?.sessionID ??
		ev.properties?.session?.id
	const sessionTitle = ev.properties?.session?.title

	// AGENT-NOTE: Enhanced logging for all OpenCode events (except session.diff - too verbose)
	if (ev.type !== "session.diff") {
		log("debug", "📥 OpenCode event received", {
			type: ev.type,
			sessionId,
			sessionTitle,
			timestamp: new Date().toISOString(),
			propertiesKeys: ev.properties ? Object.keys(ev.properties) : [],
			hasInfo: !!ev.properties?.info,
			hasPart: !!ev.properties?.part,
			hasSession: !!ev.properties?.session,
			hasStatus: !!ev.properties?.status,
			hasError: !!ev.properties?.error,
		})
	}

	// Log errors in full and send to Telegram
	if (ev.type === "session.error") {
		const errorMsg = JSON.stringify(ev.properties, null, 2)
		const error = ev.properties?.error as
			| { name?: string; data?: { message?: string } }
			| undefined
		const errorName = error?.name
		const errorText = error?.data?.message
		const isInterrupted =
			errorName === "MessageAbortedError" || errorText === "The operation was aborted."

		log("error", "❌ OpenCode session error", {
			sessionId,
			error: ev.properties,
		})

		if (isInterrupted) {
			const sendResult = await state.telegram.sendMessage("Interrupted.")
			if (sendResult.status === "error") {
				log("error", "Failed to send interrupt message", {
					error: sendResult.error.message,
				})
			}
			return
		}

		// Send error to Telegram for visibility
		const sendResult = await state.telegram.sendMessage(
			`OpenCode Error:\n${errorMsg.slice(0, 3500)}`
		)
		if (sendResult.status === "error") {
			log("error", "Failed to send session error message", {
				error: sendResult.error.message,
			})
		}
	}

	if (!sessionId || sessionId !== state.sessionId) return

	if (ev.type === "session.status") {
		const status = ev.properties?.status
		log("info", "📊 Session status update", {
			sessionId,
			statusType: status?.type,
			statusMessage: status?.message,
			attempt: status?.attempt,
			next: status?.next,
			fullStatus: status,
		})
		
		if (status?.type === "retry") {
			const message = status.message || "Request is being retried"
			const attempt = status.attempt || 1
			const nextTime = status.next ? new Date(status.next).toLocaleTimeString() : "soon"
			
			await state.telegram.sendMessage(
				`⏳ Retry attempt ${attempt}: ${message}\nNext attempt at ${nextTime}`
			)
			log("info", "🔄 OpenCode retry status sent to Telegram", { 
				attempt, 
				message: status.message 
			})
		} else if (status?.type === "error") {
			const message = status.message || "An error occurred"
			await state.telegram.sendMessage(`❌ Error: ${message}`)
			log("info", "❌ OpenCode error status sent to Telegram", { 
				message: status.message 
			})
		}
		return
	}

	if (ev.type === "session.idle") {
		log("info", "💤 Session became idle", {
			sessionId,
			activeTypingIndicators: Array.from(state.typingIndicators.keys()).filter(key => 
				key.startsWith(`${sessionId}:`)
			),
		})
		
		for (const [key, entry] of state.typingIndicators) {
			if (key.startsWith(`${sessionId}:`)) {
				if (entry.timeout) clearTimeout(entry.timeout)
				entry.stop()
				state.typingIndicators.delete(key)
			}
		}
		return
	}

	// Send typing action on every session event to keep indicator active during long operations
	if (ev.type !== "session.error") {
		state.telegram.sendTypingAction()
	}

	if (sessionTitle && state.threadId) {
		const trimmedTitle = sessionTitle.trim()
		const shouldUpdate = trimmedTitle && trimmedTitle !== state.threadTitle
		if (shouldUpdate) {
			const renameResult = await state.telegram.editForumTopic(
				state.threadId,
				trimmedTitle
			)
			if (renameResult.status === "ok") {
				state.threadTitle = trimmedTitle
				log("info", "Updated Telegram thread title", {
					threadId: state.threadId,
					title: trimmedTitle,
				})
			} else {
				log("error", "Failed to update Telegram thread title", {
					threadId: state.threadId,
					title: trimmedTitle,
					error: renameResult.error.message,
				})
			}
		}
	}

	if (ev.type === "message.updated") {
		const info = ev.properties.info
		log("debug", "💬 Message updated", {
			sessionId,
			messageId: info?.id,
			role: info?.role,
			content: info?.content ? `${info.content.substring(0, 100)}...` : null,
			contentLength: info?.content?.length,
			hasAttachments: !!info?.attachments?.length,
			attachmentCount: info?.attachments?.length || 0,
		})
		
		if (info?.role === "assistant") {
			const key = `${info.sessionID}:${info.id}`
			state.assistantMessageIds.add(key)
			log("debug", "Registered assistant message", { key })
			
			// Process any buffered parts for this message
			if (state.bufferedParts?.has(key)) {
				const buffered = state.bufferedParts.get(key)!
				state.bufferedParts.delete(key)
				log("debug", "Processing buffered parts", { key, count: buffered.length })
				
				// Process each buffered part by creating synthetic events
				for (const part of buffered) {
					const syntheticEvent = {
						type: "message.part.updated" as const,
						properties: { part },
						sessionId: part.sessionID,
						timestamp: new Date().toISOString()
					}
					// Recursively call the event handler
					await handleOpenCodeEvent(syntheticEvent, state)
				}
			}
			
			const entry = state.typingIndicators.get(key)
			if (entry && entry.mode === "tool") {
				if (entry.timeout) clearTimeout(entry.timeout)
				entry.stop()
				state.typingIndicators.delete(key)
			}
		}
	}

	if (ev.type === "message.part.updated") {
		const part = ev.properties.part
		if (!part) return

		const key = `${part.sessionID}:${part.messageID}`
		
		if (!state.assistantMessageIds.has(key)) {
			// Buffer parts until message is registered
			if (!state.bufferedParts) {
				state.bufferedParts = new Map()
			}
			const buffered = state.bufferedParts.get(key) ?? []
			buffered.push(part)
			state.bufferedParts.set(key, buffered)
			log("debug", "Buffered part until message registration", { key, partType: part.type })
			return
		}

		const stopTypingIndicator = (targetKey: string) => {
			const entry = state.typingIndicators.get(targetKey)
			if (!entry) return
			if (entry.timeout) clearTimeout(entry.timeout)
			entry.stop()
			state.typingIndicators.delete(targetKey)
		}

		const startTypingIndicator = (targetKey: string, mode: "idle" | "tool") => {
			const existing = state.typingIndicators.get(targetKey)
			if (existing && existing.mode === mode) return
			if (existing) {
				if (existing.timeout) clearTimeout(existing.timeout)
				existing.stop()
			}

			const stop = state.telegram.startTyping(mode === "tool" ? 1500 : 2500)
			state.typingIndicators.set(targetKey, { stop, timeout: null, mode })
		}

		const bumpTypingIndicator = (targetKey: string, mode: "idle" | "tool") => {
			const existing = state.typingIndicators.get(targetKey)
			if (!existing || existing.mode !== mode) {
				startTypingIndicator(targetKey, mode)
				return
			}

			if (existing.timeout) clearTimeout(existing.timeout)
			existing.timeout = setTimeout(() => {
				stopTypingIndicator(targetKey)
			}, 12000)
		}

		log("debug", "🧩 Processing message part", {
			key,
			partType: part.type,
			partId: part.id,
			tool: part.tool,
			state: part.state?.status,
			hasContent: !!part.content,
			contentLength: part.content?.length,
			hasInput: !!part.state?.input,
			inputKeys: part.state?.input ? Object.keys(part.state.input) : [],
			hasOutput: !!part.state?.output,
		})

		const existing = state.pendingParts.get(key) ?? []
		const idx = existing.findIndex((p) => p.id === part.id)
		if (idx >= 0) existing[idx] = part
		else existing.push(part)
		state.pendingParts.set(key, existing)

		if (part.type !== "step-finish") {
			const typingMode =
				part.type === "tool" && (part.tool === "edit" || part.tool === "write")
					? "tool"
					: "idle"
			bumpTypingIndicator(key, typingMode)
		}

		// Send tools immediately (except edit/write tools - wait for completion to get diff data)
		// Stream reasoning parts by collecting and updating a single message
		const isEditOrWrite =
			part.type === "tool" && (part.tool === "edit" || part.tool === "write")
		if (
			part.type === "tool" &&
			part.state?.status === "running" &&
			!isEditOrWrite
		) {
			if (!state.sentPartIds.has(part.id)) {
				const formatted = formatPart(part)
				if (formatted.trim()) {
					const sendResult = await state.telegram.sendMessage(formatted)
					if (sendResult.status === "error") {
						log("error", "❌ Failed to send formatted part", {
							error: sendResult.error.message,
						})
					} else {
						log("debug", "📤 Sent OpenCode response part", {
							partType: part.type,
							partId: part.id
						})
					}
					state.sentPartIds.add(part.id)
				}
			}
		}

		// Handle reasoning parts with streaming updates
		if (part.type === "reasoning") {
			const reasoningKey = `${key}:reasoning`
			if (!state.reasoningMessages) {
				state.reasoningMessages = new Map()
			}
			
			let reasoningState = state.reasoningMessages.get(reasoningKey)
			if (!reasoningState) {
				const formatted = formatPart(part)
				if (formatted.trim()) {
					const sendResult = await state.telegram.sendMessage(formatted)
					if (sendResult.status === "ok") {
						reasoningState = {
							messageId: sendResult.value.message_id,
							content: part.text || "",
							lastUpdate: Date.now()
						}
						state.reasoningMessages.set(reasoningKey, reasoningState)
						log("debug", "📤 Started reasoning stream", { partId: part.id })
					}
				}
			} else {
				// Update existing reasoning message
				reasoningState.content = part.text || ""
				const now = Date.now()
				
				// Throttle updates to avoid rate limits (max once per 2 seconds)
				if (now - reasoningState.lastUpdate > 2000) {
					// Clear any pending timeout since we're sending now
					if (reasoningState.timeoutId) {
						clearTimeout(reasoningState.timeoutId)
						reasoningState.timeoutId = undefined
					}
					
					const formatted = formatPart({ ...part, text: reasoningState.content })
					if (formatted.trim()) {
						const editResult = await state.telegram.editMessage(
							reasoningState.messageId,
							formatted
						)
						if (editResult.status === "ok") {
							reasoningState.lastUpdate = now
							log("debug", "📝 Updated reasoning stream", { partId: part.id })
						}
					}
				} else {
					// Set timeout to send final update if no immediate send
					if (reasoningState.timeoutId) {
						clearTimeout(reasoningState.timeoutId)
					}
					reasoningState.timeoutId = setTimeout(async () => {
						const formatted = formatPart({ ...part, text: reasoningState.content })
						if (formatted.trim()) {
							const editResult = await state.telegram.editMessage(
								reasoningState.messageId,
								formatted
							)
							if (editResult.status === "ok") {
								reasoningState.lastUpdate = Date.now()
								log("debug", "📝 Final reasoning update", { partId: part.id })
							}
						}
						reasoningState.timeoutId = undefined
					}, 2500)
				}
			}
			state.sentPartIds.add(part.id)
		}

		// Handle text parts with streaming updates (similar to reasoning)
		if (part.type === "text") {
			const textKey = `${key}:text`
			if (!state.textMessages) {
				state.textMessages = new Map()
			}
			
			let textState = state.textMessages.get(textKey)
			if (!textState) {
				// Only create initial message if we have substantial content to avoid plain text fallback
				const formatted = formatPart(part)
				if (formatted.trim() && formatted.length > 10) {
					const sendResult = await state.telegram.sendMessage(formatted)
					if (sendResult.status === "ok") {
						// Check if markdown was successfully used
						const usedMarkdown = sendResult.value.usedMarkdown !== false
						
						if (usedMarkdown) {
							// Successfully sent as markdown - create state and start streaming
							textState = {
								messageId: sendResult.value.message_id,
								content: part.text || "",
								lastUpdate: Date.now(),
								usedMarkdown: true
							}
							state.textMessages.set(textKey, textState)
							log("debug", "📤 Started text stream (markdown)", { partId: part.id })
						} else {
							// Markdown failed - buffer this message until finish
							textState = {
								messageId: sendResult.value.message_id,
								content: part.text || "",
								lastUpdate: Date.now(),
								usedMarkdown: false
							}
							state.textMessages.set(textKey, textState)
							log("debug", "📦 Created message but will buffer updates (markdown failed)", { 
								partId: part.id,
								messageId: sendResult.value.message_id
							})
						}
					}
				} else {
					// Buffer the content until we have enough for a proper message
					textState = {
						messageId: -1, // Placeholder - no message created yet
						content: part.text || "",
						lastUpdate: Date.now()
					}
					state.textMessages.set(textKey, textState)
					log("debug", "📝 Buffering text content (insufficient content)", { partId: part.id, contentLength: formatted.length })
				}
			} else {
				// Update existing text message
				textState.content = part.text || ""
				const now = Date.now()
				
				// If we haven't created a message yet, check if we have enough content now
				if (textState.messageId === -1) {
					const formatted = formatPart({ ...part, text: textState.content })
					if (formatted.trim() && formatted.length > 10) {
						log("debug", "📤 Creating text message with content", { 
							partId: part.id, 
							contentLength: formatted.length,
							contentPreview: formatted.substring(0, 100),
							hasMarkdownChars: /[#*_`]/.test(formatted)
						})
						const sendResult = await state.telegram.sendMessage(formatted)
						if (sendResult.status === "ok") {
							const usedMarkdown = sendResult.value.usedMarkdown !== false
							textState.messageId = sendResult.value.message_id
							textState.lastUpdate = now
							textState.usedMarkdown = usedMarkdown
							log("debug", "📤 Created delayed text stream message", { 
								partId: part.id,
								usedMarkdown
							})
						}
					}
					return // Don't try to edit if we just created the message
				}
				
				// Only stream updates if markdown is being used successfully
				// If markdown failed (usedMarkdown === false), buffer until finish
				log("debug", "🔍 Checking if should stream update", {
					partId: part.id,
					usedMarkdown: textState.usedMarkdown,
					timeSinceLastUpdate: now - textState.lastUpdate,
					willStream: textState.usedMarkdown !== false
				})
				
				if (textState.usedMarkdown !== false) {
					// Throttle updates to avoid rate limits (max once per 2 seconds)
					if (now - textState.lastUpdate >= 2000) {
						// Enough time has passed - send update immediately
						// Clear any pending timeout since we're sending now
						if (textState.timeoutId) {
							clearTimeout(textState.timeoutId)
							textState.timeoutId = undefined
						}
						
						const formatted = formatPart({ ...part, text: textState.content })
						if (formatted.trim()) {
							const editResult = await state.telegram.editMessage(
								textState.messageId,
								formatted
							)
							if (editResult.status === "ok") {
								// Check if markdown failed during edit
								if (!editResult.value.usedMarkdown) {
									// Markdown failed - switch to buffering mode for remaining updates
									textState.usedMarkdown = false
									log("debug", "⚠️ Markdown failed during edit, switching to buffer mode", { partId: part.id })
								} else {
									textState.lastUpdate = now
									log("debug", "📝 Updated text stream (markdown)", { partId: part.id })
								}
							}
						}
					} else {
						// Too soon - set/keep timeout to send update after 2 seconds from last update
						// Only create timeout if one doesn't exist yet
						if (!textState.timeoutId) {
							const delay = 2000 - (now - textState.lastUpdate)
							textState.timeoutId = setTimeout(async () => {
								const formatted = formatPart({ ...part, text: textState.content })
								if (formatted.trim()) {
									const editResult = await state.telegram.editMessage(
										textState.messageId,
										formatted
									)
									if (editResult.status === "ok") {
										// Check if markdown failed during edit
										if (!editResult.value.usedMarkdown) {
											// Markdown failed - switch to buffering mode for remaining updates
											textState.usedMarkdown = false
											log("debug", "⚠️ Markdown failed during delayed edit, switching to buffer mode", { partId: part.id })
										} else {
											textState.lastUpdate = Date.now()
											log("debug", "📝 Delayed text update (markdown)", { partId: part.id })
										}
									}
								}
								textState.timeoutId = undefined
							}, delay)
							log("debug", "⏰ Scheduled text update", { partId: part.id, delay })
						}
					}
				} else {
					// Markdown failed - buffer updates, don't stream partial content
					log("debug", "📦 Buffering text update (markdown failed)", { 
						partId: part.id,
						contentLength: textState.content.length
					})
				}
			}
			state.sentPartIds.add(part.id)
		}

		// On step-finish, send remaining parts
		if (part.type === "step-finish") {
			stopTypingIndicator(key)
			
			// Finalize any streamed text messages with proper markdown formatting
			if (state.textMessages) {
				for (const [textKey, textState] of state.textMessages.entries()) {
					if (textKey.startsWith(key + ":")) {
						// Clear any pending timeout
						if (textState.timeoutId) {
							clearTimeout(textState.timeoutId)
							textState.timeoutId = undefined
						}
						
						// Find the corresponding text part to get final content
						const textPart = existing.find(p => p.type === "text" && `${key}:text` === textKey)
						if (textPart) {
							const formatted = formatPart(textPart)
							if (formatted.trim()) {
								// If we buffered content because markdown failed, send final update
								// This allows the complete message to render as plain text if it's not markdown
								const editResult = await state.telegram.editMessage(
									textState.messageId,
									formatted
								)
								if (editResult.status === "ok") {
									log("debug", "📝 Finalized text stream", { 
										partId: textPart.id,
										wasBuffered: textState.usedMarkdown === false,
										finalUsedMarkdown: editResult.value.usedMarkdown
									})
									if (!editResult.value.usedMarkdown) {
										log("warn", "⚠️ Final edit failed markdown, message rendered as plain text", {
											partId: textPart.id
										})
									}
								}
							}
						} else {
							// If we can't find the text part in existing, create a synthetic text part
							// from the stored content and format it properly
							const syntheticTextPart = {
								type: "text" as const,
								text: textState.content,
								id: `synthetic-${textKey}`,
								sessionID: key.split(':')[0],
								messageID: key.split(':')[1]
							}
							const formatted = formatPart(syntheticTextPart as any)
							if (formatted.trim()) {
								const editResult = await state.telegram.editMessage(
									textState.messageId,
									formatted
								)
								if (editResult.status === "ok") {
									log("debug", "📝 Finalized text stream with synthetic part formatting", { 
										textKey,
										wasBuffered: textState.usedMarkdown === false,
										finalUsedMarkdown: editResult.value.usedMarkdown
									})
									if (!editResult.value.usedMarkdown) {
										log("warn", "⚠️ Final synthetic edit failed markdown, message rendered as plain text", {
											textKey
										})
									}
								}
							}
						}
					}
				}
			}
			
			for (const p of existing) {
				if (p.type === "step-start" || p.type === "step-finish") continue
				if (state.sentPartIds.has(p.id)) continue

				// Handle edit tool diffs
				if (
					p.type === "tool" &&
					p.tool === "edit" &&
					p.state?.status === "completed"
				) {
					const input = p.state.input ?? {}
					const filePath = (input.filePath as string) || ""
					const oldString = (input.oldString as string) || ""
					const newString = (input.newString as string) || ""

					log("debug", "📝 Edit tool completed", {
						filePath,
						hasOldString: !!oldString,
						hasNewString: !!newString,
						oldStringLen: oldString.length,
						newStringLen: newString.length,
						inputKeys: Object.keys(input),
					})

					if (filePath && (oldString || newString)) {
						const diffFile = createDiffFromEdit({
							filePath,
							oldString,
							newString,
						})
						log("debug", "Uploading diff", {
							filePath,
							additions: diffFile.additions,
							deletions: diffFile.deletions,
						})
						const diffResult = await uploadDiff([diffFile], {
							title: filePath.split("/").pop() || "Edit",
							log,
						})

						const diffUpload = diffResult.status === "ok" ? diffResult.value : null
						if (diffResult.status === "error") {
							log("error", "Diff upload failed", {
								error: diffResult.error.message,
							})
						}

						log("debug", "Diff upload result", {
							success: !!diffUpload,
							url: diffUpload?.viewerUrl,
						})
						const formatted = formatPart(p)
						const preview = generateInlineDiffPreview(oldString, newString, 8)
						const message = preview ? `${formatted}\n\n${preview}` : formatted

						if (diffUpload) {
							const sendResult = await state.telegram.sendMessage(message, {
								replyMarkup: {
									inline_keyboard: [
										[{ text: "View Diff", url: diffUpload.viewerUrl }],
									],
								},
							})
							if (sendResult.status === "error") {
								log("error", "Failed to send diff message", {
									error: sendResult.error.message,
								})
							}
						} else {
							const sendResult = await state.telegram.sendMessage(message)
							if (sendResult.status === "error") {
								log("error", "Failed to send diff message", {
									error: sendResult.error.message,
								})
							}
						}
						state.sentPartIds.add(p.id)
						continue
					}

					log("warn", "Edit tool missing filePath or content", {
						filePath,
						hasOld: !!oldString,
						hasNew: !!newString,
					})
				}

				const formatted = formatPart(p)
				if (formatted.trim()) {
					const sendResult = await state.telegram.sendMessage(formatted)
					if (sendResult.status === "error") {
						log("error", "Failed to send formatted part", {
							error: sendResult.error.message,
						})
					}
					state.sentPartIds.add(p.id)
				}
			}
			state.pendingParts.delete(key)
		}
	}

	if (ev.type === "message.updated") {
		const info = ev.properties.info
		if (info?.role === "assistant") {
			const key = `${info.sessionID}:${info.id}`
			const entry = state.typingIndicators.get(key)
			if (entry && entry.mode === "tool") {
				const stopTypingIndicator = (targetKey: string) => {
					const existing = state.typingIndicators.get(targetKey)
					if (!existing) return
					if (existing.timeout) clearTimeout(existing.timeout)
					existing.stop()
					state.typingIndicators.delete(targetKey)
				}
				stopTypingIndicator(key)
			}
		}
	}

	const threadId = state.threadId ?? null

	if (ev.type === "question.asked") {
		const request = ev.properties as unknown as QuestionRequest
		log("info", "❓ Question asked", {
			sessionId,
			questionType: request?.type,
			questionText: request?.question,
			hasOptions: !!request?.options?.length,
			optionCount: request?.options?.length || 0,
			options: request?.options,
		})
		
		await showQuestionButtons({
			telegram: state.telegram,
			chatId: Number(state.chatId),
			threadId,
			sessionId,
			request: ev.properties as unknown as QuestionRequest,
			directory: state.directory,
			log,
		})
	}

	if (ev.type === "permission.asked") {
		const request = ev.properties as unknown as PermissionRequest
		log("info", "🔐 Permission requested", {
			sessionId,
			permissionType: request?.type,
			resource: request?.resource,
			action: request?.action,
			message: request?.message,
		})
		
		await showPermissionButtons({
			telegram: state.telegram,
			chatId: Number(state.chatId),
			threadId,
			sessionId,
			request: ev.properties as unknown as PermissionRequest,
			directory: state.directory,
			log,
		})
	}

	// AGENT-NOTE: Log any unhandled event types for debugging
	const handledTypes = [
		"session.error", 
		"session.status", 
		"session.idle", 
		"session.diff",
		"message.updated", 
		"message.part.updated", 
		"question.asked", 
		"permission.asked"
	]
	if (!handledTypes.includes(ev.type)) {
		log("warn", "🔍 Unhandled OpenCode event type", {
			type: ev.type,
			sessionId,
			propertiesKeys: ev.properties ? Object.keys(ev.properties) : [],
			properties: ev.properties,
		})
		
		// Convert to YAML-like format
		const toYaml = (obj: any, indent = 0): string => {
			const spaces = '  '.repeat(indent)
			if (obj === null || obj === undefined) return 'null'
			if (typeof obj === 'string') return obj
			if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj)
			if (Array.isArray(obj)) {
				return obj.map(item => `${spaces}- ${toYaml(item, indent + 1)}`).join('\n')
			}
			if (typeof obj === 'object') {
				return Object.entries(obj).map(([key, value]) => 
					`${spaces}${key}: ${toYaml(value, indent + 1)}`
				).join('\n')
			}
			return String(obj)
		}
		
		const eventYaml = toYaml(ev)
		const message = `🔍 Unhandled OpenCode Event: \`${ev.type}\`\n\n\`\`\`yaml\n${eventYaml}\`\`\``
		const sendResult = await state.telegram.sendMessage(message)
		if (sendResult.status === "error") {
			log("error", "Failed to send unhandled event message", {
				error: sendResult.error.message,
			})
		}
	}
}

main().catch((error) => {
	console.error("Fatal error:", error)
	process.exit(1)
})
