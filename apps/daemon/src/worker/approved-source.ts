import { constants } from "node:fs";
import { open } from "node:fs/promises";

import type { ProjectState } from "@smartflow/state-store";
import { sha256Bytes } from "@smartflow/task-manifest";

export interface ApprovedSourceObservation {
  approvedHash: string | undefined;
  observedHash: string;
  matches: boolean;
}

export async function observeApprovedSource(
  state: ProjectState,
  jobId: string
): Promise<ApprovedSourceObservation> {
  const run = state.runs[jobId];
  const path = typeof run?.approvedTasks?.path === "string" ? run.approvedTasks.path : undefined;
  const approvedHash = typeof run?.approvedTasks?.sourceHash === "string"
    ? run.approvedTasks.sourceHash
    : undefined;
  if (path === undefined || approvedHash === undefined) {
    return { approvedHash, observedHash: "UNAVAILABLE", matches: false };
  }
  try {
    const bytes = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).then(
      async (handle) => {
        try {
          const metadata = await handle.stat();
          if (!metadata.isFile()) throw new Error("TASK_SOURCE_NOT_REGULAR");
          return await handle.readFile();
        } finally {
          await handle.close();
        }
      }
    );
    const observedHash = sha256Bytes(bytes);
    return { approvedHash, observedHash, matches: observedHash === approvedHash };
  } catch {
    return { approvedHash, observedHash: "UNAVAILABLE", matches: false };
  }
}
