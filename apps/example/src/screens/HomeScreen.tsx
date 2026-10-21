import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStack } from '../navigation';
import { useSession } from '../session';
import { Card, PrimaryButton, useColors } from '../ui';

const RECENT = ['Montréal → Paris', 'Toronto → London', 'Vancouver → Tokyo', 'Calgary → Cancún', 'Ottawa → Lisbon', 'Halifax → Dublin', 'Québec → Rome', 'Winnipeg → Denver', 'Edmonton → Honolulu', 'Victoria → Seattle'];

export function HomeScreen({ navigation }: NativeStackScreenProps<RootStack, 'Home'>) {
  const c = useColors();
  const { user, signOut } = useSession();
  const [alerts, setAlerts] = useState(false);
  const [dealOpen, setDealOpen] = useState(false);

  return (
    <ScrollView testID="home-scroll" style={{ backgroundColor: c.bg }} contentContainerStyle={styles.content}>
      <Text style={[styles.greeting, { color: c.text }]}>Hi {user ?? 'traveler'} 👋</Text>

      <Pressable testID="trip-card" accessibilityRole="button" onPress={() => navigation.navigate('BookingDetails', { bookingId: 'BK-1042' })}>
        <Card>
          <Text style={[styles.eyebrow, { color: c.primary }]}>UPCOMING TRIP</Text>
          <Text style={[styles.cardTitle, { color: c.text }]}>Montréal (YUL) → Paris (CDG)</Text>
          <Text style={{ color: c.muted }}>Nov 14 · 2 travellers · Booking BK-1042</Text>
          <Text style={[styles.link, { color: c.primary }]}>Booking details ›</Text>
        </Card>
      </Pressable>

      <View style={styles.grid}>
        <Pressable testID="deals-card" accessibilityRole="button" style={styles.gridItem} onPress={() => setDealOpen(true)}>
          <Card>
            <Text style={styles.emoji}>🏷️</Text>
            <Text style={[styles.cardTitle, { color: c.text }]}>Deals</Text>
          </Card>
        </Pressable>
        <Pressable testID="playground-card" accessibilityRole="button" style={styles.gridItem} onPress={() => navigation.navigate('Playground')}>
          <Card>
            <Text style={styles.emoji}>🧪</Text>
            <Text style={[styles.cardTitle, { color: c.text }]}>Debug playground</Text>
          </Card>
        </Pressable>
      </View>

      <Card>
        <View style={styles.row}>
          <View style={styles.flex}>
            <Text style={[styles.cardTitle, { color: c.text }]}>Price alerts</Text>
            <Text style={{ color: c.muted }}>Notify me when fares drop</Text>
          </View>
          <Switch testID="price-alerts" accessibilityLabel="Price alerts" value={alerts} onValueChange={setAlerts} />
        </View>
      </Card>

      <Text style={[styles.section, { color: c.text }]}>Recent searches</Text>
      {RECENT.map((r) => (
        <Card key={r} style={styles.recent}>
          <Text style={{ color: c.text }}>{r}</Text>
        </Card>
      ))}

      <PrimaryButton testID="logout" title="Log out" variant="secondary" onPress={signOut} />

      <Modal visible={dealOpen} transparent animationType="fade" onRequestClose={() => setDealOpen(false)}>
        <View style={styles.scrim}>
          <Card style={styles.modalCard}>
            <Text style={[styles.cardTitle, { color: c.text }]}>Deal of the day</Text>
            <Text style={{ color: c.muted }}>Lisbon from $489 return. Book by Sunday.</Text>
            <PrimaryButton testID="deal-view" title="View deal" onPress={() => setDealOpen(false)} />
            <PrimaryButton testID="deal-close" title="Close" variant="secondary" onPress={() => setDealOpen(false)} />
          </Card>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  greeting: { fontSize: 26, fontWeight: '800', marginVertical: 4 },
  eyebrow: { fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  cardTitle: { fontSize: 17, fontWeight: '700' },
  link: { fontWeight: '600', marginTop: 4 },
  grid: { flexDirection: 'row', gap: 12 },
  gridItem: { flex: 1 },
  emoji: { fontSize: 26 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  section: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  recent: { paddingVertical: 14 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 24 },
  modalCard: { gap: 12 },
});
