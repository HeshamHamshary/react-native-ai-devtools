import type { ReactNode } from 'react';
import { View, type AccessibilityRole, type StyleProp, type ViewStyle } from 'react-native';

export interface AgentTargetProps {
  /** Stable identifier; becomes the element's testID. */
  id: string;
  /** Name the agent sees. */
  label: string;
  role?: AccessibilityRole;
  /**
   * Invoked when the agent activates the element. Use for components automatic
   * discovery cannot drive (canvas/Skia/WebGL drawings, custom gesture recognizers).
   * Activation through this callback is reported as mode "semantic".
   */
  onActivate?: () => void;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * Optional explicit instrumentation for the rare component automatic discovery
 * cannot see or operate. Most apps never need this: Pressables, Touchables,
 * TextInputs, Switches, ScrollViews and accessibility-labelled views are found
 * automatically. The wrapper only adds standard accessibility props, so it is
 * harmless (and improves accessibility) in production builds.
 */
export function AgentTarget({ id, label, role = 'button', onActivate, children, style }: AgentTargetProps) {
  void onActivate; // read by the inspector from this component's props
  return (
    <View testID={id} accessible accessibilityLabel={label} accessibilityRole={role} collapsable={false} style={style}>
      {children}
    </View>
  );
}

/** Marker the inspector uses to recognise explicit targets without importing React internals. */
(AgentTarget as unknown as { __rnadTarget: boolean }).__rnadTarget = true;
