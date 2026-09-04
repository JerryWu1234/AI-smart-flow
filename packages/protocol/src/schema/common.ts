import { z } from "zod";

export const identifierSchema = z.string().trim().min(1).max(256);
export const nonNegativeIntegerSchema = z.number().int().nonnegative();
export const positiveIntegerSchema = z.number().int().positive();
export const sha256Schema = z
  .string()
  .regex(/^(?:sha256:)?[a-f0-9]{64}$/u, "expected a SHA-256 digest");
export const bareSha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "expected an unprefixed SHA-256 digest");
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

export const artifactRefSchema = z
  .object({
    relativePath: z.string().min(1).refine(
      (value) =>
        !value.startsWith("/") &&
        !value.includes("\\") &&
        !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
      "expected a safe relative POSIX artifact path"
    ),
    sha256: sha256Schema,
    size: nonNegativeIntegerSchema
  })
  .strict();

export const structuredErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    stage: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    nextActions: z.array(z.string().min(1)),
    artifacts: z.array(artifactRefSchema)
  })
  .strict();

export const canonicalValueSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(canonicalValueSchema),
    z.record(z.string(), canonicalValueSchema)
  ])
);

export const idempotentReceiptSchema = z
  .object({
    requestId: identifierSchema,
    requestHash: sha256Schema,
    response: canonicalValueSchema,
    committedAtStateVersion: nonNegativeIntegerSchema
  })
  .strict();

export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export function artifactRefsEqual(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.relativePath === right.relativePath &&
    left.sha256 === right.sha256 &&
    left.size === right.size;
}
