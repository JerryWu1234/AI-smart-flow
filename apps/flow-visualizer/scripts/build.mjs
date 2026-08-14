/* global console, URL */

import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ACTORS,
  FLOW,
  FLOW_META,
  SCENARIOS,
  STAGES,
  TRANSITIONS
} from "../src/flow-model.js";
import { DATA_DETAILS } from "../src/data-structures.js";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const distRoot = fileURLToPath(new URL("../dist/", import.meta.url));
const indexPath = fileURLToPath(new URL("../index.html", import.meta.url));
const reviewDecisionPath = fileURLToPath(new URL("../../../packages/review/src/review-decision.ts", import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(`FLOW_MODEL_INVALID: ${message}`);
}

function assertUnique(items, label) {
  const ids = new Set();
  for (const item of items) {
    assert(typeof item.id === "string" && item.id.length > 0, `${label} contains an empty id`);
    assert(!ids.has(item.id), `${label} repeats id ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

const reviewDecisionSource = await readFile(reviewDecisionPath, "utf8");
const repairRoundLimitMatch = reviewDecisionSource.match(/export const REPAIR_ROUND_LIMIT\s*=\s*(\d+)/u);
assert(repairRoundLimitMatch !== null, "cannot read REPAIR_ROUND_LIMIT from executable review policy");
const executableRepairRoundLimit = Number(repairRoundLimitMatch[1]);
assert(
  FLOW_META.repairRoundLimit === executableRepairRoundLimit,
  `repair limit drifted from executable policy (${String(executableRepairRoundLimit)})`
);
assert(FLOW.meta === FLOW_META, "FLOW must expose the same metadata object");
assert(FLOW_META.schemaVersion === 5, "visualizer must describe StateStore schema v5");
assert(FLOW_META.simulationKind === "ILLUSTRATIVE_SIMULATION", "sample values must not be presented as live telemetry");

const actorIds = assertUnique(ACTORS, "actors");
const stageIds = assertUnique(STAGES, "stages");
const transitionIds = assertUnique(TRANSITIONS, "transitions");
assert(ACTORS.length === 8, "all eight ownership participants must be present");
assert(stageIds.has(FLOW_META.entryStageId), "entry stage does not exist");

const occupiedLayoutCells = new Set();
for (const item of STAGES) {
  assert(item.layout !== undefined, `${item.id} has no graph layout`);
  assert(Number.isInteger(item.layout.row) && item.layout.row >= 1 && item.layout.row <= 4, `${item.id} has invalid row`);
  assert(Number.isInteger(item.layout.column) && item.layout.column >= 1 && item.layout.column <= 6, `${item.id} has invalid column`);
  const cell = `${String(item.layout.row)}:${String(item.layout.column)}`;
  assert(!occupiedLayoutCells.has(cell), `${item.id} overlaps another stage at ${cell}`);
  occupiedLayoutCells.add(cell);
  assert(typeof item.title === "string" && item.title.length >= 4, `${item.id} has no useful title`);
  assert(typeof item.summary === "string" && item.summary.length >= 18, `${item.id} has no useful summary`);
  assert(typeof item.plainLanguage === "string" && item.plainLanguage.length >= 24, `${item.id} has no useful plain-language explanation`);
  assert(Object.keys(item.before).length > 0 && Object.keys(item.after).length > 0, `${item.id} has no before/after projection`);
  assert(item.outputs.length > 0, `${item.id} has no documented output`);
  assert(item.sources.length > 0, `${item.id} has no implementation evidence`);
  for (const actorId of item.actorIds) assert(actorIds.has(actorId), `${item.id} references unknown actor ${actorId}`);
  for (const ref of item.sources) assert(ref.includes("#"), `${item.id} source must include a stable symbol: ${ref}`);
  assert(!["CLAIMING", "LEADER_DECISION", "REPAIR_TASKS_READY"].includes(item.phase), `${item.id} exposes a legacy phase as current`);
}

const outgoing = new Map(STAGES.map((item) => [item.id, []]));
for (const item of TRANSITIONS) {
  assert(stageIds.has(item.fromStageId), `${item.id} has unknown source stage ${item.fromStageId}`);
  assert(stageIds.has(item.toStageId), `${item.id} has unknown target stage ${item.toStageId}`);
  assert(item.fromStageId !== item.toStageId, `${item.id} must not hide behavior in a self edge`);
  assert(["main", "repair", "pause", "recovery", "cancel"].includes(item.lane), `${item.id} has unknown lane ${item.lane}`);
  assert(typeof item.condition === "string" && item.condition.length >= 10, `${item.id} has no useful condition`);
  assert(typeof item.explanation === "string" && item.explanation.length >= 14, `${item.id} has no useful explanation`);
  assert(typeof item.payloadExample === "string" && item.payloadExample.length > 0, `${item.id} has no example payload`);
  assert(Object.keys(item.before).length > 0 && Object.keys(item.after).length > 0, `${item.id} has no before/after durable projection`);
  assert(item.changes.length > 0, `${item.id} has no documented change`);
  assert(item.dataDetailIds.length > 0, `${item.id} has no DataDetail mapping`);
  assert(item.sources.length > 0, `${item.id} has no implementation source`);
  for (const actorId of item.actorIds) assert(actorIds.has(actorId), `${item.id} references unknown actor ${actorId}`);
  for (const detailId of item.dataDetailIds) assert(DATA_DETAILS[detailId] !== undefined, `${item.id} references unknown DataDetail ${detailId}`);
  for (const ref of item.sources) assert(ref.includes("#"), `${item.id} source must include a stable symbol: ${ref}`);
  outgoing.get(item.fromStageId).push(item.toStageId);
}

for (const item of STAGES) {
  if (!item.terminal) assert(outgoing.get(item.id).length > 0, `${item.id} is non-terminal but has no outgoing transition`);
}

for (const [id, item] of Object.entries(DATA_DETAILS)) {
  assert(id === item.id, `${id} identity does not match its map key`);
  assert(typeof item.objectName === "string" && item.objectName.length > 0, `${id} has no object name`);
  assert(typeof item.purpose === "string" && item.purpose.length >= 16, `${id} has no useful plain-language purpose`);
  assert(typeof item.producer === "string" && typeof item.consumer === "string", `${id} has no producer/consumer`);
  assert(typeof item.transformation === "string" && typeof item.lifecycle === "string", `${id} has no lifecycle description`);
  assert(item.fields.length > 0, `${id} has no fields`);
  assert(item.sources.length > 0, `${id} has no sources`);
  for (const entry of item.fields) {
    assert(entry.path.length > 0 && entry.type.length > 0, `${id} contains an unnamed field`);
    assert(typeof entry.required === "boolean", `${id}/${entry.path} has no required flag`);
    assert(entry.example.length > 0 && entry.purpose.length > 0, `${id}/${entry.path} lacks example or purpose`);
  }
}

const scenarioIds = assertUnique(Object.values(SCENARIOS), "scenarios");
assert(scenarioIds.has("success") && scenarioIds.has("repair"), "success and repair scenarios are mandatory");
const coveredTransitions = new Set();
for (const item of Object.values(SCENARIOS)) {
  assert(item.transitionPath.length > 0, `${item.id} has an empty transition path`);
  let previousTarget;
  for (const [index, transitionId] of item.transitionPath.entries()) {
    assert(transitionIds.has(transitionId), `${item.id} references unknown transition ${transitionId}`);
    const edge = TRANSITIONS.find((candidate) => candidate.id === transitionId);
    assert(edge !== undefined, `${item.id} cannot resolve transition ${transitionId}`);
    if (previousTarget !== undefined) {
      assert(
        previousTarget === edge.fromStageId,
        `${item.id} path breaks before step ${String(index + 1)}: expected ${previousTarget}, got ${edge.fromStageId}`
      );
    }
    previousTarget = edge.toStageId;
    coveredTransitions.add(transitionId);
  }
}
for (const transitionId of transitionIds) {
  assert(coveredTransitions.has(transitionId), `${transitionId} is not exercisable from any scenario`);
}

const reachable = new Set([FLOW_META.entryStageId]);
const queue = [FLOW_META.entryStageId];
while (queue.length > 0) {
  const from = queue.shift();
  for (const to of outgoing.get(from) ?? []) {
    if (!reachable.has(to)) {
      reachable.add(to);
      queue.push(to);
    }
  }
}
for (const stageId of stageIds) assert(reachable.has(stageId), `${stageId} is unreachable from the entry stage`);

const repairBackEdge = TRANSITIONS.find((item) => item.id === "tr.repair.create-scoped-revision");
assert(repairBackEdge?.fromStageId === "stage.repair.prepare-revision", "repair back edge must originate after scoped revision preparation");
assert(repairBackEdge?.toStageId === "stage.run.preparing", "repair back edge must return to PREPARING");
assert(repairBackEdge?.route === "repair-back", "repair back edge must be visually explicit");
assert(transitionIds.has("tr.reviewer.create") && transitionIds.has("tr.reviewer.resume"), "Reviewer CREATE and RESUME must both be explicit");
assert(STAGES.find((item) => item.id === "stage.output.done")?.phase.includes("DONE"), "DONE output boundary must be explicit");

const html = await readFile(indexPath, "utf8");
for (const requiredReference of [
  "./src/styles.css",
  "./src/app.js",
  "id=\"flowGraph\"",
  "id=\"flowSvg\"",
  "id=\"stageLayer\"",
  "id=\"branchRail\"",
  "id=\"pathList\"",
  "id=\"dataDetailList\"",
  "id=\"stateBefore\"",
  "id=\"stateAfter\"",
  "ILLUSTRATIVE · NOT LIVE"
]) {
  assert(html.includes(requiredReference), `index.html is missing ${requiredReference}`);
}

await rm(distRoot, { recursive: true, force: true });
await mkdir(distRoot, { recursive: true });
await cp(indexPath, `${distRoot}/index.html`);
await cp(sourceRoot, `${distRoot}/src`, { recursive: true });

console.log(
  `Built SmartFlow complete graph: ${String(STAGES.length)} stages, ${String(TRANSITIONS.length)} transitions, ${String(Object.keys(SCENARIOS).length)} scenarios → ${distRoot.replace(`${appRoot}/`, "")}`
);
