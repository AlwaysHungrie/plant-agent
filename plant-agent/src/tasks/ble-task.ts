import { BleManager, Device, State } from 'react-native-ble-plx';
import { Platform, PermissionsAndroid } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const DEVICE_NAME = 'PhysicalAgent';
export const DEVICE_ID_KEY = 'ble_device_id';
const SCAN_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const POST_CONNECT_HOLD_MS = 1_000;
const BLE_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const BLE_NOTIFY_UUID  = 'beb5483e-36e1-4688-b7f5-ea07361b26a9';
const BLE_WRITE_UUID   = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';

const TAG = '[BLE]';

// atob is available in RN 0.70+ / Hermes; guard against missing polyfill
function decodeBase64(b64: string): string {
  if (typeof atob === 'function') return atob(b64);
  // manual decode for ASCII (sys_info values are ASCII)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let out = '';
  for (let i = 0; i < b64.length; ) {
    const c1 = chars.indexOf(b64[i++]);
    const c2 = chars.indexOf(b64[i++]);
    const c3 = chars.indexOf(b64[i++]);
    const c4 = chars.indexOf(b64[i++]);
    out += String.fromCharCode((c1 << 2) | (c2 >> 4));
    if (c3 !== 64) out += String.fromCharCode(((c2 & 15) << 4) | (c3 >> 2));
    if (c4 !== 64) out += String.fromCharCode(((c3 & 3) << 6) | c4);
  }
  return out;
}

// Singleton — never destroyed. BleManager native side is process-scoped.
// HeadlessJS kills the process after the task completes anyway.
let _manager: BleManager | null = null;
function getManager(): BleManager {
  if (!_manager) {
    console.log(TAG, 'creating BleManager');
    _manager = new BleManager();
  }
  return _manager;
}

async function requestPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const granted = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ]);
  const result = Object.values(granted).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
  console.log(TAG, 'permissions:', result ? 'granted' : 'denied');
  return result;
}

async function waitForBTReady(manager: BleManager, timeoutMs = 8_000): Promise<boolean> {
  const current = await manager.state();
  console.log(TAG, 'BT state:', current);
  if (current === State.PoweredOn) return true;

  return new Promise(resolve => {
    const timer = setTimeout(() => { sub.remove(); resolve(false); }, timeoutMs);
    const sub = manager.onStateChange(state => {
      console.log(TAG, 'BT state change:', state);
      if (state === State.PoweredOn) { clearTimeout(timer); sub.remove(); resolve(true); }
      else if (state === State.PoweredOff || state === State.Unsupported) { clearTimeout(timer); sub.remove(); resolve(false); }
    }, false);
  });
}

// Direct connect by cached device ID — works with screen off (no scan needed).
async function connectById(manager: BleManager, deviceId: string): Promise<boolean> {
  console.log(TAG, 'direct connect to', deviceId);
  try {
    const connected = await manager.connectToDevice(deviceId, { timeout: CONNECT_TIMEOUT_MS });
    console.log(TAG, 'connected, holding 1s...');
    await new Promise(r => setTimeout(r, POST_CONNECT_HOLD_MS));
    console.log(TAG, 'disconnecting...');
    await connected.cancelConnection().catch(() => {});
    console.log(TAG, 'direct connect ok');
    return true;
  } catch (err: any) {
    console.log(TAG, 'direct connect failed:', err?.message ?? err);
    return false;
  }
}

// Scan fallback — finds device, caches ID, connects. Screen must be on for scan results.
async function scanAndConnect(manager: BleManager): Promise<boolean> {
  console.log(TAG, `scanning for "${DEVICE_NAME}"`);
  return new Promise(resolve => {
    let settled = false;

    const settle = (result: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      console.log(TAG, `scan settled: ${result} (${reason})`);
      resolve(result);
    };

    const timer = setTimeout(() => {
      manager.stopDeviceScan();
      settle(false, 'scan timeout');
    }, SCAN_TIMEOUT_MS);

    manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (settled) return;

      if (error) {
        clearTimeout(timer);
        manager.stopDeviceScan();
        settle(false, `scan error: ${error.message}`);
        return;
      }

      if (!device || device.name !== DEVICE_NAME) return;

      clearTimeout(timer);
      manager.stopDeviceScan();
      console.log(TAG, 'found', DEVICE_NAME, device.id, '— caching ID');

      // Cache device ID so future calls skip scan
      AsyncStorage.setItem(DEVICE_ID_KEY, device.id).catch(() => {});

      device
        .connect({ timeout: CONNECT_TIMEOUT_MS })
        .then(connected => {
          console.log(TAG, 'connected, holding 1s...');
          return new Promise<typeof connected>(r => setTimeout(() => r(connected), POST_CONNECT_HOLD_MS));
        })
        .then(connected => {
          console.log(TAG, 'disconnecting...');
          return connected.cancelConnection().catch(() => {});
        })
        .then(() => settle(true, 'ok'))
        .catch(err => settle(false, `connect error: ${err?.message}`));
    });
  });
}

