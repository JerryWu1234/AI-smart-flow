/* global document, window, requestAnimationFrame, cancelAnimationFrame, ResizeObserver, performance, localStorage */

import {
  ACTORS,
  FLOW_META,
  INVARIANTS,
  OWNERSHIP,
  PUBLIC_TOOLS,
  SCENARIOS,
  STAGES,
  TRANSITIONS
} from "./flow-model.js";
import { DATA_DETAILS } from "./data-structures.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const EDGE_HOLD_MS = 420;
const TONE_COLORS = Object.freeze({
  cyan: "#63e6c1",
  violet: "#a997ff",
  amber: "#ffc25f",
  green: "#7ce890",
  red: "#ff7184"
});
const KIND_LABELS = Object.freeze({
  external: "外部信任边界",
  durable: "Durable State",
  activity: "原子活动",
  terminal: "Durable Terminal",
  output: "协议输出",
  recovery: "恢复协调",
  pause: "安全暂停",
  rejection: "创建前拒绝"
});
const DATA_CATEGORY_LABELS = Object.freeze({
  message: "协议消息",
  "durable-state": "Durable State",
  artifact: "不可变 Artifact",
  "message-and-state": "消息 + 状态",
  "artifact-and-state": "Artifact + 状态",
  "side-effect-receipt": "外部副作用回执",
  "derived-state": "派生状态",
  derived: "派生对象"
});

