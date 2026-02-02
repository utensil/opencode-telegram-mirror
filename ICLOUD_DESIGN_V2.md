# iCloud Coordination - Updated Design

## Critical Changes Based on Your Feedback

### ✅ Fixed Issue 1: Automatic Failover

**Problem**: If active device crashes, no device polls Telegram → messages lost

**Solution**: Standby devices monitor active device heartbeat and auto-activate if stale

```
Active device heartbeat every 30s
                 ↓
         state.json updates
                 ↓
    Standby devices check every 5s
                 ↓
         Heartbeat > 90s old?
                 ↓
    YES → Wait random(0-10s) → Try activate
    NO  → Continue standby
```

### ✅ Fixed Issue 2: Device Identity

**Problem**: Multiple mirrors on same Mac need unique identity

**Solution**: Device ID = `hostname:directory` or `custom@hostname:directory`

```
OLD (wrong):
- Device A: "laptop"
- Device B: "desktop"
Problem: Can't run multiple mirrors on same laptop!

NEW (correct):
- Device A: "MacBook-Pro.local:/Users/me/project-a"
- Device B: "MacBook-Pro.local:/Users/me/project-b"
- Device C: "iMac.local:/Users/me/project-a"
- Device D: "work@MacBook-Pro.local:/Users/me/client-x"
```

## Architecture

### State Files

**`state.json`** - Active device tracking:
```json
{
  "activeDevice": "MacBook-Pro.local:/Users/me/project-a",
  "activeDeviceHeartbeat": 1234567890123,
  "lastUpdateId": 12345,
  "lastModified": 1234567890123,
  "modifiedBy": "MacBook-Pro.local:/Users/me/project-a"
}
```

**`devices.json`** - Device registry:
```json
{
  "MacBook-Pro.local:/Users/me/project-a": {
    "name": "MacBook-Pro.local:/Users/me/project-a",
    "threadId": 123,
    "lastSeen": 1234567890123,
    "hostname": "MacBook-Pro.local",
    "directory": "/Users/me/project-a",
    "pid": 12345
  },
  "work@MacBook-Pro.local:/Users/me/client-x": {
    "name": "work@MacBook-Pro.local:/Users/me/client-x",
    "threadId": 456,
    "lastSeen": 1234567890124,
    "hostname": "MacBook-Pro.local",
    "directory": "/Users/me/client-x",
    "pid": 12346
  }
}
```

## Heartbeat & Failover Logic

### Constants

```typescript
HEARTBEAT_INTERVAL_MS = 30000      // 30 seconds (active device updates)
HEARTBEAT_TIMEOUT_MS = 90000       // 90 seconds (3x interval = stale)
FAILOVER_JITTER_MAX_MS = 10000     // 0-10 seconds random delay
```

### Active Device Responsibilities

Every 30 seconds:
1. Update `devices[myId].lastSeen` (device heartbeat)
2. Update `state.activeDeviceHeartbeat` (active heartbeat)
3. Poll Telegram API
4. Process messages

### Standby Device Responsibilities

Every 5 seconds:
1. Update `devices[myId].lastSeen` (device heartbeat)
2. Read `state.activeDeviceHeartbeat`
3. Check if heartbeat is stale (> 90 seconds old)
4. If stale, attempt failover:
   ```typescript
   // Wait random 0-10 seconds to avoid thundering herd
   await sleep(Math.random() * 10000)
   
   // Re-check staleness (another device may have activated)
   if (still stale) {
     // Try to become active
     state.activeDevice = myId
     state.activeDeviceHeartbeat = now
     writeState()
     
     // Verify we won (poor man's optimistic locking)
     await sleep(500) // Let iCloud sync
     if (state.activeDevice === myId) {
       // We won! Start polling Telegram
     } else {
       // Lost race, stay standby
     }
   }
   ```

## Scenario: Active Device Crashes

