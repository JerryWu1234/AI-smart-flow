import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

import type { ArtifactRef } from "@smartflow/protocol";

import { bytesHash } from "./canonical-json.js";
import { StateStoreError } from "./errors.js";

export type AtomicWriteCheckpoint =
  | "AFTER_TEMP_WRITE"
  | "AFTER_FILE_FSYNC"
  | "AFTER_RENAME"
  | "AFTER_DIRECTORY_FSYNC";

export interface AtomicWriteHooks {
  checkpoint?(checkpoint: AtomicWriteCheckpoint): void | Promise<void>;
}

async function ignoreMissing(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function atomicWriteFile(
  targetPath: string,
  data: Uint8Array,
  hooks: AtomicWriteHooks = {}
): Promise<void> {
  const parent = dirname(targetPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = resolve(
    parent,
    `.${basename(targetPath)}.tmp-${String(process.pid)}-${randomUUID()}`
  );
  let renamed = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await hooks.checkpoint?.("AFTER_TEMP_WRITE");
      await handle.sync();
      await hooks.checkpoint?.("AFTER_FILE_FSYNC");
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, targetPath);
    renamed = true;
    await hooks.checkpoint?.("AFTER_RENAME");
    const directoryHandle = await open(parent, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    await hooks.checkpoint?.("AFTER_DIRECTORY_FSYNC");
  } catch (error) {
    if (!renamed) await ignoreMissing(temporaryPath);
    throw error;
  }
}

function ensureContained(baseDirectory: string, targetPath: string): string {
  const base = resolve(baseDirectory);
  const target = resolve(targetPath);
  const relativePath = relative(base, target);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  ) {
    throw new StateStoreError(
      "ARTIFACT_OUTSIDE_DATA_DIR",
      `Artifact path must be inside the data directory: ${target}`
    );
  }
  return relativePath.split(sep).join("/");
}

export async function durableWriteArtifact(
  dataDirectory: string,
  targetPath: string,
  data: Uint8Array,
  hooks: AtomicWriteHooks = {}
): Promise<ArtifactRef> {
  const relativePath = ensureContained(dataDirectory, targetPath);
  const parent = dirname(targetPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = resolve(
    parent,
    `.${basename(targetPath)}.artifact-${String(process.pid)}-${randomUUID()}`
  );
  let created = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await hooks.checkpoint?.("AFTER_TEMP_WRITE");
      await handle.sync();
      await hooks.checkpoint?.("AFTER_FILE_FSYNC");
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, targetPath);
      created = true;
      await hooks.checkpoint?.("AFTER_RENAME");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(targetPath);
      if (!Buffer.from(existing).equals(Buffer.from(data))) {
        throw new StateStoreError(
          "ARTIFACT_IMMUTABLE",
          `Artifact already exists with different bytes: ${relativePath}`
        );
      }
    }
    const directoryHandle = await open(parent, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    await hooks.checkpoint?.("AFTER_DIRECTORY_FSYNC");
  } finally {
    await ignoreMissing(temporaryPath);
  }
  const observed = await readFile(targetPath);
  const expectedHash = bytesHash(data);
  if (bytesHash(observed) !== expectedHash) {
    throw new StateStoreError(
      "ARTIFACT_HASH_MISMATCH",
      `Artifact hash verification failed: ${relativePath}`
    );
  }
  if (!created && observed.byteLength !== data.byteLength) {
    throw new StateStoreError(
      "ARTIFACT_IMMUTABLE",
      `Artifact replay size differs: ${relativePath}`
    );
  }
  return { relativePath, sha256: expectedHash, size: observed.byteLength };
}
