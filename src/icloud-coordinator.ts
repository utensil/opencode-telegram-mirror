/**
 * iCloud-based device coordination
 * Uses iCloud Drive local path for shared state between isolated devices
 * 
 * KEY DESIGN: Per-device files to avoid write conflicts
 * - state.json: Shared state (active device, last update ID) - only active device writes
 * - devices/<device-id>.json: Per-device files - each device writes only its own
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises"
import { join } from "node:path"
import { Result, TaggedError } from "better-result"
import type { LogFn } from "./log"

// iCloud Drive path on macOS
const ICLOUD_BASE = join(
  process.env.HOME || "",
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs"
)

const COORDINATOR_DIR = join(ICLOUD_BASE, "opencode-telegram-mirror")
const STATE_FILE = join(COORDINATOR_DIR, "state.json")
const DEVICES_DIR = join(COORDINATOR_DIR, "devices")

/**
 * Get file path for a specific device
 * Format: devices/<safe-device-id>.json
 */
function getDeviceFilePath(deviceId: string): string {
  // Sanitize device ID for filename (replace special chars with -)
  const safeId = deviceId.replace(/[^a-zA-Z0-9._@-]/g, "-")
  return join(DEVICES_DIR, `${safeId}.json`)
}

export interface DeviceInfo {
  name: string              // Unique ID: "hostname:directory" or custom name
  threadId: number | null   // Thread this device monitors
  lastSeen: number          // Timestamp of last heartbeat
  hostname: string          // Machine hostname
  directory: string         // Working directory path
  pid: number               // Process ID
}

export interface CoordinatorState {
  activeDevice: string | null      // Device name that's currently active
  activeDeviceHeartbeat: number    // Last heartbeat timestamp from active device
  lastUpdateId: number             // Last processed Telegram update_id
  lastModified: number             // Last state modification time
  modifiedBy: string               // Which device modified this
  foreignChatIds: number[]         // Foreign chat IDs that tried to connect
}

// ============================================================================
// UNIFIED RANDOMIZATION SYSTEM
// Prevents synchronized operations across all devices
// ============================================================================

/**
 * Randomization parameters
 * All intervals use: base + random(0, jitter)
 */
export const RANDOMIZATION = {
  // Active device heartbeat (device lastSeen + state.json updates)
  ACTIVE_HEARTBEAT_BASE_MS: 30000,    // 30 seconds
  ACTIVE_HEARTBEAT_JITTER_MS: 10000,  // +0-10 seconds = 30-40s range
  
  // Standby device heartbeat (device lastSeen only - infrequent)
  STANDBY_HEARTBEAT_BASE_MS: 300000,  // 5 minutes (300 seconds)
  STANDBY_HEARTBEAT_JITTER_MS: 60000, // +0-60 seconds = 5-6 minutes range
  
  // Standby device check interval (frequent - detect failures fast)
  CHECK_BASE_MS: 30000,               // 30 seconds
  CHECK_JITTER_MS: 10000,             // +0-10 seconds = 30-40s range
  
  // Failover attempt delay
  FAILOVER_JITTER_MS: 10000,          // 0-10 seconds random delay
  
  // Heartbeat timeout (when to consider device stale)
  HEARTBEAT_TIMEOUT_MS: 90000,        // 90 seconds (must be > max active heartbeat interval)
} as const

/**
 * Get randomized interval using unified mechanism
 * @param base Base interval in milliseconds
 * @param jitter Maximum additional jitter in milliseconds
 * @returns base + random(0, jitter)
 */
export function getRandomizedInterval(base: number, jitter: number): number {
  return base + Math.random() * jitter
}

// Legacy exports for backwards compatibility
export const HEARTBEAT_TIMEOUT_MS = RANDOMIZATION.HEARTBEAT_TIMEOUT_MS
export const FAILOVER_JITTER_MAX_MS = RANDOMIZATION.FAILOVER_JITTER_MS

export class CoordinatorError extends TaggedError("CoordinatorError")<{
  message: string
  cause?: unknown
}>() {}

/**
 * Initialize iCloud coordinator directory
 */
