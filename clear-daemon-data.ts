import { lstat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

function defaultUserDataRoot(): string {
  const configured = process.env.SMARTFLOW_DATA_HOME;
  if (configured !== undefined) {
    if (configured.trim().length === 0) {
      throw new Error("SMARTFLOW_DATA_HOME must not be empty");
    }
    return configured;
  }
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? resolve(homedir(), "AppData", "Local");
  }
  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support");
  }
  return process.env.XDG_DATA_HOME ?? resolve(homedir(), ".local", "share");
}

function contains(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path.length === 0 || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function main(): Promise<void> {
  const userDataRoot = resolve(defaultUserDataRoot());
  const daemonDataDirectory = resolve(userDataRoot, "smartflow", "daemon");
  const expectedRelativePath = join("smartflow", "daemon");
  const protectedPaths = [
    parse(daemonDataDirectory).root,
    resolve(homedir()),
    resolve(process.cwd())
  ];

  if (
    relative(userDataRoot, daemonDataDirectory) !== expectedRelativePath ||
    protectedPaths.includes(daemonDataDirectory) ||
    contains(daemonDataDirectory, resolve(homedir(), ".codex"))
  ) {
    throw new Error(`Refusing to remove unsafe path: ${daemonDataDirectory}`);
  }

  if (!(await exists(daemonDataDirectory))) {
    console.log(`No SmartFlow daemon data found at: ${daemonDataDirectory}`);
    return;
  }

  await rm(daemonDataDirectory, { recursive: true, force: true });
  console.log(`Cleared SmartFlow daemon data: ${daemonDataDirectory}`);
}

await main();
