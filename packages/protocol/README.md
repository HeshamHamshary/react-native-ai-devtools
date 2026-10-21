# react-native-agent-devtools-protocol

Shared by the in-app runtime and the server. It has no runtime dependencies and contains:

- message types and validators (`parseClientMessage`, `parseServerMessage`)
- target selectors (`e12`, `#testID`, `text=…`, `role=…`)
- the sequence schema and its hard limits (`validateSequence`, `LIMITS`)
- the replayable flow format (`validateFlow`, `FlowStep`, `MAX_FLOW_STEPS`)
- inspection types (`ElementDetails`, `Finding`, `SourceRef`)
- redaction (`redactText`, `redactUrl`, `redactValue`, `redactBody`)