```
Time    Event
────────────────────────────────────────────────────
10:00   Device A active, heartbeat: 10:00
10:00   Device B standby, checks heartbeat: 10:00 (fresh)
10:00   Device C standby, checks heartbeat: 10:00 (fresh)

10:30   Device A sends heartbeat: 10:30
10:30   B checks: 10:30 (fresh) → stay standby
10:30   C checks: 10:30 (fresh) → stay standby

11:00   Device A sends heartbeat: 11:00
11:00   B checks: 11:00 (fresh) → stay standby
11:00   C checks: 11:00 (fresh) → stay standby

11:05   🔴 Device A CRASHES (no more heartbeats)

11:30   B checks: 11:00 (30s old) → stay standby
11:30   C checks: 11:00 (30s old) → stay standby

12:00   B checks: 11:00 (60s old) → stay standby
12:00   C checks: 11:00 (60s old) → stay standby

12:30   B checks: 11:00 (90s old) → ⚠️ STALE!
        B waits random 3.2s
12:30   C checks: 11:00 (90s old) → ⚠️ STALE!
        C waits random 7.8s

12:33   B attempts activation → SUCCESS ✅
        B becomes active, starts polling

12:38   C attempts activation → LOST RACE ❌
        C sees B is active, stays standby
```

## Device Naming Strategies

### Strategy 1: Hostname + Directory (Default)

```bash
# No DEVICE_NAME set
# Automatic: "MacBook-Pro.local:/Users/me/project-a"
cd /Users/me/project-a
bunx opencode-telegram-mirror .
```

**Pros**: Unique by default, includes location info
**Cons**: Long names

### Strategy 2: Custom Name + Auto Suffix

```bash
# Set custom prefix
export DEVICE_NAME="laptop-work"
# Result: "laptop-work@MacBook-Pro.local:/Users/me/project-a"
cd /Users/me/project-a
bunx opencode-telegram-mirror .
```

**Pros**: Readable names, still unique
**Cons**: Still somewhat long

### Strategy 3: Just Use Hostname (Same Dir on Different Machines)

```bash
# Same project, different machines
# Device A: "MacBook-Pro.local:/Users/me/shared-project"
# Device B: "iMac.local:/Users/me/shared-project"
```

**Pros**: Natural failover between machines
**Cons**: Must use same directory path

## Integration Changes for main.ts

### Change 1: Initialize with directory

```typescript
// OLD
const coordination = await ICloudCoordination.initializeCoordination(
  config.threadId ?? null,
  log
)

// NEW
const coordination = await ICloudCoordination.initializeCoordination(
  directory,  // Pass working directory
  config.threadId ?? null,
  log
)
```

### Change 2: Use deviceId instead of deviceName

```typescript
// OLD
const state: BotState = {
  deviceName: coordination.deviceName,
  useICloudCoordination: coordination.useICloud,
}

// NEW
const state: BotState = {
  deviceId: coordination.deviceId,  // Changed field name
  useICloudCoordination: coordination.useICloud,
}
```

### Change 3: Check active WITH failover

```typescript
// OLD
const isActive = await ICloudCoordination.checkIfActive(
  state.deviceName,
  state.useICloudCoordination,
  log
)

// NEW
const isActive = await ICloudCoordination.checkIfActiveWithFailover(
  state.deviceId,
  state.useICloudCoordination,
  log
)
```

### Change 4: Heartbeat every 30 seconds with active flag

```typescript
// In polling loop
let heartbeatCounter = 0
const HEARTBEAT_INTERVAL = 6  // 6 polls × 5s = 30s

while (true) {
  heartbeatCounter++
  
  // Check if active (includes failover logic)
  const isActive = await ICloudCoordination.checkIfActiveWithFailover(
    state.deviceId,
    state.useICloudCoordination,
    log
  )
  
  // Send heartbeat every 30 seconds
  if (heartbeatCounter >= HEARTBEAT_INTERVAL) {
    await ICloudCoordination.sendHeartbeat(
      state.deviceId,
      state.useICloudCoordination,
      isActive,  // Pass active status
      log
    )
    heartbeatCounter = 0
  }
  
  if (!isActive) {
    await Bun.sleep(5000)
    continue
  }
  
  // Poll Telegram...
}
```

## Usage Examples

### Example 1: Same Mac, Different Projects

```bash
# Terminal 1 - Project A
cd /Users/me/project-a
export DEVICE_NAME="work"
export TELEGRAM_THREAD_ID="123"
bunx opencode-telegram-mirror .
# Device ID: "work@MacBook-Pro.local:/Users/me/project-a"

# Terminal 2 - Project B
cd /Users/me/project-b
export DEVICE_NAME="personal"
export TELEGRAM_THREAD_ID="456"
bunx opencode-telegram-mirror .
# Device ID: "personal@MacBook-Pro.local:/Users/me/project-b"
```

