# react-native-agent-devtools-protocol

Shared by the in-app runtime and the server, with no runtime dependencies:

- message types and validators (`parseClientMessage`, `parseServerMessage`)
- target selectors (`e12`, `#testID`, `text=…`, `role=…`)
- the sequence schema and its hard limits (`validateSequence`, `LIMITS`)
- redaction (`redactText`, `redactUrl`, `redactValue`, `redactBody`)
