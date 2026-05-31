import notifee, { AndroidImportance, TriggerType } from '@notifee/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { connectAndOperatePump, connectAndReadSysInfo } from './ble-task';
import { takePicture, uploadPhotoFireAndForget } from './camera-capture';

const BASE_URL = 'https://message-api.dhairyashah98.workers.dev';
const WAKEUP_LEAD_MS = 3_000;

export const CHANNEL_ID = 'scheduler';
export const NOTIF_DATA_TYPE = 'scheduler-job';
export const JOB_STATE_KEY = 'scheduler_job_state_v2';
export const ACTIVE_NOTIF_ID_KEY = 'scheduler_active_notif_id';
export const AUTH_TOKEN_KEY = 'scheduler_auth_token';
export const CHECKIN_LOG_KEY = 'scheduler_checkin_log_v1';
export const JOB_LOCK_KEY = 'scheduler_job_lock_v1';
export const SCHEDULE_GEN_KEY = 'scheduler_generation_v1';
const MAX_LOG_ENTRIES = 10;

// A run that hasn't released its lock within this window is treated as crashed.
const LOCK_STALE_MS = 3 * 60_000;
// On a failed/aborted run, retry this soon (≈ one device sleep) instead of dying.
const RETRY_DELAY_MS = 35_000;
// Safety-net alarm armed at the START of every run so a mid-run crash still
// leaves a future alarm pending. Replaced by the real next-alarm on success.
const FALLBACK_DELAY_MS = 90_000;
// Never schedule a trigger closer than this — guards against tight refire loops.
const MIN_FIRE_AHEAD_MS = 5_000;
// Wake-window margin: a pump must finish this long before the device sleeps.
const PUMP_WAKE_MARGIN_MS = 3_000;

// In-process guard. Foreground listeners (Home + Logs) share one JS runtime, so
// this dedupes them synchronously before the async AsyncStorage lease is read.
let _runningInProcess = false;

// ── re-entrancy lock + cancel generation ────────────────────────────────────

export async function loadGeneration(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(SCHEDULE_GEN_KEY);
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}

// Bumped whenever the user schedules or cancels. An in-flight job captures the
// generation at start and refuses to re-arm if it has changed since — so a
// Stop/Reschedule deterministically wins the race against a running job.
export async function bumpGeneration(): Promise<number> {
  const next = (await loadGeneration()) + 1;
  await AsyncStorage.setItem(SCHEDULE_GEN_KEY, String(next));
  return next;
}

async function acquireLock(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(JOB_LOCK_KEY);
    if (raw) {
      const startedAt = Number(raw);
      if (Number.isFinite(startedAt) && Date.now() - startedAt < LOCK_STALE_MS) return false;
    }
    await AsyncStorage.setItem(JOB_LOCK_KEY, String(Date.now()));
    return true;
  } catch {
    return true;
  }
}

async function releaseLock(): Promise<void> {
  await AsyncStorage.removeItem(JOB_LOCK_KEY).catch(() => {});
}

// Arm the single active trigger, replacing any existing one. Returns the new
// notif id, or null if the schedule was cancelled (generation changed) — in
// which case nothing is armed.
export async function armTrigger(
  fireAt: number,
  intervalSeconds: number,
  gen: number,
): Promise<string | null> {
  const cur = await loadGeneration();
  if (cur !== gen) {
    console.log('[Job]', `generation changed (${gen} → ${cur}) — not arming`);
    return null;
  }
  const prev = await AsyncStorage.getItem(ACTIVE_NOTIF_ID_KEY).catch(() => null);
  if (prev) await notifee.cancelTriggerNotification(prev).catch(() => {});
  const safeFireAt = Math.max(Date.now() + MIN_FIRE_AHEAD_MS, fireAt);
  const id = await scheduleJobNotification(intervalSeconds, safeFireAt);
  await AsyncStorage.setItem(ACTIVE_NOTIF_ID_KEY, id);
  return id;
}

