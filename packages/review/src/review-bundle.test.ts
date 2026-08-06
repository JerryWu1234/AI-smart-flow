import { createHash } from "node:crypto";

import { canonicalStringify, sha256Bytes, taskManifestSchema } from "@smartflow/task-manifest";
import type { Candidate } from "@smartflow/workspace";
import { describe, expect, it } from "vitest";

import { createReviewHostAction } from "./host-action.js";
import { createReviewBundle, verifyReviewBundle, type ReviewBundleInput } from "./review-bundle.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function input(): ReviewBundleInput {
  const newA = Buffer.from("new a", "utf8");
  const newB = Buffer.from("new b", "utf8");
  const manifest = taskManifestSchema.parse({
    schemaVersion: 3,
    projectId: "project-1",
    jobId: "job-1",
    runId: "job-1",
    revision: 2,
    revisionId: "job-1:revision-2",
    canonicalTaskPath: "/project/tasks.md",
    taskSourceArtifact: {
      relativePath: "runs/job-1/revision-1/task-source.md",
      sha256: "4".repeat(64),
      size: 100
    },
    sourceHash: "4".repeat(64),
    tasksSha256: "4".repeat(64),
    tasksHash: "5".repeat(64),
    allowNoChange: false,
    providerRuntimeConfigHash: "6".repeat(64),
    enabledTaskIds: ["T044"],
    tasks: [{
      id: "T044",
      module: "M13",
      parallel: false,
      description: "Update packages",
      filePaths: ["packages/a.ts", "packages/b.ts"],
      acceptanceCriteria: ["tests pass"]
    }],
    approval: {
      kind: "USER",
      approvedAt: "2026-07-20T00:00:00.000Z",
      parentRevision: null,
      authorizedCriterionIds: []
    }
  });
  const candidateBody: Pick<Candidate, "baselineHash" | "operations"> = {
    baselineHash: "9".repeat(64),
    operations: [
      {
        kind: "MODIFY",
        path: "packages/a.ts",
        oldEntry: { path: "packages/a.ts", kind: "FILE", sha256: "d".repeat(64), size: 5, mode: 0o644 },
        newEntry: { path: "packages/a.ts", kind: "FILE", sha256: digest(newA), size: newA.byteLength, mode: 0o644 }
      },
      {
        kind: "ADD",
        path: "packages/b.ts",
        newEntry: { path: "packages/b.ts", kind: "FILE", sha256: digest(newB), size: newB.byteLength, mode: 0o644 }
      }
    ]
  };
  const candidate: Candidate = {
    ...candidateBody,
    hash: digest(canonical(candidateBody))
  };
  const taskManifestHash = sha256Bytes(Buffer.from(canonicalStringify(manifest), "utf8"));
  return {
    revision: 2,
    taskManifest: manifest,
    taskManifestHash,
    baselineHash: candidate.baselineHash,
    candidate,
    candidateHash: candidate.hash,
    changedPathHashes: {
      "packages/a.ts": { operation: "MODIFY", oldHash: "d".repeat(64), newHash: digest(newA) },
      "packages/b.ts": { operation: "ADD", oldHash: null, newHash: digest(newB) }
    },
    pathEvidence: [
      {
        path: "packages/a.ts",
        operation: "MODIFY",
        oldHash: "d".repeat(64),
        newHash: digest(newA),
        diff: null,
        blob: newA.toString("base64")
      },
      {
        path: "packages/b.ts",
        operation: "ADD",
        oldHash: null,
        newHash: digest(newB),
        diff: null,
        blob: newB.toString("base64")
      }
    ],
    workerSummary: "Implemented both files",
    knownRisks: []
  };
}

describe("immutable ReviewBundle", () => {
  it("embeds every frozen artifact and creates a bound Review Action", () => {
    const bundle = createReviewBundle(input());
    expect(verifyReviewBundle(bundle)).toBe(true);
    expect(bundle.taskManifest.tasks[0]?.acceptanceCriteria).toEqual(["tests pass"]);
    expect(bundle.changedPaths.map((path) => path.path)).toEqual(["packages/a.ts", "packages/b.ts"]);
    const action = createReviewHostAction(
      bundle,
      { relativePath: "review/bundle.json", sha256: "3".repeat(64), size: 100 },
      new Date(Date.now() + 60_000).toISOString(),
      {
        taskSource: bundle.taskManifest.taskSourceArtifact,
        approvedSourceHash: bundle.taskManifest.sourceHash,
        piSessionId: "pi-session-1"
      }
    );
    expect(action).toMatchObject({
      type: "REVIEW",
      revision: 2,
      reviewBundleHash: bundle.bundleHash,
      reviewerSession: { mode: "CREATE" }
    });
  });

  it("fails closed for omitted paths, mismatched hashes, invalid revisions, and nested tampering", () => {
    const value = input();
    expect(() => createReviewBundle({ ...value, pathEvidence: value.pathEvidence.slice(0, 1) })).toThrow(
      /REVIEW_PATH_COVERAGE_INCOMPLETE/u
    );
    expect(() =>
      createReviewBundle({
        ...value,
        pathEvidence: value.pathEvidence.map((path) =>
          path.path === "packages/a.ts" ? { ...path, newHash: "0".repeat(64) } : path
        )
      })
    ).toThrow(/REVIEW_PATH_EVIDENCE_INVALID/u);
    expect(() => createReviewBundle({ ...value, revision: 0 })).toThrow(/REVIEW_REVISION_INVALID/u);
    const bundle = createReviewBundle(value);
    expect(verifyReviewBundle({ ...bundle, candidateHash: "0".repeat(64) })).toBe(false);
    expect(verifyReviewBundle({
      ...bundle,
      taskManifest: { ...bundle.taskManifest, revision: 3 }
    })).toBe(false);
    expect(verifyReviewBundle({
      ...bundle,
      changedPaths: bundle.changedPaths.map((path) =>
        path.path === "packages/a.ts" ? { ...path, newHash: "0".repeat(64) } : path
      )
    })).toBe(false);
  });
});