export async function isBTOn(): Promise<boolean> {
  const state = await getManager().state();
  return state === State.PoweredOn;
}

// Request the Bluetooth + location permissions the scanner/connector needs.
export async function requestBlePermissions(): Promise<boolean> {
  return requestPermissions();
}

// Check (without prompting) whether the Bluetooth permissions are already granted.
export async function checkBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const checks = await Promise.all([
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN),
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT),
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION),
  ]);
  return checks.every(Boolean);
}

// Scan-only — no connect. Caches device ID for future direct connects.
// Used during foreground setup so background tasks can skip scanning.
export async function scanAndCacheDeviceId(
  onProgress?: (msg: string) => void,
): Promise<string | null> {
  const ok = await requestPermissions();
  if (!ok) { onProgress?.('Permissions denied'); return null; }

  const manager = getManager();
  const ready = await waitForBTReady(manager);
  if (!ready) { onProgress?.('Bluetooth not available'); return null; }

  onProgress?.(`Scanning for "${DEVICE_NAME}"…`);

  return new Promise(resolve => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      manager.stopDeviceScan();
      onProgress?.('Device not found');
      resolve(null);
    }, SCAN_TIMEOUT_MS);

    manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (settled) return;
      if (error || !device || device.name !== DEVICE_NAME) return;

      settled = true;
      clearTimeout(timer);
      manager.stopDeviceScan();

      console.log(TAG, 'setup scan found', DEVICE_NAME, device.id);
      AsyncStorage.setItem(DEVICE_ID_KEY, device.id).catch(() => {});
      onProgress?.('Device found');
      resolve(device.id);
    });
  });
}

export async function connectAndDisconnectBLE(): Promise<void> {
  const t0 = Date.now();
  const elapsed = () => `+${Date.now() - t0}ms`;

  console.log(TAG, `[bg-ble] START — ${new Date().toISOString()}`);

  const permT = Date.now();
  const ok = await requestPermissions();
  console.log(TAG, `[bg-ble] permissions: ${ok ? 'granted' : 'DENIED'} (took ${Date.now() - permT}ms, elapsed ${elapsed()})`);
  if (!ok) { console.log(TAG, '[bg-ble] ABORT — permissions denied'); return; }

  const managerT = Date.now();
  const manager = getManager();
  console.log(TAG, `[bg-ble] manager ready (took ${Date.now() - managerT}ms, elapsed ${elapsed()})`);

  const btT = Date.now();
  console.log(TAG, `[bg-ble] waiting for BT ready... (elapsed ${elapsed()})`);
  const ready = await waitForBTReady(manager);
  console.log(TAG, `[bg-ble] BT ready: ${ready} (waited ${Date.now() - btT}ms, elapsed ${elapsed()})`);
  if (!ready) { console.log(TAG, '[bg-ble] ABORT — BT not ready'); return; }

  const cacheT = Date.now();
  const cachedId = await AsyncStorage.getItem(DEVICE_ID_KEY).catch(() => null);
  console.log(TAG, `[bg-ble] cached device ID: ${cachedId ?? 'none'} (took ${Date.now() - cacheT}ms, elapsed ${elapsed()})`);

  let attempt = 0;
  let success = false;

  if (cachedId) {
    while (attempt < MAX_RETRIES && !success) {
      attempt++;
      const attT = Date.now();
      console.log(TAG, `[bg-ble] direct connect attempt ${attempt}/${MAX_RETRIES} (elapsed ${elapsed()})`);
      success = await connectById(manager, cachedId);
      console.log(TAG, `[bg-ble] attempt ${attempt} result: ${success ? 'ok' : 'fail'} (took ${Date.now() - attT}ms, elapsed ${elapsed()})`);
    }
  }

  if (!success) {
    console.log(TAG, `[bg-ble] no cached ID or all direct attempts failed — falling back to scan (elapsed ${elapsed()})`);
    const scanT = Date.now();
    success = await scanAndConnect(manager);
    console.log(TAG, `[bg-ble] scan result: ${success ? 'ok' : 'fail'} (took ${Date.now() - scanT}ms, elapsed ${elapsed()})`);
  }

  console.log(TAG, `[bg-ble] DONE — success: ${success}, total: ${elapsed()}`);
}