// Cancel the schedule for good. Bumps the generation (so any in-flight job
// refuses to re-arm), cancels the actually-armed trigger, and clears state.
export async function cancelSchedule(): Promise<void> {
  await bumpGeneration();
  const active = await AsyncStorage.getItem(ACTIVE_NOTIF_ID_KEY).catch(() => null);
  if (active) await notifee.cancelTriggerNotification(active).catch(() => {});
  await clearJobState();
}

// Re-arm a dead chain. Called when the app opens and finds an active JobState
// but no live trigger (chain died from a swallowed/failed/crashed run).
export async function ensureScheduleArmed(): Promise<boolean> {
  const state = await loadJobState();
  if (!state) return false;
  const triggers = await notifee.getTriggerNotifications().catch(() => []);
  const live = triggers.some(
    t => (t.notification?.data as any)?.notifType === NOTIF_DATA_TYPE,
  );
  if (live) return false;
  const gen = await loadGeneration();
  const id = await armTrigger(Date.now() + MIN_FIRE_AHEAD_MS, state.intervalSeconds, gen);
  console.log('[Schedule]', `no live trigger for active job — re-armed → ${id ?? 'skipped'}`);
  return id != null;
}

export async function loadAuthToken(): Promise<string> {
  try {
    return (await AsyncStorage.getItem(AUTH_TOKEN_KEY))?.trim() ?? '';
  } catch {
    return '';
  }
}

export async function saveAuthToken(token: string): Promise<void> {
  await AsyncStorage.setItem(AUTH_TOKEN_KEY, token.trim());
}

export async function clearAuthToken(): Promise<void> {
  await AsyncStorage.removeItem(AUTH_TOKEN_KEY);
}

// A single completed check-in. Stored separately from JobState so the history
// survives when the user cancels the active schedule.
export type CheckinLog = {
  ranAt: number;
  intervalSeconds: number;
  photoPath: string | null;
  pending: number;
  pumped: number;
  nextFiresAt: number;
};

export async function loadCheckinLog(): Promise<CheckinLog[]> {
  try {
    const raw = await AsyncStorage.getItem(CHECKIN_LOG_KEY);
    return raw ? (JSON.parse(raw) as CheckinLog[]) : [];
  } catch {
    return [];
  }
}

export async function appendCheckinLog(entry: CheckinLog): Promise<void> {
  const existing = await loadCheckinLog();
  const next = [entry, ...existing].slice(0, MAX_LOG_ENTRIES);
  await AsyncStorage.setItem(CHECKIN_LOG_KEY, JSON.stringify(next));
}

export async function clearCheckinLog(): Promise<void> {
  await AsyncStorage.removeItem(CHECKIN_LOG_KEY);
}

export type JobState = {
  notificationId: string;
  intervalSeconds: number;
  scheduledAt: number;
  willFireAt: number;
  lastRanAt: number | null;
  nextFiresAt: number | null;
  readResponse: Record<string, unknown> | null;
  receiptResult: { id: number; created_at: string } | null;
  lastPhotoPath: string | null;
};

export async function ensureChannel() {
  await notifee.createChannel({
    id: CHANNEL_ID,
    name: 'Scheduler',
    importance: AndroidImportance.HIGH,
  });
}

export async function loadJobState(): Promise<JobState | null> {
  try {
    const raw = await AsyncStorage.getItem(JOB_STATE_KEY);
    return raw ? (JSON.parse(raw) as JobState) : null;
  } catch {
    return null;
  }
}

export async function saveJobState(state: JobState) {
  await AsyncStorage.setItem(JOB_STATE_KEY, JSON.stringify(state));
}

export async function clearJobState() {
  await AsyncStorage.multiRemove([JOB_STATE_KEY, ACTIVE_NOTIF_ID_KEY]);
}

export async function scheduleJobNotification(
  intervalSeconds: number,
  timestamp: number,
): Promise<string> {
  return notifee.createTriggerNotification(
    {
      title: 'Scheduler',
      body: `Job at ${new Date(timestamp).toLocaleTimeString()}`,
      data: { notifType: NOTIF_DATA_TYPE, intervalSeconds: String(intervalSeconds) },
      android: {
        channelId: CHANNEL_ID,
        smallIcon: 'ic_launcher',
        pressAction: { id: 'default' },
      },
    },
    {
      type: TriggerType.TIMESTAMP,
      timestamp,
      alarmManager: { allowWhileIdle: true },
    },
  );
}

