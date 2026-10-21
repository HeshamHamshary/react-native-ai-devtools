import { Alert, type AlertButton } from 'react-native';

export interface TrackedAlert {
  title: string;
  message?: string;
  buttons: { text: string; style?: string; onPress?: (value?: string) => void }[];
  ts: number;
}

type AlertFn = typeof Alert.alert;

/**
 * Records the alert shown with `Alert.alert` (development builds only) so the agent
 * can see it and, where the platform has no public API to press a native alert
 * button (iOS), answer it through the button's own callback. Existing behavior is
 * preserved: the original Alert.alert always runs, with the same arguments.
 */
export class AlertTracker {
  current?: TrackedAlert;
  private original?: AlertFn;

  install(): void {
    if (this.original) return;
    const original = Alert.alert;
    this.original = original;
    const tracker = this;
    Alert.alert = function alert(title: string, message?: string, buttons?: AlertButton[], options?: unknown) {
      const list = buttons?.length ? buttons : [{ text: 'OK' }];
      const record: TrackedAlert = { title: String(title ?? ''), ...(message ? { message: String(message) } : {}), buttons: [], ts: Date.now() };
      const wrapped = list.map((b) => {
        const onPress = b.onPress;
        const press = (value?: string) => {
          if (tracker.current === record) tracker.current = undefined;
          onPress?.(value);
        };
        record.buttons.push({ text: String(b.text ?? 'OK'), ...(b.style ? { style: b.style } : {}), onPress: press });
        return { ...b, onPress: press };
      });
      tracker.current = record;
      return (original as (...a: unknown[]) => void).call(Alert, title, message, buttons?.length ? wrapped : buttons, options);
    } as AlertFn;
  }

  uninstall(): void {
    if (this.original) Alert.alert = this.original;
    this.original = undefined;
    this.current = undefined;
  }
}