function encodeBase64(s: string): string {
  if (typeof btoa === 'function') return btoa(s);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < s.length; ) {
    const c1 = s.charCodeAt(i++);
    const c2 = i < s.length ? s.charCodeAt(i++) : NaN;
    const c3 = i < s.length ? s.charCodeAt(i++) : NaN;
    const e1 = c1 >> 2;
    const e2 = ((c1 & 3) << 4) | ((isNaN(c2) ? 0 : c2) >> 4);
    const e3 = isNaN(c2) ? 64 : (((c2 & 15) << 2) | ((isNaN(c3) ? 0 : c3) >> 6));
    const e4 = isNaN(c3) ? 64 : (c3 & 63);
    out += chars[e1] + chars[e2] + (e3 === 64 ? '=' : chars[e3]) + (e4 === 64 ? '=' : chars[e4]);
  }
  return out;
}

// Connect, write operate_pump command, disconnect.
export async function connectAndOperatePump(seconds: number): Promise<boolean> {
  const t0 = Date.now();
  const elapsed = () => `+${Date.now() - t0}ms`;
  console.log(TAG, `[pump] START seconds=${seconds} — ${new Date().toISOString()}`);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.log(TAG, '[pump] ABORT — bad seconds');
    return false;
  }

  const ok = await requestPermissions();
  if (!ok) { console.log(TAG, '[pump] ABORT — permissions'); return false; }

  const manager = getManager();
  const ready = await waitForBTReady(manager);
  if (!ready) { console.log(TAG, '[pump] ABORT — BT not ready'); return false; }

  let device: Device | null = null;
  try {
    const cachedId = await AsyncStorage.getItem(DEVICE_ID_KEY).catch(() => null);
    console.log(TAG, `[pump] cached ID: ${cachedId ?? 'none'} (elapsed ${elapsed()})`);

    if (cachedId) {
      device = await manager.connectToDevice(cachedId, { timeout: CONNECT_TIMEOUT_MS });
    } else {
      device = await new Promise<Device>((resolve, reject) => {
        const timer = setTimeout(() => {
          manager.stopDeviceScan();
          reject(new Error('scan timeout'));
        }, SCAN_TIMEOUT_MS);
        manager.startDeviceScan(null, { allowDuplicates: false }, (error, d) => {
          if (error) { clearTimeout(timer); manager.stopDeviceScan(); reject(error); return; }
          if (!d || d.name !== DEVICE_NAME) return;
          clearTimeout(timer);
          manager.stopDeviceScan();
          AsyncStorage.setItem(DEVICE_ID_KEY, d.id).catch(() => {});
          resolve(d);
        });
      });
      device = await (device as Device).connect({ timeout: CONNECT_TIMEOUT_MS });
    }

    console.log(TAG, `[pump] connected, discovering (elapsed ${elapsed()})`);
    await device.discoverAllServicesAndCharacteristics();

    const cmd = `operate_pump,${Math.round(seconds)}`;
    const payload = encodeBase64(cmd);
    console.log(TAG, `[pump] writing "${cmd}" (elapsed ${elapsed()})`);
    await device.writeCharacteristicWithResponseForService(BLE_SERVICE_UUID, BLE_WRITE_UUID, payload);
    console.log(TAG, `[pump] write done (elapsed ${elapsed()})`);

    // Hold briefly so device processes command before disconnect.
    await new Promise(r => setTimeout(r, 500));
    return true;
  } catch (err: any) {
    console.log(TAG, '[pump] error:', err?.message ?? err);
    return false;
  } finally {
    if (device) {
      await device.cancelConnection().catch(() => {});
      console.log(TAG, `[pump] disconnected (elapsed ${elapsed()})`);
    }
  }
}

export type SysInfo = {
  readAt: number;        // Date.now() at successful characteristic read
  totalMs: number;       // msUntilSleep + sleepDurationMs (raw sum from device)
  msUntilSleep: number;  // remaining wake window when read (ms) — pump must fit in this
  sleepDurationMs: number;
};

