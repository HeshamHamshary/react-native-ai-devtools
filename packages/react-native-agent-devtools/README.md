# react-native-agent-devtools

In-app AI developer assistant for React Native **debug builds**: a floating chat plus a React-aware runtime that lets a Claude agent on your computer inspect, operate and debug the running app.

```tsx
import { AgentDevTools } from 'react-native-agent-devtools';

<AgentDevTools navigationRef={navigationRef}>
  <App />
</AgentDevTools>
```

- Requires the New Architecture (Fabric) and a native rebuild. Expo Go is not supported. Use a development build and add `"react-native-agent-devtools"` to your Expo `plugins`.
- Release builds get a stub: Metro removes the runtime from the bundle, and the native methods refuse to run in non-debuggable builds.
- **Inspect mode** (the crosshair in the panel) works without a model. It shows an element's source file and line, the components that rendered it, its props, handlers and layout, and whether a finger can reach it.
- Pair it with `react-native-agent-devtools-server` on your computer.

**Props:**

| Prop | Purpose |
|---|---|
| `serverUrl` | Server address. Defaults to the Metro host, port 8765. |
| `navigationRef` | React Navigation container ref, for exact route history |
| `network.captureBodies` | Capture request/response bodies (default `false`) |
| `confirmSensitiveActions` | Ask on the device before sensitive taps (default `true`) |
| `isSensitive` | Override the sensitive-action classifier |
| `initiallyOpen` | Open the chat on mount |
| `launcherIcon` | Replace the launcher icon |
| `hideLauncher` | Start with the launcher hidden ("Show Agent DevTools" in the dev menu brings it back) |
| `theme` | `'system'` (default), `'light'` or `'dark'` |

**Other exports:**

- `reportRoute(name)`: report the route manually (apps without React Navigation).
- `<AgentTarget id label onActivate>`: explicit instrumentation for components discovery can't drive.

See the [repository docs](../../docs) for setup, architecture, the capability matrix and security.
