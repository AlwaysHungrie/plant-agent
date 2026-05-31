# PlantAgent — Background Task Handling, Edge Cases & Fixes

_Report generated 2026-05-31. Covers the scheduler/BLE/pump pipeline in
`plant-agent/` (Expo app) and `pump-operator/physical_agent/physical_agent.ino`
(ESP32 firmware)._

> **Status (2026-05-31): Fixes 1–7 implemented.** The chain can no longer
> silently die (foreground execution + guaranteed reschedule + safety-net alarm
> + self-heal-on-open), Stop/Reschedule deterministically win over an in-flight
> run (lock + generation), pumps that don't fit the wake window are deferred
> instead of cut mid-pour, and the firmware no longer deep-sleeps while the pump
> is active. Fixes 8–9 (manual `kill`, refire floor — partly covered by
> `MIN_FIRE_AHEAD_MS`) remain optional. **The ESP32 must be reflashed** with the
> updated `.ino` for Fix 6 to take effect.

---

## 1. How it works today

### 1.1 The two halves

**Firmware (ESP32, "PhysicalAgent")** — `physical_agent.ino`

- Relay-driven pump on GPIO 18 (active-LOW: `LOW` = on, `HIGH` = off).
- **Sleep cycle:** awake `WAKE_DURATION_MS = 120s`, then `esp_deep_sleep` for
  `SLEEP_DURATION_US = 30s`, repeat. Full period ≈ **150s**.
  During deep sleep the radio is **off** — the device is neither advertising,
  discoverable, nor connectable.
- On BLE connect it pushes one notification:
  `sys_info,<ms_until_sleep>,<sleep_duration_ms>` where `ms_until_sleep` is how
  long the current wake window has left and `sleep_duration_ms` is always 30000.
- Commands written to the WRITE characteristic:
  - `operate_pump,<seconds>` → `pumpOn()`, sets `pumpEndTime = millis() + seconds*1000`.
  - `kill` → `pumpOff()`.
- **Sleep takes precedence over the pump** (`loop()`): when `millis() >= sleepAt`
  the device calls `pumpOff()` and deep-sleeps *even if the pump timer has not
  expired*. State `inSleepCycle` lives in `RTC_DATA_ATTR` — it survives deep
  sleep but **not** a full power loss.

**App (Expo / React Native)**

- `scheduler-task.ts` holds the job logic and persistence (AsyncStorage keys:
  `JOB_STATE_KEY`, `ACTIVE_NOTIF_ID_KEY`, `AUTH_TOKEN_KEY`, `CHECKIN_LOG_KEY`).
- Scheduling is a **single Notifee `TriggerNotification`** of type `TIMESTAMP`
  with `alarmManager.allowWhileIdle`. Android `AlarmManager` fires it (exact-alarm
  + boot perms are declared in the manifest).
- **The chain is a linked list, not a repeating alarm.** Each successful job run
  schedules *exactly one* next alarm at the end of `executeJob`. There is no
  periodic/recurring alarm and no watchdog.

### 1.2 A normal cycle

1. User taps **Schedule check-ins** (`index.tsx → scheduleJob`). App connects,
   reads `sys_info`, computes
   `fireAt = max(now+1s, readAt + (msUntilSleep + 30000) − 3000)`
   (the `WAKEUP_LEAD_MS = 3s` makes the alarm fire ~3s *before* the device's next
   wake so the BLE connect is already in flight when the radio comes back).
   Schedules the trigger, saves `JobState`.
2. Alarm fires → Notifee delivers a `DELIVERED` event.
3. **If the app is killed/backgrounded:** `index.js`'s `onBackgroundEvent`
   (HeadlessJS) runs `executeJob`:
   - connect + read `sys_info` (abort if null),
   - capture photo (foreground-service camera) + fire-and-forget upload,
   - `GET /messages/pending`, for each: `connectAndOperatePump(duration)` then
     `PATCH /messages/:id {received:true}` on success,
   - compute next `fireAt`, schedule next trigger, write `ACTIVE_NOTIF_ID`,
     save `JobState`, append `CheckinLog`.
4. Repeat.

### 1.3 Where execution actually lives

