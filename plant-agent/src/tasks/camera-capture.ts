import { Linking, NativeModules, PermissionsAndroid, Platform } from 'react-native';

export async function requestCameraPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
    title: 'Camera Permission',
    message: 'Plant Agent needs camera access to photograph your plant automatically.',
    buttonPositive: 'Allow',
    buttonNegative: 'Deny',
  });
  // Permanently denied ("Don't ask again") — system dialog no longer shows.
  // Send user to app settings to enable manually.
  if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
    await Linking.openSettings();
    return false;
  }
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export async function checkCameraPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const result = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA);
  return result;
}

export async function takePicture(): Promise<string | null> {
  try {
    const path: string = await NativeModules.CameraCapture.takePicture();
    console.log('[Camera]', `captured → ${path}`);
    return path;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[Camera]', `capture failed: ${msg}`);
    return null;
  }
}

export type UploadedImage = {
  id: number;
  key: string;
  url: string;
  size: number;
  content_type: string;
  created_at: string;
};

export async function uploadPhoto(
  baseUrl: string,
  localPath: string,
): Promise<UploadedImage | null> {
  const t0 = Date.now();
  try {
    const uri = localPath.startsWith('file://') ? localPath : `file://${localPath}`;
    const res = await fetch(uri);
    const blob = await res.blob();
    const contentType = blob.type || 'image/jpeg';

    const uploadRes = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: blob,
    });
    if (!uploadRes.ok) {
      console.error('[Upload]', `failed status=${uploadRes.status}`);
      return null;
    }
    const data = (await uploadRes.json()) as UploadedImage;
    console.log('[Upload]', `done id=${data.id} size=${data.size} elapsed=${Date.now() - t0}ms`);
    return data;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[Upload]', `error: ${msg}`);
    return null;
  }
}

export function uploadPhotoFireAndForget(baseUrl: string, localPath: string) {
  uploadPhoto(baseUrl, localPath).catch((e) => {
    console.error('[Upload]', 'unhandled', e);
  });
}