// Public entry point — wraps executeJob with a re-entrancy lock, a start-of-run
// safety-net alarm, and a guaranteed reschedule so the chain can never silently
// die. Called from the HeadlessJS background handler AND the foreground
// listeners (they share one process, so the in-process guard dedupes them).
export async function runScheduledJob(intervalSeconds: number, prevNotifId: string): Promise<void> {
  if (_runningInProcess) {
    console.log('[Job]', 'in-process run already active — skip');
    return;
  }
  _runningInProcess = true;

  const acquired = await acquireLock();
  if (!acquired) {
    _runningInProcess = false;
    console.log('[Job]', 'lock held by another run — skip');
    return;
  }

  const myGen = await loadGeneration();

  // If the schedule was cancelled, a stray (e.g. safety-net) trigger may still
  // fire — don't resurrect it.
  if (!(await loadJobState())) {
    console.log('[Job]', 'no active schedule — skip (cancelled)');
    await releaseLock();
    _runningInProcess = false;
    return;
  }

  // Cancel the trigger that just fired so it doesn't linger in the tray.
  await notifee.cancelNotification(prevNotifId).catch(() => {});

  // Arm a safety-net BEFORE doing any work: if the process is killed mid-run, a
  // future alarm still exists to resume the chain. Replaced on success.
  await armTrigger(Date.now() + FALLBACK_DELAY_MS, intervalSeconds, myGen);

  let ok = false;
  try {
    ok = await executeJob(intervalSeconds, myGen);
  } catch (err: any) {
    console.log('[Job]', `uncaught error: ${err?.message ?? err}`);
  } finally {
    // If the run failed/aborted (and wasn't cancelled), retry sooner than the
    // safety-net so a single bad read just retries instead of killing the chain.
    if (!ok) {
      const gen = await loadGeneration();
      const state = await loadJobState();
      if (gen === myGen && state) {
        console.log('[Job]', 'run did not complete — scheduling retry');
        await armTrigger(Date.now() + RETRY_DELAY_MS, intervalSeconds, myGen);
      }
    }
    await releaseLock();
    _runningInProcess = false;
  }
}

