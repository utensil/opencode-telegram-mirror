/**
 * Integration layer for iCloud coordination in main.ts
 * Provides wrapper functions that work with or without iCloud coordination
 */

import * as icloud from "./icloud-coordinator"
import * as localDb from "./database"
import type { LogFn } from "./log"

// Flag to enable/disable iCloud coordination
const USE_ICLOUD = process.env.USE_ICLOUD_COORDINATOR !== "false" // Enabled by default

/**
 * Initialize coordination (iCloud or local DB)
 */
export async function initializeCoordination(
  directory: string,
  threadId: number | null,
  log: LogFn
): Promise<{ deviceId: string; useICloud: boolean }> {
  if (!USE_ICLOUD) {
    // Generate device ID even in local mode for consistency
    const deviceId = icloud.generateDeviceId(directory)
    log("info", "iCloud coordination disabled, using local database", { deviceId })
    return { deviceId, useICloud: false }
  }

  // Try to initialize iCloud coordinator
  const initResult = await icloud.initCoordinator(log)

  if (initResult.status === "error") {
    const deviceId = icloud.generateDeviceId(directory)
    log("warn", "iCloud coordinator failed to initialize, falling back to local database", {
      error: initResult.error.message,
    })
    return { deviceId, useICloud: false }
  }

  // Register this device (returns device ID)
  const registerResult = await icloud.registerDevice(directory, threadId, log)

  if (registerResult.status === "error") {
    const deviceId = icloud.generateDeviceId(directory)
    log("warn", "Failed to register device, falling back to local database", {
      error: registerResult.error.message,
    })
    return { deviceId, useICloud: false }
  }

  const deviceId = registerResult.value

  log("info", "iCloud coordination enabled", {
    deviceId,
    directory,
    path: icloud.getCoordinatorPath(),
  })

  return { deviceId, useICloud: true }
}

/**
 * Check if this device is active and handle automatic failover
 * Returns true if this device should process messages
 */
export async function checkIfActiveWithFailover(
  deviceId: string,
  useICloud: boolean,
  log: LogFn
): Promise<boolean> {
  if (!useICloud) {
    return true // Always active when using local DB
  }

  // First check if we're already active
  const activeResult = await icloud.isActive(deviceId, log)
  if (activeResult.status === "error") {
    log("warn", "Failed to check active status, assuming inactive", {
      error: activeResult.error.message,
    })
    return false
  }

  if (activeResult.value) {
    return true // We're active
  }

  // We're not active - check if active device is stale
  const staleResult = await icloud.isActiveDeviceStale(log)
  if (staleResult.status === "error") {
    log("warn", "Failed to check heartbeat staleness", {
      error: staleResult.error.message,
    })
    return false
  }

  if (!staleResult.value) {
    return false // Active device is healthy, stay standby
  }

  // Active device is stale - attempt failover with random jitter
  log("info", "Active device heartbeat is stale, attempting failover", { deviceId })

  // Random jitter: 0-10 seconds to avoid thundering herd
  const jitterMs = getRandomizedFailoverJitter()
  log("info", "Waiting for failover jitter", { jitterMs: Math.round(jitterMs) })
  await new Promise(resolve => setTimeout(resolve, jitterMs))

  // Try to become active
  const becameActiveResult = await icloud.tryBecomeActive(deviceId, log)
  if (becameActiveResult.status === "error") {
    log("error", "Failed to attempt activation", {
      error: becameActiveResult.error.message,
    })
    return false
  }

  if (becameActiveResult.value) {
    log("info", "Failover successful - this device is now active", { deviceId })
    return true
  } else {
    log("info", "Another device won the failover race", { deviceId })
    return false
  }
}

/**
 * Send heartbeat for device registry
 * Active devices: Update frequently (30-40s)
 * Standby devices: Update infrequently (5-6 minutes)
 */
