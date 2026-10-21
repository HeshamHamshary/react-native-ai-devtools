import { StyleSheet, View } from 'react-native';

/**
 * Claude-style spark mark, drawn with Views (no image asset).
 *
 * TEMPORARY: the project owner asked for the Claude logo on the launcher during
 * internal development. Claude is an Anthropic trademark — replace this mark (or get
 * permission) before publishing the package. Apps can already override it with the
 * `launcherIcon` prop on <AgentDevTools>.
 */
export const CLAUDE_TERRACOTTA = '#D97757';

// Relative ray lengths: slightly irregular, like the hand-drawn spark.
const RAYS = [1, 0.8, 0.94, 0.76, 0.98, 0.84, 0.9, 0.78, 1, 0.82, 0.92, 0.77];

export function ClaudeMark({ size = 28, color = CLAUDE_TERRACOTTA }: { size?: number; color?: string }) {
  const radius = size / 2;
  const thickness = Math.max(2, size * 0.13);
  return (
    <View style={{ width: size, height: size }} pointerEvents="none">
      {RAYS.map((len, i) => {
        const h = radius * len;
        return (
          <View
            key={i}
            style={[
              styles.ray,
              {
                left: radius - thickness / 2,
                top: radius - h / 2,
                width: thickness,
                height: h,
                borderRadius: thickness / 2,
                backgroundColor: color,
                // Rotate about the bar center, then push it outward so its inner end sits at the center.
                transform: [{ rotate: `${i * (360 / RAYS.length)}deg` }, { translateY: -h / 2 }],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  ray: { position: 'absolute' },
});
