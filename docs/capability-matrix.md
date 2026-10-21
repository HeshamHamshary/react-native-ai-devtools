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
| `os-injected` | OS-level injection from outside the app (adb, XCUITest). **Not implemented yet** (see the roadmap). |

| Feature | iOS simulator | iOS device | Android emulator | Android device | Native module needed | Mode | Known limitations |
|---|---|---|---|---|---|---|---|
| UI discovery (fiber tree + Fabric layout) | ✅ | ✅¹ | ✅ | ✅¹ | no (JS) | read | Needs Fabric (New Architecture). Native-only UI (UIKit/Android views not rendered by React, native-stack header bar) isn't in the tree; the header title and back availability are inferred. |
| Visibility + detached-screen pruning | ✅ | ✅¹ | ✅ | ✅¹ | yes | read | Without the native module, visibility is geometric only. |
| Native hit-testing ("covered by …") | ✅ `UIView.hitTest` | ✅¹ | ✅ `TouchTargetHelper` + window focus | ✅¹ | yes | read | Android reports "another window" without naming it. |
| Tap | ✅ | ✅¹ | ✅ | ✅¹ | iOS no / Android yes | iOS `semantic` (hit-test gated; `native` for UISwitch/UIButton); Android `synthesized-touch` (re-hit-tested at dispatch) | iOS has no public in-process touch injection. Gesture-handler–only gestures need Android or an OS backend. |
| Long press | ✅ | ✅¹ | ✅ | ✅¹ | Android | iOS `semantic`; Android `synthesized-touch` | |
| Type / clear text | ✅ | ✅¹ | ✅ | ✅¹ | yes (semantic fallback without) | `native` | Not keystroke-level: `onKeyPress` doesn't fire per character. Masked inputs are reported via read-back warnings. |
| Submit (return key) | ✅ | ✅¹ | ✅ | ✅¹ | yes | `native` | Uses the field's delegate / IME action. |
| Scroll / scroll into view | ✅ | ✅¹ | ✅ | ✅¹ | yes | `native` | Programmatic offset change, not a fling. Momentum-end events don't fire. Virtualized lists are paged until the target renders (max 10 pages). |
| Swipe gesture | ❌ | ❌ | ✅ | ✅¹ | yes | `synthesized-touch` | iOS needs OS-level input (roadmap). |
| Back | ✅ | ✅¹ | ✅ | ✅¹ | Android | iOS `semantic` (`navigation.goBack()`); Android `native` | iOS needs a React Navigation route with `canGoBack`. |
| Wait for route / element / text | ✅ | ✅¹ | ✅ | ✅¹ | no | read | Event-driven (React commits) plus 150 ms polling for native-only changes. |
| Multi-step sequences on device | ✅ | ✅¹ | ✅ | ✅¹ | no | per step | 25 steps / 60 s max. Stops on failure, divergence (`expect`), cancel or timeout. |
| Screenshot | ✅ (~60 ms) | ✅¹ | ✅ PixelCopy + RN modal dialogs | ✅¹ | yes | read | iOS skips keyboard windows; secure-flag windows render black on Android. |
| Annotated screenshot (ref boxes) | ✅ | ✅¹ | ✅ | ✅¹ | yes | read | |
| Console logs + uncaught JS errors | ✅ | ✅¹ | ✅ | ✅¹ | no | read | Native logs (os_log/logcat) aren't captured. Errors before the provider mounts are missed. |
| Network (fetch/XHR) | ✅ | ✅¹ | ✅ | ✅¹ | no | read | JS traffic only: native SDKs, image loading and WebViews aren't visible. Bodies are opt-in. |
| Navigation / route history | ✅ | ✅¹ | ✅ | ✅¹ | no | read | Automatic with React Navigation; `reportRoute()` otherwise. |
| Native alerts (`Alert.alert`) | ✅ read-only | ✅¹ | ✅ read-only | ✅¹ | yes | read | Tapping native alert buttons isn't supported yet. |
| Connection | ✅ loopback | ✅¹ LAN + pairing | ✅ `10.0.2.2` | ✅¹ `adb reverse` or LAN | no | — | LAN uses `ws://` (no TLS); trusted networks only. |
| In-app chat UI | ✅ | ✅¹ | ✅ (driven with adb input) | ✅¹ | optional (safe area) | — | |

"iOS device ✅¹": the code paths are identical to the simulator and use only public UIKit APIs, but nothing was run on a physical iPhone in this session.