| App state when alarm fires | Handler that runs | Does it run `executeJob`? |
|---|---|---|
| Killed / swiped away | `index.js` `onBackgroundEvent` (HeadlessJS) | **Yes** |
| Backgrounded (recent apps) | `index.js` `onBackgroundEvent` | **Yes** |
| **Foreground (open on screen)** | `index.tsx` / `scheduler.tsx` `onForegroundEvent` | **NO — UI refresh only** |

That last row is the core defect (see Edge Case A).

---

## 2. "What happens if I open the app mid-schedule?"

This was the explicit question. Two sub-cases:

### 2.1 App opened while a job is **scheduled but not yet firing**
Mostly harmless. The foreground/`useFocusEffect`/`AppState` listeners reload
`JobState` and re-render the countdown. The pending `AlarmManager` trigger is
untouched. **But** if the alarm happens to fire *while you are looking at the
app*, see 2.2 — it will be swallowed.

### 2.2 App opened (or already open) when the alarm **fires** — BROKEN
Notifee delivers the `DELIVERED` event to `onForegroundEvent`, **not** to the
HeadlessJS `onBackgroundEvent`. The foreground handlers only do
`loadJobState().then(setJobState)` — they **do not call `executeJob`**. Result:

- no BLE connect, no photo, no pump, no ack,
- **and no next alarm is scheduled** → the linked-list chain terminates.

This is almost certainly the *"sometimes a job is fired but it remains
incomplete and the next job is never fired"* symptom you described. The recovery
you've been doing by hand (open app → cancel → reschedule) is the only thing that
re-arms the chain.

### 2.3 App opened while a background job is **currently running**
There is **no re-entrancy guard**. Opening the app triggers `useFocusEffect` /
`AppState 'active'` reads (safe), but if the user taps **Reschedule** or **Stop**
while the HeadlessJS job is mid-flight, the two paths race over the same
AsyncStorage keys and the same single BleManager:

- **Stop** clears `JobState` + cancels `ACTIVE_NOTIF_ID`, but the in-flight job
  reaches its end and *re-schedules a fresh trigger + re-saves `JobState`* →
  cancel doesn't stick (zombie chain).
- **Reschedule** creates a second trigger while the job creates its own → two
  competing chains, double pumps over time.
- Two concurrent `connectToDevice` calls on the one process-global BleManager to
  the same peripheral → connection errors, partial pumps.

---

## 3. Edge cases (full list)

Severity: 🔴 breaks the chain / wrong watering · 🟠 degraded · 🟡 minor.

### 🔴 A. Foreground alarm is swallowed → chain dies
As in §2.2. The single most likely cause of your observed "job fired, never
fired again." **Highest priority.**

### 🔴 B. Any `executeJob` early-return kills the chain forever
`executeJob` reschedules the next alarm **only at the very end**. Several paths
return before that with no reschedule:

- `if (!sysInfo) return null;` (line ~137) — BLE read failed.
- An unhandled throw anywhere in the body.

Because the chain is a linked list, *one* failed run = permanently dead
scheduler. This is the mechanism behind your *"job starts but can't find the
device because the device is asleep/off"* case: the alarm fires, the device is in
its 30s sleep (or phase-shifted after a power cut), `connectAndReadSysInfo`
returns `null`, the job aborts **without rescheduling**, and nothing ever fires
again.

### 🔴 C. Pump cut off mid-run by firmware sleep precedence
Firmware sleeps at `sleepAt` regardless of `pumpActive`. If a pump command lands
late in the wake window (very likely — BLE connect + `sys_info` read + photo +
pending-fetch all burn time before the pump write), the remaining wake budget can
be < `duration_sec`. The device waters partially, then deep-sleeps. The app has
**already written the command successfully**, so it `PATCH`es `received:true` →
**under-watering recorded as success.** Matches *"pump turns off before the job
is completed."*

### 🔴 D. Multi-message pumping overruns the wake window
`executeJob` loops over *all* pending messages sequentially, each a full
connect→pump→disconnect→ack. Total time easily exceeds the 120s wake window. Once
the device sleeps, later `connectAndOperatePump` calls fail (`ok=false`, message
*not* acked — that part self-heals next cycle), but the message that was pumping
at the sleep boundary is acked as a partial pour (same as C).

