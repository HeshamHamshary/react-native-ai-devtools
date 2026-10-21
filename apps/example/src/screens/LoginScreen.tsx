import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, ApiError } from '../api';
import { useSession } from '../session';
import { Card, Field, PrimaryButton, useColors } from '../ui';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function LoginScreen() {
  const c = useColors();
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [touched, setTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const emailError = touched && !EMAIL.test(email) ? 'Enter a valid email address' : undefined;
  const passwordError = touched && password.length < 8 ? 'Password must be at least 8 characters' : undefined;

  const submit = async () => {
    setTouched(true);
    setServerError(null);
    if (!EMAIL.test(email) || password.length < 8) return;
    setLoading(true);
    try {
      const r = await api.login(email, password);
      signIn(r.user.name);
    } catch (e) {
      setServerError(e instanceof ApiError ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: c.bg }]} edges={['top']}>
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.brand, { color: c.primary }]}>✈ SkyTrips</Text>
        <Text style={[styles.title, { color: c.text }]}>Welcome back</Text>
        <Text style={[styles.subtitle, { color: c.muted }]}>Sign in to manage your trips.</Text>
        <Card>
          <Field
            label="Email"
            testID="login-email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            autoCapitalize="none"
            keyboardType="email-address"
            autoCorrect={false}
            error={emailError}
          />
          <Field
            label="Password"
            testID="login-password"
            value={password}
            onChangeText={setPassword}
            placeholder="At least 8 characters"
            secureTextEntry
            error={passwordError}
            onSubmitEditing={submit}
          />
          <View style={styles.row}>
            <Text style={[styles.rowLabel, { color: c.text }]}>Remember me</Text>
            <Switch testID="login-remember" value={remember} onValueChange={setRemember} />
          </View>
          {serverError ? (
            <Text testID="login-error" style={[styles.serverError, { color: c.danger }]}>
              {serverError}
            </Text>
          ) : null}
          <PrimaryButton testID="login-submit" title="Log in" onPress={submit} loading={loading} />
        </Card>
        <Text style={[styles.hint, { color: c.muted }]}>Demo account: any email with password “password123”.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 20, gap: 12, paddingTop: 16 },
  brand: { fontSize: 18, fontWeight: '800' },
  title: { fontSize: 30, fontWeight: '800' },
  subtitle: { fontSize: 16, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  rowLabel: { fontSize: 15 },
  serverError: { fontSize: 14, fontWeight: '600' },
  hint: { fontSize: 13, textAlign: 'center', marginTop: 8 },
});
