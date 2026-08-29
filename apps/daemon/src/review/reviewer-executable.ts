import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, resolve } from "node:path";

import type { ReviewStrategy } from "../config/config.js";

const REVIEWER_EXECUTABLES = {
  "claude-code": "claude",
  codex: "codex",
  "codex-desktop": "codex"
} as const satisfies Record<ReviewStrategy, string>;

function executableNames(executable: string, environment: NodeJS.ProcessEnv): readonly string[] {
  if (process.platform !== "win32") return [executable];
  const extensions = (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);
  return [executable, ...extensions.map((extension) => `${executable}${extension}`)];
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveReviewerExecutable(
  strategy: ReviewStrategy,
  environment: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const executable = REVIEWER_EXECUTABLES[strategy];
  const searchPath = environment.PATH;
  if (searchPath !== undefined) {
    for (const directory of searchPath.split(delimiter)) {
      if (directory.length === 0) continue;
      for (const name of executableNames(executable, environment)) {
        const candidate = resolve(directory, name);
        if (await isExecutableFile(candidate)) return candidate;
      }
    }
  }
  throw new Error(
    `REVIEW_AGENT_UNAVAILABLE: adapter "${strategy}" requires executable "${executable}" on PATH`
  );
}