function required(selector, scope = document) {
  const element = scope.querySelector(selector);
  if (element === null) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function createSvgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

const actorsById = new Map(ACTORS.map((actor) => [actor.id, actor]));
const stagesById = new Map(STAGES.map((item) => [item.id, item]));
const transitionsById = new Map(TRANSITIONS.map((item) => [item.id, item]));
const scenarios = Object.values(SCENARIOS);

const ui = {
  startRepairButton: required("#startRepairButton"),
  scenarioSelect: required("#scenarioSelect"),
  scenarioTone: required("#scenarioTone"),
  scenarioDescription: required("#scenarioDescription"),
  scenarioOutcome: required("#scenarioOutcome"),
  phaseReadout: required("#phaseReadout"),
  revisionReadout: required("#revisionReadout"),
  reviewReadout: required("#reviewReadout"),
  repairReadout: required("#repairReadout"),
  graphViewport: required("#graphViewport"),
  flowGraph: required("#flowGraph"),
  flowSvg: required("#flowSvg"),
  stageLayer: required("#stageLayer"),
  graphAnnouncement: required("#graphAnnouncement"),
  branchRail: required("#branchRail"),
  pathList: required("#pathList"),
  previousButton: required("#previousButton"),
  playButton: required("#playButton"),
  playIcon: required("#playIcon"),
  playLabel: required("#playLabel"),
  nextButton: required("#nextButton"),
  replayButton: required("#replayButton"),
  flowScrubber: required("#flowScrubber"),
  progressStart: required("#progressStart"),
  flowProgress: required("#flowProgress"),
  speedSelect: required("#speedSelect"),
  loopToggle: required("#loopToggle"),
  selectionEyebrow: required("#selectionEyebrow"),
  selectionId: required("#selectionId"),
  selectionBadge: required("#selectionBadge"),
  selectionTitle: required("#selectionTitle"),
  selectionSummary: required("#selectionSummary"),
  selectionPlain: required("#selectionPlain"),
  selectionCondition: required("#selectionCondition"),
  participantList: required("#participantList"),
  payloadExample: required("#payloadExample"),
  stateTransitionLabel: required("#stateTransitionLabel"),
  stateBefore: required("#stateBefore"),
  stateAfter: required("#stateAfter"),
  changeList: required("#changeList"),
  sourceList: required("#sourceList"),
  dataDetailList: required("#dataDetailList"),
  selectionAnnouncement: required("#selectionAnnouncement"),
  toolGrid: required("#toolGrid"),
  ownershipGrid: required("#ownershipGrid"),
  invariantList: required("#invariantList")
};

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const playback = {
  scenarioId: "repair",
  pathIndex: 0,
  edgeProgress: 0,
  speed: 1,
  playing: !prefersReducedMotion.matches,
  loop: true,
  frameId: 0,
  lastFrameAt: performance.now(),
  selectedTransitionId: "tr.execute.create-run",
  selectedStageId: null,
  renderedSelectionKey: "",
  edgeVisuals: new Map()
};

function currentScenario() {
  return SCENARIOS[playback.scenarioId];
}

function currentTransition() {
  const id = currentScenario().transitionPath[playback.pathIndex];
  const result = transitionsById.get(id);
  if (result === undefined) throw new Error(`Unknown transition in active path: ${id}`);
  return result;
}

function stageFor(id) {
  const result = stagesById.get(id);
  if (result === undefined) throw new Error(`Unknown stage: ${id}`);
  return result;
}

function globalProgress() {
  const length = currentScenario().transitionPath.length;
  if (length === 0) return 0;
  return clamp((playback.pathIndex + playback.edgeProgress) / length);
}

function actorMarkup(actorIds) {
  return actorIds.map((id) => {
    const actor = actorsById.get(id);
    return `<span title="${escapeHtml(actor?.role ?? id)}"><b>${escapeHtml(actor?.code ?? id)}</b>${escapeHtml(actor?.name ?? id)}</span>`;
  }).join("");
}

function renderScenarioOptions() {
  const grouped = new Map();
  for (const item of scenarios) {
    const entries = grouped.get(item.category) ?? [];
    entries.push(item);
    grouped.set(item.category, entries);
  }
  ui.scenarioSelect.innerHTML = [...grouped.entries()].map(([category, entries]) => `
    <optgroup label="${escapeHtml(category)}">
      ${entries.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.shortName)}</option>`).join("")}
    </optgroup>
  `).join("");
  ui.scenarioSelect.value = playback.scenarioId;
  ui.speedSelect.value = String(playback.speed);
  ui.loopToggle.checked = playback.loop;
}

function renderGraphNodes() {
  ui.stageLayer.innerHTML = STAGES.map((item) => `
    <button
      type="button"
      class="graph-node tone-${escapeHtml(item.tone)}"
      data-stage-id="${escapeHtml(item.id)}"
      style="--node-row:${String(item.layout.row)};--node-column:${String(item.layout.column)}"
      aria-label="${escapeHtml(item.title)}，${escapeHtml(item.phase)}。点击查看节点详情"
    >
      <span class="node-top"><b>${escapeHtml(item.badge)}</b><small>${escapeHtml(KIND_LABELS[item.kind] ?? item.kind)}</small></span>
      <strong>${escapeHtml(item.title)}</strong>
      <code>${escapeHtml(item.shortTitle)}</code>
      <span class="node-actors">${item.actorIds.map((id) => `<i>${escapeHtml(actorsById.get(id)?.code ?? id)}</i>`).join("")}</span>
    </button>
  `).join("");

  for (const button of ui.stageLayer.querySelectorAll("button[data-stage-id]")) {
    button.addEventListener("click", () => selectStage(button.dataset.stageId));
  }
}

function relativeRect(element, containerRect) {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left - containerRect.left,
    right: rect.right - containerRect.left,
    top: rect.top - containerRect.top,
    bottom: rect.bottom - containerRect.top,
    width: rect.width,
    height: rect.height,
    centerX: rect.left - containerRect.left + rect.width / 2,
    centerY: rect.top - containerRect.top + rect.height / 2
  };
}

function anchorToward(rect, targetRect) {
  const dx = targetRect.centerX - rect.centerX;
  const dy = targetRect.centerY - rect.centerY;
  if (Math.abs(dx) >= Math.abs(dy) * 0.82) {
    return {
      x: dx >= 0 ? rect.right : rect.left,
      y: rect.centerY
    };
  }
  return {
    x: rect.centerX,
    y: dy >= 0 ? rect.bottom : rect.top
  };
}

function transitionPathData(item, fromRect, toRect) {
  if (item.route === "repair-back") {
    const start = { x: fromRect.left + fromRect.width * 0.34, y: fromRect.top };
    const end = { x: toRect.centerX, y: toRect.bottom };
    return `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} C ${(start.x - 76).toFixed(1)} ${(start.y - 118).toFixed(1)}, ${(end.x + 146).toFixed(1)} ${(end.y + 166).toFixed(1)}, ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
  }

  const start = anchorToward(fromRect, toRect);
  const end = anchorToward(toRect, fromRect);
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const magnitude = Math.max(1, Math.hypot(dx, dy));
  const normal = { x: -dy / magnitude, y: dx / magnitude };
  const control = {
    x: midpoint.x + normal.x * item.bend,
    y: midpoint.y + normal.y * item.bend
  };
  return `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${control.x.toFixed(1)} ${control.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
}

function appendArrowMarkers(defs) {
  for (const [tone, color] of Object.entries(TONE_COLORS)) {
    const marker = createSvgElement("marker", {
      id: `arrow-${tone}`,
      viewBox: "0 0 10 10",
      refX: "8.4",
      refY: "5",
      markerWidth: "7",
      markerHeight: "7",
      orient: "auto-start-reverse"
    });
    marker.append(createSvgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: color }));
    defs.append(marker);
  }
}

function drawEdges() {
  const graphRect = ui.flowGraph.getBoundingClientRect();
  const width = ui.flowGraph.offsetWidth;
  const height = ui.flowGraph.offsetHeight;
  ui.flowSvg.replaceChildren();
  ui.flowSvg.setAttribute("viewBox", `0 0 ${String(width)} ${String(height)}`);
  ui.flowSvg.setAttribute("width", String(width));
  ui.flowSvg.setAttribute("height", String(height));
  playback.edgeVisuals.clear();

  const defs = createSvgElement("defs");
  appendArrowMarkers(defs);
  const glow = createSvgElement("filter", { id: "edgeGlow", x: "-80%", y: "-80%", width: "260%", height: "260%" });
  glow.append(createSvgElement("feGaussianBlur", { stdDeviation: "4", result: "blur" }));
  const merge = createSvgElement("feMerge");
  merge.append(createSvgElement("feMergeNode", { in: "blur" }), createSvgElement("feMergeNode", { in: "SourceGraphic" }));
  glow.append(merge);
  defs.append(glow);
  ui.flowSvg.append(defs);

  for (const item of TRANSITIONS) {
    const fromNode = required(`[data-stage-id="${item.fromStageId}"]`, ui.stageLayer);
    const toNode = required(`[data-stage-id="${item.toStageId}"]`, ui.stageLayer);
    const fromRect = relativeRect(fromNode, graphRect);
    const toRect = relativeRect(toNode, graphRect);
    const data = transitionPathData(item, fromRect, toRect);
    const group = createSvgElement("g", {
      class: `flow-edge lane-${item.lane} tone-${item.tone}`,
      "data-transition-id": item.id,
      role: "button",
      tabindex: "0",
      "aria-label": `${item.label}。条件：${item.condition}`
    });
    const title = createSvgElement("title");
    title.textContent = `${item.label} — ${item.condition}`;
    const hitPath = createSvgElement("path", { class: "edge-hit", d: data });
    const path = createSvgElement("path", {
      class: "edge-path",
      d: data,
      "marker-end": `url(#arrow-${item.tone})`,
      "vector-effect": "non-scaling-stroke"
    });
    const packet = createSvgElement("circle", { class: "edge-packet", r: "5", opacity: "0" });
    group.append(title, hitPath, path, packet);
    ui.flowSvg.append(group);

    let labelPoint = { x: (fromRect.centerX + toRect.centerX) / 2, y: (fromRect.centerY + toRect.centerY) / 2 };
    try {
      const length = path.getTotalLength();
      labelPoint = path.getPointAtLength(length * 0.5);
    } catch {
      // The fallback midpoint remains usable in browsers that have not laid out SVG yet.
    }
    const labelWidth = Math.min(154, Math.max(66, item.graphLabel.length * 8.2 + 22));
    const label = createSvgElement("g", {
      class: "edge-label",
      transform: `translate(${labelPoint.x.toFixed(1)} ${labelPoint.y.toFixed(1)})`
    });
    label.append(
      createSvgElement("rect", { x: (-labelWidth / 2).toFixed(1), y: "-11", width: labelWidth.toFixed(1), height: "22", rx: "7" })
    );
    const text = createSvgElement("text", { x: "0", y: "4", "text-anchor": "middle" });
    text.textContent = item.graphLabel;
    label.append(text);
    group.append(label);

    const activate = () => selectTransition(item.id);
    group.addEventListener("click", activate);
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
    playback.edgeVisuals.set(item.id, { group, path, packet });
  }
  updateGraphState();
}