// Connect, read sys_info characteristic, disconnect.
export async function connectAndReadSysInfo(): Promise<SysInfo | null> {
  const t0 = Date.now();
  const elapsed = () => `+${Date.now() - t0}ms`;
  console.log(TAG, `[sysinfo] START — ${new Date().toISOString()}`);

  const ok = await requestPermissions();
  console.log(TAG, `[sysinfo] permissions: ${ok ? 'granted' : 'DENIED'} (elapsed ${elapsed()})`);
  if (!ok) { return null; }

  const manager = getManager();
  console.log(TAG, `[sysinfo] waiting for BT ready (elapsed ${elapsed()})`);
  const ready = await waitForBTReady(manager);
  console.log(TAG, `[sysinfo] BT ready: ${ready} (elapsed ${elapsed()})`);
  if (!ready) { return null; }

  let device: Device | null = null;

  try {
    const cachedId = await AsyncStorage.getItem(DEVICE_ID_KEY).catch(() => null);
    console.log(TAG, `[sysinfo] cached device ID: ${cachedId ?? 'none'} (elapsed ${elapsed()})`);

    if (cachedId) {
      console.log(TAG, `[sysinfo] connecting by ID (elapsed ${elapsed()})`);
      device = await manager.connectToDevice(cachedId, { timeout: CONNECT_TIMEOUT_MS });
    } else {
      console.log(TAG, `[sysinfo] no cached ID — scanning (elapsed ${elapsed()})`);
      device = await new Promise<Device>((resolve, reject) => {
        const timer = setTimeout(() => {
          manager.stopDeviceScan();
          reject(new Error('scan timeout'));
        }, SCAN_TIMEOUT_MS);

        manager.startDeviceScan(null, { allowDuplicates: false }, (error, d) => {
          if (error) { clearTimeout(timer); manager.stopDeviceScan(); reject(error); return; }
          if (!d || d.name !== DEVICE_NAME) return;
          clearTimeout(timer);
          manager.stopDeviceScan();
          AsyncStorage.setItem(DEVICE_ID_KEY, d.id).catch(() => {});
          resolve(d);
        });
      });
      device = await (device as Device).connect({ timeout: CONNECT_TIMEOUT_MS });
    }

    console.log(TAG, `[sysinfo] connected, discovering services (elapsed ${elapsed()})`);
    await device.discoverAllServicesAndCharacteristics();
    console.log(TAG, `[sysinfo] services discovered, reading sys_info (elapsed ${elapsed()})`);

    type ParsedSysInfo = { msUntilSleep: number; sleepDurationMs: number };
    const parseSysInfo = (value: string | null): ParsedSysInfo | null => {
      if (!value) return null;
      try {
        const raw = decodeBase64(value);
        console.log(TAG, '[sysinfo] characteristic value:', raw);
        if (!raw.startsWith('sys_info,')) return null;
        const parts = raw.split(',');
        const msUntilSleep = parseInt(parts[1], 10);
        const sleepDurationMs = parseInt(parts[2], 10);
        if (isNaN(msUntilSleep) || isNaN(sleepDurationMs)) return null;
        console.log(TAG, `[sysinfo] msUntilSleep=${msUntilSleep} sleepDurationMs=${sleepDurationMs} totalMs=${msUntilSleep + sleepDurationMs}`);
        return { msUntilSleep, sleepDurationMs };
      } catch (e) {
        console.log(TAG, '[sysinfo] parseSysInfo failed:', e);
        return null;
      }
    };

    // Device sends sys_info within 50ms of connect; discovery takes ~1-2s.
    // Wait 1s after discovery to be safe, then retry up to 3x.
    await new Promise(r => setTimeout(r, 1_000));
    let parsed: ParsedSysInfo | null = null;
    for (let attempt = 0; attempt < 3 && parsed === null; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 500));
      console.log(TAG, `[sysinfo] read attempt ${attempt + 1} (elapsed ${elapsed()})`);
      const char = await device.readCharacteristicForService(BLE_SERVICE_UUID, BLE_NOTIFY_UUID);
      parsed = parseSysInfo(char.value);
    }

    const readAt = Date.now();
    console.log(TAG, `[sysinfo] read done — ${parsed ? `msUntilSleep=${parsed.msUntilSleep}` : 'null'} (elapsed ${elapsed()})`);
    return parsed !== null
      ? {
          readAt,
          totalMs: parsed.msUntilSleep + parsed.sleepDurationMs,
          msUntilSleep: parsed.msUntilSleep,
          sleepDurationMs: parsed.sleepDurationMs,
        }
      : null;
  } catch (err: any) {
    console.log(TAG, '[sysinfo] error:', err?.message ?? err);
    return null;
  } finally {
    if (device) {
      await device.cancelConnection().catch(() => {});
      console.log(TAG, `[sysinfo] disconnected (elapsed ${elapsed()})`);
    }
  }
}