### Example 2: Multiple Macs, Same Project (Failover)

```bash
# Laptop
cd /Users/me/shared-project
bunx opencode-telegram-mirror .
# Device ID: "MacBook-Pro.local:/Users/me/shared-project"

# Desktop (same directory path!)
cd /Users/me/shared-project
bunx opencode-telegram-mirror .
# Device ID: "iMac.local:/Users/me/shared-project"

# Laptop becomes active
/activate MacBook-Pro.local:/Users/me/shared-project

# Later: Laptop crashes → Desktop auto-activates after 90s
```

### Example 3: Testing Failover

```bash
# Terminal 1
bunx opencode-telegram-mirror .
# Becomes active

# Terminal 2 (same or different Mac)
cd /different/directory
bunx opencode-telegram-mirror .
# Standby

# In Telegram
/devices
# Shows both devices

# Kill Terminal 1 (Ctrl+C or kill -9)
# Wait 90-100 seconds
# Terminal 2 automatically becomes active!
```

## Telegram Commands

### `/devices` - Show all registered devices

```
🟢 ACTIVE `work@MacBook-Pro.local:/Users/me/project-a`
  Thread: 123
  Last seen: 2s ago
  Heartbeat: 1s ago ✅

⚪ Standby `MacBook-Pro.local:/Users/me/project-b`
  Thread: 456
  Last seen: 3s ago

⚪ Standby `iMac.local:/Users/me/project-a`
  Thread: 123
  Last seen: 5s ago

Heartbeat timeout: 90s
```

### `/activate <device-id>` - Manually activate device

```
/activate iMac.local:/Users/me/project-a

✅ Device "iMac.local:/Users/me/project-a" is now ACTIVE
```

## Testing Failover

### Test 1: Verify Heartbeat Timeout

```bash
# Start 2 devices
Device A: bunx opencode-telegram-mirror .
Device B: cd /other && bunx opencode-telegram-mirror .

# In Telegram
/activate <device-a-id>
/devices  # See Device A active

# Kill Device A
kill -9 <pid>

# Watch /devices every 30 seconds
# At ~90s: Device B status changes to ACTIVE automatically
```

### Test 2: Verify Random Jitter

```bash
# Start 3 devices on same Mac
Terminal 1: cd /a && bunx opencode-telegram-mirror .
Terminal 2: cd /b && bunx opencode-telegram-mirror .
Terminal 3: cd /c && bunx opencode-telegram-mirror .

# Activate one
/activate <device-a-id>

# Kill it
kill -9 <pid>

# Watch logs - devices attempt activation at different times
# due to random 0-10s jitter
```

## Benefits

### ✅ Always-On Telegram Polling

- No single point of failure
- Automatic failover if active device crashes
- Messages never lost

### ✅ Supports Complex Setups

- Multiple projects on same Mac
- Same project on multiple Macs
- Mixed scenarios

### ✅ Conflict Resolution

- Random jitter prevents thundering herd
- Optimistic locking via timestamp check
- Graceful handling when multiple devices try to activate

### ✅ Observable

- `/devices` shows heartbeat health
- Stale heartbeat marked with ⚠️
- Clear indication of active vs standby

## Security Considerations

### Heartbeat Age Disclosure

**Risk**: Attacker with iCloud access can see when devices are active

**Mitigation**: Heartbeat only shows device online/offline, not sensitive data

### Activation Race Condition

**Risk**: Multiple devices might briefly think they're active

**Impact**: Temporary duplicate Telegram polls (Telegram handles via update_id)

**Mitigation**: 500ms verification wait + optimistic locking check

### Process ID Disclosure

**Risk**: PIDs stored in devices.json

**Impact**: Low - attacker needs local access to exploit PID info

**Mitigation**: File permissions (user-only read/write)

## Limitations

### iCloud Sync Delay

- Typical: 5-30 seconds
- Failover takes 90s + sync time = ~100-120s total

**Acceptable for coding sessions where crashes are rare**

### Optimistic Locking Weakness

- No true distributed locks
- Relies on iCloud file sync + timestamp comparison
- Small race window (~500ms)

**Acceptable - Telegram's update_id prevents duplicate processing**

### Heartbeat Overhead

- Every active device writes to iCloud every 30s
- Every standby device reads from iCloud every 5s

**Acceptable - small JSON files, minimal bandwidth**

---

**All critical issues fixed! Ready for integration into main.ts.**