export async function initCoordinator(log?: LogFn): Promise<Result<void, CoordinatorError>> {
  return Result.tryPromise({
    try: async () => {
      // Check if iCloud Drive exists
      try {
        await access(ICLOUD_BASE)
      } catch {
        throw new Error(
          `iCloud Drive not found at ${ICLOUD_BASE}. Is iCloud Drive enabled?`
        )
      }

      // Create coordinator directory and devices subdirectory
      await mkdir(COORDINATOR_DIR, { recursive: true })
      await mkdir(DEVICES_DIR, { recursive: true })

      // Initialize state.json if not exists
      try {
        await access(STATE_FILE)
      } catch {
        const initialState: CoordinatorState = {
          activeDevice: null,
          activeDeviceHeartbeat: 0,
          lastUpdateId: 0,
          lastModified: Date.now(),
          modifiedBy: "system",
          foreignChatIds: [],
        }
        await writeFile(STATE_FILE, JSON.stringify(initialState, null, 2))
        log?.("info", "Created initial state file", { path: STATE_FILE })
      }

      log?.("info", "iCloud coordinator initialized", { 
        dir: COORDINATOR_DIR,
        devicesDir: DEVICES_DIR,
      })
    },
    catch: (error) =>
      new CoordinatorError({
        message: `Failed to initialize coordinator: ${String(error)}`,
        cause: error,
      }),
  })
}

/**
 * Read current coordinator state
 */
export async function readState(log?: LogFn): Promise<Result<CoordinatorState, CoordinatorError>> {
  return Result.tryPromise({
    try: async () => {
      const content = await readFile(STATE_FILE, "utf-8")
      const state = JSON.parse(content) as CoordinatorState
      
      // Migration: ensure foreignChatIds exists
      if (!state.foreignChatIds) {
        state.foreignChatIds = []
        await writeFile(STATE_FILE, JSON.stringify(state, null, 2))
        log?.("info", "Migrated state to include foreignChatIds")
      }
      
      log?.("debug", "Read coordinator state", { activeDevice: state.activeDevice })
      return state
    },
    catch: (error) =>
      new CoordinatorError({
        message: `Failed to read state: ${String(error)}`,
        cause: error,
      }),
  })
}

/**
 * Write coordinator state
 */
export async function writeState(
  state: CoordinatorState,
  log?: LogFn
): Promise<Result<void, CoordinatorError>> {
  return Result.tryPromise({
    try: async () => {
      await writeFile(STATE_FILE, JSON.stringify(state, null, 2))
      log?.("debug", "Wrote coordinator state", { activeDevice: state.activeDevice })
    },
    catch: (error) =>
      new CoordinatorError({
        message: `Failed to write state: ${String(error)}`,
        cause: error,
      }),
  })
}

/**
 * Add a foreign chat ID that tried to connect
 */
export async function addForeignChatId(
  chatId: number,
  log?: LogFn
): Promise<Result<void, CoordinatorError>> {
  return Result.tryPromise({
    try: async () => {
      const currentStateResult = await readState(log)
      if (currentStateResult.status === "error") {
        throw currentStateResult.error
      }
      
      const state = currentStateResult.value
      
      // Only add if not already in the list
      if (!state.foreignChatIds.includes(chatId)) {
        state.foreignChatIds.push(chatId)
        state.lastModified = Date.now()
        state.modifiedBy = "foreign-chat-tracker"
        
        await writeFile(STATE_FILE, JSON.stringify(state, null, 2))
        log?.("info", "Added foreign chat ID", { chatId, totalForeignChats: state.foreignChatIds.length })
      }
    },
    catch: (error) =>
      new CoordinatorError({
        message: `Failed to add foreign chat ID: ${String(error)}`,
        cause: error,
      }),
  })
}

/**
 * Get all foreign chat IDs
 */
export async function getForeignChatIds(
  log?: LogFn
): Promise<Result<number[], CoordinatorError>> {
  return Result.tryPromise({
    try: async () => {
      const stateResult = await readState(log)
      if (stateResult.status === "error") {
        return []
      }
      return stateResult.value.foreignChatIds
    },
    catch: (error) =>
      new CoordinatorError({
        message: `Failed to get foreign chat IDs: ${String(error)}`,
        cause: error,
      }),
  })
}