export async function sendDeviceHeartbeat(
  deviceId: string,
  useICloud: boolean,
  log: LogFn
): Promise<void> {
  if (!useICloud) {
    return
  }

  // Update device lastSeen in its own file
  const deviceHeartbeatResult = await icloud.heartbeat(deviceId, log)
  if (deviceHeartbeatResult.status === "error") {
    log("warn", "Failed to update device heartbeat", {
      error: deviceHeartbeatResult.error.message,
    })
  }
}

/**
 * Send active device heartbeat (state.json update)
 * Only called by active device
 */
export async function sendActiveHeartbeat(
  deviceId: string,
  useICloud: boolean,
  log: LogFn
): Promise<void> {
  if (!useICloud) {
    return
  }

  const activeHeartbeatResult = await icloud.updateActiveHeartbeat(deviceId, log)
  if (activeHeartbeatResult.status === "error") {
    log("warn", "Failed to update active device heartbeat", {
      error: activeHeartbeatResult.error.message,
    })
  }
}

/**
 * Get last update ID (iCloud or local DB)
 */
export async function getUpdateId(useICloud: boolean, log: LogFn): Promise<number> {
  if (!useICloud) {
    return localDb.getLastUpdateId(log)
  }

  const result = await icloud.getLastUpdateId(log)
  return result.status === "ok" ? result.value : 0
}

/**
 * Set last update ID (iCloud or local DB)
 */
export async function setUpdateId(
  updateId: number,
  deviceId: string,
  useICloud: boolean,
  log: LogFn
): Promise<void> {
  if (!useICloud) {
    localDb.setLastUpdateId(updateId, log)
    return
  }

  const result = await icloud.setLastUpdateId(updateId, deviceId, log)
  if (result.status === "error") {
    log("error", "Failed to update last update ID", { error: result.error.message })
  }
}

/**
 * Activate a device by number or name
 */
export async function activateDeviceByNumberOrName(
  selection: string,
  useICloud: boolean,
  log: LogFn
): Promise<{ success: boolean; message: string }> {
  if (!useICloud) {
    return {
      success: false,
      message: "iCloud coordination not enabled. Set USE_ICLOUD_COORDINATOR=true",
    }
  }

  // Check if selection is a number
  const deviceNumber = parseInt(selection, 10)
  
  if (!isNaN(deviceNumber)) {
    // Activate by number
    const statusResult = await getDeviceStatus(useICloud, log)
    
    if (!statusResult.success || !statusResult.devices) {
      return {
        success: false,
        message: "Failed to get device list",
      }
    }
    
    const device = statusResult.devices.find(d => d.number === deviceNumber)
    
    if (!device) {
      return {
        success: false,
        message: `❌ Device #${deviceNumber} not found. Use /dev to see available devices.`,
      }
    }
    
    // Activate by device name
    const result = await icloud.activateDevice(device.name, log)
    
    if (result.status === "error") {
      return {
        success: false,
        message: `Failed to activate device: ${result.error.message}`,
      }
    }
    
    return {
      success: true,
      message: `✅ Device #${deviceNumber} "${device.name}" is now ACTIVE`,
    }
  } else {
    // Activate by full device name
    const result = await icloud.activateDevice(selection, log)
    
    if (result.status === "error") {
      return {
        success: false,
        message: `Failed to activate device: ${result.error.message}`,
      }
    }
    
    return {
      success: true,
      message: `✅ Device "${selection}" is now ACTIVE`,
    }
  }
}

/**
 * Get device status with numbered selection
 */
