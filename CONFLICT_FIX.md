# Fix: Eliminated Write Conflicts with Per-Device Files

## ❌ **The Problem You Identified**

**Original design had ALL devices writing to one file:**

```
devices.json (shared file)
├─ Device A writes lastSeen every 30s ──┐
├─ Device B writes lastSeen every 30s ──┼─→ WRITE CONFLICTS!
└─ Device C writes lastSeen every 30s ──┘
```

**What happens:**
- iCloud tries to sync devices.json
- Multiple devices modify it simultaneously
- File conflicts, lost updates, sync errors
- Potential data corruption

## ✅ **The Solution: Per-Device Files**

**New design: Each device writes ONLY to its own file:**

```
state.json (shared, only ACTIVE device writes)
├─ activeDevice: "device-a"
├─ activeDeviceHeartbeat: 123456789
└─ lastUpdateId: 100

devices/
├─ device-a.json  ← Device A writes ONLY this
├─ device-b.json  ← Device B writes ONLY this
└─ device-c.json  ← Device C writes ONLY this
```

**Key insight:**
- Each device has its OWN file
- No two devices write to the same file
- **ZERO conflicts!**

## 📁 **File Structure**

### Before (Conflict-Prone)

```
~/Library/Mobile Documents/com~apple~CloudDocs/opencode-telegram-mirror/
├── state.json          # Shared (active device writes)
└── devices.json        # ❌ ALL devices write here → CONFLICTS!
```

### After (Conflict-Free)

```
~/Library/Mobile Documents/com~apple~CloudDocs/opencode-telegram-mirror/
├── state.json          # Shared (only active device writes)
└── devices/
    ├── MacBook-Pro.local:-Users-me-project-a.json   # Device A only
    ├── iMac.local:-Users-me-project-b.json          # Device B only
    └── work@MacBook-Pro.local:-Users-me-client.json # Device C only
```

## 🔄 **Write Patterns**

### state.json (Low Conflict Risk)

**Who writes:** Only the ACTIVE device

```typescript
Active Device (every 30s):
├─ Update activeDeviceHeartbeat
├─ Update lastUpdateId (when polls Telegram)
└─ Update lastModified

Standby Devices:
└─ NEVER write (only read) ✅
```

**Conflict risk:** Very low (only one writer at a time)

### devices/*.json (Zero Conflicts)

**Who writes:** Each device writes ONLY its own file

```typescript
Device A:
└─ Writes devices/device-a.json ✅

Device B:
└─ Writes devices/device-b.json ✅

Device C:
└─ Writes devices/device-c.json ✅
```

**Conflict risk:** **ZERO** (completely separate files)

## 🔧 **Implementation Changes**

### File Operations

```typescript
// OLD (shared file - conflicts!)
async function heartbeat(deviceId: string) {
  const devices = await readDevices()        // Read ALL devices
  devices[deviceId].lastSeen = Date.now()    // Modify one entry
  await writeDevices(devices)                // Write ENTIRE file
  // ⚠️ Another device might have modified the file!
}

// NEW (per-device file - no conflicts!)
async function heartbeat(deviceId: string) {
  const device = await readDeviceFile(deviceId)   // Read OUR file
  device.lastSeen = Date.now()                    // Modify
  await writeDeviceFile(deviceId, device)         // Write OUR file
  // ✅ No other device touches this file!
}
```

### Reading All Devices

```typescript
// Read all device files from devices/ directory
async function readDevices(): Promise<Record<string, DeviceInfo>> {
  const files = await readdir(DEVICES_DIR)
  const devices: Record<string, DeviceInfo> = {}
  
  for (const file of files.filter(f => f.endsWith('.json'))) {
    const content = await readFile(join(DEVICES_DIR, file))
    const device = JSON.parse(content)
    devices[device.name] = device
  }
  
  return devices
}
```

## 📊 **Conflict Analysis**

### state.json Write Frequency

| Operation | Frequency | Who Writes |
|-----------|-----------|------------|
| Update active heartbeat | Every 30s | Active device only |
| Set last update ID | ~Every 5s | Active device only |
| Activate device | Manual | User via /activate command |
| Failover | ~Every 100s | One standby (after jitter) |

**Total writers:** 1 device at a time (very low conflict)

### devices/*.json Write Frequency

| Operation | Frequency | Who Writes |
|-----------|-----------|------------|
| Device heartbeat | Every 30s | Each device writes its OWN file |

**Total writers:** N devices, N separate files (**zero conflict**)

## 🧪 **Testing Conflict Scenarios**

### Test 1: Concurrent Heartbeats

```bash
# Start 3 devices
Device A: bunx opencode-telegram-mirror .
Device B: cd /other && bunx opencode-telegram-mirror .
Device C: cd /another && bunx opencode-telegram-mirror .

# All send heartbeat at same time (every 30s)
# Watch: ls -la ~/Library/Mobile\ Documents/.../devices/
# Result: 3 separate files, all update independently ✅
```

### Test 2: Failover + Heartbeat Collision

```bash
# Active device crashes
# Multiple standbys try failover simultaneously
# Each also updates its own heartbeat

# state.json: 1 device wins activation (optimistic locking)
# devices/*.json: ALL devices update their own files (no conflict)
```

### Test 3: Read While Writing

```bash
# Device A writing devices/device-a.json
# Device B reading all devices/*.json files
# Result: No conflict (read doesn't block write on different files)
```

## 🎯 **Benefits**

### ✅ Eliminated Write Conflicts

- Each device writes to separate file
- No coordination needed
- Works even with slow iCloud sync

### ✅ Simplified Logic

- No need for distributed locking
- No retry logic for writes
- No conflict resolution code

### ✅ Better Performance

- Devices don't re-write entire registry
- Smaller file writes (single device vs all devices)
- Less iCloud bandwidth

### ✅ Automatic Cleanup

```typescript
// Clean up devices not seen for > 24 hours
await cleanupStaleDevices()
// Removes: devices/old-laptop-12345.json
```

## 🔒 **Remaining Low-Risk Conflict: state.json**

**When it happens:**
- Multiple standbys detect stale heartbeat simultaneously
- All try to become active within ~10 seconds

**How we handle it:**
1. Random jitter (0-10s) spreads attempts
2. Each device reads before writing
3. Timestamp-based optimistic locking
4. Verification read after write (500ms delay)
5. Losers gracefully stay standby

**Impact:** Minimal - Telegram's update_id prevents duplicate processing

## 📝 **Migration**

If you have old `devices.json`:

```bash
# Automatic migration on first run
# Each device creates its own file on startup
# Old devices.json can be safely deleted

rm ~/Library/Mobile\ Documents/.../devices.json  # Optional cleanup
```

## Summary

| Aspect | Before | After |
|--------|--------|-------|
| **Write conflicts** | ❌ High (all devices → 1 file) | ✅ Zero (each device → own file) |
| **Conflict resolution** | ❌ Required | ✅ Not needed |
| **iCloud sync stress** | ❌ High (large file updates) | ✅ Low (small separate files) |
| **Code complexity** | ❌ Need retry logic | ✅ Simple writes |
| **Performance** | ❌ Slow (full file writes) | ✅ Fast (single device writes) |

---

**Problem solved! Write conflicts eliminated through per-device file architecture.**
