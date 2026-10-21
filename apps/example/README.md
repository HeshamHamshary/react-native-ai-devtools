# SkyTrips example app

A fake travel app for exercising react-native-agent-devtools.

| Screen | What it exercises |
|---|---|
| Login | Validation, mock request. Any email plus `password123`. |
| Home | Cards, modal, switch, list |
| Booking details | Expandable sections, request; "Cancel booking" triggers the sensitive-action confirmation |
| Itinerary | FlatList |
| Debug playground | Throwing handler, failing request, disabled button, slow request, invalid navigation, an invisible view covering a button, a misaligned price, a 50-item list |

The fake backend (`mockApi.js`) runs as Metro middleware, so nothing else needs to be started. Run instructions are in the [root README](../../README.md#quick-start-example-app).