### 🔴 E. Power outage resets firmware phase → app fires at the wrong time
On power loss `inSleepCycle` (RTC memory) is lost. Reboot is treated as **first
boot**, so the wake window restarts from `millis()=0` and the 150s phase shifts
arbitrarily relative to the app's last-computed `fireAt`. The next app alarm now
lands at a random point in the device's cycle — possibly during the 30s sleep →
connect fails → combines with Edge Case B → dead chain. Self-watering does not
resume until the user manually reschedules.

### 🟠 F. No re-entrancy / cancel-vs-run race
As in §2.3. No lock, no generation token. Stop can be undone by an in-flight job;
double schedules spawn parallel chains.

### 🟠 G. Process killed mid-run (OOM / OEM battery killer / user swipe)
If the process dies after the alarm fires but before the reschedule line (~210),
the whole BLE+photo+pump window (tens of seconds) is unprotected → chain dies.
No durable "next alarm" exists during a run.

### 🟠 H. Radio/Doze timing drift erodes the 3s lead
BLE is a radio and the alarm is mediated by Android. The design fires
`3s` before the predicted wake. Tolerance is asymmetric:

- Firing **late** by up to ~120s is fine (device is awake the whole window).
- Firing **early**, or late by >120s, lands in/after the 30s sleep → connect
  fails → Edge Case B.

Under Doze / aggressive OEMs, even `setExactAndAllowWhileIdle` alarms get
deferred, and each missed/failed cycle is terminal because of B. There is no
catch-up logic.

### 🟡 I. `kill` command is never used by the app
The firmware supports `kill`, but the app never sends it. There is no way to
abort a runaway pump from software except waiting for `pumpEndTime` or the sleep
boundary.

### 🟡 J. `fireAt` floor can cause a tight loop
`fireAt = max(now+1000, …)`. If `sys_info` is stale/small or the read is slow,
`fireAt` collapses to `now+1s`, producing near-back-to-back fires.

### 🟡 K. Reboot relies on Notifee's boot receiver
`RECEIVE_BOOT_COMPLETED` is declared and Notifee re-arms trigger notifications on
boot, so a phone reboot *usually* survives — but if the chain had already died
(A/B/E) before reboot, there's nothing to restore.

### 🟡 L. `ACTIVE_NOTIF_ID` vs `JobState.notificationId` can desync
Two sources of truth for "the live trigger." `executeJob` writes
`ACTIVE_NOTIF_ID` *after* scheduling and also stores it in `JobState`; manual
schedule/cancel touches both. Interleavings can orphan a trigger that still
fires.

---

## 4. Proposed fixes

Ordered by impact. The first three eliminate the "dead chain" class entirely.

### Fix 1 — Run the job in the foreground too (kills Edge Case A) 🔴
In both `onForegroundEvent` handlers, when
`detail.notification?.data?.notifType === NOTIF_DATA_TYPE` and
`type === EventType.DELIVERED`, call `executeJob(intervalSeconds, notifId)`
(guarded by the lock from Fix 3), then refresh the UI. Best done by extracting a
shared `handleDeliveredEvent()` used by `index.js`, `index.tsx`, and
`scheduler.tsx` so foreground and background behave identically.

### Fix 2 — Guarantee a reschedule on *every* path (kills B & G) 🔴
Make rescheduling unconditional:

- Wrap the body of `executeJob` in `try { … } finally { … }`. In `finally`,
  if no successful next-alarm was scheduled this run, schedule a **retry alarm**
  (e.g. `now + SLEEP_DURATION + small jitter`, ~30–45s) so a failed read just
  retries instead of dying.
- **Arm before you work:** at the very start of a run, schedule a *fallback*
  trigger a bit past the expected next-wake; on success, cancel/replace it with
  the real one. This way a mid-run crash (G) still leaves a future alarm.
- Net rule: **there must always be ≥1 future alarm pending.** The chain becomes
  self-healing instead of a fragile linked list.

### Fix 3 — Re-entrancy lock + cancel generation token (kills F, §2.3) 🟠
- Store a `job_running` lease in AsyncStorage (`{startedAt}`); `executeJob`
  bails if a fresh lease exists (treat stale > N min as crashed). Clear in
  `finally`.
- Add a monotonically increasing `scheduleGeneration`. `cancelJob` increments it
  and clears state. `executeJob` captures the generation at start and **re-reads
  it just before rescheduling**; if it changed (user hit Stop) or state was
  cleared, it skips the reschedule. Cancel now wins deterministically.

