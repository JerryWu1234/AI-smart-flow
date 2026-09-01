---
"@smartflow/cli": minor
---

Allow the Pi Worker `API` environment setting to be omitted. SmartFlow now resolves a missing value to `openai-responses` before computing Provider fingerprints and runtime hashes, while preserving every explicitly configured supported API. Blank and unsupported explicit values remain invalid, and SmartFlow does not probe endpoints or switch API formats after a request fails.
