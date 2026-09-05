import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { approvedSourceMatches } from "../../../../apps/daemon/src/worker/approved-source.js";
import { createProjectState, createRunRecord } from "../../../fixtures/state-store/test-fixture.js";

it("requires the exact approved task bytes and accepts their restoration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smartflow-approved-source-"));
  try {
    const path = join(directory, "tasks.md");
    const source = "Implement the approved task\n";
    const run = createRunRecord({
      approvedTasks: { path, sourceHash: createHash("sha256").update(source).digest("hex") }
    });
    const state = createProjectState({ runs: { [run.jobId]: run } });

    await writeFile(path, source);
    expect(await approvedSourceMatches(state, run.jobId)).toBe(true);
    await writeFile(path, "Implement a different task\n");
    expect(await approvedSourceMatches(state, run.jobId)).toBe(false);
    await writeFile(path, source);
    expect(await approvedSourceMatches(state, run.jobId)).toBe(true);
    await rm(path);
    expect(await approvedSourceMatches(state, run.jobId)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
