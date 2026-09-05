# SmartFlow E2E Tasks

> Set Project Root to the repository root when running and use `tests/fixtures/smartflow-e2e/task.md` as tasksPath.
> Keep all implementation and generated output under `.smartflow-e2e/`; do not modify any other project file or this task file.

## M01 · SmartFlow E2E Fixture

- [ ] T001 [M01] Create `.smartflow-e2e/flow-input.json` — Acceptance: the file is valid UTF-8 JSON with content `{"suite":"smartflow-e2e","status":"pending","value":7}`.
- [ ] T002 [M01] Create `.smartflow-e2e/flow-transform.js` to read `.smartflow-e2e/flow-input.json` and generate `.smartflow-e2e/flow-output.json` — Acceptance: the script uses only built-in Node.js APIs; after execution, the output is `{"suite":"smartflow-e2e","status":"passed","value":14,"sourceStatus":"pending"}`, and the input file is unchanged.
- [ ] T003 [M01] Create `.smartflow-e2e/flow-summary.md` — Acceptance: the document records the relative paths of the input, transform script, and output, explains that input value `7` becomes output value `14`, and matches the actual files.
