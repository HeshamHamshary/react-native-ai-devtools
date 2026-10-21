import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, DevSettings, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { native } from '../native';
import type { Runtime } from '../runtime/Runtime';
import { useStore } from '../utils/Store';
import { ChatPanel, statusColor } from './ChatPanel';
import { FloatingButton } from './FloatingButton';
import { InspectLayer } from './InspectLayer';
import { palette, type ThemeSetting } from './theme';

interface Props {
  runtime: Runtime;
  initiallyOpen?: boolean;
  launcherIcon?: ReactNode;
  theme?: ThemeSetting;
  /** Start with the launcher hidden (e.g. for screenshot tests); the dev menu brings it back. */
  hideLauncher?: boolean;
}

/** Visible signal that the agent is driving the app (edge glow + top pill with Stop). */
function ControlIndicator({ runtime, top, color }: { runtime: Runtime; top: number; color: string }) {
  const pulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.glow, { borderColor: color, opacity: pulse }]} />
      <View style={[styles.pill, { top: top + 4, backgroundColor: color }]}>
        <Text style={styles.pillText}>Agent is operating the app</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Stop agent" hitSlop={8} onPress={() => runtime.cancel()} style={styles.pillStop}>
          <Text style={[styles.pillStopText, { color }]}>Stop</Text>
        </Pressable>
      </View>
    </>
  );
}

export function Overlay({ runtime, initiallyOpen = false, launcherIcon, theme = 'system', hideLauncher = false }: Props) {
  const system = useColorScheme();
  const p = palette(theme === 'system' ? system === 'dark' : theme === 'dark');
  const [open, setOpen] = useState(initiallyOpen);
  const [launcherHidden, setLauncherHidden] = useState(hideLauncher);
  const [attach, setAttach] = useState(false);
  const inspecting = useStore(runtime.store, (s) => s.inspecting);
  const [expandedDuringTurn, setExpandedDuringTurn] = useState(false);
  const [insets, setInsets] = useState({ top: 0, bottom: 0, left: 0, right: 0 });
  const connection = useStore(runtime.store, (s) => s.connection);
  const chat = useStore(runtime.store, (s) => s.chat);
  const hidden = useStore(runtime.store, (s) => s.overlayHidden);
  const messageCount = useStore(runtime.store, (s) => s.messages.length);
  const pendingConfirm = useStore(runtime.store, (s) => s.pendingConfirm);
  const [seen, setSeen] = useState(0);
  const [actedThisTurn, setActedThisTurn] = useState(false);

  useEffect(() => {
    native.getSafeAreaInsets().then(setInsets, () => undefined);
  }, []);

  useEffect(() => {
    if (chat === 'acting') setActedThisTurn(true);
    if (chat === 'idle') {
      setActedThisTurn(false);
      setExpandedDuringTurn(false);
    }
  }, [chat]);

  useEffect(() => {
    if (open) setSeen(messageCount);
  }, [open, messageCount]);

  // The panel would cover the app while picking an element.
  useEffect(() => {
    if (inspecting) setOpen(false);
  }, [inspecting]);

  const onAsk = useCallback(
    (question?: string) => {
      if (question) {
        runtime.sendChat(question, true);
        setAttach(false);
      } else {
        setAttach(true);
      }
      setOpen(true);
    },
    [runtime],
  );

  // Approval requests must be visible even if the chat was closed.
  useEffect(() => {
    if (pendingConfirm) {
      setOpen(true);
      setExpandedDuringTurn(true);
    }
  }, [pendingConfirm]);

  useEffect(() => {
    // Recover a hidden launcher from the dev menu.
    try {
      DevSettings.addMenuItem('Show Agent DevTools', () => {
        setLauncherHidden(false);
        setOpen(true);
      });
    } catch {
      // DevSettings unavailable
    }
  }, []);

  const onPress = useCallback(() => setOpen((v) => !v), []);
  const onLongPress = useCallback(() => setLauncherHidden(true), []);

  if (hidden) return null;

  const busy = chat !== 'idle';
  const collapsed = busy && actedThisTurn && !expandedDuringTurn;
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {busy && actedThisTurn ? <ControlIndicator runtime={runtime} top={insets.top} color={p.accent} /> : null}
      {!open ? <InspectLayer runtime={runtime} palette={p} insets={insets} onAsk={onAsk} /> : null}
      {open ? (
        <ChatPanel
          runtime={runtime}
          palette={p}
          insets={insets}
          collapsed={collapsed}
          attach={attach}
          onAttachChange={setAttach}
          onExpand={() => setExpandedDuringTurn(true)}
          onClose={() => setOpen(false)}
          onHideLauncher={() => {
            setOpen(false);
            setLauncherHidden(true);
          }}
        />
      ) : null}
      {!open && !launcherHidden && !inspecting ? (
        <FloatingButton
          palette={p}
          insets={insets}
          busy={busy}
          statusColor={statusColor(connection, p)}
          unread={messageCount > seen}
          onPress={onPress}
          onLongPress={onLongPress}
          icon={launcherIcon}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  glow: { borderWidth: 3, borderRadius: 4 },
  pill: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 16,
    paddingLeft: 12,
    paddingRight: 4,
    paddingVertical: 4,
  },
  pillText: { color: '#fff', fontSize: 12.5, fontWeight: '600' },
  pillStop: { backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  pillStopText: { fontSize: 12, fontWeight: '700' },
});
