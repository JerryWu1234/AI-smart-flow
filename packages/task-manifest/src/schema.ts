import { z } from "zod";

const moduleIdSchema = z.string().regex(/^M\d{2}$/u);

const manifestTaskSchema = z
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
    projectId: z.string().min(1),
    jobId: z.string().min(1),
    canonicalTaskPath: z.string().min(1),
    taskSourceArtifact: z.object({
      relativePath: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      size: z.number().int().nonnegative()
    }).strict(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    allowNoChange: z.boolean(),
    providerRuntimeConfigHash: z.string().regex(/^[a-f0-9]{64}$/u),
    enabledTaskIds: z.array(z.string().regex(/^T\d{3,}$/u)),
    tasks: z.array(manifestTaskSchema).min(1),
    approval: z
      .object({
        kind: z.literal("USER"),
        approvedAt: z.iso.datetime({ offset: true }),
        authorizedCriterionIds: z.array(z.string().min(1))
      })
      .strict()
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.taskSourceArtifact.relativePath !== `runs/${manifest.jobId}/task-source.md`) {
      context.addIssue({
        code: "custom",
        path: ["taskSourceArtifact", "relativePath"],
        message: "task source Artifact path must be bound to jobId"
      });
    }
    if (manifest.taskSourceArtifact.sha256 !== manifest.sourceHash) {
      context.addIssue({
        code: "custom",
        path: ["taskSourceArtifact"],
        message: "task source Artifact must contain the exact approved source bytes"
      });
    }
  });

export type ManifestTask = z.infer<typeof manifestTaskSchema>;
export type TaskManifest = z.infer<typeof taskManifestSchema>;
