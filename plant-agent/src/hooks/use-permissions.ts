import notifee, {
  AndroidNotificationSetting,
  AuthorizationStatus,
} from '@notifee/react-native';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { checkCameraPermission, requestCameraPermission } from '@/tasks/camera-capture';
import { checkBlePermissions, requestBlePermissions } from '@/tasks/ble-task';

export type PermissionKey = 'bluetooth' | 'camera' | 'notifications' | 'alarm';

export type PermissionState = Record<PermissionKey, boolean | null>;

const INITIAL: PermissionState = {
  bluetooth: null,
  camera: null,
  notifications: null,
  alarm: null,
};

async function readNotifAndAlarm() {
  const settings = await notifee.getNotificationSettings();
  const notifications =
    settings.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
    settings.authorizationStatus === AuthorizationStatus.PROVISIONAL;
  const alarm =
    settings.android.alarm === AndroidNotificationSetting.ENABLED ||
    settings.android.alarm === AndroidNotificationSetting.NOT_SUPPORTED;
  return { notifications, alarm };
}

export function usePermissions() {
  const [perms, setPerms] = useState<PermissionState>(INITIAL);
  const [requesting, setRequesting] = useState(false);

  const recheck = useCallback(async (): Promise<PermissionState> => {
    const [bluetooth, camera, notifState] = await Promise.all([
      checkBlePermissions(),
      checkCameraPermission(),
      readNotifAndAlarm(),
    ]);
    const next: PermissionState = {
      bluetooth,
      camera,
      notifications: notifState.notifications,
      alarm: notifState.alarm,
    };
    setPerms(next);
    return next;
  }, []);

  useEffect(() => {
    recheck();
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') recheck();
    });
    return () => sub.remove();
  }, [recheck]);

  // Request every permission in one pass. Camera + Bluetooth + notifications
  // prompt inline; the exact-alarm grant lives in system settings, so we only
  // open it when it is still missing after the inline prompts.
  const requestAll = useCallback(async () => {
    setRequesting(true);
    try {
      await requestBlePermissions().catch(() => {});
      await requestCameraPermission().catch(() => {});
      await notifee.requestPermission().catch(() => {});
      const { alarm } = await readNotifAndAlarm();
      if (!alarm) {
        await notifee.openAlarmPermissionSettings().catch(() => {});
      }
    } finally {
      setRequesting(false);
      await recheck();
    }
  }, [recheck]);

  const allGranted =
    perms.bluetooth === true &&
    perms.camera === true &&
    perms.notifications === true &&
    perms.alarm === true;

  return { perms, allGranted, requesting, requestAll, recheck };
}
