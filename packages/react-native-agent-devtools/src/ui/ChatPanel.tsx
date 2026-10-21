import { useEffect, useRef, useState, type ComponentRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import type { ChatMessage, Runtime, UIState } from '../runtime/Runtime';
import { useStore } from '../utils/Store';
import { ClaudeMark } from './ClaudeMark';
import { Markdown } from './Markdown';
import type { Palette } from './theme';

const SUGGESTIONS = ['What screen am I on?', 'Check for errors', 'Take a screenshot and describe the screen'];

function statusText(s: UIState): string {
  switch (s.connection) {
    case 'connected':
      return s.server?.agent.available === false ? `Connected · agent unavailable` : 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'pairing-required':
      return 'Pairing required';
    case 'disconnected':
      return 'Disconnected · retrying';
    case 'error':
      return 'Error';
    default:
      return 'Offline';
  }
}

export function statusColor(s: UIState['connection'], p: Palette): string {
  return s === 'connected' ? p.ok : s === 'connecting' || s === 'pairing-required' ? p.warn : p.error;
}

function ToolRow({ m, p }: { m: ChatMessage; p: Palette }) {
  const t = m.tool!;
  const running = t.phase === 'start';
  return (
    <View style={[styles.toolRow, { borderColor: p.border, backgroundColor: p.surface }]}>
      {running ? (
        <ActivityIndicator size="small" color={p.accent} style={styles.toolIcon} />
      ) : (
        <Text style={[styles.toolIcon, styles.toolGlyph, { color: t.ok === false ? p.error : p.ok }]}>{t.ok === false ? '✕' : '✓'}</Text>
      )}
      <Text numberOfLines={1} style={[styles.toolText, { color: p.muted }]}>
        {t.summary ?? t.name}
      </Text>
      {t.durationMs !== undefined ? <Text style={[styles.toolMs, { color: p.muted }]}>{t.durationMs}ms</Text> : null}
    </View>
  );
}

function Message({ m, p }: { m: ChatMessage; p: Palette }) {
  if (m.role === 'tool' && m.tool) return <ToolRow m={m} p={p} />;
  if (m.role === 'user') {
    return (
      <View style={[styles.userBubble, { backgroundColor: p.userBubble }]}>
        <Text selectable style={[styles.bodyText, { color: p.text }]}>
          {m.text}
        </Text>
      </View>
    );
  }
  if (m.role === 'error' || m.role === 'system') {
    return <Text style={[styles.errorText, { color: m.role === 'error' ? p.error : p.muted }]}>{m.text}</Text>;
  }
  return (
    <View style={styles.assistant}>
      <Markdown text={m.text} palette={p} />
    </View>
  );
}

interface Props {
  runtime: Runtime;
  palette: Palette;
  insets: { top: number; bottom: number };
  collapsed: boolean;
  onExpand: () => void;
  onClose: () => void;
  onHideLauncher: () => void;
}

export function ChatPanel({ runtime, palette: p, insets, collapsed, onExpand, onClose, onHideLauncher }: Props) {
  const state = useStore(runtime.store, (s) => s);
  const { height } = useWindowDimensions();
  const [draft, setDraft] = useState('');
  const [code, setCode] = useState('');
  const [showPerf, setShowPerf] = useState(false);
  const [kb, setKb] = useState(0);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(slide, { toValue: 1, useNativeDriver: true, friction: 9, tension: 70 }).start();
  }, [slide]);

  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, (e) => setKb(e.endCoordinates.height));
    const b = Keyboard.addListener(hideEvt, () => setKb(0));
    return () => {
      a.remove();
      b.remove();
    };
  }, []);

  const busy = state.chat !== 'idle';
  const lastTool = [...state.messages].reverse().find((m) => m.role === 'tool');
  const lastText = [...state.messages].reverse().find((m) => m.role === 'assistant');
  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [400, 0] });
  const panelHeight = Math.min(height * 0.62, height - insets.top - kb - 40);

  const send = () => {
    if (!draft.trim() || busy) return;
    runtime.sendChat(draft);
    setDraft('');
  };

  if (collapsed) {
    return (
      <Animated.View style={[styles.compact, { backgroundColor: p.bg, borderColor: p.border, bottom: insets.bottom + 10, transform: [{ translateY }] }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Expand agent chat" style={styles.compactMain} onPress={onExpand}>
          <ActivityIndicator size="small" color={p.accent} />
          <Text numberOfLines={1} style={[styles.compactText, { color: p.text }]}>
            {lastTool?.tool?.phase === 'start' ? lastTool.tool.summary ?? lastTool.tool.name : lastText?.text.split('\n').pop() || 'Working…'}
          </Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Stop agent" onPress={() => runtime.cancel()} style={[styles.stopSmall, { backgroundColor: p.error }]}>
          <View style={styles.stopSquare} />
        </Pressable>
      </Animated.View>
    );
  }

  const confirm = state.pendingConfirm;
  const pairing = state.connection === 'pairing-required';

  return (
    <Animated.View
      style={[
        styles.panel,
        { height: panelHeight, bottom: kb, paddingBottom: kb ? 8 : insets.bottom + 8, backgroundColor: p.bg, borderColor: p.border, transform: [{ translateY }] },
      ]}
    >
      <View style={[styles.header, { borderColor: p.border }]}>
        <ClaudeMark size={18} />
        <View style={styles.headerTitle}>
          <Text style={[styles.title, { color: p.text }]}>Agent DevTools</Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: statusColor(state.connection, p) }]} />
            <Text numberOfLines={1} style={[styles.statusText, { color: p.muted }]}>
              {statusText(state)}
              {state.server?.agent.model ? ` · ${state.server.agent.model}` : ''}
            </Text>
          </View>
        </View>
        <HeaderButton label="New chat" glyph="＋" p={p} onPress={() => runtime.resetChat()} />
        <HeaderButton label="Performance" glyph="⏱" p={p} active={showPerf} onPress={() => setShowPerf((v) => !v)} />
        <HeaderButton label="Hide launcher" glyph="◌" p={p} onPress={onHideLauncher} />
        <HeaderButton label="Close chat" glyph="✕" p={p} onPress={onClose} />
      </View>

      {showPerf ? <PerfPanel runtime={runtime} p={p} /> : null}

      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {state.messages.length === 0 ? (
          <View style={styles.empty}>
            <Text style={[styles.emptyTitle, { color: p.text }]}>Ask about this screen, or tell the agent what to do.</Text>
            {state.server?.agent.available === false ? (
              <Text style={[styles.errorText, { color: p.warn }]}>Agent unavailable: {state.server.agent.reason}</Text>
            ) : null}
            <View style={styles.chips}>
              {SUGGESTIONS.map((s) => (
                <Pressable key={s} onPress={() => runtime.sendChat(s)} disabled={state.connection !== 'connected'} style={[styles.chip, { borderColor: p.border }]}>
                  <Text style={[styles.chipText, { color: p.text }]}>{s}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          state.messages.map((m) => <Message key={m.id} m={m} p={p} />)
        )}
        {busy && state.messages[state.messages.length - 1]?.role === 'user' ? (
          <View style={styles.thinking}>
            <ActivityIndicator size="small" color={p.accent} />
            <Text style={[styles.statusText, { color: p.muted }]}>Thinking…</Text>
          </View>
        ) : null}
      </ScrollView>

      {confirm ? (
        <View style={[styles.confirm, { borderColor: p.warn, backgroundColor: p.surface }]}>
          <Text style={[styles.confirmTitle, { color: p.text }]}>{confirm.title}</Text>
          <Text style={[styles.bodyText, { color: p.text }]}>{confirm.detail}</Text>
          <View style={styles.confirmRow}>
            <Pressable onPress={() => runtime.answerConfirm(confirm.id, false)} style={[styles.confirmBtn, { borderColor: p.border }]}>
              <Text style={[styles.confirmBtnText, { color: p.text }]}>Deny</Text>
            </Pressable>
            <Pressable onPress={() => runtime.answerConfirm(confirm.id, true)} style={[styles.confirmBtn, { backgroundColor: p.accent, borderColor: p.accent }]}>
              <Text style={[styles.confirmBtnText, { color: p.accentText }]}>Allow once</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {pairing ? (
        <View style={[styles.composer, { borderColor: p.border }]}>
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="Pairing code from the server terminal"
            placeholderTextColor={p.muted}
            autoCapitalize="characters"
            autoCorrect={false}
            style={[styles.input, { color: p.text, backgroundColor: p.surface }]}
            onSubmitEditing={() => runtime.submitPairingCode(code)}
          />
          <Pressable onPress={() => runtime.submitPairingCode(code)} style={[styles.send, { backgroundColor: p.accent }]}>
            <Text style={[styles.sendGlyph, { color: p.accentText }]}>→</Text>
          </Pressable>
        </View>
      ) : (
        <View style={[styles.composer, { borderColor: p.border }]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={state.connection === 'connected' ? 'Message the agent…' : 'Waiting for the devtools server…'}
            placeholderTextColor={p.muted}
            multiline
            style={[styles.input, { color: p.text, backgroundColor: p.surface }]}
            onSubmitEditing={send}
            blurOnSubmit={false}
            returnKeyType="send"
            submitBehavior="submit"
          />
          {busy ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Stop agent" onPress={() => runtime.cancel()} style={[styles.send, { backgroundColor: p.error }]}>
              <View style={styles.stopSquare} />
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" accessibilityLabel="Send message" onPress={send} style={[styles.send, { backgroundColor: draft.trim() ? p.accent : p.border }]}>
              <Text style={[styles.sendGlyph, { color: p.accentText }]}>↑</Text>
            </Pressable>
          )}
        </View>
      )}
    </Animated.View>
  );
}

function HeaderButton({ glyph, label, onPress, p, active }: { glyph: string; label: string; onPress: () => void; p: Palette; active?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={8} onPress={onPress} style={[styles.headerBtn, active ? { backgroundColor: p.surface } : null]}>
      <Text style={[styles.headerGlyph, { color: p.muted }]}>{glyph}</Text>
    </Pressable>
  );
}

function PerfPanel({ runtime, p }: { runtime: Runtime; p: Palette }) {
  const stats = useStore(runtime.store, (s) => s.lastStats);
  const perf = runtime.perfSummary();
  const ops = Object.entries(perf.ops).slice(0, 8);
  return (
    <View style={[styles.perf, { borderColor: p.border, backgroundColor: p.surface }]}>
      {stats ? (
        <Text style={[styles.perfText, { color: p.text }]}>
          Last turn {stats.totalMs}ms · model {stats.modelMs}ms · tools {stats.toolMs}ms (device {stats.deviceMs}ms) · first token{' '}
          {stats.firstTokenMs ?? '–'}ms · {stats.toolCalls} tool calls{stats.costUsd !== undefined ? ` · $${stats.costUsd.toFixed(4)}` : ''}
        </Text>
      ) : (
        <Text style={[styles.perfText, { color: p.muted }]}>No completed turn yet.</Text>
      )}
      {ops.map(([op, v]) => (
        <Text key={op} style={[styles.perfText, { color: p.muted }]}>
          {op}: p50 {v.p50}ms · p95 {v.p95}ms · n={v.n}
        </Text>
      ))}
      {perf.lastSnapshot ? (
        <Text style={[styles.perfText, { color: p.muted }]}>
          last snapshot: {perf.lastSnapshot.collectMs}ms ({perf.lastSnapshot.fibers} fibers, {perf.lastSnapshot.hostNodes} host views, hit-test{' '}
          {perf.lastSnapshot.hitTestMs ?? '–'}ms)
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 },
    elevation: 16,
  },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  headerTitle: { flex: 1, marginLeft: 2 },
  title: { fontSize: 15, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 12 },
  headerBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  headerGlyph: { fontSize: 16 },
  messages: { flex: 1 },
  messagesContent: { padding: 14, gap: 10 },
  bodyText: { fontSize: 15, lineHeight: 21 },
  userBubble: { alignSelf: 'flex-end', maxWidth: '86%', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  assistant: { alignSelf: 'stretch' },
  errorText: { fontSize: 13 },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  toolIcon: { width: 16 },
  toolGlyph: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  toolText: { flex: 1, fontSize: 12.5 },
  toolMs: { fontSize: 11 },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  empty: { gap: 12, paddingVertical: 8 },
  emptyTitle: { fontSize: 15, fontWeight: '600' },
  chips: { gap: 8 },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, alignSelf: 'flex-start' },
  chipText: { fontSize: 14 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, minHeight: 40, maxHeight: 110, borderRadius: 20, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, fontSize: 15 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  sendGlyph: { fontSize: 20, fontWeight: '700' },
  stopSquare: { width: 12, height: 12, borderRadius: 2, backgroundColor: '#fff' },
  confirm: { marginHorizontal: 12, marginBottom: 8, borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  confirmTitle: { fontSize: 15, fontWeight: '700' },
  confirmRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  confirmBtn: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  confirmBtnText: { fontSize: 14, fontWeight: '600' },
  compact: {
    position: 'absolute',
    left: 12,
    right: 12,
    height: 52,
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    paddingRight: 6,
    gap: 10,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 10,
  },
  compactMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  compactText: { flex: 1, fontSize: 13.5 },
  stopSmall: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  perf: { marginHorizontal: 12, marginTop: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 3 },
  perfText: { fontSize: 11.5 },
});
