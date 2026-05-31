import notifee, { EventType } from '@notifee/react-native';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useTheme } from '@/hooks/use-theme';
import { useBLESetup } from '@/hooks/use-ble-setup';
import { usePermissions, type PermissionKey } from '@/hooks/use-permissions';
import { Brand, BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import {
  NOTIF_DATA_TYPE,
  type JobState,
  armTrigger,
  bumpGeneration,
  cancelSchedule,
  clearAuthToken,
  ensureChannel,
  ensureScheduleArmed,
  loadAuthToken,
  loadJobState,
  runScheduledJob,
  saveAuthToken,
  saveJobState,
} from '@/tasks/scheduler-task';
import { connectAndReadSysInfo } from '@/tasks/ble-task';

// ── shared bits ─────────────────────────────────────────────────────────────

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <ThemedView type="backgroundElement" style={cardStyles.card}>
      <View style={cardStyles.header}>
        <ThemedText type="smallBold">{title}</ThemedText>
        {subtitle ? (
          <ThemedText type="small" themeColor="textSecondary" style={cardStyles.subtitle}>
            {subtitle}
          </ThemedText>
        ) : null}
      </View>
      {children ? <View style={cardStyles.body}>{children}</View> : null}
    </ThemedView>
  );
}

const cardStyles = StyleSheet.create({
  card: { borderRadius: 16, overflow: 'hidden' },
  header: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
    gap: 4,
  },
  subtitle: { lineHeight: 18 },
  body: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.three,
    gap: Spacing.two,
  },
});

function CollapsibleCard({
  title,
  summary,
  summaryColor,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  summaryColor: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <ThemedView type="backgroundElement" style={cardStyles.card}>
      <TouchableOpacity
        style={collapseStyles.header}
        onPress={onToggle}
        activeOpacity={0.7}
      >
        <ThemedText type="smallBold" style={collapseStyles.headerTitle}>{title}</ThemedText>
        <ThemedText type="small" style={{ color: summaryColor }}>{summary}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={collapseStyles.chevron}>
          {open ? '▾' : '▸'}
        </ThemedText>
      </TouchableOpacity>
      {open ? <View style={cardStyles.body}>{children}</View> : null}
    </ThemedView>
  );
}

const collapseStyles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  headerTitle: { flex: 1 },
  chevron: { width: 14, textAlign: 'center' },
});

function StatusDot({ status }: { status: 'ready' | 'scanning' | 'idle' | 'error' | 'checking' }) {
  const color =
    status === 'ready' ? '#16a34a' :
      status === 'scanning' ? '#3c87f7' :
        status === 'error' ? '#ef4444' : '#94a3b8';
  return (
    <View style={[dotStyles.dot, { backgroundColor: color + '22', borderColor: color }]}>
      {status === 'scanning'
        ? <ActivityIndicator size="small" color={color} />
        : <View style={[dotStyles.inner, { backgroundColor: color }]} />}
    </View>
  );
}

const dotStyles = StyleSheet.create({
  dot: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inner: { width: 18, height: 18, borderRadius: 9 },
});

// ── permission rows ───────────────────────────────────────────────────────────

const PERMISSION_META: { key: PermissionKey; label: string; detail: string }[] = [
  { key: 'bluetooth', label: 'Bluetooth', detail: 'Connect to the device' },
  { key: 'camera', label: 'Camera', detail: 'Photograph the plant' },
  { key: 'notifications', label: 'Notifications', detail: 'Show results' },
  { key: 'alarm', label: 'Alarms & reminders', detail: 'Run while the app is closed' },
];

function PermissionRow({
  label,
  detail,
  granted,
}: {
  label: string;
  detail: string;
  granted: boolean | null;
}) {
  const color = granted ? '#16a34a' : granted === false ? '#ef4444' : '#94a3b8';
  return (
    <View style={permStyles.row}>
      <View style={[permStyles.mark, { borderColor: color, backgroundColor: color + '18' }]}>
        <ThemedText style={[permStyles.markText, { color }]}>{granted ? '✓' : '!'}</ThemedText>
      </View>
      <View style={permStyles.rowText}>
        <ThemedText type="smallBold">{label}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={{ lineHeight: 16 }}>
          {detail}
        </ThemedText>
      </View>
      <ThemedText type="small" style={{ color }}>
        {granted ? 'Granted' : granted === false ? 'Needed' : '…'}
      </ThemedText>
    </View>
  );
}

const permStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  mark: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markText: { fontSize: 14, fontWeight: '700' },
  rowText: { flex: 1, gap: 1 },
});

