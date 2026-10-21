import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, type Segment } from '../api';
import type { RootStack } from '../navigation';
import { Card, useColors } from '../ui';

export function ItineraryScreen({ route }: NativeStackScreenProps<RootStack, 'Itinerary'>) {
  const c = useColors();
  const [segments, setSegments] = useState<Segment[] | null>(null);
  useEffect(() => {
    api.itinerary(route.params.bookingId).then(setSegments, () => setSegments([]));
  }, [route.params.bookingId]);
  if (!segments) return <ActivityIndicator style={styles.loading} />;
  return (
    <FlatList
      testID="itinerary-list"
      style={{ backgroundColor: c.bg }}
      contentContainerStyle={styles.content}
      data={segments}
      keyExtractor={(s) => s.flight}
      renderItem={({ item }) => (
        <Card>
          <Text style={[styles.flight, { color: c.primary }]}>{item.flight}</Text>
          <View style={styles.row}>
            <Text style={[styles.airport, { color: c.text }]}>{item.from}</Text>
            <Text style={{ color: c.muted }}>→</Text>
            <Text style={[styles.airport, { color: c.text }]}>{item.to}</Text>
          </View>
          <Text style={{ color: c.muted }}>
            {item.depart} – {item.arrive} · {item.aircraft}
          </Text>
        </Card>
      )}
      ItemSeparatorComponent={() => <View style={styles.sep} />}
    />
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 80 },
  content: { padding: 16 },
  flight: { fontWeight: '800' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  airport: { fontSize: 24, fontWeight: '800' },
  sep: { height: 12 },
});
