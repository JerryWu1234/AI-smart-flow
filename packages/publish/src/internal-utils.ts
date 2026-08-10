import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

export { canonical, sha256 } from "@smartflow/protocol";

/**
 * Observes file hash and mode at `path`.
 * Returns `{ hash, mode }` if it's a regular non-symlink file,
 * `"ABSENT"` if it does not exist, or `"OTHER"` if it is a directory / symlink / special.
 */
export async function observedFile(
  path: string
): Promise<{ hash: string; mode: number } | "ABSENT" | "OTHER"> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return "OTHER";
    return {
      hash: createHash("sha256").update(await readFile(path)).digest("hex"),
      mode: stats.mode & 0o777
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "ABSENT";
    throw error;
  }
}