// ── screen ────────────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const theme = useTheme();
  const { perms, allGranted, requesting, requestAll, recheck } = usePermissions();
  const { status, deviceId, statusMsg, connect, forget } = useBLESetup();

  const [storedToken, setStoredToken] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [savingToken, setSavingToken] = useState(false);

  const [jobState, setJobState] = useState<JobState | null>(null);
  const [scheduling, setScheduling] = useState(false);

  const tokenSet = storedToken.length > 0;
  const deviceReady = status === 'ready';

  // Permissions card collapses once everything is granted; opens if action needed.
  const [permsOpen, setPermsOpen] = useState(false);
  useEffect(() => {
    setPermsOpen(!allGranted);
  }, [allGranted]);

  // Initial load + refresh on focus / resume.
  useEffect(() => {
    ensureChannel();
    loadAuthToken().then(setStoredToken);
    loadJobState().then(setJobState);
  }, []);

  useFocusEffect(useCallback(() => {
    loadAuthToken().then(setStoredToken);
    loadJobState().then(setJobState);
    // Self-heal: if a schedule is active but its alarm vanished (chain died
    // from a swallowed/failed/crashed run), re-arm it instead of waiting for
    // the user to cancel + reschedule by hand.
    ensureScheduleArmed().then(() => loadJobState().then(setJobState));
    recheck();
  }, [recheck]));

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        loadAuthToken().then(setStoredToken);
        ensureScheduleArmed().then(() => loadJobState().then(setJobState));
      }
    });
    return () => sub.remove();
  }, []);

  // A trigger that fires while the app is in the foreground is delivered HERE,
  // not to the HeadlessJS background handler — so we must run the job from here
  // too, or the chain silently dies. runScheduledJob is lock-guarded, so this
  // is safe even if the background handler also fires.
  useEffect(() => {
    return notifee.onForegroundEvent(async ({ type, detail }) => {
      if (type !== EventType.DELIVERED) return;
      const data = detail.notification?.data;
      if (data?.notifType !== NOTIF_DATA_TYPE) return;
      const intervalSeconds = Number(data.intervalSeconds);
      const notifId = detail.notification?.id ?? '';
      if (intervalSeconds) await runScheduledJob(intervalSeconds, notifId);
      loadJobState().then(setJobState);
    });
  }, []);

  async function handleSaveToken() {
    const trimmed = tokenInput.trim();
    if (!trimmed) return;
    setSavingToken(true);
    try {
      await saveAuthToken(trimmed);
      setStoredToken(trimmed);
      setTokenInput('');
    } finally {
      setSavingToken(false);
    }
  }

  async function handleForgetToken() {
    await clearAuthToken();
    setStoredToken('');
    setTokenInput('');
  }

  async function scheduleJob() {
    if (!deviceReady) return;
    setScheduling(true);
    try {
      const sysInfo = await connectAndReadSysInfo();
      if (!sysInfo) return;

      // New schedule = new generation; invalidates any in-flight background job.
      const gen = await bumpGeneration();
      const fireAt = Math.max(Date.now() + 1000, sysInfo.readAt + sysInfo.totalMs - 3_000);
      const intervalSeconds = Math.round(sysInfo.totalMs / 1000);
      const notifId = await armTrigger(fireAt, intervalSeconds, gen);
      if (!notifId) return;

      const state: JobState = {
        notificationId: notifId,
        intervalSeconds,
        scheduledAt: Date.now(),
        willFireAt: fireAt,
        lastRanAt: null,
        nextFiresAt: fireAt,
        readResponse: null,
        receiptResult: null,
        lastPhotoPath: null,
      };
      await saveJobState(state);
      setJobState(state);
    } finally {
      setScheduling(false);
    }
  }

  async function cancelJob() {
    await cancelSchedule();
    setJobState(null);
  }

  const deviceStatusLabel =
    status === 'checking' ? 'Checking…' :
      status === 'ready' ? 'Connected' :
        status === 'scanning' ? (statusMsg || 'Searching…') :
          status === 'error' ? (statusMsg || 'Not found — try again') :
            'Not paired';

  const deviceStatusColor =
    status === 'ready' ? '#16a34a' :
      status === 'scanning' ? '#3c87f7' :
        status === 'error' ? '#ef4444' : '#94a3b8';

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Banner */}
          <View style={bannerStyles.banner}>
            <Image
              source={require('@/assets/images/logo.png')}
              style={bannerStyles.logo}
              resizeMode="cover"
            />
            <View style={bannerStyles.bannerText}>
              <ThemedText style={bannerStyles.title}>PlantAgent</ThemedText>
              <ThemedText style={bannerStyles.tagline}>Autonomous Plant Brain</ThemedText>
            </View>
          </View>

          {/* Permissions */}
          <CollapsibleCard
            title="Permissions"
            summary={allGranted ? 'All granted' : 'Action needed'}
            summaryColor={allGranted ? '#16a34a' : '#ef4444'}
            open={permsOpen}
            onToggle={() => setPermsOpen(v => !v)}
          >
            <View style={styles.permList}>
              {PERMISSION_META.map(p => (
                <PermissionRow
                  key={p.key}
                  label={p.label}
                  detail={p.detail}
                  granted={perms[p.key]}
                />
              ))}
            </View>
            {!allGranted && (
              <TouchableOpacity
                style={[btnStyles.btn, btnStyles.primary, requesting && btnStyles.disabled]}
                onPress={requestAll}
                activeOpacity={0.7}
                disabled={requesting}
              >
                {requesting && (
                  <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
                )}
                <ThemedText style={btnStyles.primaryLabel}>
                  {requesting ? 'Requesting…' : 'Grant permissions'}
                </ThemedText>
              </TouchableOpacity>
            )}
          </CollapsibleCard>

          {/* Everything past here is gated on permissions */}
          {!allGranted ? (
            <LockedNote text="Grant all permissions to continue." />
          ) : (
            <>
              {/* Token */}
              <Card
                title="Server token"
                subtitle={
                  tokenSet
                    ? undefined
                    : 'Paste the token issued for your device.'
                }
              >
                {tokenSet ? (
                  <>
                    <View style={styles.tokenSavedRow}>
                      <View style={[permStyles.mark, { borderColor: '#16a34a', backgroundColor: '#16a34a18' }]}>
                        <ThemedText style={[permStyles.markText, { color: '#16a34a' }]}>✓</ThemedText>
                      </View>
                      <ThemedText type="small" themeColor="textSecondary" style={{ flex: 1 }}>
                        Token saved on this device.
                      </ThemedText>
                    </View>
                    <TouchableOpacity
                      style={[btnStyles.btn, btnStyles.danger]}
                      onPress={handleForgetToken}
                      activeOpacity={0.7}
                    >
                      <ThemedText style={btnStyles.dangerLabel}>Forget token</ThemedText>
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <TextInput
                      value={tokenInput}
                      onChangeText={setTokenInput}
                      placeholder="Paste your token"
                      placeholderTextColor="#9ca3af"
                      autoCapitalize="none"
                      autoCorrect={false}
                      secureTextEntry
                      style={[tokenStyles.input, { color: theme.text }]}
                    />
                    <TouchableOpacity
                      style={[
                        btnStyles.btn,
                        btnStyles.primary,
                        (!tokenInput.trim() || savingToken) && btnStyles.disabled,
                      ]}
                      onPress={handleSaveToken}
                      activeOpacity={0.7}
                      disabled={!tokenInput.trim() || savingToken}
                    >
                      <ThemedText style={btnStyles.primaryLabel}>
                        {savingToken ? 'Saving…' : 'Save token'}
                      </ThemedText>
                    </TouchableOpacity>
                  </>
                )}
              </Card>

              {!tokenSet ? (
                <LockedNote text="Save your token to continue." />
              ) : (
                <>
                  {/* Device */}
                  <Card title="Device">
                    <View style={styles.deviceRow}>
                      <StatusDot status={status} />
                      <View style={styles.deviceText}>
                        <ThemedText type="smallBold" style={{ color: deviceStatusColor }}>
                          {deviceStatusLabel}
                        </ThemedText>
                        <ThemedText type="small" themeColor="textSecondary">
                          {deviceReady
                            ? 'Paired and ready.'
                            : status === 'scanning'
                              ? 'Keep the device powered on and nearby.'
                              : 'Pair to schedule check-ins.'}
                        </ThemedText>
                      </View>
                    </View>

                    {deviceId && deviceReady && (
                      <View style={[styles.devicePill, { backgroundColor: theme.backgroundSelected }]}>
                        <ThemedText type="small" themeColor="textSecondary">Device ID</ThemedText>
                        <ThemedText type="code" numberOfLines={1} style={styles.devicePillValue}>
                          {deviceId}
                        </ThemedText>
                      </View>
                    )}

                    {!deviceReady && status !== 'scanning' && (
                      <TouchableOpacity
                        style={[btnStyles.btn, btnStyles.primary, status === 'checking' && btnStyles.disabled]}
                        onPress={connect}
                        activeOpacity={0.7}
                        disabled={status === 'checking'}
                      >
                        <ThemedText style={btnStyles.primaryLabel}>
                          {status === 'error' ? 'Try again' : 'Pair device'}
                        </ThemedText>
                      </TouchableOpacity>
                    )}
                    {status === 'scanning' && (
                      <View style={[btnStyles.btn, btnStyles.primary, btnStyles.disabled]}>
                        <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
                        <ThemedText style={btnStyles.primaryLabel}>Searching…</ThemedText>
                      </View>
                    )}
                    {deviceReady && (
                      <TouchableOpacity
                        style={[btnStyles.btn, btnStyles.danger]}
                        onPress={forget}
                        activeOpacity={0.7}
                      >
                        <ThemedText style={btnStyles.dangerLabel}>Forget device</ThemedText>
                      </TouchableOpacity>
                    )}
                  </Card>

                  {/* Schedule */}
                  <Card
                    title="Check-ins"
                    subtitle={
                      jobState
                        ? 'Running automatically.'
                        : 'Reads the interval from your device, then photographs the plant each cycle.'
                    }
                  >
                    {scheduling && (
                      <View style={styles.inlineRow}>
                        <ActivityIndicator size="small" color={Brand.primary} />
                        <ThemedText type="small" style={{ color: Brand.primary }}>
                          Connecting to device…
                        </ThemedText>
                      </View>
                    )}
                    {!deviceReady && (
                      <ThemedText type="small" themeColor="textSecondary">
                        Pair your device first.
                      </ThemedText>
                    )}
                    <View style={styles.scheduleBtnRow}>
                      <TouchableOpacity
                        style={[
                          btnStyles.btn,
                          btnStyles.primary,
                          styles.flex,
                          (!deviceReady || scheduling) && btnStyles.disabled,
                        ]}
                        onPress={scheduleJob}
                        activeOpacity={0.7}
                        disabled={!deviceReady || scheduling}
                      >
                        <ThemedText style={btnStyles.primaryLabel}>
                          {jobState ? 'Reschedule' : 'Schedule check-ins'}
                        </ThemedText>
                      </TouchableOpacity>
                      {jobState && !scheduling && (
                        <TouchableOpacity
                          style={[btnStyles.btn, btnStyles.danger]}
                          onPress={cancelJob}
                          activeOpacity={0.7}
                        >
                          <ThemedText style={btnStyles.dangerLabel}>Stop</ThemedText>
                        </TouchableOpacity>
                      )}
                    </View>
                    <ThemedText type="small" themeColor="textSecondary" style={styles.fineHint}>
                      See results in the Logs tab.
                    </ThemedText>
                  </Card>
                </>
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

function LockedNote({ text }: { text: string }) {
  return (
    <ThemedView type="backgroundElement" style={lockStyles.box}>
      <ThemedText type="small" themeColor="textSecondary" style={lockStyles.text}>
        {text}
      </ThemedText>
    </ThemedView>
  );
}

const lockStyles = StyleSheet.create({
  box: { borderRadius: 16, padding: Spacing.three },
  text: { textAlign: 'center', lineHeight: 18 },
});

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
  permList: { gap: Spacing.three, marginBottom: 4 },
  tokenSavedRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  deviceRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  deviceText: { flex: 1, gap: 2 },
  devicePill: {
    borderRadius: 8,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    gap: 2,
  },
  devicePillValue: { fontSize: 11 },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  scheduleBtnRow: { flexDirection: 'row', gap: Spacing.two },
  flex: { flex: 1 },
  fineHint: { textAlign: 'center', marginTop: 2 },
});

const bannerStyles = StyleSheet.create({
  banner: {
    backgroundColor: Brand.bannerBg,
    borderRadius: 20,
    paddingVertical: Spacing.four,
    paddingHorizontal: Spacing.four,
    minHeight: 150,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  logo: {
    position: 'absolute',
    right: -40,
    top: -20,
    width: 220,
    height: 220,
  },
  bannerText: { gap: 4, maxWidth: '62%' },
  title: { color: '#fff', fontSize: 28, fontWeight: '800', lineHeight: 32 },
  tagline: { color: '#ffffffd0', fontSize: 15, fontWeight: '500' },
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
  },
  primary: { backgroundColor: Brand.primary },
  disabled: { opacity: 0.4 },
  danger: {
    backgroundColor: '#ef444410',
    borderWidth: 1,
    borderColor: '#ef444440',
  },
  primaryLabel: { color: '#fff', fontSize: 15, fontWeight: '600' },
  dangerLabel: { color: '#ef4444', fontSize: 15, fontWeight: '600' },
});

const tokenStyles = StyleSheet.create({
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#00000033',
    borderRadius: 10,
    paddingHorizontal: Spacing.three,
    paddingVertical: 12,
    fontSize: 13,
    fontFamily: 'monospace',
  },
});
