---
"@smartflow/cli": minor
---

Allow MCP server configurations to set `REVIEW_ENABLED=false`. Disabled Review skips local Reviewer executable checks and sends a completed Worker Candidate directly through Publish without creating Review or Leader Decision artifacts. Publish and crash recovery retain Candidate, operation, preflight, CAS, and apply-boundary validation without fabricating a Review hash.
