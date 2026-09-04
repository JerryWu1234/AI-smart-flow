---
"@smartflow/cli": patch
---

Remove unread and duplicate Hash projections from compiled manifests, approved-source and manual-publish recovery metadata, repair continuations, and review action preparation.

Artifact integrity remains bound to the existing task-source and task-manifest `ArtifactRef` SHA values. Manual publish confirmation keeps its stable request ID, and review preparation still verifies task-source bytes before reusing the verified Artifact SHA.
