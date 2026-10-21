import type * as Runtime from './AgentDevTools';

/**
 * The devtools runtime is only required in development builds. For release bundles
 * Metro inlines `__DEV__` as false and drops the dead branch before it resolves
 * dependencies, so none of the runtime ships (checked by `yarn check:release-bundle`).
 */
const impl: Pick<typeof Runtime, 'AgentDevTools' | 'reportRoute'> = __DEV__ ? require('./AgentDevTools') : require('./production');

export const AgentDevTools = impl.AgentDevTools;
export const reportRoute = impl.reportRoute;
/** Alias matching the original design sketch. */
export const ReactNativeAIDevTools = impl.AgentDevTools;
export type { AgentDevToolsProps } from './AgentDevTools';
export type { NavigationRefLike } from './collectors/NavigationTracker';
export type { NetworkOptions } from './collectors/NetworkCollector';
export { AgentTarget, type AgentTargetProps } from './AgentTarget';
export type {
  ActionResult,
  InteractionMode,
  LogEntry,
  NetworkEntry,
  UIElement,
  UISnapshot,
} from 'react-native-agent-devtools-protocol';