function scenarioContainingTransition(transitionId) {
  return scenarios.find((item) => item.transitionPath.includes(transitionId));
}

function nearestOccurrence(path, transitionId) {
  const matches = path
    .map((id, index) => id === transitionId ? index : -1)
    .filter((index) => index >= 0);
  if (matches.length === 0) return -1;
  return matches.sort((left, right) => (
    Math.abs(left - playback.pathIndex) - Math.abs(right - playback.pathIndex)
  ))[0];
}

function selectTransition(transitionId, occurrenceIndex) {
  let item = transitionsById.get(transitionId);
  if (item === undefined) return;
  setPlaying(false);

  let activeScenario = currentScenario();
  let scenarioChanged = false;
  let index = Number.isInteger(occurrenceIndex)
    ? occurrenceIndex
    : nearestOccurrence(activeScenario.transitionPath, transitionId);
  if (index < 0) {
    const containing = scenarioContainingTransition(transitionId);
    if (containing !== undefined) {
      playback.scenarioId = containing.id;
      activeScenario = containing;
      index = activeScenario.transitionPath.indexOf(transitionId);
      scenarioChanged = true;
    }
  }
  if (index >= 0) {
    playback.pathIndex = index;
    playback.edgeProgress = 0.5;
  }
  if (scenarioChanged) renderScenarioSurface();
  playback.selectedTransitionId = transitionId;
  playback.selectedStageId = null;
  playback.renderedSelectionKey = "";
  item = transitionsById.get(transitionId);
  if (item !== undefined) renderTransitionSelection(item);
  updateEverything();

  const destination = ui.stageLayer.querySelector(`[data-stage-id="${item?.toStageId ?? ""}"]`);
  destination?.scrollIntoView({
    behavior: prefersReducedMotion.matches ? "auto" : "smooth",
    block: "nearest",
    inline: "center"
  });
  ui.graphAnnouncement.textContent = `已选择转移：${item?.label ?? transitionId}。动画已暂停，详情与状态投影已同步。`;
}

