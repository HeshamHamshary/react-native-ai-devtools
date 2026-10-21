import { useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api } from '../api';
import type { RootStack } from '../navigation';
import { Card, PrimaryButton, useColors } from '../ui';

const ITEMS = Array.from({ length: 50 }, (_, i) => `Fare bucket #${i + 1}`);

/** Intentionally broken behaviors for the assistant to investigate. */
export function PlaygroundScreen({ navigation }: NativeStackScreenProps<RootStack, 'Playground'>) {
  const c = useColors();
  const [status, setStatus] = useState('Idle');
  const [slowResult, setSlowResult] = useState<string | null>(null);
  const [promoTaps, setPromoTaps] = useState(0);

  const header = (
    <View style={styles.content}>
      <Text testID="playground-status" style={[styles.status, { color: c.muted }]}>
        Status: {status}
      </Text>

      <Card>
        <Text style={[styles.title, { color: c.text }]}>1 · Crashing handler</Text>
        <PrimaryButton
          testID="throw-error"
          title="Apply coupon"
          onPress={() => {
            const coupon: { code?: { value: string } } = {};
            setStatus(`Applied ${coupon.code!.value}`); // TypeError: cannot read 'value' of undefined
          }}
        />
      </Card>

      <Card>
        <Text style={[styles.title, { color: c.text }]}>2 · Failing request</Text>
        <PrimaryButton
          testID="failing-request"
          title="Refresh prices"
          onPress={() => {
            setStatus('Refreshing prices…');
            api.flaky().then(
              () => setStatus('Prices refreshed'),
              (e: Error) => {
                console.warn('Price refresh failed:', e.message);
                setStatus('Could not refresh prices');
              },
            );
          }}
        />
      </Card>

      <Card>
        <Text style={[styles.title, { color: c.text }]}>2b · Native alert</Text>
        <PrimaryButton
          testID="clear-cache"
          title="Clear cache"
          variant="secondary"
          onPress={() =>
            Alert.alert('Clear cache?', 'Cached fares will be downloaded again.', [
              { text: 'Not now', style: 'cancel', onPress: () => setStatus('Cache kept') },
              { text: 'Clear', onPress: () => setStatus('Cache cleared') },
            ])
          }
        />
      </Card>

      <Card>
        <Text style={[styles.title, { color: c.text }]}>3 · Disabled button</Text>
        <PrimaryButton testID="disabled-submit" title="Submit claim" disabled onPress={() => setStatus('Claim submitted')} />
      </Card>

      <Card>
        <Text style={[styles.title, { color: c.text }]}>4 · Delayed response</Text>
        <PrimaryButton
          testID="slow-request"
          title="Load seat map"
          onPress={() => {
            setSlowResult(null);
            setStatus('Loading seat map…');
            api.slow().then((r) => {
              setSlowResult(r.message);
              setStatus('Seat map loaded');
            });
          }}
        />
        {slowResult ? <Text style={{ color: c.success }}>{slowResult}</Text> : null}
      </Card>

      <Card>
        <Text style={[styles.title, { color: c.text }]}>5 · Navigation error</Text>
        <PrimaryButton
          testID="broken-nav"
          title="Open loyalty profile"
          onPress={() => (navigation as unknown as { navigate: (r: string) => void }).navigate('LoyaltyProfile')}
        />
      </Card>

      <Card>
        <Text style={[styles.title, { color: c.text }]}>6 · Overlapping element</Text>
        <View>
          <PrimaryButton testID="hidden-promo" title="Claim promo" onPress={() => setPromoTaps((n) => n + 1)} />
          {/* An invisible banner left on top of the button swallows real touches. */}
          <View testID="promo-overlay" style={styles.invisibleOverlay} />
        </View>
        <Text style={{ color: c.muted }}>Promo claimed {promoTaps} time(s)</Text>
      </Card>

      <Card>
        <Text style={[styles.title, { color: c.text }]}>7 · Misaligned component</Text>
        <View style={styles.priceRow}>
          <Text style={{ color: c.text }}>Base fare</Text>
          <Text style={{ color: c.text }}>$412.00</Text>
        </View>
        <View style={styles.priceRow}>
          <Text style={{ color: c.text }}>Taxes</Text>
          <Text testID="misaligned-price" style={[styles.misaligned, { color: c.text }]}>
            $77.00
          </Text>
        </View>
      </Card>

      <Text style={[styles.title, { color: c.text }]}>8 · Long list</Text>
    </View>
  );

  return (
    <FlatList
      testID="playground-list"
      style={{ backgroundColor: c.bg }}
      data={ITEMS}
      keyExtractor={(x) => x}
      ListHeaderComponent={header}
      renderItem={({ item }) => (
        <Pressable testID={`fare-${item.split('#')[1]}`} onPress={() => setStatus(`Selected ${item}`)} style={[styles.item, { borderColor: c.border }]}>
          <Text style={{ color: c.text }}>{item}</Text>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  status: { fontSize: 14 },
  title: { fontSize: 16, fontWeight: '700' },
  invisibleOverlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'transparent' },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between' },
  misaligned: { marginRight: -18, marginTop: 9 },
  item: { marginHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
});