/**
 * Read a specific device file
 */
async function readDeviceFile(
  deviceId: string,
  log?: LogFn
): Promise<Result<DeviceInfo, CoordinatorError>> {
  return Result.tryPromise({
    try: async () => {
      const filePath = getDeviceFilePath(deviceId)
      const content = await readFile(filePath, "utf-8")
      const device = JSON.parse(content) as DeviceInfo
      log?.("debug", "Read device file", { deviceId })
      return device
    },
    catch: (error) =>
      new CoordinatorError({
        message: `Failed to read device file: ${String(error)}`,
        cause: error,
      }),
  })
}

/**
 * Write a specific device file
 */
async function writeDeviceFile(
  deviceId: string,
  device: DeviceInfo,
  log?: LogFn
): Promise<Result<void, CoordinatorError>> {
  return Result.tryPromise({
    try: async () => {
      const filePath = getDeviceFilePath(deviceId)
      await writeFile(filePath, JSON.stringify(device, null, 2))
      log?.("debug", "Wrote device file", { deviceId })
    },
    catch: (error) =>
      new CoordinatorError({
        message: `Failed to write device file: ${String(error)}`,
        cause: error,
      }),
  })
}

/**
 * Read all device files from devices/ directory
 */
export async function readDevices(
  log?: LogFn
): Promise<Result<Record<string, DeviceInfo>, CoordinatorError>> {
  return Result.tryPromise({
    try: async () => {
      const { readdir } = await import("node:fs/promises")
      
      // Read all .json files in devices directory
      let files: string[] = []
      try {
        files = await readdir(DEVICES_DIR)
      } catch {
        // Directory doesn't exist yet, return empty
        return {}
      }
      
      const jsonFiles = files.filter(f => f.endsWith(".json"))
      
      const devices: Record<string, DeviceInfo> = {}
      
      for (const file of jsonFiles) {
        try {
          const filePath = join(DEVICES_DIR, file)
          const content = await readFile(filePath, "utf-8")
          const device = JSON.parse(content) as DeviceInfo
          devices[device.name] = device
        } catch (error) {
          log?.("warn", "Failed to read device file", { file, error: String(error) })
        }
      }
      
      log?.("debug", "Read all devices", { count: Object.keys(devices).length })
      return devices
    },
    catch: (error) =>
      new CoordinatorError({
        message: `Failed to read devices: ${String(error)}`,
        cause: error,
      }),
  })
}

/**
 * Generate unique device identifier
 * Format: "hostname:directory" or custom name if DEVICE_NAME is set
 */
export function generateDeviceId(directory: string): string {
  const customName = process.env.DEVICE_NAME
  
  if (customName) {
    // Use custom name but append directory for uniqueness
    const hostname = require("node:os").hostname()
    return `${customName}@${hostname}:${directory}`
  }
  
  // Default: hostname:directory
  const hostname = require("node:os").hostname()
  return `${hostname}:${directory}`
}

/**
 * Register current device
 */
export async function registerDevice(
  directory: string,
  threadId: number | null,
  log?: LogFn
): Promise<Result<string, CoordinatorError>> {
  const deviceId = generateDeviceId(directory)
  const hostname = require("node:os").hostname()

  const deviceInfo: DeviceInfo = {
    name: deviceId,
    threadId,
    lastSeen: Date.now(),
    hostname,
    directory,
    pid: process.pid,
  }

  const writeResult = await writeDeviceFile(deviceId, deviceInfo, log)
  if (writeResult.status === "error") {
    return Result.err(writeResult.error)
  }

  log?.("info", "Device registered", { 
    deviceId, 
    threadId, 
    hostname,
    directory,
    pid: process.pid,
  })
  
  return Result.ok(deviceId)
}

/**
 * Update device heartbeat and last seen timestamp
 * Each device only writes to its own file - NO CONFLICTS!
 */
