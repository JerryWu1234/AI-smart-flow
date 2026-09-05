---
"@smartflow/cli": patch
---

Stop retaining the daemon handshake `instanceId` and registered `providerRuntimeConfigHash` on `LocalIpcClient`. Neither public field had a caller outside two test assertions, so the ready frame is now validated and discarded rather than stored.

Handshake enforcement is unchanged: a ready frame without a string `instanceId` is still rejected, a mismatched `daemonConfigFingerprint` still fails with `DAEMON_CONFIGURATION_MISMATCH`, and a connection that supplies a Worker environment but receives no registered hash still fails with `PROVIDER_CONFIG_UNAVAILABLE`.
