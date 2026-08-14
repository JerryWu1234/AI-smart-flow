---
name: evidence-driven-flow-visualizer
description: Build or refine an evidence-driven interactive process visualizer from any codebase or technical specification. Use for workflow maps, state machines, request lifecycles, data pipelines, background jobs, distributed protocols, or user journeys that need animated stages, clickable transitions, data inspection, plain-language explanations, branching, recovery, responsive UI, accessibility, and end-to-end validation.
compatibility: Requires access to relevant source code, schemas, traces, tests, or technical documentation.
---

# Evidence-Driven Flow Visualizer

Turn a real process into an accurate, interactive explanation of what happens, why it happens, what data moves, and how the process ends or recovers.

**Tradeoff:** Prefer accuracy and clarity over visual novelty. A simple truthful visualization is better than a polished fictional one.

## User Input

```text
$ARGUMENTS
```

Use the request to determine the audience, scope, style, output location, interaction depth, and validation level. Ask only when ambiguity changes the result or its factual meaning.

## 1. Start With Evidence

Before writing UI code:

- Locate the strongest available sources: executable schemas and types, runtime logic, tests or traces, then documentation.
- Trace the normal path, alternate branches, loops, failures, recovery, and external effects.
- Identify participants, ownership boundaries, state changes, data objects, and termination conditions.
- Record each important claim with a source path and symbol or another stable reference.

Treat line numbers as generated hints, not durable identities. If sources disagree, surface the conflict instead of choosing the version that is easier to visualize.

Do not change system behavior to fit the diagram. State whether the result is an illustrative simulation, recorded trace replay, or live telemetry. Never present sample data as live data.

## 2. Use a Small Semantic Model

Keep content separate from rendering:

```text
Flow -> Stage[] -> Transition[] -> DataDetail
```

- A **flow** is one complete path or meaningful variant.
- A **stage** has a stable ID, state, participants, before and after values, transitions, outputs, explanations, and sources.
- A **transition** has a stable ID, source, destination, timing, label, payload example, and data-detail reference.
- A **data detail** describes the object category, producer, consumer, transformation, lifecycle, fields, sources, and plain-language purpose.

Each field should include its path, type, required status, example, and purpose.

Use stable IDs for joins. Never use editable labels as identity keys. Adapt object categories to the domain; common categories include messages, state, artifacts, derived views, and side effects. Do not force concepts into the model when the source does not contain them.

## 3. Model Meaningful Boundaries and Variants

Create stages only where process meaning changes, such as input acceptance, control handoff, durable state change, decision, output creation, external effect, recovery checkpoint, or termination.

Each stage must answer:

1. What was true before it?
2. Who participates?
3. What data moves or changes?
4. What is produced or persisted?
5. Why does the stage exist?
6. What can happen next?
7. What evidence supports it?

Represent only variants supported by evidence. Depending on the system, these may include normal completion, alternate decisions, retries, rework, restart recovery, conflicts, cancellation, and unresolved failure.

For loops, derive the counter, limit, progress rule, and exit conditions from source behavior. Never claim a fixed iteration count unless the source guarantees it.

## 4. Explain Every Step and Data Object

Provide plain-language explanations at two levels:

- **Stage:** What is happening, why it is needed, and what problem it prevents.
- **Transition:** Who sends or changes what, how it is used, and what it enables next.

Display explanations beside the relevant stage, transition, inspector, and current payload. Do not hide them in separate documentation.

Field descriptions must explain purpose rather than repeat names. Mark payload values as examples unless they come from an identified trace. Never invent fields absent from the source.

Fail fast when a stage or transition is missing its data detail, source, or plain-language explanation.

## 5. Keep Interaction Synchronized

Use one normalized progress value as the source of truth for connections, moving markers, participant highlights, stage status, current data, inspector content, state changes, timeline, and scrubber.

Do not maintain separate clocks or selection state for related views.

When a user selects a transition:

1. Pause playback.
2. Select it by stable flow, stage, and transition IDs.
3. Seek to a representative point in its time window.
4. Update every visual and data view from the same state.
5. Open the relevant detail view and announce the selection accessibly.

Clear stale selection when changing flow or stage, replaying, or resuming. Define scrubber behavior explicitly.

## 6. Keep the Implementation Simple and Accessible

Use the existing stack unless a new dependency is necessary. Separate the process model, data catalog, rendering, styling, and validation without overengineering.

Make surgical changes when refining an existing visualizer. Avoid unrelated refactors, speculative abstractions, and single-use infrastructure.

Use native controls, visible focus states, keyboard navigation, reduced-motion support, and responsive layouts. Recalculate connection geometry after layout changes.

## 7. Verify the Experience

Define measurable success criteria before implementation. Run the repository's existing syntax, type, lint, build, and relevant test commands. Add permanent tests only when requested or required by project conventions.

For every modeled flow:

- Visit every stage and select every transition.
- Confirm selection and seeking behavior.
- Confirm every visual and data view shows the same transition.
- Confirm fields, explanations, and source references.
- Confirm the final outcome matches the model.

Also check narrow mobile, tablet, and desktop layouts; keyboard navigation; focus visibility; reduced motion; live-region behavior; text wrapping; and connection alignment after resize.

If browser validation cannot be performed, say so explicitly. A successful build is not proof that the interaction works.

## Avoid These Mistakes

- Drawing the story before investigating the source.
- Showing only one path when meaningful alternatives exist.
- Using display text as model identity.
- Treating hand-written line numbers as durable provenance.
- Showing payload values without field purpose or lifecycle.
- Adding one generic explanation while leaving transitions unexplained.
- Driving related views with separate state or timers.
- Using non-semantic clickable elements or color-only status.
- Calling simulated data live telemetry.
- Treating partial, unknown, or unreconciled outcomes as success.
- Adding domain concepts not supported by evidence.
- Reporting completion without exercising the page.

## Done When

- [ ] Every modeled stage and transition is supported by evidence.
- [ ] Stable IDs connect flows, stages, transitions, and data details.
- [ ] Relevant branches, loops, failures, and recovery paths are represented.
- [ ] Every transition documents its data lifecycle and fields.
- [ ] Every stage and transition has a visible plain-language explanation.
- [ ] Selecting a transition synchronizes all visual and data views.
- [ ] Missing mappings and invalid model data fail fast.
- [ ] Keyboard, reduced-motion, mobile, and desktop behavior are usable.
- [ ] Existing checks pass and the page has been exercised in a browser.
- [ ] The final report states what changed, what was validated, and what remains unverified.

## Source

Structure inspired by [karpathy-guidelines](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/skills/karpathy-guidelines/SKILL.md). Content was rephrased for compliance with licensing restrictions.
