# react-native-agent-devtools

In-app AI developer assistant for React Native **debug builds**: a floating chat plus a React-aware runtime that lets a Claude agent on your computer inspect, operate and debug the running app.

```tsx
import { AgentDevTools } from 'react-native-agent-devtools';

<AgentDevTools navigationRef={navigationRef}>
  <App />
</AgentDevTools>
```

- Requires the New Architecture (Fabric) and a native rebuild. Expo Go is not supported; use a development build.
- It is a no-op when `__DEV__` is false, and its native methods refuse to run in non-debuggable builds.
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

**Other exports:**

- `reportRoute(name)`: report the route manually (apps without React Navigation).
- `<AgentTarget id label onActivate>`: explicit instrumentation for components discovery can't drive.

See the [repository docs](../../docs) for setup, architecture, the capability matrix and security.
