import { spawn } from "node:child_process";

import { WorkspaceError } from "./errors.js";

export interface GitCommandOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  input?: Uint8Array;
  allowExitCodes?: readonly number[];
}

export interface GitCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export async function runGitCommand(
  gitBinary: string,
  argv: readonly string[],
  options: GitCommandOptions = {}
): Promise<GitCommandResult> {
  return await new Promise<GitCommandResult>((resolve, reject) => {
    const child = spawn(gitBinary, [...argv], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      const exitCode = code ?? -1;
      if (exitCode !== 0 && !(options.allowExitCodes ?? []).includes(exitCode)) {
        reject(new WorkspaceError(
          "GIT_COMMAND_FAILED",
          `git ${argv[0] ?? "command"} failed (${String(exitCode)}): ${Buffer.concat(stderr).toString("utf8").trim()}`
        ));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode });
    });
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}
