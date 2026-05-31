const {
  withDangerousMod,
  withMainApplication,
  withAppBuildGradle,
  withAndroidManifest,
  AndroidConfig,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Native `CameraCapture` module — headless single-shot capture for the scheduler.
 *
 * The scheduler fires from a notifee trigger as headless JS (app may be
 * backgrounded). Android blocks camera access from the background unless a
 * foreground service of type `camera` is running, so `takePicture()` starts a
 * short-lived `camera`-typed foreground service that binds CameraX
 * `ImageCapture`, saves one JPEG to cacheDir, resolves the promise, then stops.
 *
 * Delivered as a config plugin (not raw android/ edits) so it survives
 * `expo prebuild --clean`. android/ is gitignored and regenerated.
 */

const CAMERAX_VERSION = '1.3.4';

function kotlinModule(pkg) {
  return `package ${pkg}

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class CameraCaptureModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "CameraCapture"

  @ReactMethod
  fun takePicture(promise: Promise) {
    if (CameraCaptureService.pendingPromise != null) {
      promise.reject("camera_busy", "A capture is already in progress")
      return
    }
    CameraCaptureService.pendingPromise = promise
    val intent = Intent(reactContext, CameraCaptureService::class.java)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactContext.startForegroundService(intent)
      } else {
        reactContext.startService(intent)
      }
    } catch (e: Exception) {
      CameraCaptureService.pendingPromise = null
      promise.reject("camera_start_failed", e.message, e)
    }
  }
}
`;
}

function kotlinPackage(pkg) {
  return `package ${pkg}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class CameraCapturePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(CameraCaptureModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
`;
}

function kotlinService(pkg) {
  return `package ${pkg}

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import com.facebook.react.bridge.Promise
import java.io.File
import java.util.concurrent.Executors

class CameraCaptureService : LifecycleService() {

  companion object {
    @Volatile var pendingPromise: Promise? = null
    private const val CHANNEL_ID = "camera_capture"
    private const val NOTIF_ID = 4242
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    super.onStartCommand(intent, flags, startId)
    startAsForeground()
    capture()
    return START_NOT_STICKY
  }

  private fun startAsForeground() {
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val ch = NotificationChannel(CHANNEL_ID, "Camera capture", NotificationManager.IMPORTANCE_LOW)
      nm.createNotificationChannel(ch)
    }
    val notif = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Capturing plant photo")
      .setSmallIcon(android.R.drawable.ic_menu_camera)
      .setOngoing(true)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
    } else {
      startForeground(NOTIF_ID, notif)
    }
  }

  private fun capture() {
    val providerFuture = ProcessCameraProvider.getInstance(this)
    providerFuture.addListener({
      try {
        val provider = providerFuture.get()
        val imageCapture = ImageCapture.Builder()
          .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
          .build()
        provider.unbindAll()
        provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, imageCapture)

        val file = File(cacheDir, "plant_\${System.currentTimeMillis()}.jpg")
        val opts = ImageCapture.OutputFileOptions.Builder(file).build()
        imageCapture.takePicture(
          opts,
          Executors.newSingleThreadExecutor(),
          object : ImageCapture.OnImageSavedCallback {
            override fun onImageSaved(output: ImageCapture.OutputFileResults) {
              resolve(file.absolutePath)
              provider.unbindAll()
              finish()
            }

            override fun onError(exc: ImageCaptureException) {
              reject("capture_failed", exc)
              provider.unbindAll()
              finish()
            }
          },
        )
      } catch (e: Exception) {
        reject("camera_bind_failed", e)
        finish()
      }
    }, ContextCompat.getMainExecutor(this))
  }

  private fun resolve(path: String) {
    pendingPromise?.resolve(path)
    pendingPromise = null
  }

  private fun reject(code: String, e: Throwable) {
    pendingPromise?.reject(code, e.message, e)
    pendingPromise = null
  }

  private fun finish() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION") stopForeground(true)
    }
    stopSelf()
  }

  override fun onDestroy() {
    // Service died before resolving — fail the pending promise so JS isn't hung.
    pendingPromise?.reject("camera_service_destroyed", "Service stopped before capture finished")
    pendingPromise = null
    super.onDestroy()
  }
}
`;
}

function writeKotlin(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const pkg = cfg.android?.package;
      if (!pkg) throw new Error('with-camera-capture: android.package is not set');
      const srcDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'java',
        ...pkg.split('.'),
      );
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'CameraCaptureModule.kt'), kotlinModule(pkg));
      fs.writeFileSync(path.join(srcDir, 'CameraCapturePackage.kt'), kotlinPackage(pkg));
      fs.writeFileSync(path.join(srcDir, 'CameraCaptureService.kt'), kotlinService(pkg));
      return cfg;
    },
  ]);
}

function registerPackage(config) {
  return withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents;
    const ADD = 'add(CameraCapturePackage())';
    if (contents.includes(ADD)) return cfg;

    const anchor = 'PackageList(this).packages.apply {';
    if (!contents.includes(anchor)) {
      throw new Error('with-camera-capture: PackageList.packages.apply anchor not found');
    }
    contents = contents.replace(anchor, `${anchor}\n          ${ADD}`);
    cfg.modResults.contents = contents;
    return cfg;
  });
}

function addGradleDeps(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('with-camera-capture: expected groovy app/build.gradle');
    }
    let contents = cfg.modResults.contents;
    const MARKER = '// camerax-deps';
    if (contents.includes(MARKER)) return cfg;

    const deps = `
    ${MARKER}
    implementation "androidx.camera:camera-core:${CAMERAX_VERSION}"
    implementation "androidx.camera:camera-camera2:${CAMERAX_VERSION}"
    implementation "androidx.camera:camera-lifecycle:${CAMERAX_VERSION}"
    implementation "androidx.lifecycle:lifecycle-service:2.7.0"
    implementation "com.google.guava:guava:33.3.1-android"`;

    // Insert right after the opening of the dependencies { block.
    const anchor = /dependencies\s*\{/;
    if (!anchor.test(contents)) {
      throw new Error('with-camera-capture: dependencies block not found in app/build.gradle');
    }
    contents = contents.replace(anchor, (m) => `${m}\n${deps}`);
    cfg.modResults.contents = contents;
    return cfg;
  });
}

function addService(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.service = app.service || [];
    const exists = app.service.some(
      (s) => s.$?.['android:name'] === '.CameraCaptureService',
    );
    if (!exists) {
      app.service.push({
        $: {
          'android:name': '.CameraCaptureService',
          'android:exported': 'false',
          'android:foregroundServiceType': 'camera',
        },
      });
    }
    return cfg;
  });
}

module.exports = function withCameraCapture(config) {
  config = writeKotlin(config);
  config = registerPackage(config);
  config = addGradleDeps(config);
  config = addService(config);
  return config;
};
