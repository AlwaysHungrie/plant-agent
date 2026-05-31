import notifee, { EventType } from '@notifee/react-native';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, Image, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Brand, BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import {
  NOTIF_DATA_TYPE,
  type CheckinLog,
  type JobState,
  clearCheckinLog,
  ensureScheduleArmed,
  loadCheckinLog,
  loadJobState,
  runScheduledJob,
} from '@/tasks/scheduler-task';

function formatDateTime(ms: number) {
  const d = new Date(ms);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

function secondsUntil(ms: number) {
  return Math.max(0, Math.floor((ms - Date.now()) / 1000));
}

function formatInterval(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return `${h} hr`;
}

// ── components ────────────────────────────────────────────────────────────────

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <ThemedView type="backgroundElement" style={cardStyles.card}>
      <View style={cardStyles.header}>
        <ThemedText type="smallBold">{title}</ThemedText>
      </View>
      <View style={cardStyles.body}>{children}</View>
    </ThemedView>
  );
}

const cardStyles = StyleSheet.create({
  card: { borderRadius: 16, overflow: 'hidden' },
  header: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#00000018',
  },
  body: { padding: Spacing.three, gap: Spacing.two },
});

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={infoStyles.row}>
      <ThemedText type="small" themeColor="textSecondary">{label}</ThemedText>
      <ThemedText type="code" style={infoStyles.value}>{value}</ThemedText>
    </View>
  );
}

const infoStyles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: Spacing.two },
  value: { flex: 1, textAlign: 'right' },
});

function CountdownBadge({ firesAt }: { firesAt: number }) {
  const [secs, setSecs] = useState(secondsUntil(firesAt));
  useEffect(() => {
    const t = setInterval(() => setSecs(secondsUntil(firesAt)), 1000);
    return () => clearInterval(t);
  }, [firesAt]);
  const fired = secs === 0;
  return (
    <View style={[cdStyles.pill, fired && cdStyles.fired]}>
      <ThemedText style={[cdStyles.text, fired && cdStyles.textFired]}>
        {fired ? 'Running…' : `Next check-in in ${secs}s`}
      </ThemedText>
    </View>
  );
}

const cdStyles = StyleSheet.create({
  pill: { backgroundColor: Brand.faint, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, alignSelf: 'flex-start' },
  fired: { backgroundColor: '#16a34a22' },
  text: { color: Brand.primary, fontSize: 12, fontWeight: '700' },
  textFired: { color: '#16a34a' },
});

function LogItem({ entry }: { entry: CheckinLog }) {
  return (
    <View style={logStyles.item}>
      {entry.photoPath && (
        <Image
          source={{ uri: `file://${entry.photoPath}` }}
          style={logStyles.photo}
          resizeMode="cover"
        />
      )}
      <View style={logStyles.itemBody}>
        <ThemedText type="smallBold">{formatDateTime(entry.ranAt)}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {entry.pending === 0
            ? 'No watering requests'
            : `${entry.pumped} of ${entry.pending} watering request${entry.pending === 1 ? '' : 's'} handled`}
        </ThemedText>
      </View>
    </View>
  );
}

const logStyles = StyleSheet.create({
  item: { gap: Spacing.two },
  photo: { width: '100%', height: 180, borderRadius: 12 },
  itemBody: { gap: 2 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#00000018', marginVertical: Spacing.one },
});

// ── screen ────────────────────────────────────────────────────────────────────

export default function LogsScreen() {
  const [jobState, setJobState] = useState<JobState | null>(null);
  const [logs, setLogs] = useState<CheckinLog[]>([]);

  const refresh = useCallback(() => {
    loadJobState().then(setJobState);
    loadCheckinLog().then(setLogs);
  }, []);

  const handleClearLogs = useCallback(() => {
    Alert.alert(
      'Clear all logs?',
      'This permanently removes every check-in record. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await clearCheckinLog();
            setLogs([]);
          },
        },
      ],
    );
  }, []);

  useFocusEffect(useCallback(() => {
    refresh();
    ensureScheduleArmed().then(refresh);
  }, [refresh]));

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') ensureScheduleArmed().then(refresh);
    });
    return () => sub.remove();
  }, [refresh]);

  // Foreground-delivered triggers land here when Logs is the mounted screen, so
  // run the job (lock-guarded — dedupes against Home's listener / background).
  useEffect(() => {
    return notifee.onForegroundEvent(async ({ type, detail }) => {
      if (type !== EventType.DELIVERED) return;
      const data = detail.notification?.data;
      if (data?.notifType !== NOTIF_DATA_TYPE) return;
      const intervalSeconds = Number(data.intervalSeconds);
      const notifId = detail.notification?.id ?? '';
      if (intervalSeconds) await runScheduledJob(intervalSeconds, notifId);
      refresh();
    });
  }, [refresh]);

  const hasContent = jobState || logs.length > 0;

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {jobState && (
            <SectionCard title="Active schedule">
              <CountdownBadge firesAt={jobState.willFireAt} />
              <InfoRow label="Interval" value={formatInterval(jobState.intervalSeconds)} />
              <InfoRow label="Next check-in" value={formatDateTime(jobState.willFireAt)} />
              {jobState.lastRanAt && (
                <InfoRow label="Last check-in" value={formatDateTime(jobState.lastRanAt)} />
              )}
            </SectionCard>
          )}

          {logs.length > 0 && (
            <SectionCard title="Check-in history">
              {logs.map((entry, i) => (
                <View key={entry.ranAt}>
                  {i > 0 && <View style={logStyles.divider} />}
                  <LogItem entry={entry} />
                </View>
              ))}
              <TouchableOpacity
                style={[btnStyles.btn, btnStyles.danger]}
                onPress={handleClearLogs}
                activeOpacity={0.7}
              >
                <ThemedText style={btnStyles.dangerLabel}>Clear all logs</ThemedText>
              </TouchableOpacity>
            </SectionCard>
          )}

          {!hasContent && (
            <ThemedView type="backgroundElement" style={emptyStyles.box}>
              <ThemedText type="smallBold" style={emptyStyles.title}>No check-ins yet</ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={emptyStyles.text}>
                Pair a device and schedule check-ins on the Home tab. Results appear here.
              </ThemedText>
            </ThemedView>
          )}
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: BottomTabInset,
    gap: Spacing.three,
    maxWidth: MaxContentWidth,
    width: '100%',
    alignSelf: 'center',
  },
});

const emptyStyles = StyleSheet.create({
  box: { borderRadius: 16, padding: Spacing.four, alignItems: 'center', gap: Spacing.one },
  title: {},
  text: { textAlign: 'center', lineHeight: 18 },
});

const btnStyles = StyleSheet.create({
  btn: {
    borderRadius: 12,
    paddingHorizontal: Spacing.three,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    minHeight: 46,
    marginTop: Spacing.one,
  },
  danger: {
    backgroundColor: '#ef444410',
    borderWidth: 1,
    borderColor: '#ef444440',
  },
  dangerLabel: { color: '#ef4444', fontSize: 15, fontWeight: '600' },
});