export async function heartbeat(deviceId: string, log?: LogFn): Promise<Result<void, CoordinatorError>> {
  // Read our own device file
  const deviceResult = await readDeviceFile(deviceId, log)
  
  if (deviceResult.status === "error") {
    // Device file doesn't exist yet - recreate it
    log?.("warn", "Device file missing, recreating", { deviceId })
    const hostname = require("node:os").hostname()
    const deviceInfo: DeviceInfo = {
      name: deviceId,
      threadId: null,
      lastSeen: Date.now(),
      hostname,
      directory: deviceId.split(":")[1] || "",
      pid: process.pid,
    }
    return writeDeviceFile(deviceId, deviceInfo, log)
  }

  // Update only our lastSeen timestamp
  const device = deviceResult.value
  device.lastSeen = Date.now()
  
  return writeDeviceFile(deviceId, device, log)
}

/**
 * Check if current device is active
 */
export async function isActive(
  deviceId: string,
  log?: LogFn
): Promise<Result<boolean, CoordinatorError>> {
  const stateResult = await readState(log)
  if (stateResult.status === "error") {
    return Result.err(stateResult.error)
  }

  const isDeviceActive = stateResult.value.activeDevice === deviceId
  return Result.ok(isDeviceActive)
}

/**
 * Check if active device heartbeat is stale
 * Returns true if no active device OR active device hasn't sent heartbeat in > 90s
 */
export async function isActiveDeviceStale(log?: LogFn): Promise<Result<boolean, CoordinatorError>> {
  const stateResult = await readState(log)
  if (stateResult.status === "error") {
    return Result.err(stateResult.error)
  }

  const state = stateResult.value
  
  // No active device
  if (!state.activeDevice) {
    return Result.ok(true)
  }

  // Check heartbeat age
  const heartbeatAge = Date.now() - state.activeDeviceHeartbeat
  const isStale = heartbeatAge > HEARTBEAT_TIMEOUT_MS

  if (isStale) {
    log?.("warn", "Active device heartbeat is stale", {
      activeDevice: state.activeDevice,
      heartbeatAgeMs: heartbeatAge,
      thresholdMs: HEARTBEAT_TIMEOUT_MS,
    })
  }

  return Result.ok(isStale)
}

/**
 * Attempt to become active device (with optimistic concurrency control)
 * Returns true if successfully became active, false if another device won
 */
export async function tryBecomeActive(
  deviceId: string,
  log?: LogFn
): Promise<Result<boolean, CoordinatorError>> {
  // Read current state
  const stateResult = await readState(log)
  if (stateResult.status === "error") {
    return Result.err(stateResult.error)
  }

  const state = stateResult.value
  const now = Date.now()

  // Check if still stale (another device might have activated)
  const heartbeatAge = now - state.activeDeviceHeartbeat
  if (state.activeDevice && heartbeatAge < HEARTBEAT_TIMEOUT_MS) {
    log?.("info", "Active device recovered before failover", {
      activeDevice: state.activeDevice,
      heartbeatAgeMs: heartbeatAge,
    })
    return Result.ok(false)
  }

  // Try to activate with timestamp check
  const previousTimestamp = state.lastModified
  state.activeDevice = deviceId
  state.activeDeviceHeartbeat = now
  state.lastModified = now
  state.modifiedBy = deviceId

  const writeResult = await writeState(state, log)
  if (writeResult.status === "error") {
    return Result.err(writeResult.error)
  }

  // Read back to verify we won (poor man's optimistic locking)
  await new Promise(resolve => setTimeout(resolve, 500)) // Wait for iCloud sync
  const verifyResult = await readState(log)
  if (verifyResult.status === "error") {
    return Result.err(verifyResult.error)
  }

  const verified = verifyResult.value
  const weWon = verified.activeDevice === deviceId && verified.lastModified >= previousTimestamp

  if (weWon) {
    log?.("info", "Successfully became active device", { deviceId })
  } else {
    log?.("info", "Lost activation race to another device", {
      ourDevice: deviceId,
      winner: verified.activeDevice,
    })
  }

  return Result.ok(weWon)
}

/**
 * Activate a device (deactivates all others)
 * Updates heartbeat timestamp
 */
