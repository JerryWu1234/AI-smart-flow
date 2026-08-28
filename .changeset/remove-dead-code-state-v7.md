---
"@jerrywu1234/smartflow": major
---

Remove unreachable compatibility APIs, ignored daemon configuration, stale Git patch/evidence state, and unused private workspace exports.

ProjectState now stores only the active workspace relative path and no longer carries an application-level schema version. Existing daemon data is not migrated or dual-read; clear local daemon data with `pnpm clean:daemon-data` before using this release. The SQLite physical schema version advances to 5 and no longer mirrors a document schema version.

Pi worker and model-extension dynamic entries, provider SPI identity fields, and deterministic crash, atomicity, containment, and publish-recovery seams remain supported.
