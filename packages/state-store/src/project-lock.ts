import { hostname } from "node:os";
import { open, readFile, unlink } from "node:fs/promises";

import { StateStoreError } from "./errors.js";

interface LockRecord {
  ownerId: string;
  pid: number;
  hostname: string;
  fence: number;
  acquiredAt: string;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function removeStaleLocalLock(lockPath: string): Promise<boolean> {
  let record: LockRecord;
  try {
    record = JSON.parse(await readFile(lockPath, "utf8")) as LockRecord;
  } catch {
    return false;
  }
  if (record.hostname !== hostname() || processExists(record.pid)) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export class ProjectLock {
  public readonly fence: number;
  public readonly ownerId: string;
  private readonly lockPath: string;
  private released = false;

  private constructor(lockPath: string, ownerId: string, fence: number) {
    this.lockPath = lockPath;
    this.ownerId = ownerId;
    this.fence = fence;
  }

  public static async acquire(
    lockPath: string,
    ownerId: string,
    previousFence: number
  ): Promise<ProjectLock> {
    const fence = previousFence + 1;
    const record: LockRecord = {
      ownerId,
      pid: process.pid,
      hostname: hostname(),
      fence,
      acquiredAt: new Date().toISOString()
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(record), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new ProjectLock(lockPath, ownerId, fence);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt === 0 && (await removeStaleLocalLock(lockPath))) continue;
        throw new StateStoreError("PROJECT_LOCKED", `Project already has a writer: ${lockPath}`);
      }
    }
    throw new StateStoreError("PROJECT_LOCKED", `Project already has a writer: ${lockPath}`);
  }

  public async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    let record: LockRecord | undefined;
    try {
      record = JSON.parse(await readFile(this.lockPath, "utf8")) as LockRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (record.ownerId !== this.ownerId || record.fence !== this.fence) {
      throw new StateStoreError("STALE_FENCE", "Refusing to release a lock owned by another fence");
    }
    await unlink(this.lockPath);
  }
}
