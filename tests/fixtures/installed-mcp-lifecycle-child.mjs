import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const smartflowBin = process.argv[2];
const projectRoot = process.argv[3];
const daemonRoot = process.argv[4];
if (smartflowBin === undefined || projectRoot === undefined || daemonRoot === undefined) {
  throw new Error("installed MCP lifecycle child requires bin, project, and daemon paths");
}

const TASKS_SOURCE_PATH = "tasks.md";

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

async function executeAndCancelSecondary(client, primaryScope, sessionTasksPath) {
  const secondTasks = await readFile(resolve(projectRoot, "tasks-b.md"));
  await writeFile(resolve(projectRoot, sessionTasksPath), secondTasks);
  const secondExecute = await callMcp(client, "smartflow_execute", {});
  const secondScope = {
    projectId: String(secondExecute.projectId),
    jobId: String(secondExecute.jobId)
  };
  if (secondScope.jobId === primaryScope.jobId) {
    throw new Error("Secondary execute reused the primary job");
  }
  await callMcp(client, "smartflow_cancel", {
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
  const instructions = client.getInstructions();
  if (typeof instructions !== "string") {
    throw new Error("Installed MCP server omitted session instructions");
  }
  const sessionTasksPath = instructions.match(
    /\.smartflow\/tasks\/[0-9a-f-]+\/tasks\.md/u
  )?.[0];
  if (sessionTasksPath === undefined) {
    throw new Error("Installed MCP instructions omitted the session task path");
  }
  const sessionTasksAbsolutePath = resolve(projectRoot, sessionTasksPath);
  await mkdir(dirname(sessionTasksAbsolutePath), { recursive: true });
  await writeFile(
    sessionTasksAbsolutePath,
    await readFile(resolve(projectRoot, TASKS_SOURCE_PATH))
  );

  const publicTools = (await client.listTools()).tools;
  const publicToolNames = publicTools.map((tool) => tool.name).sort();
  const executeTool = publicTools.find((tool) => tool.name === "smartflow_execute");
  if (executeTool === undefined) throw new Error("Installed MCP server omitted smartflow_execute");
  const executeSchema = asRecord(executeTool.inputSchema, "smartflow_execute input schema");
  const executeInputPropertyNames = executeSchema.properties === undefined
    ? []
    : Object.keys(asRecord(executeSchema.properties, "smartflow_execute input properties"));
  if (executeInputPropertyNames.length !== 0) {
    throw new Error(`smartflow_execute exposed inputs: ${executeInputPropertyNames.join(",")}`);
  }
  const workflowToolNames = [];

  stage = "execute";
  workflowToolNames.push("smartflow_execute");
  const execute = await callMcp(client, "smartflow_execute", {});
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

  stage = "secondary-run";
  const secondary = await executeAndCancelSecondary(client, scope, sessionTasksPath);

  process.stdout.write(`${JSON.stringify({
    publicToolNames,
    executeInputPropertyNames,
    sessionTasksPath,
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
