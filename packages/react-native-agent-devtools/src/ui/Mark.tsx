import { StyleSheet, View } from 'react-native';

/**
 * The project's mark: an inspector crosshair (ring, center dot and four ticks),
 * drawn with Views so the package ships no image assets. Apps can replace it with
 * the `launcherIcon` prop.
 */
export function Mark({ size = 28, color }: { size?: number; color: string }) {
  const ring = size * 0.62;
  const stroke = Math.max(2, Math.round(size * 0.09));
  const tick = size * 0.2;
  const dot = size * 0.2;
  const c = size / 2;
  return (
    <View style={{ width: size, height: size }} pointerEvents="none">
      <View style={[styles.abs, { left: c - ring / 2, top: c - ring / 2, width: ring, height: ring, borderRadius: ring / 2, borderWidth: stroke, borderColor: color }]} />
      <View style={[styles.abs, { left: c - dot / 2, top: c - dot / 2, width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color }]} />
      <View style={[styles.abs, { left: c - stroke / 2, top: 0, width: stroke, height: tick, borderRadius: stroke / 2, backgroundColor: color }]} />
      <View style={[styles.abs, { left: c - stroke / 2, bottom: 0, width: stroke, height: tick, borderRadius: stroke / 2, backgroundColor: color }]} />
      <View style={[styles.abs, { top: c - stroke / 2, left: 0, height: stroke, width: tick, borderRadius: stroke / 2, backgroundColor: color }]} />
      <View style={[styles.abs, { top: c - stroke / 2, right: 0, height: stroke, width: tick, borderRadius: stroke / 2, backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  abs: { position: 'absolute' },
});
