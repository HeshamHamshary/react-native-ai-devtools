import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, type Booking } from '../api';
import type { RootStack } from '../navigation';
import { Card, PrimaryButton, useColors } from '../ui';

function Section({ title, children, testID }: { title: string; children: React.ReactNode; testID: string }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((v) => !v)} style={styles.sectionHead}>
        <Text style={[styles.sectionTitle, { color: c.text }]}>{title}</Text>
        <Text style={{ color: c.muted }}>{open ? '▲' : '▼'}</Text>
      </Pressable>
      {open ? <View style={styles.sectionBody}>{children}</View> : null}
    </Card>
  );
}

export function BookingDetailsScreen({ route, navigation }: NativeStackScreenProps<RootStack, 'BookingDetails'>) {
  const c = useColors();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.booking(route.params.bookingId).then(setBooking, (e: Error) => setError(e.message));
  }, [route.params.bookingId]);

  if (error) return <Text style={[styles.center, { color: c.danger }]}>{error}</Text>;
  if (!booking) return <ActivityIndicator testID="booking-loading" style={styles.center} />;

  const departure = new Date(booking.departure);
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={styles.content}>
      <Card>
        <Text style={[styles.status, { color: c.success }]}>{booking.status.toUpperCase()}</Text>
        <Text style={[styles.route, { color: c.text }]}>
          {booking.route.from} → {booking.route.to}
        </Text>
        <Text style={{ color: c.muted }}>
          Departs {departure.toDateString()} · Booking {booking.id}
        </Text>
        <Text style={[styles.total, { color: c.text }]}>
          Total {booking.total.amount.toFixed(2)} {booking.total.currency}
        </Text>
      </Card>

      <Section title="Passengers" testID="section-passengers">
        {booking.passengers.map((p) => (
          <Text key={p.name} style={{ color: c.text }}>
            {p.name} · seat {p.seat}
          </Text>
        ))}
      </Section>
      <Section title="Baggage" testID="section-baggage">
        <Text style={{ color: c.text }}>{booking.baggage}</Text>
      </Section>
      <Section title="Fare rules" testID="section-fare">
        <Text style={{ color: c.text }}>{booking.fareRules}</Text>
      </Section>

      <PrimaryButton testID="view-itinerary" title="View itinerary" onPress={() => navigation.navigate('Itinerary', { bookingId: booking.id })} />
      <PrimaryButton
        testID="cancel-booking"
        title="Cancel booking"
        variant="danger"
        onPress={() => Alert.alert('Booking cancelled', 'This is a demo; nothing was cancelled.')}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  center: { marginTop: 80, textAlign: 'center' },
  status: { fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  route: { fontSize: 28, fontWeight: '800' },
  total: { fontSize: 16, fontWeight: '700', marginTop: 6 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { fontSize: 16, fontWeight: '700' },
  sectionBody: { gap: 4, marginTop: 4 },
});
