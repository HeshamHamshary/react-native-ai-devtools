import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import type { Runtime, UIState } from '../runtime/Runtime';
import { selectionTitle } from '../runtime/Runtime';
import { useStore } from '../utils/Store';
import { Mark } from './Mark';
import { Message } from './Messages';
import { mono, radius, type Palette } from './theme';

const SUGGESTIONS = ['What screen am I on?', 'Check this screen for bugs', 'Any errors or failed requests?', 'Take a screenshot and describe the screen'];
const MODELS: (string | undefined)[] = [undefined, 'sonnet', 'opus', 'haiku'];

export function statusText(s: UIState): string {
  switch (s.connection) {
    case 'connected': {
      const a = s.server?.agent;
      if (!a?.available) return 'Connected · model not set up';
      if (a.via === 'claude-code') return 'Connected · your Claude Code';
      return ['Connected', a.credentials, a.model].filter(Boolean).join(' · ');
    }
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

interface Props {
  runtime: Runtime;
  palette: Palette;
  insets: { top: number; bottom: number };
  collapsed: boolean;
  /** The picked element is attached to the next message. */
  attach: boolean;
  onAttachChange: (attach: boolean) => void;
  onExpand: () => void;
  onClose: () => void;
  onHideLauncher: () => void;
}

export function ChatPanel({ runtime, palette: p, insets, collapsed, attach, onAttachChange, onExpand, onClose, onHideLauncher }: Props) {
  const state = useStore(runtime.store, (s) => s);
  const { height } = useWindowDimensions();
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const [kb, setKb] = useState(0);
  const scrollRef = useRef<{ scrollToEnd: (o?: { animated?: boolean }) => void } | null>(null);
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(slide, { toValue: 1, useNativeDriver: true, friction: 10, tension: 80 }).start();
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
  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [500, 0] });
  const panelHeight = Math.min(height * 0.64, height - insets.top - kb - 40);
  const selection = attach ? state.selection : undefined;

  const send = (text = draft) => {
    if (!text.trim() || busy) return;
    runtime.sendChat(text, !!selection);
    setDraft('');
    if (selection) onAttachChange(false);
  };

  if (collapsed) {
    const lastTool = [...state.messages].reverse().find((m) => m.role === 'tool');
    const lastText = [...state.messages].reverse().find((m) => m.role === 'assistant');
    return (
      <Animated.View style={[styles.compact, { backgroundColor: p.bg, borderColor: p.border, bottom: insets.bottom + 10, transform: [{ translateY }] }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Expand agent chat" style={styles.compactMain} onPress={onExpand}>
          <ActivityIndicator size="small" color={p.accent} />
          <Text numberOfLines={1} style={[styles.compactText, { color: p.text }]}>
            {lastTool?.tool?.phase === 'start' ? (lastTool.tool.summary ?? lastTool.tool.name) : lastText?.text.split('\n').pop() || 'Working…'}
          </Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Stop agent" onPress={() => runtime.cancel()} style={[styles.stopSmall, { backgroundColor: p.error }]}>
          <View style={styles.stopSquare} />
        </Pressable>
      </Animated.View>
    );
  }

  const confirm = state.pendingConfirm;
  const pairing = state.connection === 'pairing-required' || state.pairingRequested === true;
  const needsSetup = state.connection === 'connected' && state.server?.agent.available === false;
  const builtIn = state.server?.agent.available && !state.server.agent.via && state.server.agent.setup !== false;

  return (
    <Animated.View
      accessibilityViewIsModal
      style={[
        styles.panel,
        { height: panelHeight, bottom: kb, paddingBottom: kb ? 8 : insets.bottom + 8, backgroundColor: p.bg, borderColor: p.border, transform: [{ translateY }] },
      ]}
    >
      <View style={[styles.header, { borderColor: p.border }]}>
        <Mark size={20} color={p.accent} />
        <View style={styles.headerTitle}>
          <View style={styles.titleRow}>
            <Text style={[styles.title, { color: p.text }]}>Agent DevTools</Text>
            {state.trusted ? (
              <View style={[styles.badge, { borderColor: p.ok }]}>
                <Text style={[styles.badgeText, { color: p.ok }]}>paired</Text>
              </View>
            ) : null}
          </View>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: statusColor(state.connection, p) }]} />
            <Text numberOfLines={1} style={[styles.statusText, { color: p.muted }]}>
              {statusText(state)}
            </Text>
          </View>
        </View>
        <HeaderButton label="Inspect an element" glyph="mark" p={p} active={state.inspecting} onPress={() => (state.inspecting ? runtime.stopInspect() : runtime.startInspect())} />
        <HeaderButton label="New chat" glyph="＋" p={p} onPress={() => runtime.resetChat()} />
        <HeaderButton label="More" glyph="⋯" p={p} active={menu} onPress={() => setMenu((v) => !v)} />
        <HeaderButton label="Close" glyph="✕" p={p} onPress={onClose} />
      </View>

      {menu ? (
        <View style={[styles.menu, { backgroundColor: p.bg, borderColor: p.border }]}>
          {state.trusted ? (
            <MenuItem label="Unpair this app" p={p} onPress={() => (setMenu(false), runtime.unpair())} />
          ) : (
            <MenuItem label="Pair this app…" hint="needed to approve edits and permissions" p={p} onPress={() => (setMenu(false), runtime.requestPairing())} />
          )}
          {builtIn ? (
            <MenuItem
              label={`Model: ${state.server?.agent.model ?? 'server default'}`}
              hint="tap to switch (starts a new chat)"
              p={p}
              onPress={() => {
                const current = MODELS.findIndex((m) => m !== undefined && state.server?.agent.model?.includes(m));
                runtime.setModel(MODELS[(current + 1) % MODELS.length]);
              }}
            />
          ) : null}
          <MenuItem label={diagnostics ? 'Hide diagnostics' : 'Diagnostics'} p={p} onPress={() => (setMenu(false), setDiagnostics((v) => !v))} />
          <MenuItem label="Hide launcher" hint="restore from the dev menu" p={p} onPress={() => (setMenu(false), onHideLauncher())} />
        </View>
      ) : null}

      {diagnostics ? <Diagnostics runtime={runtime} state={state} p={p} /> : null}

      <ScrollView
        ref={scrollRef as never}
        style={styles.messages}
        contentContainerStyle={[styles.messagesContent, needsSetup ? styles.centered : null]}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => {
          if (state.messages.length) scrollRef.current?.scrollToEnd({ animated: true });
        }}
      >
        {state.connection !== 'connected' && state.connectionHint ? (
          <View style={[styles.hint, { borderColor: p.warn, backgroundColor: p.surface }]}>
            <Text selectable style={[styles.note, styles.hintText, { color: p.text }]}>
              {state.connectionHint}
            </Text>
          </View>
        ) : null}
        {needsSetup ? (
          <View style={styles.setupWrap}>
            <SetUp p={p} setup={state.setup} canSetup={state.server?.agent.setup === true} reason={state.server?.agent.reason} onSetup={() => runtime.openSetup()} />
            <View style={[styles.divider, { backgroundColor: p.border }]} />
            <Text style={[styles.note, { color: p.muted }]}>Inspecting works without a model:</Text>
            <InspectButton p={p} center onPress={() => runtime.startInspect()} />
          </View>
        ) : state.messages.length === 0 ? (
          <View style={styles.empty}>
            <Text style={[styles.emptyTitle, { color: p.text }]}>Ask about this screen, or tell the agent what to do.</Text>
            <InspectButton p={p} onPress={() => runtime.startInspect()} />
            <View style={styles.chips}>
              {SUGGESTIONS.map((s) => (
                <Pressable key={s} accessibilityRole="button" onPress={() => send(s)} disabled={state.connection !== 'connected'} style={[styles.chip, { borderColor: p.border }]}>
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
          <Text style={[styles.body, { color: p.text }]}>{confirm.detail}</Text>
          <View style={styles.confirmRow}>
            <Pressable accessibilityRole="button" onPress={() => runtime.answerConfirm(confirm.id, false)} style={[styles.confirmBtn, { borderColor: p.border }]}>
              <Text style={[styles.confirmBtnText, { color: p.text }]}>Deny</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => runtime.answerConfirm(confirm.id, true)} style={[styles.confirmBtn, { backgroundColor: p.accent, borderColor: p.accent }]}>
              <Text style={[styles.confirmBtnText, { color: p.accentText }]}>Allow once</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {pairing ? (
        <Pairing runtime={runtime} state={state} p={p} />
      ) : needsSetup ? null : (
        <View style={[styles.composerWrap, { borderColor: p.border }]}>
          {selection ? (
            <View style={[styles.attachChip, { borderColor: p.accent }]}>
              <Text numberOfLines={1} style={[styles.attachText, { color: p.accent }]}>
                ⌖ {selectionTitle(selection.details)}
              </Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Don't attach the element" hitSlop={10} onPress={() => onAttachChange(false)}>
                <Text style={[styles.attachText, { color: p.muted }]}>✕</Text>
              </Pressable>
            </View>
          ) : null}
          <View style={styles.composer}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={state.connection !== 'connected' ? 'Waiting for the devtools server…' : selection ? 'Ask about this element…' : 'Message the agent…'}
              placeholderTextColor={p.muted}
              multiline
              autoFocus={!!selection}
              style={[styles.input, { color: p.text, backgroundColor: p.surface }]}
              onSubmitEditing={() => send()}
              returnKeyType="send"
              submitBehavior="submit"
            />
            {busy ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Stop agent" onPress={() => runtime.cancel()} style={[styles.send, { backgroundColor: p.error }]}>
                <View style={styles.stopSquare} />
              </Pressable>
            ) : (
              <Pressable accessibilityRole="button" accessibilityLabel="Send message" onPress={() => send()} style={[styles.send, { backgroundColor: draft.trim() ? p.accent : p.border }]}>
                <Text style={[styles.sendGlyph, { color: p.accentText }]}>↑</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    </Animated.View>
  );
}

function Pairing({ runtime, state, p }: { runtime: Runtime; state: UIState; p: Palette }) {
  const [code, setCode] = useState('');
  return (
    <View style={[styles.composerWrap, { borderColor: p.border }]}>
      <View style={styles.pairingHead}>
        <Text style={[styles.note, styles.pairingText, { color: p.muted }]}>
          {state.connection === 'pairing-required' && state.connectionDetail
            ? state.connectionDetail
            : 'Pair this app to approve code edits and Claude Code permissions from it. Enter the code shown in the server terminal.'}
        </Text>
        {state.pairingRequested ? (
          <Pressable accessibilityRole="button" hitSlop={8} onPress={() => runtime.cancelPairing()}>
            <Text style={[styles.link, { color: p.muted }]}>Cancel</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.composer}>
        <TextInput
          value={code}
          onChangeText={setCode}
          placeholder="Pairing code from the server terminal"
          placeholderTextColor={p.muted}
          autoCapitalize="characters"
          autoCorrect={false}
          style={[styles.input, styles.codeInput, { color: p.text, backgroundColor: p.surface }]}
          onSubmitEditing={() => runtime.submitPairingCode(code)}
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Pair" onPress={() => runtime.submitPairingCode(code)} style={[styles.send, { backgroundColor: p.accent }]}>
          <Text style={[styles.sendGlyph, { color: p.accentText }]}>→</Text>
        </Pressable>
      </View>
    </View>
  );
}

const CLAUDE_CODE_COMMAND = 'react-native-agent-devtools-server claude';

/**
 * Shown until a model is connected. "Set up Claude" signs in with the developer's
 * Anthropic Console account in the computer's browser; the chat turns on by itself.
 * Alternatively the developer's own Claude Code answers (channels).
 */
function SetUp({ p, setup, canSetup, reason, onSetup }: { p: Palette; setup: UIState['setup']; canSetup: boolean; reason?: string; onSetup: () => boolean }) {
  const [showClaudeCode, setShowClaudeCode] = useState(!canSetup);
  const waiting = setup?.state === 'waiting';
  return (
    <View style={styles.setup}>
      {canSetup ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Set up Claude"
            accessibilityState={{ busy: waiting }}
            onPress={onSetup}
            style={({ pressed }) => [styles.setupBtn, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1 }]}
          >
            {waiting ? <ActivityIndicator size="small" color={p.accentText} /> : null}
            <Text style={[styles.setupBtnText, { color: p.accentText }]}>{waiting ? 'Finish signing in on your computer' : 'Set up Claude'}</Text>
          </Pressable>
          {setup?.state === 'failed' ? <Text style={[styles.note, { color: p.error }]}>{setup.message ?? 'Sign-in did not complete.'}</Text> : null}
        </>
      ) : reason ? (
        <Text style={[styles.note, { color: p.muted }]}>{reason}</Text>
      ) : null}
      {showClaudeCode ? (
        <View style={styles.setup}>
          <Text style={[styles.note, { color: p.muted }]}>Use your own Claude Code login. Run this on your computer and keep it open:</Text>
          <Text selectable style={[styles.command, { color: p.text, backgroundColor: p.code, borderColor: p.border }]}>
            {CLAUDE_CODE_COMMAND}
          </Text>
          <Pressable accessibilityRole="button" hitSlop={8} onPress={() => Share.share({ message: CLAUDE_CODE_COMMAND })}>
            <Text style={[styles.link, { color: p.accent }]}>Share / copy command</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setShowClaudeCode(true)}>
          <Text style={[styles.link, { color: p.muted }]}>Use my Claude Code instead</Text>
        </Pressable>
      )}
    </View>
  );
}

function Diagnostics({ runtime, state, p }: { runtime: Runtime; state: UIState; p: Palette }) {
  const perf = runtime.perfSummary();
  const stats = state.lastStats;
  const ops = Object.entries(perf.ops).slice(0, 8);
  const a = state.server?.agent;
  const rows: [string, string][] = [
    ['server', `${state.serverUrl}${state.server ? ` · v${state.server.version}` : ''}`],
    ['connection', `${state.connection}${state.connectionDetail ? ` (${state.connectionDetail})` : ''}${state.trusted ? ' · paired' : ''}`],
    ['agent', a ? (a.available ? `${a.via === 'claude-code' ? 'your Claude Code' : (a.credentials ?? 'ready')}${a.model ? ` · ${a.model}` : ''}` : `unavailable${a.reason ? `: ${a.reason}` : ''}`) : '—'],
    ['repo access', state.server?.repoAccess ?? '—'],
    ['transport', `${(perf.transport.bytesIn / 1024).toFixed(0)} KB in · ${(perf.transport.bytesOut / 1024).toFixed(0)} KB out · ${perf.rpc.calls} device calls (avg ${perf.rpc.avgDeviceMs} ms)`],
  ];
  if (perf.lastSnapshot) {
    rows.push(['last snapshot', `${perf.lastSnapshot.collectMs} ms · ${perf.lastSnapshot.fibers} fibers · ${perf.lastSnapshot.hostNodes} views · hit-test ${perf.lastSnapshot.hitTestMs ?? '–'} ms`]);
  }
  if (stats) {
    rows.push([
      'last turn',
      `${stats.totalMs} ms · model ${stats.modelMs} ms · tools ${stats.toolMs} ms (device ${stats.deviceMs} ms) · first token ${stats.firstTokenMs ?? '–'} ms · ${stats.toolCalls} tool calls${stats.costUsd !== undefined ? ` · est. $${stats.costUsd.toFixed(4)}` : ''}`,
    ]);
  }
  for (const [op, v] of ops) rows.push([op, `p50 ${v.p50} ms · p95 ${v.p95} ms · n=${v.n}`]);
  return (
    <View style={[styles.diag, { borderColor: p.border, backgroundColor: p.surface }]}>
      {rows.map(([k, v]) => (
        <View key={k} style={styles.diagRow}>
          <Text style={[styles.diagKey, { color: p.muted }]}>{k}</Text>
          <Text selectable style={[styles.diagVal, { color: p.text }]}>
            {v}
          </Text>
        </View>
      ))}
    </View>
  );
}

function InspectButton({ p, onPress, center }: { p: Palette; onPress: () => void; center?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Inspect an element"
      onPress={onPress}
      style={[styles.inspectCta, center ? styles.center : null, { borderColor: p.accent, backgroundColor: p.accentFill }]}
    >
      <Mark size={16} color={p.accent} />
      <Text style={[styles.inspectCtaText, { color: p.accent }]}>Inspect an element</Text>
    </Pressable>
  );
}

function MenuItem({ label, hint, onPress, p }: { label: string; hint?: string; onPress: () => void; p: Palette }) {
  return (
    <Pressable accessibilityRole="menuitem" onPress={onPress} style={({ pressed }) => [styles.menuItem, pressed ? { backgroundColor: p.surface } : null]}>
      <Text style={[styles.menuLabel, { color: p.text }]}>{label}</Text>
      {hint ? <Text style={[styles.menuHint, { color: p.muted }]}>{hint}</Text> : null}
    </Pressable>
  );
}

function HeaderButton({ glyph, label, onPress, p, active }: { glyph: string | 'mark'; label: string; onPress: () => void; p: Palette; active?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
      hitSlop={6}
      onPress={onPress}
      style={[styles.headerBtn, active ? { backgroundColor: p.accentFill } : null]}
    >
      {glyph === 'mark' ? <Mark size={18} color={active ? p.accent : p.muted} /> : <Text style={[styles.headerGlyph, { color: active ? p.accent : p.muted }]}>{glyph}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 },
    elevation: 16,
  },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  headerTitle: { flex: 1, marginLeft: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontSize: 15, fontWeight: '700' },
  badge: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 },
  badgeText: { fontSize: 10.5, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 12, flexShrink: 1 },
  headerBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  headerGlyph: { fontSize: 17 },
  menu: {
    position: 'absolute',
    top: 54,
    right: 12,
    zIndex: 10,
    minWidth: 240,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 20,
  },
  menuItem: { paddingHorizontal: 14, paddingVertical: 10 },
  menuLabel: { fontSize: 14, fontWeight: '600' },
  menuHint: { fontSize: 12, marginTop: 1 },
  messages: { flex: 1 },
  messagesContent: { padding: 14, gap: 10 },
  body: { fontSize: 15, lineHeight: 21 },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  empty: { gap: 12, paddingVertical: 8 },
  emptyTitle: { fontSize: 15, fontWeight: '600' },
  inspectCta: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  inspectCtaText: { fontSize: 14, fontWeight: '700' },
  chips: { gap: 8 },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, alignSelf: 'flex-start' },
  chipText: { fontSize: 14 },
  composerWrap: { paddingHorizontal: 12, paddingTop: 8, gap: 8, borderTopWidth: StyleSheet.hairlineWidth },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  attachChip: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', maxWidth: '100%', borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },
  attachText: { fontSize: 12.5, fontWeight: '600', flexShrink: 1 },
  input: { flex: 1, minHeight: 40, maxHeight: 110, borderRadius: 20, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, fontSize: 15 },
  codeInput: { fontFamily: mono, letterSpacing: 1 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  sendGlyph: { fontSize: 20, fontWeight: '700' },
  stopSquare: { width: 12, height: 12, borderRadius: 2, backgroundColor: '#fff' },
  confirm: { marginHorizontal: 12, marginBottom: 8, borderWidth: 1, borderRadius: radius.md, padding: 12, gap: 8 },
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
  centered: { flexGrow: 1, justifyContent: 'center' },
  setupWrap: { alignItems: 'center', gap: 12 },
  hint: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, padding: 10 },
  hintText: { textAlign: 'left' },
  divider: { alignSelf: 'stretch', height: StyleSheet.hairlineWidth, marginVertical: 6 },
  center: { alignSelf: 'center' },
  pairingHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pairingText: { flex: 1, textAlign: 'left' },
  setup: { alignItems: 'center', gap: 10 },
  setupBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 14, paddingHorizontal: 22, paddingVertical: 13 },
  setupBtnText: { fontSize: 16, fontWeight: '700' },
  note: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  link: { fontSize: 13.5, fontWeight: '600' },
  command: { fontFamily: mono, fontSize: 12, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  diag: { marginHorizontal: 12, marginTop: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, padding: 10, gap: 4 },
  diagRow: { flexDirection: 'row', gap: 8 },
  diagKey: { width: 92, fontSize: 11.5 },
  diagVal: { flex: 1, fontSize: 11.5 },
});