export async function activateDevice(
  deviceId: string,
  log?: LogFn
): Promise<Result<void, CoordinatorError>> {
  const stateResult = await readState(log)
  if (stateResult.status === "error") {
    return Result.err(stateResult.error)
  }

  const state = stateResult.value
  const now = Date.now()
  
  state.activeDevice = deviceId
  state.activeDeviceHeartbeat = now
  state.lastModified = now
  state.modifiedBy = deviceId

  const writeResult = await writeState(state, log)
  if (writeResult.status === "error") {
    return Result.err(writeResult.error)
  }

  log?.("info", "Device activated", { device: deviceId })
  return Result.ok(undefined)
}

/**
 * Update active device heartbeat (called by active device every 30s)
 * Only active device writes to state.json - NO CONFLICTS with standby devices!
 */
export async function updateActiveHeartbeat(
  deviceId: string,
  log?: LogFn
): Promise<Result<void, CoordinatorError>> {
  const stateResult = await readState(log)
  if (stateResult.status === "error") {
    return Result.err(stateResult.error)
  }

  const state = stateResult.value
  
  // Only update if we're still the active device
  if (state.activeDevice !== deviceId) {
    log?.("warn", "Not active device, skipping heartbeat update", {
      ourDevice: deviceId,
      activeDevice: state.activeDevice,
    })
    return Result.ok(undefined)
  }

  const now = Date.now()
  state.activeDeviceHeartbeat = now
  state.lastModified = now
  state.modifiedBy = deviceId

  const writeResult = await writeState(state, log)
  if (writeResult.status === "error") {
    return Result.err(writeResult.error)
  }

  log?.("debug", "Updated active device heartbeat", { deviceId })
  return Result.ok(undefined)
}

/**
 * Get last update ID
 */
export async function getLastUpdateId(log?: LogFn): Promise<Result<number, CoordinatorError>> {
  const stateResult = await readState(log)
  if (stateResult.status === "error") {
    return Result.err(stateResult.error)
  }

  return Result.ok(stateResult.value.lastUpdateId)
}

/**
 * Set last update ID
 */
export async function setLastUpdateId(
  updateId: number,
  deviceId: string,
  log?: LogFn
): Promise<Result<void, CoordinatorError>> {
  const stateResult = await readState(log)
  if (stateResult.status === "error") {
    return Result.err(stateResult.error)
  }

  const state = stateResult.value
  state.lastUpdateId = updateId
  state.lastModified = Date.now()
  state.modifiedBy = deviceId

  return writeState(state, log)
}

/**
 * Get coordinator directory path (for debugging)
 */
export function getCoordinatorPath(): string {
  return COORDINATOR_DIR
}

/**
 * Clean up stale device files (devices not seen for > 24 hours)
 * Call this periodically to prevent accumulation
 */
export async function cleanupStaleDevices(
  log?: LogFn
): Promise<Result<number, CoordinatorError>> {
  return Result.tryPromise({
    try: async () => {
      const { unlink } = await import("node:fs/promises")
      const devicesResult = await readDevices(log)
      
      if (devicesResult.status === "error") {
        return 0
      }
      
      const devices = devicesResult.value
      const now = Date.now()
      const staleThreshold = 24 * 60 * 60 * 1000 // 24 hours
      let cleaned = 0
      
      for (const [deviceId, device] of Object.entries(devices)) {
        const age = now - device.lastSeen
        if (age > staleThreshold) {
          const filePath = getDeviceFilePath(deviceId)
          try {
            await unlink(filePath)
            cleaned++
            log?.("info", "Cleaned up stale device file", { 
              deviceId, 
              ageHours: Math.round(age / (60 * 60 * 1000)) 
            })
          } catch (error) {
            log?.("warn", "Failed to delete stale device file", { 
              deviceId, 
              error: String(error) 
            })
          }
        }
      }
      
      if (cleaned > 0) {
        log?.("info", "Cleanup complete", { devicesRemoved: cleaned })
      }
      
      return cleaned
    },
    catch: (error) =>
      new CoordinatorError({
        message: `Failed to cleanup stale devices: ${String(error)}`,
        cause: error,
      }),
  })
}
