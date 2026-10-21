# Platform capability matrix

**Legend:**

- ✅ works, verified in this repo.
- ✅¹ works by design but **not verified on hardware** (no physical device was available).
- ⚠️ partial.
- ❌ not supported.

"Mode" is the interaction mode reported in every action result:

| Mode | What actually happens |
|---|---|
| `semantic` | A JavaScript handler is invoked (Pressability's responder handlers, or `onPress`). Native hit-testing, gesture recognizers and the OS input system are bypassed. A semantic tap can succeed where a finger would fail, so it is always gated by a native hit-test first. |
| `native` | A public platform API is called on the real view: `UITextInput.insertText` / `Editable.replace`, `UIScrollView.setContentOffset` / `ScrollView.scrollTo`, `UISwitch` + `sendActions`, `OnBackPressedDispatcher`. RN's normal events fire. |
| `synthesized-touch` | (Android) A `MotionEvent` DOWN/UP sequence is dispatched through the target window's decor view. It gets real hit-testing, `pointerEvents`, RN's `JSTouchDispatcher` and Pressability, but is not delivered by the OS input system. |
| `os-injected` | OS-level injection from outside the app: `adb shell input` (Android), XCUITest through Maestro's driver (iOS simulator). The same path a finger takes. Used with `mode: "os"` / `--os-input`, and automatically for iOS swipes. Never a silent fallback. |

| Feature | iOS simulator | iOS device | Android emulator | Android device | Native module needed | Mode | Known limitations |
|---|---|---|---|---|---|---|---|
| UI discovery (fiber tree + Fabric layout) | ✅ | ✅¹ | ✅ | ✅¹ | no (JS) | read | Needs Fabric (New Architecture). Native-only UI (UIKit/Android views not rendered by React, native-stack header bar) isn't in the tree; the header title and back availability are inferred. |
| Visibility + detached-screen pruning | ✅ | ✅¹ | ✅ | ✅¹ | yes | read | Without the native module, visibility is geometric only. |
| Native hit-testing ("covered by …") | ✅ `UIView.hitTest` | ✅¹ | ✅ `TouchTargetHelper` + window focus | ✅¹ | yes | read | Android reports "another window" without naming it. |
| Element inspection (source file:line, owners, props, handlers, style, a11y, hit-test, findings) | ✅ | ✅¹ | ✅ | ✅¹ | hit-test/pick: yes | read | Source needs a dev build with React 19 creation stacks and a reachable Metro; reported as unavailable otherwise. Handler source locations are not available on Hermes. |
| Screen audit | ✅ (~10–60 ms) | ✅¹ | ✅ (~6–30 ms) | ✅¹ | hit-test: yes | read | Static checks; text truncation isn't detected. |
| Tap | ✅ | ✅¹ | ✅ | ✅¹ | iOS no / Android yes | iOS `semantic` (hit-test gated; `native` for UISwitch/UIButton); Android `synthesized-touch` (re-hit-tested at dispatch); `os-injected` with `mode: "os"` | iOS has no public in-process touch injection; `mode: "os"` uses XCUITest on the simulator. |
| Tap with OS-level input | ✅ Maestro, ~1 s after a ~10 s warm-up | ❌ | ✅ adb, ~0.8–3.8 s on a 2 GB AVD | ✅¹ adb | no | `os-injected` | Physical iPhones have no OS backend. |
| Long press | ✅ | ✅¹ | ✅ | ✅¹ | Android | iOS `semantic`; Android `synthesized-touch`; `os-injected` with `mode: "os"` | |
| Type / clear text | ✅ | ✅¹ | ✅ | ✅¹ | yes (semantic fallback without) | `native`; `os-injected` key by key with `mode: "os"` | `native` typing is not keystroke-level (`onKeyPress` doesn't fire per character); `mode: "os"` is. Masked inputs are reported via read-back warnings. |
| Submit (return key) | ✅ | ✅¹ | ✅ | ✅¹ | yes | `native` | Uses the field's delegate / IME action. |
| Scroll / scroll into view | ✅ | ✅¹ | ✅ | ✅¹ | yes | `native` | Programmatic offset change, not a fling. Momentum-end events don't fire. Virtualized lists are paged until the target renders (max 10 pages). |
| Swipe gesture | ✅ via OS input | ❌ | ✅ | ✅¹ | Android in-app; iOS Maestro | Android `synthesized-touch`; iOS `os-injected` | iOS swipes need Maestro on the simulator. |
| Dismiss keyboard | ✅ | ✅¹ | ✅ | ✅¹ | no | `semantic` (`Keyboard.dismiss()`) | |
| Back | ✅ | ✅¹ | ✅ | ✅¹ | Android | iOS `semantic` (`navigation.goBack()`); Android `native` | iOS needs a React Navigation route with `canGoBack`. |
| Wait for route / element / text | ✅ | ✅¹ | ✅ | ✅¹ | no | read | Event-driven (React commits) plus 150 ms polling for native-only changes. |
| Multi-step sequences on device | ✅ | ✅¹ | ✅ | ✅¹ | no | per step | 25 steps / 60 s max. Stops on failure, divergence (`expect`), cancel or timeout. |
| Screenshot | ✅ (~60 ms) | ✅¹ | ✅ PixelCopy + RN modal dialogs | ✅¹ | yes | read | iOS skips keyboard windows; secure-flag windows render black on Android. |
| Annotated screenshot (ref boxes) | ✅ | ✅¹ | ✅ | ✅¹ | yes | read | |
| Console logs + uncaught JS errors (with app source lines) | ✅ | ✅¹ | ✅ | ✅¹ | no | read | Errors before the provider mounts are missed (the capture start is reported). |
| Native logs | ✅ simulator unified log (~13 s) | ❌ | ✅ logcat by pid (<1 s) | ✅¹ | no | read | Read on the computer; physical iPhones aren't supported. |
| LogBox recovery | ✅ | ✅¹ | ✅ | ✅¹ | no | `semantic` (`LogBox.clearAllLogs()`) | The errors stay in the logs. |
| Network (fetch/XHR, with the initiating app code) | ✅ | ✅¹ | ✅ | ✅¹ | no | read | JS traffic only: native SDKs, image loading and WebViews aren't visible. Bodies are opt-in. |
| Navigation / route history | ✅ | ✅¹ | ✅ | ✅¹ | no | read | Automatic with React Navigation; `reportRoute()` otherwise. |
| Native alerts (`Alert.alert`) | ✅ | ✅¹ | ✅ | ✅¹ | yes | Android `native` (dialog button `performClick`); iOS `semantic` (dismiss + the button's callback) or `os-injected` with `mode: "os"` | iOS has no public API to trigger an alert action in-process. |
| Replayable flows (record, replay, Maestro export) | ✅ | ✅¹ | ✅ (iOS-recorded flow replayed) | ✅¹ | no | per step | Replay starts from the screen the flow was recorded on; React routes can't be asserted in Maestro exports. |
| Connection | ✅ loopback | ✅¹ LAN + pairing | ✅ `10.0.2.2` | ✅¹ `adb reverse` or LAN | no | — | LAN uses `ws://` (no TLS); trusted networks only. |
| Pairing persisted across reloads/restarts | ✅ Keychain | ✅¹ | ✅ app-private prefs | ✅¹ | yes | — | |
| In-app chat and inspect UI | ✅ (driven with Maestro) | ✅¹ | ✅ (driven with adb input) | ✅¹ | optional (safe area) | — | |

"iOS device ✅¹": the code paths are identical to the simulator and use only public UIKit APIs, but nothing was run on a physical iPhone in this session.
