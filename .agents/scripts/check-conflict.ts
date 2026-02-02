#!/usr/bin/env bun
/**
 * Check if a mirror instance is already running on a specific directory
 * Uses iCloud coordination device registry
 */

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

const ICLOUD_BASE = join(
  process.env.HOME || "",
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs"
)

const DEVICES_DIR = join(ICLOUD_BASE, "opencode-telegram-mirror", "devices")

interface DeviceInfo {
  name: string
  threadId: number | null
  lastSeen: number
  hostname: string
  directory: string
  pid: number
}

async function checkConflict(targetDirectory: string): Promise<{
  hasConflict: boolean
  conflictingDevice?: DeviceInfo
}> {
  try {
    const files = await readdir(DEVICES_DIR)
    const jsonFiles = files.filter(f => f.endsWith(".json"))
    
    const currentHostname = require("node:os").hostname()
    const now = Date.now()
    const staleThreshold = 5 * 60 * 1000 // 5 minutes
    
    for (const file of jsonFiles) {
      const content = await readFile(join(DEVICES_DIR, file), "utf-8")
      const device: DeviceInfo = JSON.parse(content)
      
      // Check if same hostname and same directory
      if (device.hostname === currentHostname && device.directory === targetDirectory) {
        // Check if device is still alive (lastSeen within 5 minutes)
        const age = now - device.lastSeen
        
        if (age < staleThreshold) {
          // Verify process is actually running
          try {
            process.kill(device.pid, 0) // Signal 0 = check if process exists
            return { hasConflict: true, conflictingDevice: device }
          } catch {
            // Process not running, no conflict
            continue
          }
        }
      }
    }
    
    return { hasConflict: false }
  } catch (error) {
    // iCloud directory doesn't exist or other error - no conflict
    return { hasConflict: false }
  }
}

// Run if called directly
if (import.meta.main) {
  const targetDir = process.argv[2]
  
  if (!targetDir) {
    console.error("Usage: bun check-conflict.ts <directory>")
    process.exit(1)
  }
  
  const result = await checkConflict(targetDir)
  
  if (result.hasConflict) {
    console.log("CONFLICT")
    console.log(JSON.stringify(result.conflictingDevice, null, 2))
    process.exit(1)
  } else {
    console.log("OK")
    process.exit(0)
  }
}

export { checkConflict }
