import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Animated, Easing, PanResponder, StyleSheet, View, useWindowDimensions } from 'react-native';
import { ClaudeMark } from './ClaudeMark';
import type { Palette } from './theme';

const SIZE = 52;
const MARGIN = 12;

interface Props {
  palette: Palette;
  insets: { top: number; bottom: number; left: number; right: number };
  busy: boolean;
  statusColor: string;
  unread: boolean;
  onPress: () => void;
  onLongPress: () => void;
  icon?: ReactNode;
  dark: boolean;
}

/** Draggable launcher that snaps to the nearest horizontal edge inside the safe area. */
export function FloatingButton({ palette: p, insets, busy, statusColor, unread, onPress, onLongPress, icon, dark }: Props) {
  const { width, height } = useWindowDimensions();
  const minY = insets.top + MARGIN;
  const maxY = height - insets.bottom - SIZE - MARGIN - 40;
  const pos = useRef(new Animated.ValueXY({ x: width - SIZE - MARGIN - insets.right, y: height * 0.62 })).current;
  const current = useRef({ x: width - SIZE - MARGIN - insets.right, y: height * 0.62 });
  const spin = useRef(new Animated.Value(0)).current;
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longPressed = useRef(false);

  useEffect(() => {
    const id = pos.addListener((v) => {
      current.current = v;
    });
    return () => pos.removeListener(id);
  }, [pos]);

  // Re-snap on rotation / window changes.
  useEffect(() => {
    const { x, y } = current.current;
    const left = x + SIZE / 2 < width / 2;
    pos.setValue({
      x: left ? MARGIN + insets.left : width - SIZE - MARGIN - insets.right,
      y: Math.min(Math.max(y, minY), maxY),
    });
  }, [width, height, insets.left, insets.right, minY, maxY, pos]);

  useEffect(() => {
    if (!busy) {
      spin.stopAnimation();
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1400, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [busy, spin]);

  const responder = useMemo(() => {
    let start = { x: 0, y: 0 };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        start = { ...current.current };
        longPressed.current = false;
        longPressTimer.current = setTimeout(() => {
          longPressed.current = true;
          onLongPress();
        }, 600);
      },
      onPanResponderMove: (_e, g) => {
        if (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4) clearTimeout(longPressTimer.current);
        pos.setValue({ x: start.x + g.dx, y: start.y + g.dy });
      },
      onPanResponderRelease: (_e, g) => {
        clearTimeout(longPressTimer.current);
        const moved = Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4;
        if (!moved) {
          pos.setValue(start);
          if (!longPressed.current) onPress();
          return;
        }
        const x = start.x + g.dx;
        const y = start.y + g.dy;
        const left = x + SIZE / 2 < width / 2;
        Animated.spring(pos, {
          toValue: { x: left ? MARGIN + insets.left : width - SIZE - MARGIN - insets.right, y: Math.min(Math.max(y, minY), maxY) },
          useNativeDriver: false,
          friction: 7,
          tension: 60,
        }).start();
      },
      onPanResponderTerminate: () => clearTimeout(longPressTimer.current),
    });
  }, [pos, width, insets.left, insets.right, minY, maxY, onPress, onLongPress]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Animated.View
      {...responder.panHandlers}
      accessibilityRole="button"
      accessibilityLabel="Open agent devtools"
      style={[
        styles.button,
        { backgroundColor: dark ? '#262624' : '#FAF9F5', borderColor: p.border, transform: pos.getTranslateTransform() },
      ]}
    >
      <Animated.View style={busy ? { transform: [{ rotate }] } : undefined}>{icon ?? <ClaudeMark size={30} />}</Animated.View>
      <View style={[styles.dot, { backgroundColor: statusColor, borderColor: dark ? '#262624' : '#FAF9F5' }]} />
      {unread ? <View style={[styles.unread, { backgroundColor: p.accent }]} /> : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  button: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  dot: { position: 'absolute', right: 3, bottom: 3, width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
  unread: { position: 'absolute', right: 6, top: 6, width: 8, height: 8, borderRadius: 4 },
});
