import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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

const MAX_REVIEW_CALLS = 3;

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
    Number(secondCancel.stateVersion),
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
  stage = "import-host-skill";
  const { approveTasksSource, executeApprovedWorkflow } = await import(
    pathToFileURL(hostSkillEntry).href
  );
  if (
    typeof approveTasksSource !== "function" ||
    typeof executeApprovedWorkflow !== "function"
  ) {
    throw new Error("Installed Host Skill omitted approved workflow exports");
  }

  const tasks = await readFile(`${projectRoot}/tasks.md`);
  const approval = approveTasksSource("tasks.md", tasks);
  const workflowToolNames = [];
  const reviewerModes = [];
  const reviewChangedPaths = [];
  let reviewCalls = 0;
  let scope;
  let secondExecute;
  let secondCanceled;
  let repairMarker;
  let reviewerSessionId;
  let workflowRevision;

  const workflowGateway = {
    call: async (name, args) => {
      const expectedName = workflowToolNames.length === 0
        ? "smartflow_execute"
        : "smartflow_review_turn";
      if (name !== expectedName) {
        throw new Error(`Installed workflow called unexpected tool ${name}; expected ${expectedName}`);
      }
      workflowToolNames.push(name);
      const response = await callMcp(client, name, args);
      if (typeof response.revision === "number" && Number.isInteger(response.revision)) {
        workflowRevision = Math.max(workflowRevision ?? 0, response.revision);
      }
      if (name === "smartflow_execute") {
        scope = {
          projectId: String(response.projectId),
          jobId: String(response.jobId)
        };
      }
      return response;
    }
  };

  stage = "approved-workflow";
  const result = await executeApprovedWorkflow(
    workflowGateway,
    {
      review: async (context) => {
        reviewCalls += 1;
        if (reviewCalls > MAX_REVIEW_CALLS) {
          throw new Error(`Installed Reviewer exceeded ${String(MAX_REVIEW_CALLS)} calls`);
        }

        if (context.reviewerSession.mode === "CREATE") {
          if (reviewCalls !== 1 || reviewerSessionId !== undefined) {
            throw new Error("Installed Reviewer received CREATE after its first turn");
          }
          reviewerSessionId = `reviewer-${randomUUID()}`;
          if (reviewerSessionId === context.piSessionId) {
            throw new Error("Installed Reviewer session matched the Pi worker session");
          }
        } else {
          if (
            reviewerSessionId === undefined ||
            context.reviewerSession.reviewerSessionId !== reviewerSessionId
          ) {
            throw new Error("Installed Reviewer did not RESUME its original session");
          }
        }
        reviewerModes.push({
          mode: context.reviewerSession.mode,
          reviewerSessionId
        });

        const tasksSource = await readFile(resolve(context.worktreePath, approval.tasksPath));
        const observedHash = createHash("sha256").update(tasksSource).digest("hex");
        if (observedHash !== context.taskSourceHash) {
          throw new Error("HOST_REVIEW_TASKS_SOURCE_DRIFT");
        }
        const enabledTaskIds = [...new Set(
          [...tasksSource.toString("utf8").matchAll(/^\s*-\s+\[\s\]\s+(T\d{3,})\b/gmu)]
            .map((match) => match[1])
        )];
        if (!enabledTaskIds.includes("T057")) {
          throw new Error(`Installed Reviewer could not find T057: ${JSON.stringify(enabledTaskIds)}`);
        }

        const changedPaths = [...context.changedPaths];
        reviewChangedPaths.push(changedPaths);
        let sumSource;
        for (const changedPath of changedPaths) {
          const source = await readFile(resolve(context.worktreePath, changedPath), "utf8");
          if (changedPath.replaceAll("\\", "/") === "sum.js") sumSource = source;
        }
        if (sumSource === undefined) {
          throw new Error(`Installed Reviewer did not receive sum.js: ${JSON.stringify(changedPaths)}`);
        }

        if (reviewCalls === 1) {
          repairMarker = `// SMARTFLOW_DYNAMIC_REPAIR_${createHash("sha256")
            .update(context.reviewAttemptId)
            .digest("hex")
            .slice(0, 20)}`;
          if (sumSource.includes(repairMarker)) {
            throw new Error("Dynamic repair marker existed before the Reviewer created it");
          }
          if (scope === undefined) throw new Error("Primary execute scope was not captured");
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
        return {
          reviewerSessionId,
          completionPercentage: markerPresent ? 100 : 50,
          tasks: enabledTaskIds.map((id) => markerPresent
            ? { id, completionPercentage: 100 }
            : { id, completionPercentage: 50, reason, suggestion })
        };
      }
    },
    {
      projectRoot,
      approval,
      requestId: `execute-approved-${randomUUID()}`,
      hostTurnId: `host-turn-${randomUUID()}`,
      expectedStateVersion: 0
    }
  );

  if (
    scope === undefined ||
    secondExecute === undefined ||
    secondCanceled === undefined ||
    repairMarker === undefined ||
    workflowRevision === undefined
  ) {
    throw new Error("Installed approved workflow omitted required lifecycle evidence");
  }
  if (result.phase !== "COMPLETED" || result.status !== "COMMITTED") {
    throw new Error(`Installed approved workflow failed closed: ${JSON.stringify(result)}`);
  }
  if (workflowRevision < 2 || reviewCalls < 2) {
    throw new Error("Installed approved workflow did not perform an automatic repair review");
  }

  process.stdout.write(`${JSON.stringify({
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
