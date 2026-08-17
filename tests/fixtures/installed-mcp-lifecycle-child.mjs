import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const smartflowBin = process.argv[2];
const projectRoot = process.argv[3];
const daemonRoot = process.argv[4];
if (smartflowBin === undefined || projectRoot === undefined || daemonRoot === undefined) {
  throw new Error("installed MCP lifecycle child requires bin, project, and daemon paths");
}

const MAX_REVIEW_CALLS = 3;
const TASKS_PATH = "tasks.md";

function asRecord(value, context) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} did not return an object`);
  }
  return value;
}

function asString(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} did not return a string`);
  }
  return value;
}

function asStringArray(value, context) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${context} did not return a string array`);
  }
  return value;
}

async function callMcp(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find((item) => item.type === "text" && typeof item.text === "string");
  if (result.isError === true || text === undefined) {
    throw new Error(`MCP ${name} failed: ${JSON.stringify(content)}`);
  }
  return asRecord(JSON.parse(text.text), name);
}

async function waitForPhase(client, scope, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let summary = await callMcp(client, "smartflow_status", scope);
  while (Date.now() < deadline) {
    const phase = String(summary.phase);
    if (expected.has(phase)) return summary;
    if (new Set(["PAUSED", "FAILED", "CANCELED"]).has(phase)) {
      throw new Error(`Installed lifecycle stopped in ${phase}: ${JSON.stringify(summary)}`);
    }
    await new Promise((settle) => setTimeout(settle, 250));
    summary = await callMcp(client, "smartflow_status", scope);
  }
  throw new Error(`Installed lifecycle did not reach ${[...expected].join("/")}`);
}

async function executeAndCancelSecondary(client, primaryScope) {
  const secondTasks = await readFile(`${projectRoot}/tasks-b.md`);
  const secondExecute = await callMcp(client, "smartflow_execute", {
    projectRoot,
    tasksPath: "tasks-b.md",
    approvedSourceHash: createHash("sha256").update(secondTasks).digest("hex"),
    requestId: `execute-secondary-${randomUUID()}`
  });
  const secondScope = {
    projectId: String(secondExecute.projectId),
    jobId: String(secondExecute.jobId)
  };
  if (secondScope.jobId === primaryScope.jobId) {
    throw new Error("Secondary execute reused the primary job");
  }
  let secondCancel;
  for (let attempt = 0; attempt < 5 && secondCancel === undefined; attempt += 1) {
    const secondStatus = await callMcp(client, "smartflow_status", secondScope);
    try {
      secondCancel = await callMcp(client, "smartflow_cancel", {
        ...secondScope,
        expectedRevision: Number(secondStatus.revision),
        expectedStateVersion: Number(secondStatus.stateVersion),
        requestId: `cancel-secondary-${randomUUID()}`,
        reason: "installed multi-run isolation check complete"
      });
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
  if (secondCancel === undefined) throw new Error("Secondary cancel was not accepted");
  const secondCanceled = await waitForPhase(
    client,
    secondScope,
    new Set(["CANCELED"]),
    120_000
  );
  return { secondExecute, secondCanceled };
}

const transport = new StdioClientTransport({
  command: smartflowBin,
  args: ["mcp", "--data-dir", daemonRoot],
  cwd: projectRoot,
  env: Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string")
  ),
  stderr: "pipe"
});
let gatewayStderr = "";
transport.stderr?.on("data", (chunk) => {
  gatewayStderr += chunk.toString();
});
const client = new Client({ name: "smartflow-installed-e2e", version: "1.0.0" });
let stage = "connect";
try {
  await client.connect(transport);
  const publicToolNames = (await client.listTools()).tools
    .map((tool) => tool.name)
    .sort();

  const tasks = await readFile(resolve(projectRoot, TASKS_PATH));
  const approvedSourceHash = createHash("sha256").update(tasks).digest("hex");
  const workflowToolNames = [];
  const reviewerModes = [];
  const reviewChangedPaths = [];
  let reviewCalls = 0;
  let secondExecute;
  let secondCanceled;
  let repairMarker;
  let reviewerSessionId;
  let workflowRevision;

  stage = "execute";
  workflowToolNames.push("smartflow_execute");
  const execute = await callMcp(client, "smartflow_execute", {
    projectRoot,
    tasksPath: TASKS_PATH,
    approvedSourceHash,
    requestId: `execute-approved-${randomUUID()}`,
    expectedStateVersion: 0
  });
  const scope = {
    projectId: asString(execute.projectId, "smartflow_execute projectId"),
    jobId: asString(execute.jobId, "smartflow_execute jobId")
  };
  if (typeof execute.revision !== "number" || !Number.isInteger(execute.revision)) {
    throw new Error("smartflow_execute omitted its revision");
  }
  workflowRevision = execute.revision;

  stage = "review-turn-loop";
  const hostTurnId = `host-turn-${randomUUID()}`;
  let sequence = 0;
  let continuation = {};
  let result;
  while (result === undefined) {
    sequence += 1;
    workflowToolNames.push("smartflow_review_turn");
    const turn = await callMcp(client, "smartflow_review_turn", {
      requestId: `review-turn-${String(sequence)}-${randomUUID()}`,
      ...scope,
      hostTurnId,
      ...continuation
    });
    continuation = {};
    if (typeof turn.revision === "number" && Number.isInteger(turn.revision)) {
      workflowRevision = Math.max(workflowRevision, turn.revision);
    }

    if (turn.kind === "NOT_READY") {
      const retryAfterMs = Number(turn.retryAfterMs);
      if (!Number.isInteger(retryAfterMs) || retryAfterMs < 1) {
        throw new Error("smartflow_review_turn returned an invalid retryAfterMs");
      }
      await new Promise((settle) => setTimeout(settle, retryAfterMs));
      continue;
    }
    if (turn.kind === "DONE") {
      result = asRecord(turn.result, "smartflow_review_turn DONE result");
      break;
    }
    if (turn.kind !== "REVIEW_REQUIRED") {
      throw new Error(`Installed lifecycle requires unexpected Host input: ${JSON.stringify(turn)}`);
    }

    reviewCalls += 1;
    if (reviewCalls > MAX_REVIEW_CALLS) {
      throw new Error(`Installed Reviewer exceeded ${String(MAX_REVIEW_CALLS)} calls`);
    }

    const reviewerSession = asRecord(turn.reviewerSession, "Reviewer session request");
    const reviewerMode = asString(reviewerSession.mode, "Reviewer session mode");
    const piSessionId = asString(turn.piSessionId, "Pi session ID");
    if (reviewerMode === "CREATE") {
      if (reviewCalls !== 1 || reviewerSessionId !== undefined) {
        throw new Error("Installed Reviewer received CREATE after its first turn");
      }
      reviewerSessionId = `reviewer-${randomUUID()}`;
      if (reviewerSessionId === piSessionId) {
        throw new Error("Installed Reviewer session matched the Pi worker session");
      }
    } else if (reviewerMode === "RESUME") {
      if (
        reviewerSessionId === undefined ||
        reviewerSession.reviewerSessionId !== reviewerSessionId
      ) {
        throw new Error("Installed Reviewer did not RESUME its original session");
      }
    } else {
      throw new Error(`Installed Reviewer received unsupported mode ${reviewerMode}`);
    }
    reviewerModes.push({ mode: reviewerMode, reviewerSessionId });

    const worktreePath = asString(turn.worktreePath, "Reviewer worktree path");
    const tasksSource = await readFile(resolve(worktreePath, TASKS_PATH));
    const observedHash = createHash("sha256").update(tasksSource).digest("hex");
    if (observedHash !== turn.taskSourceHash) {
      throw new Error("HOST_REVIEW_TASKS_SOURCE_DRIFT");
    }
    const enabledTaskIds = [...new Set(
      [...tasksSource.toString("utf8").matchAll(/^\s*-\s+\[\s\]\s+(T\d{3,})\b/gmu)]
        .map((match) => match[1])
    )];
    if (!enabledTaskIds.includes("T057")) {
      throw new Error(`Installed Reviewer could not find T057: ${JSON.stringify(enabledTaskIds)}`);
    }

    const changedPaths = asStringArray(turn.changedPaths, "Reviewer changed paths");
    reviewChangedPaths.push([...changedPaths]);
    let sumSource;
    for (const changedPath of changedPaths) {
      const source = await readFile(resolve(worktreePath, changedPath), "utf8");
      if (changedPath.replaceAll("\\", "/") === "sum.js") sumSource = source;
    }
    if (sumSource === undefined) {
      throw new Error(`Installed Reviewer did not receive sum.js: ${JSON.stringify(changedPaths)}`);
    }

    if (reviewCalls === 1) {
      const reviewAttemptId = asString(turn.reviewAttemptId, "Review attempt ID");
      repairMarker = `// SMARTFLOW_DYNAMIC_REPAIR_${createHash("sha256")
        .update(reviewAttemptId)
        .digest("hex")
        .slice(0, 20)}`;
      if (sumSource.includes(repairMarker)) {
        throw new Error("Dynamic repair marker existed before the Reviewer created it");
      }
      const secondary = await executeAndCancelSecondary(client, scope);
      secondExecute = secondary.secondExecute;
      secondCanceled = secondary.secondCanceled;
    }
    if (repairMarker === undefined || reviewerSessionId === undefined) {
      throw new Error("Installed Reviewer state was not initialized");
    }

    const markerPresent = sumSource.includes(repairMarker);
    if (!markerPresent && reviewCalls >= MAX_REVIEW_CALLS) {
      throw new Error("Installed automatic repair did not add the dynamic marker in time");
    }
    const reason = `The authorized dynamic repair marker is missing from sum.js: ${repairMarker}`;
    const suggestion = `Add this exact standalone comment to sum.js: ${repairMarker}`;
    const completionPercentage = markerPresent ? 100 : 50;
    continuation = {
      turnToken: asString(turn.turnToken, "Review turn token"),
      review: {
        reviewerSessionId,
        result: {
          completionPercentage,
          tasks: enabledTaskIds.map((id) => markerPresent
            ? { id, completionPercentage: 100 }
            : { id, completionPercentage: 50, reason, suggestion })
        }
      }
    };
  }

  if (
    secondExecute === undefined ||
    secondCanceled === undefined ||
    repairMarker === undefined ||
    workflowRevision === undefined
  ) {
    throw new Error("Installed MCP workflow omitted required lifecycle evidence");
  }
  if (result.phase !== "COMPLETED" || result.status !== "COMMITTED") {
    throw new Error(`Installed MCP workflow failed closed: ${JSON.stringify(result)}`);
  }
  if (workflowRevision < 2 || reviewCalls < 2) {
    throw new Error("Installed MCP workflow did not perform an automatic repair review");
  }

  process.stdout.write(`${JSON.stringify({
    publicToolNames,
    scope,
    secondExecute,
    secondCanceled,
    result: { ...result, revision: workflowRevision },
    workflowToolNames,
    reviewerModes,
    reviewChangedPaths,
    repairMarker,
    reviewCalls
  })}\n`);
} catch (error) {
  throw new Error(
    `Installed MCP child failed at ${stage}; gateway stderr=${gatewayStderr || "<empty>"}`,
    { cause: error }
  );
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
}
