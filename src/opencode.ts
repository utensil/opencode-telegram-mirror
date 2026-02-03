/**
 * OpenCode server process manager.
 * Spawns and maintains a single OpenCode API server.
 */

import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import {
  createOpencodeClient,
  type OpencodeClient,
  type Config,
} from "@opencode-ai/sdk/v2"
import { Result, TaggedError } from "better-result"
import { createLogger } from "./log"

const log = createLogger()

export interface OpenCodeServer {
  process: ChildProcess | null  // null when connecting to external server
  client: OpencodeClient
  port: number
  directory: string
  baseUrl: string
}

export const OPENCODE_TIMEOUT_MS = 30000  // 30 second timeout for API calls

export class PortLookupError extends TaggedError("PortLookupError")<{
  message: string
  cause: unknown
}>() {
  constructor(args: { cause: unknown }) {
    const causeMessage = args.cause instanceof Error ? args.cause.message : String(args.cause)
    super({ ...args, message: `Failed to get open port: ${causeMessage}` })
  }
}

export class ServerStartError extends TaggedError("ServerStartError")<{
  message: string
  cause: unknown
}>() {
  constructor(args: { cause: unknown }) {
    const causeMessage = args.cause instanceof Error ? args.cause.message : String(args.cause)
    super({ ...args, message: `Server failed to start: ${causeMessage}` })
  }
}

export class DirectoryAccessError extends TaggedError("DirectoryAccessError")<{
  message: string
  directory: string
  cause: unknown
}>() {
  constructor(args: { directory: string; cause: unknown }) {
    const causeMessage = args.cause instanceof Error ? args.cause.message : String(args.cause)
    super({ ...args, message: `Directory not accessible: ${args.directory} (${causeMessage})` })
  }
}

let server: OpenCodeServer | null = null

async function getOpenPort(): Promise<Result<number, PortLookupError>> {
  return Result.tryPromise({
    try: () =>
      new Promise<number>((resolve, reject) => {
        const srv = net.createServer()
        srv.listen(0, () => {
          const address = srv.address()
          if (address && typeof address === "object") {
            const port = address.port
            srv.close(() => resolve(port))
          } else {
            reject(new Error("Failed to get port"))
          }
        })
        srv.on("error", reject)
      }),
    catch: (error) => new PortLookupError({ cause: error }),
  })
}

async function waitForServer(
  port: number,
  maxAttempts = 30,
  baseUrl?: string
): Promise<Result<boolean, ServerStartError>> {
  const url = baseUrl || `http://127.0.0.1:${port}`

  for (let i = 0; i < maxAttempts; i++) {
    const responseResult = await Result.tryPromise({
      try: () =>
        fetch(`${url}/session`, {
          signal: AbortSignal.timeout(2000),
        }),
      catch: (error) => new ServerStartError({ cause: error }),
    })

    if (responseResult.status === "ok") {
      if (responseResult.value.status < 500) {
        return Result.ok(true)
      }
    }

    await new Promise((r) => setTimeout(r, 1000))
  }

  return Result.err(
    new ServerStartError({
      cause: new Error(`Server did not start at ${url} after ${maxAttempts} seconds`),
    })
  )
}

/**
 * Build auth headers for OpenCode server if credentials are configured.
 * Uses OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD env vars.
 * If only password is set, username defaults to "opencode".
 */
function getAuthHeaders(): Record<string, string> {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) {
    return {}
  }

  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode"
  const credentials = btoa(`${username}:${password}`)
  return { Authorization: `Basic ${credentials}` }
}

/**
 * Connect to an already-running OpenCode server
 */
