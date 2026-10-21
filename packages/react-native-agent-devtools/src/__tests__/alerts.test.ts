import { expect, it, jest } from '@jest/globals';
import { Alert } from 'react-native';
import { AlertTracker } from '../collectors/AlertTracker';

it('records Alert.alert, keeps the original behavior and clears when answered', () => {
  const original = jest.fn();
  Alert.alert = original as never;
  const tracker = new AlertTracker();
  tracker.install();
  const onClear = jest.fn();
  Alert.alert('Clear cache?', 'Fares are downloaded again.', [{ text: 'Not now', style: 'cancel' }, { text: 'Clear', onPress: onClear }]);
  expect(original).toHaveBeenCalledTimes(1);
  expect(tracker.current).toMatchObject({ title: 'Clear cache?', buttons: [{ text: 'Not now', style: 'cancel' }, { text: 'Clear' }] });

  // The native side calls the button callback it was given: ours, which forwards.
  const passed = original.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
  passed[1]!.onPress?.();
  expect(onClear).toHaveBeenCalledTimes(1);
  expect(tracker.current).toBeUndefined();

  tracker.uninstall();
  expect(Alert.alert).toBe(original);
});
