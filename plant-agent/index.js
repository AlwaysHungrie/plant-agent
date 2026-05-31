// Must use require() here — import statements are hoisted, so static imports
// would load expo-router/entry BEFORE onBackgroundEvent registers, breaking
// headless background execution when the app is killed.

const notifee = require('@notifee/react-native').default;
const { EventType } = require('@notifee/react-native');
const { runScheduledJob, NOTIF_DATA_TYPE } = require('./src/tasks/scheduler-task');

// Runs in HeadlessJS when the app is killed and a trigger fires (AlarmManager wakes it).
notifee.onBackgroundEvent(async ({ type, detail }) => {
  if (type !== EventType.DELIVERED) return;

  const data = detail.notification?.data;
  if (data?.notifType !== NOTIF_DATA_TYPE) return;

  const intervalSeconds = Number(data.intervalSeconds);
  if (!intervalSeconds) return;

  const notifId = detail.notification?.id ?? '';
  await runScheduledJob(intervalSeconds, notifId);
});

require('expo-router/entry');
