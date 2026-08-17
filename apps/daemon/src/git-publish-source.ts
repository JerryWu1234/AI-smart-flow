import type { ArtifactRef } from "@smartflow/protocol";
import type { ApplyOperation } from "@smartflow/publish";
import {
  readGitBlob,
  type Candidate,
  type GitSnapshotEntry,
  type GitWorkspaceSnapshot
} from "@smartflow/workspace";

const gitBlobPathPattern = /^git-object-store\/blobs\/([a-f0-9]{40,64})$/u;

function fileMode(entry: GitSnapshotEntry): number {
  if (entry.kind !== "FILE" || entry.mode === "120000") {
    throw new Error(`PUBLISH_SYMLINK_OPERATION_UNSUPPORTED: ${entry.path}`);
  }
  return entry.mode === "100755" ? 0o755 : 0o644;
}

export function gitPublishOperations(
  candidate: Candidate,
  resultSnapshot: GitWorkspaceSnapshot
): ApplyOperation[] {
  if (
    (candidate.schemaVersion !== 2 && candidate.schemaVersion !== 3) ||
    candidate.resultSnapshotHash !== resultSnapshot.snapshotHash ||
    candidate.revision !== resultSnapshot.revision ||
    resultSnapshot.snapshotKind !== "REVISION_RESULT"
  ) {
    throw new Error("PUBLISH_GIT_SOURCE_BINDING_INVALID");
  }
  const resultEntries = new Map(resultSnapshot.entries.map((entry) => [entry.path, entry]));
  return candidate.operations.map((candidateOperation) => {
    const oldEntry = "oldEntry" in candidateOperation ? candidateOperation.oldEntry : undefined;
    const newEntry = "newEntry" in candidateOperation ? candidateOperation.newEntry : undefined;
    if (oldEntry?.kind === "SYMLINK" || newEntry?.kind === "SYMLINK") {
      throw new Error(`PUBLISH_SYMLINK_OPERATION_UNSUPPORTED: ${candidateOperation.path}`);
    }
    let blobRef: ArtifactRef | null = null;
    if (newEntry !== undefined) {
      const snapshotEntry = resultEntries.get(candidateOperation.path);
      if (
        snapshotEntry === undefined ||
        snapshotEntry.path !== newEntry.path ||
        snapshotEntry.kind !== "FILE" ||
        snapshotEntry.sha256 !== newEntry.sha256 ||
        snapshotEntry.size !== newEntry.size ||
        fileMode(snapshotEntry) !== newEntry.mode
      ) {
        throw new Error(`PUBLISH_GIT_BLOB_BINDING_INVALID: ${candidateOperation.path}`);
      }
      blobRef = {
        relativePath: `git-object-store/blobs/${snapshotEntry.blobId}`,
        sha256: snapshotEntry.sha256,
        size: snapshotEntry.size
      };
    }
    return {
      path: candidateOperation.path,
      type: candidateOperation.kind,
      expectedOldKind: oldEntry === undefined ? "ABSENT" : "FILE",
      expectedOldHash: oldEntry?.sha256 ?? null,
      expectedOldMode: oldEntry?.mode ?? null,
      newHash: newEntry?.sha256 ?? null,
      newMode: newEntry?.mode ?? null,
      blobRef
    };
  });
}

export function gitPublishBlobReader(input: {
  dataDirectory: string;
  gitDirectory: string;
}): { read(ref: ArtifactRef): Promise<Uint8Array> } {
  return {
    read: async (ref): Promise<Uint8Array> => {
      const blobId = gitBlobPathPattern.exec(ref.relativePath)?.[1];
      if (blobId === undefined) {
        throw new Error(`PUBLISH_GIT_BLOB_REF_INVALID: ${ref.relativePath}`);
      }
      return readGitBlob({
        dataDirectory: input.dataDirectory,
        gitDirectory: input.gitDirectory,
        blobId,
        expectedSha256: ref.sha256.replace(/^sha256:/u, ""),
        expectedSize: ref.size
      });
    }
  };
}
