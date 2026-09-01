---
"@smartflow/cli": patch
---

Remove the `mcpToolSchemas` barrel from `@smartflow/protocol`. It enumerated the six public MCP tools as input/output schema pairs, but no production code imported it — its only consumers were three assertions in the protocol unit test.

It was also a shadow of a structure the server does not have. Real registration in `apps/mcp-server/src/server.ts` passes `inputSchema` only, and output validation happens separately per tool through `createValidatedHandler`, so the barrel's paired shape could not drift into agreement with what MCP actually exposes.

The tool-set assertion is not lost. `tests/contract/mcp-tools.test.ts` already makes the identical check against `createToolHandlers()`, which is the production handler map, and the contract suite runs on every CI build. The remaining schema assertion now uses the exported `statusOutputSchema` directly.

No behavior change.
