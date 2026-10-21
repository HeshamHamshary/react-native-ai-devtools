import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AgentDevTools } from 'react-native-agent-devtools';
import { navigationRef, type RootStack } from './navigation';
import { BookingDetailsScreen } from './screens/BookingDetailsScreen';
import { HomeScreen } from './screens/HomeScreen';
import { ItineraryScreen } from './screens/ItineraryScreen';
import { LoginScreen } from './screens/LoginScreen';
import { PlaygroundScreen } from './screens/PlaygroundScreen';
import { SessionProvider, useSession } from './session';

const Stack = createNativeStackNavigator<RootStack>();

function Routes() {
  const { user } = useSession();
  return (
    <Stack.Navigator>
      {user ? (
        <>
          <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'SkyTrips' }} />
          <Stack.Screen name="BookingDetails" component={BookingDetailsScreen} options={{ title: 'Booking details' }} />
          <Stack.Screen name="Itinerary" component={ItineraryScreen} />
          <Stack.Screen name="Playground" component={PlaygroundScreen} options={{ title: 'Debug playground' }} />
        </>
      ) : (
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  const dark = useColorScheme() === 'dark';
  return (
    // Development-only: renders just the app when __DEV__ is false.
    <AgentDevTools navigationRef={navigationRef}>
      <SafeAreaProvider>
        <SessionProvider>
          <NavigationContainer ref={navigationRef} theme={dark ? DarkTheme : DefaultTheme}>
            <Routes />
          </NavigationContainer>
        </SessionProvider>
      </SafeAreaProvider>
    </AgentDevTools>
  );
}
