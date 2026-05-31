/*
 * Physical Agent - ESP32 BLE Receiver
 *
 * Device name: PhysicalAgent
 * Service UUID:        4fafc201-1fb5-459e-8fcc-c5c9c331914b
 * Characteristic UUID: beb5483e-36e1-4688-b7f5-ea07361b26a8  (WRITE — commands)
 * Notify UUID:         beb5483e-36e1-4688-b7f5-ea07361b26a9  (NOTIFY — sys_info)
 *
 * Commands (write to CHARACTERISTIC_UUID):
 *   operate_pump,<seconds>  — turn pump on for N seconds
 *   kill                    — stop pump immediately
 *
 * Notifications (sent to NOTIFY_UUID on connect):
 *   sys_info,<ms_until_sleep>,<sleep_duration_ms>
 *
 * Sleep cycle (starts BOOT_DELAY_MS after first boot):
 *   WAKE_DURATION_MS awake → deep sleep SLEEP_DURATION_MS → repeat
 *   Sleep takes precedence over pump. RTC memory preserves cycle state.
 *
 * Board: ESP32 Dev Module (Arduino IDE)
 * Required library: ESP32 BLE Arduino (included with esp32 board package)
 */

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "driver/gpio.h"
#include "esp_sleep.h"

#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define NOTIFY_UUID         "beb5483e-36e1-4688-b7f5-ea07361b26a9"

#define RELAY_PIN 18

// Relay is active-LOW: HIGH = pump off, LOW = pump on.
#define PUMP_ON  LOW
#define PUMP_OFF HIGH

#define BOOT_DELAY_MS     (0UL * 1000)
#define WAKE_DURATION_MS  (120UL * 1000)
#define SLEEP_DURATION_US (30ULL * 1000000)
// Hard cap on how long an active pump may defer deep sleep. Bounds a bad/long
// operate_pump command so it can't pin the device awake indefinitely.
#define MAX_PUMP_EXTENSION_MS (20UL * 1000)

RTC_DATA_ATTR bool inSleepCycle = false;

BLEServer*         pServer       = nullptr;
BLECharacteristic* pNotifyChar   = nullptr;
bool               deviceConnected    = false;
bool               pendingSync        = false;
bool               restartAdvertising = false;

bool         pumpActive  = false;
unsigned long pumpEndTime = 0;

unsigned long sleepAt = 0;

void pumpOn() {
  digitalWrite(RELAY_PIN, PUMP_ON);
  pumpActive = true;
  Serial.println("[PUMP] ON");
}

void pumpOff() {
  digitalWrite(RELAY_PIN, PUMP_OFF);
  pumpActive  = false;
  pumpEndTime = 0;
  Serial.println("[PUMP] OFF");
}

void sendSysInfo() {
  if (!pNotifyChar) return;
  unsigned long now        = millis();
  long          msUntilSleep = max(0L, (long)sleepAt - (long)now);

  char buf[64];
  snprintf(buf, sizeof(buf), "sys_info,%ld,%llu",
           msUntilSleep,
           (unsigned long long)(SLEEP_DURATION_US / 1000));

  pNotifyChar->setValue((uint8_t*)buf, strlen(buf));
  pNotifyChar->notify();
  Serial.print("[BLE] Notified: ");
  Serial.println(buf);
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override {
    deviceConnected = true;
    pendingSync     = true;
    Serial.println("[BLE] Client connected");
  }
  void onDisconnect(BLEServer*) override {
    deviceConnected    = false;
    pendingSync        = false;
    restartAdvertising = true;
    Serial.println("[BLE] Client disconnected — restarting advertising");
  }
};

class CharacteristicCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pChar) override {
    String value = pChar->getValue();
    value.trim();
    if (value.length() == 0) return;

    Serial.print("[CMD] ");
    Serial.println(value);

    if (value == "kill") {
      pumpOff();
      return;
    }

    if (value.startsWith("operate_pump,")) {
      int seconds = value.substring(13).toInt();
      if (seconds > 0) {
        pumpEndTime = millis() + (unsigned long)seconds * 1000;
        pumpOn();
        Serial.print("[PUMP] Running for ");
        Serial.print(seconds);
        Serial.println("s");
      } else {
        Serial.println("[ERR] Invalid duration");
      }
      return;
    }

    Serial.println("[ERR] Unknown command");
  }
};

void setup() {
  Serial.begin(115200);

  pinMode(RELAY_PIN, OUTPUT);
  gpio_pulldown_en(GPIO_NUM_18);
  gpio_pullup_dis(GPIO_NUM_18);
  digitalWrite(RELAY_PIN, PUMP_OFF);

  sleepAt = millis() + (inSleepCycle ? WAKE_DURATION_MS : BOOT_DELAY_MS + WAKE_DURATION_MS);
  Serial.println(inSleepCycle ? "[SLEEP] Woke from deep sleep" : "[SLEEP] First boot — sleep cycle starts in 60s");

  BLEDevice::init("PhysicalAgent");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService* pService = pServer->createService(SERVICE_UUID);

  BLECharacteristic* pWriteChar = pService->createCharacteristic(
    CHARACTERISTIC_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
  );
  pWriteChar->setCallbacks(new CharacteristicCallbacks());

  pNotifyChar = pService->createCharacteristic(
    NOTIFY_UUID,
    BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ
  );
  pNotifyChar->addDescriptor(new BLE2902());

  pService->start();

  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  BLEDevice::startAdvertising();

  Serial.println("[BLE] Advertising as 'PhysicalAgent'");
}

void loop() {
  unsigned long now = millis();

  // Go to sleep when the wake window expires — but never mid-pour. If the pump
  // is still running, defer sleep until it finishes (clamped) so a watering
  // command issued late in the window completes its full dose.
  if (now >= sleepAt) {
    if (pumpActive && pumpEndTime > now) {
      unsigned long deferTo = pumpEndTime + 200;          // small flush margin
      unsigned long maxTo   = now + MAX_PUMP_EXTENSION_MS; // hard cap
      sleepAt = (deferTo < maxTo) ? deferTo : maxTo;
      Serial.print("[SLEEP] Pump active — deferring sleep to +");
      Serial.print(sleepAt - now);
      Serial.println("ms");
    } else {
      Serial.println("[SLEEP] Entering deep sleep");
      pumpOff();
      inSleepCycle = true;
      if (deviceConnected) delay(100); // let BLE flush pending notifications
      esp_sleep_enable_timer_wakeup(SLEEP_DURATION_US);
      esp_deep_sleep_start();
    }
  }

  // Restart advertising outside BLE callback context to avoid LoadProhibited crash.
  if (restartAdvertising) {
    restartAdvertising = false;
    BLEDevice::startAdvertising();
  }

  // Send sys_info on connect (small delay lets client subscribe to CCCD).
  if (pendingSync && deviceConnected && now > 1000) {
    pendingSync = false;
    sendSysInfo();
  }

  // Expire pump timer.
  if (pumpActive && pumpEndTime > 0 && now >= pumpEndTime) {
    pumpOff();
  }

  delay(50);
}