### Fix 4 — Self-heal on app open (covers E, residual A/B) 🔴
On `AppState 'active'` / focus, reconcile:

```
const triggers = await notifee.getTriggerNotifications();
const live = triggers.some(t => t.notification.data?.notifType === NOTIF_DATA_TYPE);
if (jobState && !live) {
  // chain died — re-arm now (or after a quick sys_info read)
}
if (jobState && jobState.willFireAt < Date.now() - GRACE && !live) { /* same */ }
```

This automates exactly the manual "open → cancel → reschedule" recovery you do
today.

### Fix 5 — Respect the wake budget before pumping (kills C & D, app side) 🔴
The app knows `msUntilSleep` from the `sys_info` read at the top of the job. Before
each `connectAndOperatePump(duration)`:

- compute remaining wake budget = `msUntilSleep − (now − readAt) − margin`;
- only pump if `duration*1000` fits; otherwise **defer** (don't ack — it stays
  pending and runs next cycle).
- Optionally re-read `sys_info` right before the pump for a fresh budget.

This stops partial pours being acked as complete.

### Fix 6 — Firmware: don't sleep while the pump is active (kills C at the root) 🔴
In `loop()`, gate the sleep on the pump:

```c
if (now >= sleepAt) {
  if (pumpActive && pumpEndTime > now) {
    // defer sleep until the pump finishes (clamp to a max so a bad
    // command can't keep us awake forever)
    sleepAt = min(pumpEndTime + 200, now + MAX_PUMP_EXTENSION_MS);
  } else {
    // ... existing deep-sleep path ...
  }
}
```

Trade-off: slightly more awake time / power on watering cycles, in exchange for
correct dose. Add a hard clamp so a malformed `operate_pump` can't pin the device
awake.

### Fix 7 — Firmware: make phase survive power loss (mitigates E) 🟠
`RTC_DATA_ATTR` is lost on power cut. Options:

- Persist a boot epoch / cycle marker to NVS (`Preferences`) so a cold boot can
  detect it just rebooted and (a) advertise immediately (already does) and
  (b) optionally shorten the first wake window to resync faster.
- Simpler: rely on **Fix 2 + Fix 4** — the app re-reads `sys_info` every cycle and
  resyncs phase on the first successful reconnect, so the only cost of a power cut
  is one or two retried cycles instead of a dead chain. Document this as the
  intended recovery path.

### Fix 8 — Use `kill` + add a manual "stop pump" affordance (addresses I) 🟡
Wire `connectAndKillPump()` (write `kill`) and expose it from the UI / a
notification action for runaway-pump safety.

### Fix 9 — Floor `fireAt` to a sane minimum (addresses J) 🟡
Replace `now + 1000` with `now + MIN_INTERVAL_MS` (e.g. one full device period)
to prevent tight refire loops on a stale/small `sys_info`.

---

## 5. Suggested implementation order

1. **Fix 2** (guaranteed reschedule) — stops permanent death immediately, even
   before anything else lands.
2. **Fix 1** (foreground execution) — closes the most common trigger of the bug.
3. **Fix 3** (lock + generation) — makes 1 & 2 safe under concurrency.
4. **Fix 4** (self-heal on open) — automates your manual recovery.
5. **Fix 5 + Fix 6** (wake-budget aware pumping) — fixes under-watering.
6. **Fix 7 / 8 / 9** — hardening.

Fixes 1–4 are app-only and together should eliminate the "job fired but never
fires again, must manually reschedule" failure. Fixes 5–6 address the
"pump turns off before the job completes" failure. Fix 7 (+2/4) addresses the
power-outage reset.

---

## 6. File reference

| Concern | File |
|---|---|
| HeadlessJS background handler | `plant-agent/index.js` |
| Job logic, persistence, scheduling | `plant-agent/src/tasks/scheduler-task.ts` |
| BLE connect / sys_info / pump | `plant-agent/src/tasks/ble-task.ts` |
| Camera capture + upload | `plant-agent/src/tasks/camera-capture.ts` |
| Home screen (schedule/cancel, foreground listener) | `plant-agent/src/app/index.tsx` |
| Logs screen (foreground listener) | `plant-agent/src/app/scheduler.tsx` |
| Firmware (sleep cycle, pump, sys_info) | `pump-operator/physical_agent/physical_agent.ino` |
