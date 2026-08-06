import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const smartflowBin = process.argv[2];
const projectRoot = process.argv[3];
const daemonRoot = process.argv[4];
const hostSkillEntry = process.argv[5];
if (
  smartflowBin === undefined ||
  projectRoot === undefined ||
  daemonRoot === undefined ||
  hostSkillEntry === undefined
) {
  throw new Error("installed MCP lifecycle child requires bin, project, daemon, and Host Skill paths");
}

function asRecord(value, context) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} did not return an object`);
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

async function waitForPhase(client, scope, afterStateVersion, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const firstWait = await callMcp(client, "smartflow_wait", {
    ...scope,
    afterStateVersion,
    timeoutMs: Math.min(5_000, timeoutMs)
  });
  let summary = asRecord(firstWait.summary, "smartflow_wait.summary");
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
  stage = "execute";
  const tasks = await readFile(`${projectRoot}/tasks.md`);
  const execute = await callMcp(client, "smartflow_execute", {
    projectRoot,
    tasksPath: "tasks.md",
    approvedSourceHash: createHash("sha256").update(tasks).digest("hex"),
    requestId: `execute-${randomUUID()}`,
    expectedStateVersion: 0
  });
  await writeFile(`${projectRoot}/tasks.md`, "# Modified after execute\n", "utf8");
  const scope = { projectId: String(execute.projectId), jobId: String(execute.jobId) };
  stage = "wait-review";
  await waitForPhase(
    client,
    scope,
    Number(execute.stateVersion),
    new Set(["REVIEW_PENDING"]),
    300_000
  );
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
    Number(secondCancel.stateVersion),
    new Set(["CANCELED"]),
    120_000
  );
  const reviewPending = await callMcp(client, "smartflow_status", scope);
  if (reviewPending.phase !== "REVIEW_PENDING") {
    throw new Error(`Primary review changed during secondary cancellation: ${JSON.stringify(reviewPending)}`);
  }
  stage = "host-review";
  const { HostActionLoop } = await import(
    pathToFileURL(hostSkillEntry).href
  );
  const review = asRecord(await new HostActionLoop(
    { call: (name, args) => callMcp(client, name, args) },
    {
      review: async (context) => {
        const projectDataRoot = resolve(daemonRoot, "projects", scope.projectId);
        const tasksSource = await readFile(
          resolve(projectDataRoot, context.taskSource.relativePath)
        );
        const observedHash = createHash("sha256").update(tasksSource).digest("hex");
        if (observedHash !== context.approvedSourceHash) {
          throw new Error("HOST_REVIEW_TASKS_SOURCE_DRIFT");
        }
        const reviewBundle = asRecord(
          JSON.parse(await readFile(
            resolve(projectDataRoot, context.reviewBundle.relativePath),
            "utf8"
          )),
          "review bundle"
        );
        const evidence = Array.isArray(reviewBundle.changedPaths)
          ? reviewBundle.changedPaths.map((item) => asRecord(item, "changed path evidence"))
          : [];
        for (const path of context.changedPaths) {
          const item = evidence.find((candidate) => candidate.path === path);
          if (item === undefined || (item.blob === null && item.diff === null)) {
            throw new Error(`HOST_REVIEW_EVIDENCE_MISSING:${path}`);
          }
        }
        return {
          reviewerSessionId: context.reviewerSession.mode === "RESUME"
            ? context.reviewerSession.reviewerSessionId
            : `reviewer-${randomUUID()}`,
          result: {
            verdict: "APPROVE",
            completionPercentage: 100,
            convergeFindings: [],
            adversarialFindings: [],
            pathCoverage: Object.fromEntries(
              context.changedPaths.map((path) => [path, "FULL"])
            ),
            residualRisks: []
          }
        };
      }
    }
  ).pollOnce({
    ...scope,
    expectedRevision: Number(reviewPending.revision),
    expectedStateVersion: Number(reviewPending.stateVersion),
    hostTurnId: `host-turn-${randomUUID()}`,
    requestId: `host-review-${randomUUID()}`
  }), "HostActionLoop review result");
  if (typeof review.reviewHash !== "string") {
    const reviewStatus = await callMcp(client, "smartflow_status", scope);
    throw new Error(
      `Installed Host review did not produce a reviewHash; review=${JSON.stringify(review)} status=${JSON.stringify(reviewStatus)}`
    );
  }
  stage = "leader-decision";
  const leader = await callMcp(client, "smartflow_submit_leader_decision", {
    ...scope,
    reviewHash: review.reviewHash,
    decision: "accept",
    reason: "Installed E2E accepted the Review result",
    requestId: `leader-${randomUUID()}`,
    expectedRevision: Number(review.revision),
    expectedStateVersion: Number(review.stateVersion)
  });
  stage = "wait-published";
  await waitForPhase(
    client,
    scope,
    Number(leader.stateVersion),
    new Set(["COMPLETED"]),
    120_000
  );
  stage = "result";
  const result = await callMcp(client, "smartflow_result", scope);
  process.stdout.write(`${JSON.stringify({
    scope,
    execute,
    reviewPending,
    secondExecute,
    secondCanceled,
    result
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
