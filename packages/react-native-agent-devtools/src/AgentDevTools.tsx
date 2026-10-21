import { Component, Profiler, useEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { NavigationRefLike } from './collectors/NavigationTracker';
import type { NetworkOptions } from './collectors/NetworkCollector';
import { Runtime } from './runtime/Runtime';
import { Overlay } from './ui/Overlay';

export interface AgentDevToolsProps {
  children: ReactNode;
  /**
   * Turn the tooling on. Defaults to `__DEV__`. It is ALWAYS off when `__DEV__` is
   * false, regardless of this prop, so it cannot ship enabled in a release bundle.
   */
  enabled?: boolean;
  /** WebSocket URL of react-native-agent-devtools-server. Defaults to the Metro host on port 8765. */
  serverUrl?: string;
  /** Pairing code printed by the server when it runs in --lan mode. Usually entered in the chat UI instead. */
  pairingCode?: string;
  /** Optional React Navigation container ref for exact route tracking and history. */
  navigationRef?: NavigationRefLike | null;
  /** Network capture options. Bodies are NOT captured unless `captureBodies` is true. */
  network?: NetworkOptions;
  /** Ask on-device before taps that look destructive or externally consequential (default true). */
  confirmSensitiveActions?: boolean;
  /** Override the built-in sensitive-action classifier. */
  isSensitive?: (el: { role: string; label?: string; text?: string; testID?: string }) => boolean;
  /** Open the chat on mount. */
  initiallyOpen?: boolean;
  /** Replace the launcher icon. */
  launcherIcon?: ReactNode;
}

let activeRuntime: Runtime | undefined;

/** Explicitly report the current route (for apps without React Navigation). */
export function reportRoute(name: string, params?: object): void {
  activeRuntime?.nav.record(name, 'manual', params ? Object.keys(params) : undefined);
}

/** Holds a class instance so the runtime can locate its fiber in the committed tree. */
class Anchor extends Component<{ children: ReactNode }> {
  render() {
    return this.props.children;
  }
}

function AgentDevToolsInner(props: AgentDevToolsProps) {
  const runtimeRef = useRef<Runtime | null>(null);
  if (!runtimeRef.current) {
    runtimeRef.current = new Runtime({
      serverUrl: props.serverUrl,
      pairingCode: props.pairingCode,
      network: props.network,
      navigationRef: props.navigationRef,
      confirmSensitiveActions: props.confirmSensitiveActions,
      isSensitive: props.isSensitive,
    });
  }
  const rt = runtimeRef.current;

  useEffect(() => {
    activeRuntime = rt;
    rt.start();
    return () => {
      rt.stop();
      if (activeRuntime === rt) activeRuntime = undefined;
    };
  }, [rt]);

  useEffect(() => {
    rt.setNavigationRef(props.navigationRef);
  }, [rt, props.navigationRef]);

  return (
    <View style={styles.fill}>
      <Profiler id="rnad-app" onRender={rt.commits.onRender}>
        <Anchor ref={rt.setAppAnchor}>{props.children}</Anchor>
      </Profiler>
      <Anchor ref={rt.setOverlayAnchor}>
        <Overlay runtime={rt} initiallyOpen={props.initiallyOpen} launcherIcon={props.launcherIcon} />
      </Anchor>
    </View>
  );
}

/**
 * Wrap your app root. Development-only: when `__DEV__` is false this renders
 * `children` unchanged and installs nothing (no collectors, no socket, no UI).
 */
export function AgentDevTools(props: AgentDevToolsProps) {
  if (!__DEV__ || props.enabled === false) return <>{props.children}</>;
  return <AgentDevToolsInner {...props} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
