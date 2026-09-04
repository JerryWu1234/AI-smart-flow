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
  const secondCancel = await callMcp(client, "smartflow_cancel", {
    ...secondScope,
    requestId: `cancel-secondary-${randomUUID()}`,
    reason: "installed multi-run isolation check complete"
  });
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

  stage = "execute";
  workflowToolNames.push("smartflow_execute");
  const execute = await callMcp(client, "smartflow_execute", {
    projectRoot,
    tasksPath: TASKS_PATH,
    approvedSourceHash,
    requestId: `execute-approved-${randomUUID()}`
  });
  const scope = {
    projectId: asString(execute.projectId, "smartflow_execute projectId"),
    jobId: asString(execute.jobId, "smartflow_execute jobId")
  };
  if (
    typeof execute.stateVersion !== "number" ||
    !Number.isInteger(execute.stateVersion) ||
    execute.stateVersion < 0
  ) {
    throw new Error("smartflow_execute omitted its stateVersion");
  }
  if (execute.phase !== "PREPARING") {
    throw new Error(`smartflow_execute returned unexpected phase ${String(execute.phase)}`);
  }
  if (Object.hasOwn(execute, "revision")) {
    throw new Error("smartflow_execute leaked removed revision state");
  }

  stage = "secondary-run";
  const secondary = await executeAndCancelSecondary(client, scope);

  stage = "review-turn-loop";
  const hostTurnId = `host-turn-${randomUUID()}`;
  let sequence = 0;
  let result;
  while (result === undefined) {
    sequence += 1;
    workflowToolNames.push("smartflow_review_turn");
    const turn = await callMcp(client, "smartflow_review_turn", {
      requestId: `review-turn-${String(sequence)}-${randomUUID()}`,
      ...scope,
      hostTurnId
    });

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
    throw new Error(`Installed lifecycle requires unexpected Host input: ${JSON.stringify(turn)}`);
  }

  if (result.phase !== "COMPLETED" || result.status !== "COMMITTED") {
    throw new Error(`Installed MCP workflow failed closed: ${JSON.stringify(result)}`);
  }

  process.stdout.write(`${JSON.stringify({
    publicToolNames,
    scope,
    secondExecute: secondary.secondExecute,
    secondCanceled: secondary.secondCanceled,
    result,
    workflowToolNames
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
