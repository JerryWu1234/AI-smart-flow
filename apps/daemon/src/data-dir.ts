import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface ProjectDataDirectoryOptions {
  projectRoot: string;
  projectId: string;
  userDataRoot?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
}

export function defaultUserDataRoot(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
): string {
  if (environment.SMARTFLOW_DATA_HOME !== undefined) return environment.SMARTFLOW_DATA_HOME;
  if (platform === "win32") {
    return environment.LOCALAPPDATA ?? resolve(homedir(), "AppData", "Local");
  }
  if (platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support");
  }
  return environment.XDG_DATA_HOME ?? resolve(homedir(), ".local", "share");
}

export function resolveInstallationDataDirectory(options: {
  userDataRoot?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
} = {}): string {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  return resolve(
    options.userDataRoot ?? defaultUserDataRoot(platform, environment),
    "smartflow"
  );
}

function isContained(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path.length === 0 || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export function resolveProjectDataDirectory(options: ProjectDataDirectoryOptions): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(options.projectId)) {
    throw new Error("projectId is not safe for use as a data-directory component");
  }
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const root = resolve(options.userDataRoot ?? defaultUserDataRoot(platform, environment));
  const dataDirectory = resolve(root, "smartflow", "projects", options.projectId);
  if (isContained(options.projectRoot, dataDirectory)) {
    throw new Error("SmartFlow Data Dir must be outside the active project");
  }
  return dataDirectory;
}

export function resolveRunDataDirectory(projectDataDirectory: string, jobId: string): string {
  if (!/^job-[A-Za-z0-9-]+$/u.test(jobId)) {
    throw new Error("jobId is not safe for use as a data-directory component");
  }
  const projectDirectory = resolve(projectDataDirectory);
  const runDirectory = resolve(projectDirectory, "runs", jobId);
  if (!isContained(projectDirectory, runDirectory) || runDirectory === projectDirectory) {
    throw new Error("Run Data Dir must be inside the Project Data Dir");
  }
  return runDirectory;
}
