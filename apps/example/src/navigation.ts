import { createNavigationContainerRef } from '@react-navigation/native';

export type RootStack = {
  Login: undefined;
  Home: undefined;
  BookingDetails: { bookingId: string };
  Itinerary: { bookingId: string };
  Playground: undefined;
};

export const navigationRef = createNavigationContainerRef<RootStack>();