export async function connectToServer(
  baseUrl: string,
  directory: string
): Promise<Result<OpenCodeServer, ServerStartError>> {
  // Reuse existing server if connected to same URL
  if (server && server.baseUrl === baseUrl) {
    log("info", "Reusing existing connection", { baseUrl })
    return Result.ok(server)
  }

  log("info", "Connecting to external OpenCode server", { baseUrl })

  // Extract port from URL
  const url = new URL(baseUrl)
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80)

  // Wait for server to be ready
  const readyResult = await waitForServer(port, 30, baseUrl)
  if (readyResult.status === "error") {
    return Result.err(readyResult.error)
  }

  log("info", "External server ready", { baseUrl })

  const authHeaders = getAuthHeaders()
  const hasAuth = Object.keys(authHeaders).length > 0
  if (hasAuth) {
    log("info", "Using basic auth for OpenCode server", {
      username: process.env.OPENCODE_SERVER_USERNAME || "opencode",
    })
  }

  // Custom fetch with timeout and auto-restart
  const fetchWithAutoRestart = async (request: Request): Promise<Response> => {
    try {
      return await fetch(request, {
        signal: AbortSignal.timeout(OPENCODE_TIMEOUT_MS),
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const isTimeout = errorMessage.includes("timeout") || 
                        errorMessage.includes("AbortError") ||
                        errorMessage.includes("ECONNRESET")
      
      if (isTimeout && server?.process) {
        log("warn", "OpenCode API timeout, restarting server...", { error: errorMessage })
        
        // Kill existing server
        server.process.kill()
        server = null
        
        // Start fresh server
        const startResult = await startServer(directory)
        if (startResult.status === "error") {
          throw new Error(`Failed to restart server: ${startResult.error.message}`)
        }
        
        log("info", "Server restarted, retrying API call...")
        
        // Retry with new server
        return await fetch(request, {
          signal: AbortSignal.timeout(OPENCODE_TIMEOUT_MS),
        })
      }
      throw error
    }
  }

  const client = createOpencodeClient({
    baseUrl,
    fetch: fetchWithAutoRestart as typeof fetch,
    headers: authHeaders,
  })

  server = {
    process: null,  // No process - external server
    client,
    port,
    directory,
    baseUrl,
  }

  return Result.ok(server)
}

export async function startServer(
  directory: string
): Promise<Result<OpenCodeServer, DirectoryAccessError | PortLookupError | ServerStartError>> {
  // Reuse existing server if running
  if (server?.process && !server.process.killed) {
    log("info", "Reusing existing server", { directory, port: server.port })
    return Result.ok(server)
  }

  // Verify directory exists
  const accessResult = Result.try({
    try: () => fs.accessSync(directory, fs.constants.R_OK | fs.constants.X_OK),
    catch: (error) => new DirectoryAccessError({ directory, cause: error }),
  })

  if (accessResult.status === "error") {
    return Result.err(accessResult.error)
  }

  const envPort = process.env.OPENCODE_PORT
  const parsedPort = envPort ? Number(envPort) : null
  const portResult = parsedPort && !Number.isNaN(parsedPort) ? Result.ok(parsedPort) : await getOpenPort()

  if (portResult.status === "error") {
    return Result.err(portResult.error)
  }

  const port = portResult.value
  const opencodePath = process.env.OPENCODE_PATH || `${process.env.HOME}/.opencode/bin/opencode`

  log("info", "Starting opencode serve", { directory, port })

  const serverProcess = spawn(opencodePath, ["serve", "--port", port.toString()], {
    stdio: "pipe",
    detached: false,
    cwd: directory,
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        lsp: false,
        formatter: false,
        permission: {
          edit: "allow",
          bash: "allow",
          webfetch: "allow",
        },
      } satisfies Config),
    },
  })

  serverProcess.stdout?.on("data", (data) => {
    log("debug", "opencode stdout", { data: data.toString().trim().slice(0, 200) })
  })

  serverProcess.stderr?.on("data", (data) => {
    log("debug", "opencode stderr", { data: data.toString().trim().slice(0, 200) })
  })

  serverProcess.on("error", (error) => {
    log("error", "Server process error", { directory, error: String(error) })
  })

  serverProcess.on("exit", (code) => {
    log("info", "Server exited", { directory, code })
    server = null

    if (code !== 0) {
      log("info", "Restarting server", { directory })
      startServer(directory).then((result) => {
        if (result.status === "error") {
          log("error", "Failed to restart server", { error: result.error.message })
        }
      })
    }
  })

  const readyResult = await waitForServer(port)
  if (readyResult.status === "error") {
    return Result.err(readyResult.error)
  }

  log("info", "Server ready", { directory, port })

  const baseUrl = `http://127.0.0.1:${port}`
  
  // Custom fetch with timeout and auto-restart
  const fetchWithAutoRestart = async (request: Request): Promise<Response> => {
    try {
      return await fetch(request, {
        signal: AbortSignal.timeout(OPENCODE_TIMEOUT_MS),
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const isTimeout = errorMessage.includes("timeout") || 
                        errorMessage.includes("AbortError") ||
                        errorMessage.includes("ECONNRESET")
      
      if (isTimeout && server?.process) {
        log("warn", "OpenCode API timeout, restarting server...", { error: errorMessage })
        
        // Kill existing server
        server.process.kill()
        server = null
        
        // Start fresh server
        const startResult = await startServer(directory)
        if (startResult.status === "error") {
          throw new Error(`Failed to restart server: ${startResult.error.message}`)
        }
        
        log("info", "Server restarted, retrying API call...")
        
        // Retry with new server
        return await fetch(request, {
          signal: AbortSignal.timeout(OPENCODE_TIMEOUT_MS),
        })
      }
      throw error
    }
  }

  const client = createOpencodeClient({
    baseUrl,
    fetch: fetchWithAutoRestart as typeof fetch,
  })

  server = {
    process: serverProcess,
    client,
    port,
    directory,
    baseUrl,
  }

  return Result.ok(server)
}

export function getServer(): OpenCodeServer | null {
  return server
}

export async function stopServer(): Promise<Result<void, ServerStartError>> {
  if (!server) {
    return Result.ok(undefined)
  }

  const serverToStop = server

  const stopResult = Result.try({
    try: () => {
      serverToStop.process?.kill()
      log("info", "Server stopped", { directory: serverToStop.directory })
      server = null
    },
    catch: (error) => new ServerStartError({ cause: error }),
  })

  return stopResult.map(() => undefined)
}

/**
 * Restart the OpenCode server (kills old process and starts new one)
 * Used when API calls timeout
 */
export async function restartServer(): Promise<Result<OpenCodeServer, DirectoryAccessError | PortLookupError | ServerStartError>> {
  if (!server) {
    return startServer(process.cwd())
  }
  
  log("info", "Restarting OpenCode server due to timeout...")
  
  // Kill existing server
  server.process?.kill()
  server = null
  
  // Start fresh
  return startServer(process.cwd())
}

/**
 * Call an OpenCode API function with automatic restart on timeout.
 * If the call times out or fails, restarts the server and retries once.
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  directory: string
): Promise<Result<T, Error>> {
  try {
    return Result.ok(await fn())
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    
    // Check if it's a timeout or connection error
    const isTimeout = errorMessage.includes("timeout") || 
                      errorMessage.includes("AbortError") ||
                      errorMessage.includes("ECONNRESET") ||
                      errorMessage.includes("connection")
    
    if (isTimeout) {
      log("warn", "OpenCode API call failed, restarting server...", { error: errorMessage })
      
      // Restart the server
      const restartResult = await restartServer()
      if (restartResult.status === "error") {
        return Result.err(new Error(`Failed to restart server: ${restartResult.error.message}`))
      }
      
      log("info", "Server restarted, retrying API call...")
      
      // Retry the call
      try {
        return Result.ok(await fn())
      } catch (retryError) {
        return Result.err(retryError as Error)
      }
    }
    
    return Result.err(error as Error)
  }
}