function selectStage(stageId) {
  const item = stagesById.get(stageId);
  if (item === undefined) return;
  setPlaying(false);
  playback.selectedStageId = stageId;
  playback.selectedTransitionId = null;
  playback.renderedSelectionKey = "";
  renderStageSelection(item);
  updateEverything();
  ui.graphAnnouncement.textContent = `已选择节点：${item.title}。动画已暂停，节点详情已同步。`;
}

function projectionMarkup(projection) {
  return Object.entries(projection).map(([key, value]) => `
    <div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>
  `).join("");
}

function renderParticipants(actorIds) {
  ui.participantList.innerHTML = actorMarkup(actorIds);
}

function renderSources(sources) {
  ui.sourceList.innerHTML = sources.map((item) => {
    const separator = item.lastIndexOf("#");
    const path = separator < 0 ? item : item.slice(0, separator);
    const symbol = separator < 0 ? "" : item.slice(separator + 1);
    return `
      <code><span>${escapeHtml(path)}</span>${symbol.length === 0 ? "" : `<b>#${escapeHtml(symbol)}</b>`}</code>
    `;
  }).join("");
}

function adjacentDataDetails(stageId) {
  return [...new Set(TRANSITIONS.flatMap((item) => (
    item.fromStageId === stageId || item.toStageId === stageId ? item.dataDetailIds : []
  )))];
}

function renderDataDetails(ids) {
  ui.dataDetailList.innerHTML = ids.map((id, index) => {
    const item = DATA_DETAILS[id];
    if (item === undefined) return "";
    return `
      <details class="data-detail" ${index === 0 ? "open" : ""}>
        <summary>
          <span><b>${String(index + 1).padStart(2, "0")}</b><i>${escapeHtml(DATA_CATEGORY_LABELS[item.category] ?? item.category)}</i></span>
          <strong>${escapeHtml(item.objectName)}</strong>
          <small>${escapeHtml(item.purpose)}</small>
          <em aria-hidden="true">＋</em>
        </summary>
        <div class="data-body">
          <p>${escapeHtml(item.summary)}</p>
          <div class="data-route">
            <span><small>PRODUCER</small><strong>${escapeHtml(item.producer)}</strong></span>
            <i aria-hidden="true">→</i>
            <span><small>CONSUMER</small><strong>${escapeHtml(item.consumer)}</strong></span>
          </div>
          <dl class="data-lifecycle">
            <div><dt>转换</dt><dd>${escapeHtml(item.transformation)}</dd></div>
            <div><dt>生命周期</dt><dd>${escapeHtml(item.lifecycle)}</dd></div>
          </dl>
          <div class="field-table">
            <header><span>字段</span><span>类型 / 必填</span><span>示例值</span><span>用途</span></header>
            ${item.fields.map((entry) => `
              <div>
                <code>${escapeHtml(entry.path)}</code>
                <span>${escapeHtml(entry.type)} · ${entry.required ? "必填" : "可选"}</span>
                <code>${escapeHtml(entry.example)}</code>
                <p>${escapeHtml(entry.purpose)}</p>
              </div>
            `).join("")}
          </div>
          <footer>${item.sources.map((entry) => `<code>${escapeHtml(entry)}</code>`).join("")}</footer>
        </div>
      </details>
    `;
  }).join("");
}

function setSelectionState(before, after, changes) {
  ui.stateBefore.innerHTML = projectionMarkup(before);
  ui.stateAfter.innerHTML = projectionMarkup(after);
  ui.changeList.innerHTML = changes.map((item) => `<li><span aria-hidden="true">↳</span>${escapeHtml(item)}</li>`).join("");
}

function renderTransitionSelection(item) {
  const from = stageFor(item.fromStageId);
  const to = stageFor(item.toStageId);
  const key = `transition:${item.id}:${playback.pathIndex}`;
  if (playback.renderedSelectionKey === key) return;
  playback.renderedSelectionKey = key;
  ui.selectionEyebrow.textContent = `TRANSITION · ${item.lane.toUpperCase()}`;
  ui.selectionId.textContent = item.id;
  ui.selectionBadge.textContent = `${from.shortTitle} → ${to.shortTitle}`;
  ui.selectionTitle.textContent = item.label;
  ui.selectionSummary.textContent = item.explanation;
  ui.selectionPlain.textContent = `${item.condition} 通过后，系统把 ${from.title} 推进到 ${to.title}；这一步的状态变化和数据绑定如下。`;
  ui.selectionCondition.textContent = item.condition;
  ui.payloadExample.textContent = `示例 · ${item.payloadExample}`;
  ui.stateTransitionLabel.textContent = `${item.before.phase ?? from.phase} → ${item.after.phase ?? to.phase}`;
  renderParticipants(item.actorIds);
  setSelectionState(item.before, item.after, item.changes);
  renderSources(item.sources);
  renderDataDetails(item.dataDetailIds);
  ui.selectionAnnouncement.textContent = `已显示转移 ${item.label}。触发条件：${item.condition}`;
}

function renderStageSelection(item) {
  const key = `stage:${item.id}`;
  if (playback.renderedSelectionKey === key) return;
  playback.renderedSelectionKey = key;
  ui.selectionEyebrow.textContent = `STAGE · ${KIND_LABELS[item.kind] ?? item.kind}`;
  ui.selectionId.textContent = item.id;
  ui.selectionBadge.textContent = item.phase;
  ui.selectionTitle.textContent = item.title;
  ui.selectionSummary.textContent = item.summary;
  ui.selectionPlain.textContent = item.plainLanguage;
  ui.selectionCondition.textContent = "这是共享图节点；选择任一相连箭头可查看该入口或出口的精确条件。";
  ui.payloadExample.textContent = `产出 · ${item.outputs.join(" · ")}`;
  ui.stateTransitionLabel.textContent = `${item.shortTitle} · NODE PROJECTION`;
  renderParticipants(item.actorIds);
  setSelectionState(item.before, item.after, item.outputs);
  renderSources(item.sources);
  renderDataDetails(adjacentDataDetails(item.id));
  ui.selectionAnnouncement.textContent = `已显示节点 ${item.title}。${item.plainLanguage}`;
}

function renderBranchRail() {
  const groups = [
    { id: "repair", label: "自动修复回环" },
    { id: "pause", label: "暂停出口" },
    { id: "recovery", label: "重启恢复" },
    { id: "cancel", label: "取消终止" }
  ];
  ui.branchRail.innerHTML = groups.map((group) => {
    const items = TRANSITIONS.filter((item) => item.lane === group.id);
    return `
      <section data-branch-group="${group.id}">
        <header><i></i><strong>${escapeHtml(group.label)}</strong><span>${String(items.length).padStart(2, "0")}</span></header>
        <div>${items.map((item) => `
          <button type="button" data-transition-id="${escapeHtml(item.id)}" title="${escapeHtml(item.condition)}">
            <span>${escapeHtml(item.graphLabel)}</span><small>${escapeHtml(stageFor(item.fromStageId).shortTitle)} → ${escapeHtml(stageFor(item.toStageId).shortTitle)}</small>
          </button>
        `).join("")}</div>
      </section>
    `;
  }).join("");
  for (const button of ui.branchRail.querySelectorAll("button[data-transition-id]")) {
    button.addEventListener("click", () => selectTransition(button.dataset.transitionId));
  }
}

function renderPath() {
  const active = currentScenario();
  ui.pathList.innerHTML = active.transitionPath.map((transitionId, index) => {
    const item = transitionsById.get(transitionId);
    if (item === undefined) return "";
    return `
      <button type="button" data-path-index="${String(index)}" data-transition-id="${escapeHtml(transitionId)}">
        <span>${String(index + 1).padStart(2, "0")}</span>
        <small>${escapeHtml(stageFor(item.fromStageId).shortTitle)}</small>
        <strong>${escapeHtml(item.graphLabel)}</strong>
        <i aria-hidden="true">→</i>
      </button>
    `;
  }).join("");
  for (const button of ui.pathList.querySelectorAll("button[data-path-index]")) {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.pathIndex);
      if (Number.isInteger(index)) selectTransition(button.dataset.transitionId, index);
    });
  }
}

function renderScenarioSurface() {
  const active = currentScenario();
  document.documentElement.dataset.scenarioTone = active.tone;
  ui.scenarioSelect.value = active.id;
  ui.scenarioTone.className = `tone-${active.tone}`;
  ui.scenarioDescription.textContent = active.description;
  ui.scenarioOutcome.textContent = active.outcome;
  renderPath();
  savePreferences();
  updateEverything();
}

function pathIndicesFor(transitionId) {
  return currentScenario().transitionPath
    .map((id, index) => id === transitionId ? index : -1)
    .filter((index) => index >= 0);
}

function transitionHasCompleted(index) {
  return index < playback.pathIndex || (index === playback.pathIndex && playback.edgeProgress >= 0.62);
}

function countCompleted(transitionId) {
  return pathIndicesFor(transitionId).filter(transitionHasCompleted).length;
}

function updateReadouts() {
  const item = currentTransition();
  const projection = playback.edgeProgress < 0.55 ? item.before : item.after;
  ui.phaseReadout.textContent = projection.phase ?? stageFor(item.toStageId).phase;

  const noRun = item.id === "tr.execute.reject-source-drift" || (
    item.id === "tr.execute.create-run" && playback.edgeProgress < 0.55 && playback.pathIndex === 0
  );
  const revisionsCreated = countCompleted("tr.repair.create-scoped-revision") + countCompleted("tr.pause.approve-new-revision");
  const revision = noRun ? "—" : 1 + revisionsCreated;
  ui.revisionReadout.textContent = String(revision);
  ui.reviewReadout.textContent = noRun ? "—" : `#${String(1 + revisionsCreated)}`;

  let repairRounds = countCompleted("tr.review.request-repair");
  if (currentScenario().id === "repairLimit") {
    const resumedAt = currentScenario().transitionPath.indexOf("tr.pause.resume-repair-budget");
    repairRounds = playback.pathIndex < resumedAt || (playback.pathIndex === resumedAt && playback.edgeProgress < 0.55) ? 15 : 1;
  }
  ui.repairReadout.textContent = `${String(repairRounds)} / ${String(FLOW_META.repairRoundLimit)}`;
}

function updatePathState() {
  for (const button of ui.pathList.querySelectorAll("button[data-path-index]")) {
    const index = Number(button.dataset.pathIndex);
    const current = index === playback.pathIndex;
    button.classList.toggle("is-current", current);
    button.classList.toggle("is-complete", index < playback.pathIndex);
    button.classList.toggle("is-pending", index > playback.pathIndex);
    if (current) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  }
}

function updateBranchRailState() {
  const onPath = new Set(currentScenario().transitionPath);
  for (const button of ui.branchRail.querySelectorAll("button[data-transition-id]")) {
    const id = button.dataset.transitionId;
    button.classList.toggle("is-on-path", onPath.has(id));
    button.classList.toggle("is-selected", id === playback.selectedTransitionId);
  }
}

function updateGraphState() {
  if (playback.edgeVisuals.size === 0) return;
  const path = currentScenario().transitionPath;
  const onPathTransitions = new Set(path);
  const visitedStages = new Set();
  for (let index = 0; index < playback.pathIndex; index += 1) {
    const transitionItem = transitionsById.get(path[index]);
    if (transitionItem !== undefined) {
      visitedStages.add(transitionItem.fromStageId);
      visitedStages.add(transitionItem.toStageId);
    }
  }
  const active = currentTransition();
  const activeStageId = playback.edgeProgress < 0.52 ? active.fromStageId : active.toStageId;
  const onPathStages = new Set(path.flatMap((id) => {
    const item = transitionsById.get(id);
    return item === undefined ? [] : [item.fromStageId, item.toStageId];
  }));

  for (const node of ui.stageLayer.querySelectorAll("[data-stage-id]")) {
    const id = node.dataset.stageId;
    node.classList.toggle("is-on-path", onPathStages.has(id));
    node.classList.toggle("is-complete", visitedStages.has(id) && id !== activeStageId);
    node.classList.toggle("is-current", id === activeStageId);
    node.classList.toggle("is-selected", id === playback.selectedStageId);
  }

  for (const item of TRANSITIONS) {
    const visual = playback.edgeVisuals.get(item.id);
    if (visual === undefined) continue;
    const occurrences = pathIndicesFor(item.id);
    const activeEdge = item.id === active.id;
    const complete = occurrences.some((index) => index < playback.pathIndex);
    visual.group.classList.toggle("is-on-path", onPathTransitions.has(item.id));
    visual.group.classList.toggle("is-complete", complete);
    visual.group.classList.toggle("is-active", activeEdge);
    visual.group.classList.toggle("is-selected", item.id === playback.selectedTransitionId);
    if (activeEdge) {
      try {
        const length = visual.path.getTotalLength();
        const point = visual.path.getPointAtLength(length * clamp(playback.edgeProgress));
        visual.packet.setAttribute("cx", point.x.toFixed(2));
        visual.packet.setAttribute("cy", point.y.toFixed(2));
        visual.packet.setAttribute("opacity", "1");
      } catch {
        visual.packet.setAttribute("opacity", "0");
      }
    } else {
      visual.packet.setAttribute("opacity", "0");
    }
  }
}

function updateScrubber() {
  const progress = globalProgress();
  ui.flowScrubber.value = String(Math.round(progress * 1_000));
  ui.flowScrubber.style.setProperty("--flow-progress", String(progress));
  ui.flowProgress.textContent = `${String(Math.round(progress * 100))}%`;
  ui.progressStart.textContent = `STEP ${String(playback.pathIndex + 1).padStart(2, "0")} / ${String(currentScenario().transitionPath.length).padStart(2, "0")}`;
  ui.previousButton.disabled = playback.pathIndex === 0 && playback.edgeProgress < 0.1;
  ui.nextButton.disabled = !playback.loop && playback.pathIndex === currentScenario().transitionPath.length - 1 && playback.edgeProgress >= 1;
}

function followCurrentTransition(force = false) {
  if (!playback.playing && !force) return;
  const item = currentTransition();
  playback.selectedTransitionId = item.id;
  playback.selectedStageId = null;
  const key = `transition:${item.id}:${playback.pathIndex}`;
  if (force || playback.renderedSelectionKey !== key) renderTransitionSelection(item);
}

function updateEverything() {
  updateReadouts();
  updatePathState();
  updateBranchRailState();
  updateGraphState();
  updateScrubber();
}

function setPlaying(playing) {
  playback.playing = playing;
  ui.playButton.classList.toggle("is-playing", playing);
  ui.playIcon.textContent = playing ? "Ⅱ" : "▶";
  ui.playLabel.textContent = playing ? "暂停" : "播放";
  ui.playButton.setAttribute("aria-label", playing ? "暂停" : "播放");
  playback.lastFrameAt = performance.now();
  if (playing) followCurrentTransition(true);
}

function setPathPosition(index, progress, follow = true) {
  const length = currentScenario().transitionPath.length;
  playback.pathIndex = Math.max(0, Math.min(length - 1, index));
  playback.edgeProgress = clamp(progress);
  if (follow) {
    playback.selectedTransitionId = currentTransition().id;
    playback.selectedStageId = null;
    playback.renderedSelectionKey = "";
    renderTransitionSelection(currentTransition());
  }
  updateEverything();
}

function nextTransition(autoplay = playback.playing) {
  const length = currentScenario().transitionPath.length;
  if (playback.pathIndex < length - 1) {
    setPathPosition(playback.pathIndex + 1, 0, true);
    setPlaying(autoplay);
    return;
  }
  if (playback.loop) {
    setPathPosition(0, 0, true);
    setPlaying(autoplay);
    return;
  }
  playback.edgeProgress = 1;
  setPlaying(false);
  updateEverything();
}

function previousTransition() {
  setPlaying(false);
  if (playback.edgeProgress > 0.15) setPathPosition(playback.pathIndex, 0, true);
  else setPathPosition(playback.pathIndex - 1, 0, true);
}

function switchScenario(scenarioId, autoplay = false) {
  if (SCENARIOS[scenarioId] === undefined) return;
  playback.scenarioId = scenarioId;
  playback.pathIndex = 0;
  playback.edgeProgress = 0;
  playback.selectedTransitionId = currentTransition().id;
  playback.selectedStageId = null;
  playback.renderedSelectionKey = "";
  renderScenarioSurface();
  renderTransitionSelection(currentTransition());
  setPlaying(autoplay && !prefersReducedMotion.matches);
  updateEverything();
}

function seekGlobal(rawProgress) {
  setPlaying(false);
  const length = currentScenario().transitionPath.length;
  const scaled = clamp(rawProgress) * length;
  const index = Math.min(length - 1, Math.floor(scaled));
  const progress = scaled >= length ? 1 : scaled - index;
  setPathPosition(index, progress, true);
}

function animationFrame(now) {
  const delta = Math.min(100, Math.max(0, now - playback.lastFrameAt));
  playback.lastFrameAt = now;
  if (playback.playing) {
    const duration = currentTransition().durationMs;
    playback.edgeProgress += delta * playback.speed / duration;
    if (playback.edgeProgress >= 1 + EDGE_HOLD_MS / duration) {
      nextTransition(true);
    }
    followCurrentTransition();
    updateEverything();
  }
  playback.frameId = requestAnimationFrame(animationFrame);
}

function renderEvidence() {
  ui.toolGrid.innerHTML = PUBLIC_TOOLS.map((item, index) => `
    <article>
      <header><span>${String(index + 1).padStart(2, "0")}</span><b>${escapeHtml(item.role)}</b></header>
      <code>${escapeHtml(item.name)}</code>
      <p>${escapeHtml(item.description)}</p>
      <footer>${escapeHtml(item.direction)}</footer>
    </article>
  `).join("");
  ui.ownershipGrid.innerHTML = OWNERSHIP.map((item, index) => `
    <article><span>${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(item.object)}</strong><small>${escapeHtml(item.owner)}</small><p>${escapeHtml(item.rule)}</p></div></article>
  `).join("");
  ui.invariantList.innerHTML = INVARIANTS.map((item) => `<li><span aria-hidden="true">✓</span><p>${escapeHtml(item)}</p></li>`).join("");
}

function savePreferences() {
  try {
    localStorage.setItem("smartflow-complete-flow-preferences", JSON.stringify({
      scenarioId: playback.scenarioId,
      speed: playback.speed,
      loop: playback.loop
    }));
  } catch {
    // Storage is optional; deterministic defaults remain available.
  }
}

function restorePreferences() {
  try {
    const raw = localStorage.getItem("smartflow-complete-flow-preferences");
    if (raw === null) return;
    const saved = JSON.parse(raw);
    if (typeof saved.scenarioId === "string" && SCENARIOS[saved.scenarioId] !== undefined) {
      playback.scenarioId = saved.scenarioId;
    }
    if ([0.75, 1, 1.5, 2].includes(saved.speed)) playback.speed = saved.speed;
    if (typeof saved.loop === "boolean") playback.loop = saved.loop;
  } catch {
    // Ignore malformed or unavailable preferences.
  }
}

ui.scenarioSelect.addEventListener("change", () => switchScenario(ui.scenarioSelect.value, false));
ui.startRepairButton.addEventListener("click", () => {
  switchScenario("repair", true);
  required("#flow-map").scrollIntoView({ behavior: prefersReducedMotion.matches ? "auto" : "smooth", block: "start" });
});
ui.playButton.addEventListener("click", () => setPlaying(!playback.playing));
ui.previousButton.addEventListener("click", previousTransition);
ui.nextButton.addEventListener("click", () => {
  setPlaying(false);
  nextTransition(false);
});
ui.replayButton.addEventListener("click", () => {
  setPlaying(false);
  setPathPosition(playback.pathIndex, 0, true);
});
ui.flowScrubber.addEventListener("input", () => seekGlobal(Number(ui.flowScrubber.value) / 1_000));
ui.speedSelect.addEventListener("change", () => {
  playback.speed = Number(ui.speedSelect.value);
  savePreferences();
});
ui.loopToggle.addEventListener("change", () => {
  playback.loop = ui.loopToggle.checked;
  savePreferences();
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof window.HTMLElement && (
    target.isContentEditable || ["INPUT", "SELECT", "BUTTON", "SUMMARY", "A"].includes(target.tagName)
  )) return;
  if (event.code === "Space") {
    event.preventDefault();
    setPlaying(!playback.playing);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    setPlaying(false);
    nextTransition(false);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    previousTransition();
  }
});

prefersReducedMotion.addEventListener("change", (event) => {
  if (event.matches) setPlaying(false);
});

const resizeObserver = new ResizeObserver(() => requestAnimationFrame(drawEdges));
resizeObserver.observe(ui.graphViewport);
window.addEventListener("resize", () => requestAnimationFrame(drawEdges));
window.addEventListener("beforeunload", () => {
  cancelAnimationFrame(playback.frameId);
  resizeObserver.disconnect();
});

restorePreferences();
renderScenarioOptions();
renderGraphNodes();
renderBranchRail();
renderEvidence();
renderScenarioSurface();
renderTransitionSelection(currentTransition());
setPlaying(playback.playing);
requestAnimationFrame(drawEdges);
updateEverything();
playback.frameId = requestAnimationFrame(animationFrame);
