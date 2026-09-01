---
"@smartflow/cli": patch
---

Drop the library entry metadata from the private `@smartflow/cli` manifest. `apps/cli/src/index.ts` contains only `export {}`, so `main`, `types`, `exports`, and `files` advertised an empty module that nothing imports. The published CLI is bundled from `apps/cli/src/main.ts` through the root `tsdown.config.mjs`, not from this entry.

The manifest itself stays. `scripts/release/check-changeset.mjs` and `scripts/release/version-root-package.mjs` both key on the `@smartflow/cli` name for release versioning.

No behavior change.
