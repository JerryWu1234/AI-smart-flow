import { z } from "zod";

const moduleIdSchema = z.string().regex(/^M\d{2}$/u);

export const manifestTaskSchema = z
  .object({
    id: z.string().regex(/^T\d{3,}$/u),
    module: moduleIdSchema,
    parallel: z.boolean(),
    description: z.string().min(1),
    filePaths: z.array(z.string().min(1)).min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1)
  })
  .strict();

export const taskManifestSchema = z
  .object({
    schemaVersion: z.literal(3),
    projectId: z.string().min(1),
    jobId: z.string().min(1),
    runId: z.string().min(1),
    revision: z.number().int().positive(),
    revisionId: z.string().min(1),
    canonicalTaskPath: z.string().min(1),
    taskSourceArtifact: z.object({
      relativePath: z.string().regex(/^runs\/[^/]+\/revision-\d+\/task-source\.md$/u),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      size: z.number().int().nonnegative()
    }).strict(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    tasksSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    tasksHash: z.string().regex(/^[a-f0-9]{64}$/u),
    allowNoChange: z.boolean(),
    providerRuntimeConfigHash: z.string().regex(/^[a-f0-9]{64}$/u),
    enabledTaskIds: z.array(z.string().regex(/^T\d{3,}$/u)),
    tasks: z.array(manifestTaskSchema).min(1),
    approval: z
      .object({
        kind: z.enum(["USER", "LEADER_REPAIR"]),
        approvedAt: z.iso.datetime({ offset: true }),
        parentRevision: z.number().int().positive().nullable(),
        authorizedCriterionIds: z.array(z.string().min(1))
      })
      .strict()
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      manifest.runId !== manifest.jobId ||
      manifest.revisionId !== `${manifest.runId}:revision-${String(manifest.revision)}`
    ) {
      context.addIssue({
        code: "custom",
        path: ["revisionId"],
        message: "runId/revisionId must bind the current Run Revision"
      });
    }
    if (
      manifest.taskSourceArtifact.sha256 !== manifest.sourceHash ||
      manifest.tasksSha256 !== manifest.sourceHash
    ) {
      context.addIssue({
        code: "custom",
        path: ["taskSourceArtifact"],
        message: "task source Artifact must contain the exact approved source bytes"
      });
    }
  });

export type ManifestTask = z.infer<typeof manifestTaskSchema>;
export type TaskManifest = z.infer<typeof taskManifestSchema>;
