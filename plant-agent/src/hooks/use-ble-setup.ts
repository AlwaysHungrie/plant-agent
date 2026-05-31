import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEVICE_ID_KEY, scanAndCacheDeviceId } from '@/tasks/ble-task';

export type BLESetupStatus = 'checking' | 'ready' | 'scanning' | 'idle' | 'error';

export function useBLESetup() {
  const [status, setStatus] = useState<BLESetupStatus>('checking');
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState('');

  useEffect(() => {
    AsyncStorage.getItem(DEVICE_ID_KEY)
      .then(id => {
        setDeviceId(id);
        setStatus(id ? 'ready' : 'idle');
      })
      .catch(() => setStatus('idle'));
  }, []);

  const connect = useCallback(async () => {
    setStatus('scanning');
    setStatusMsg('');

    const id = await scanAndCacheDeviceId(setStatusMsg).catch(() => null);

    if (id) {
      setDeviceId(id);
      setStatus('ready');
      setStatusMsg('');
    } else {
      setStatus('error');
    }
  }, []);

  const forget = useCallback(async () => {
    await AsyncStorage.removeItem(DEVICE_ID_KEY).catch(() => {});
    setDeviceId(null);
    setStatus('idle');
    setStatusMsg('');
  }, []);

  return { status, deviceId, statusMsg, connect, forget };
}