export async function getDeviceStatus(
  useICloud: boolean,
  log: LogFn
): Promise<{ 
  success: boolean
  message: string
  devices?: Array<{ 
    number: number
    name: string
    threadId: number | null
    isActive: boolean
    lastSeenAgo: number
    heartbeatAge?: number 
  }> 
}> {
  if (!useICloud) {
    return {
      success: false,
      message: "iCloud coordination not enabled",
    }
  }

  const stateResult = await icloud.readState(log)
  const devicesResult = await icloud.readDevices(log)

  if (stateResult.status === "error" || devicesResult.status === "error") {
    return {
      success: false,
      message: "Failed to read device status",
    }
  }

  const state = stateResult.value
  const devices = devicesResult.value

  // Sort devices: active first, then by lastSeen (most recent first)
  const sortedDevices = Object.values(devices).sort((a, b) => {
    const aIsActive = state.activeDevice === a.name
    const bIsActive = state.activeDevice === b.name
    if (aIsActive && !bIsActive) return -1
    if (!aIsActive && bIsActive) return 1
    return b.lastSeen - a.lastSeen
  })

  const deviceList = sortedDevices.map((dev, index) => ({
    number: index + 1,  // 1-based numbering
    name: dev.name,
    threadId: dev.threadId,
    isActive: state.activeDevice === dev.name,
    lastSeenAgo: Date.now() - dev.lastSeen,
    heartbeatAge: state.activeDevice === dev.name 
      ? Date.now() - state.activeDeviceHeartbeat 
      : undefined,
  }))

  let message = "*Registered Devices:*\n\n"
  
  for (const dev of deviceList) {
    const status = dev.isActive ? "🟢 ACTIVE" : "⚪ Standby"
    const seenAgo = Math.floor(dev.lastSeenAgo / 1000)
    
    // Show number in brackets for easy selection
    message += `${status} [${dev.number}] \`${dev.name}\`\n`
    message += `  Thread: ${dev.threadId || "all"}\n`
    message += `  Last seen: ${seenAgo}s ago\n`
    
    if (dev.isActive && dev.heartbeatAge !== undefined) {
      const heartbeatAgo = Math.floor(dev.heartbeatAge / 1000)
      const isStale = dev.heartbeatAge > icloud.HEARTBEAT_TIMEOUT_MS
      const heartbeatStatus = isStale ? "⚠️ STALE" : "✅"
      message += `  Heartbeat: ${heartbeatAgo}s ago ${heartbeatStatus}\n`
    }
    
    message += "\n"
  }

  if (deviceList.length === 0) {
    message = "No devices registered yet."
  } else {
    message += `\n_Use /use <number> to activate a device_\n`
    message += `_Heartbeat timeout: ${icloud.HEARTBEAT_TIMEOUT_MS / 1000}s_`
  }

  return {
    success: true,
    message,
    devices: deviceList,
  }
}

// Export unified randomization system
export const RANDOMIZATION = icloud.RANDOMIZATION
export const getRandomizedInterval = icloud.getRandomizedInterval

/**
 * Get randomized check interval (standby devices)
 * Returns: 30-40 seconds (randomized)
 */
export function getRandomizedCheckInterval(): number {
  return getRandomizedInterval(
    RANDOMIZATION.CHECK_BASE_MS,
    RANDOMIZATION.CHECK_JITTER_MS
  )
}

/**
 * Get randomized heartbeat interval for ACTIVE devices
 * Returns: 30-40 seconds (randomized)
 */
export function getRandomizedActiveHeartbeatInterval(): number {
  return getRandomizedInterval(
    RANDOMIZATION.ACTIVE_HEARTBEAT_BASE_MS,
    RANDOMIZATION.ACTIVE_HEARTBEAT_JITTER_MS
  )
}

/**
 * Get randomized heartbeat interval for STANDBY devices
 * Returns: 5-6 minutes (300-360 seconds, randomized)
 */
export function getRandomizedStandbyHeartbeatInterval(): number {
  return getRandomizedInterval(
    RANDOMIZATION.STANDBY_HEARTBEAT_BASE_MS,
    RANDOMIZATION.STANDBY_HEARTBEAT_JITTER_MS
  )
}

/**
 * Get randomized failover jitter
 * Returns: 0-10 seconds (randomized)
 */
export function getRandomizedFailoverJitter(): number {
  return Math.random() * RANDOMIZATION.FAILOVER_JITTER_MS
}

export { DEVICE_NAME }