// Core job. Returns true if the run reached a terminal state that already
// (re)scheduled the next alarm OR was cancelled; false means the caller must
// schedule a retry. Never throws past runScheduledJob's try/catch.
export async function executeJob(_intervalSeconds: number, gen: number): Promise<boolean> {
  const jobT0 = Date.now();
  const elapsed = () => `+${Date.now() - jobT0}ms`;
  console.log('[Job]', `START — ${new Date().toISOString()}`);

  // 1. Connect BLE, read sys_info first
  console.log('[Job]', `connecting BLE for sys_info (elapsed ${elapsed()})`);
  const sysInfo = await connectAndReadSysInfo();
  console.log('[Job]', `sys_info done — ${sysInfo ? `readAt=${sysInfo.readAt} totalMs=${sysInfo.totalMs} msUntilSleep=${sysInfo.msUntilSleep}` : 'null'} (elapsed ${elapsed()})`);

  if (!sysInfo) {
    console.log('[Job]', 'ABORT — could not read sys_info (caller will retry)');
    return false;
  }

  // 2. Capture photo via background foreground-service camera
  console.log('[Job]', `capturing photo (elapsed ${elapsed()})`);
  const photoPath = await takePicture();
  console.log('[Job]', `photo ${photoPath ? `saved → ${photoPath}` : 'skipped (no permission or error)'} (elapsed ${elapsed()})`);

  // Async upload to Cloudflare R2 — don't block job or local display
  if (photoPath) {
    uploadPhotoFireAndForget(BASE_URL, photoPath);
  }

  // 3. Fetch pending messages, operate pump per message, ack
  console.log('[Job]', `fetching pending messages (elapsed ${elapsed()})`);
  type PendingMessage = {
    id: number;
    contact_id: string;
    volume_ml: number;
    cost_usd: number;
    duration_sec: number;
    received: boolean;
    txn: string;
    created_at: string;
  };
  let pending: PendingMessage[] = [];
  try {
    const res = await fetch(`${BASE_URL}/messages/pending`).then(r => r.json());
    pending = (res?.results ?? []) as PendingMessage[];
  } catch (err: any) {
    console.log('[Job]', `pending fetch failed: ${err?.message ?? err}`);
  }
  console.log('[Job]', `pending count: ${pending.length} (elapsed ${elapsed()})`);

  const authToken = await loadAuthToken();
  if (!authToken) {
    console.log('[Job]', 'no auth token set — PATCH acks will be rejected (set token in Scheduler screen)');
  }

  const processed: Array<{ id: number; ok: boolean }> = [];
  for (const msg of pending) {
    // Only pump if the dose fits the device's remaining wake window — otherwise
    // the firmware sleeps mid-pour (under-watering). Defer: leave it unacked so
    // it stays pending and runs in a fresh window next cycle.
    const remainingWakeMs = sysInfo.msUntilSleep - (Date.now() - sysInfo.readAt) - PUMP_WAKE_MARGIN_MS;
    if (msg.duration_sec * 1000 > remainingWakeMs) {
      console.log('[Job]', `defer pump #${msg.id} — need ${msg.duration_sec * 1000}ms but only ${remainingWakeMs}ms wake left (elapsed ${elapsed()})`);
      processed.push({ id: msg.id, ok: false });
      continue;
    }
    console.log('[Job]', `pump msg #${msg.id} for ${msg.duration_sec}s (elapsed ${elapsed()})`);
    const ok = await connectAndOperatePump(msg.duration_sec);
    if (ok) {
      try {
        const res = await fetch(`${BASE_URL}/messages/${msg.id}`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({ received: true }),
        });
        if (!res.ok) {
          console.log('[Job]', `ack #${msg.id} rejected: HTTP ${res.status}`);
        }
      } catch (err: any) {
        console.log('[Job]', `ack #${msg.id} failed: ${err?.message ?? err}`);
      }
    }
    processed.push({ id: msg.id, ok });
  }

  const readRes = { pending: pending.length, processed };
  const ackedCount = processed.filter(p => p.ok).length;

  // 3. Reschedule at readAt + totalMs, lead by WAKEUP_LEAD_MS so BLE setup completes before device wakes
  const fireAt = Math.max(Date.now() + 1000, sysInfo.readAt + sysInfo.totalMs - WAKEUP_LEAD_MS);
  const intervalSeconds = Math.round(sysInfo.totalMs / 1000);

  console.log('[Job]', `scheduling next at ${new Date(fireAt).toISOString()} (elapsed ${elapsed()})`);
  // armTrigger replaces the start-of-run safety net and respects the cancel
  // generation — if the user hit Stop mid-run, it returns null and we bail
  // without resurrecting the schedule.
  const nextNotifId = await armTrigger(fireAt, intervalSeconds, gen);
  if (!nextNotifId) {
    console.log('[Job]', 'cancelled during run — not saving state or rescheduling');
    return true;
  }

  await notifee.displayNotification({
    title: 'Job complete',
    body: `Next ${new Date(fireAt).toLocaleTimeString()}${ackedCount > 0 ? ` · pumped ${ackedCount}` : ''}`,
    android: { channelId: CHANNEL_ID, smallIcon: 'ic_launcher' },
  });

  const state: JobState = {
    notificationId: nextNotifId,
    intervalSeconds,
    scheduledAt: Date.now(),
    willFireAt: fireAt,
    lastRanAt: Date.now(),
    nextFiresAt: fireAt,
    readResponse: readRes,
    receiptResult: null,
    lastPhotoPath: photoPath,
  };
  await saveJobState(state);

  // Persist a log entry independent of the active schedule so it survives a cancel.
  await appendCheckinLog({
    ranAt: state.lastRanAt!,
    intervalSeconds,
    photoPath: photoPath,
    pending: pending.length,
    pumped: ackedCount,
    nextFiresAt: fireAt,
  });

  console.log('[Job]', `DONE (total ${elapsed()})`);
  return true;
}
