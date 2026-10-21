import type { AgentDevToolsProps } from './AgentDevTools';

/**
 * Release-build stand-ins. `index.tsx` requires this file instead of the runtime when
 * `__DEV__` is false, so a release bundle contains no collectors, socket, inspector or UI.
 */
export function AgentDevTools(props: AgentDevToolsProps) {
  return <>{props.children}</>;
}

export function reportRoute(_name: string, _params?: object): void {}
