import { TaskManifestError } from "./errors.js";

export interface ParsedTask {
  id: string;
  module: string;
  completed: boolean;
  parallel: boolean;
  description: string;
  filePaths: string[];
  acceptanceCriteria: string[];
}

export interface ParsedTasksDocument {
  sourceBytes: Uint8Array;
  tasks: ParsedTask[];
}

function isTargetPath(value: string): boolean {
  if (value.includes("/") || value.includes("\\")) return true;
  return /^[\w.*{}-]+\.(?:cjs|css|html|js|json|jsx|md|mjs|sh|ts|tsx|txt|yaml|yml)$/u.test(value);
}

function extractTargetPaths(description: string): string[] {
  const paths: string[] = [];
  for (const match of description.matchAll(/`([^`]+)`/gu)) {
    const value = match[1]?.trim();
    if (value !== undefined && isTargetPath(value) && !paths.includes(value)) paths.push(value);
  }
  return paths;
}

function parseTaskLine(
  line: string,
  lineNumber: number,
  headingModule: string
): ParsedTask {
  const checkboxMatch = /^- \[([ xX])\]\s+(.+)$/u.exec(line);
  if (checkboxMatch === null) {
    throw new TaskManifestError(
      "TASK_FORMAT_INVALID",
      `Line ${String(lineNumber)} is not a valid task checkbox`
    );
  }
  const tail = checkboxMatch[2]?.trim() ?? "";
  const idMatch = /^(T\d{3,})\s+(.+)$/u.exec(tail);
  if (idMatch === null) {
    throw new TaskManifestError(
      "TASK_ID_MISSING",
      `Line ${String(lineNumber)} has no valid Task ID`
    );
  }
  const id = idMatch[1] ?? "";
  let remaining = idMatch[2] ?? "";
  const tags: string[] = [];
  while (remaining.startsWith("[")) {
    const tagMatch = /^\[([^\]]+)\]\s*/u.exec(remaining);
    if (tagMatch === null) break;
    tags.push(tagMatch[1] ?? "");
    remaining = remaining.slice(tagMatch[0].length);
  }
  const moduleTags = tags.filter((tag) => /^M\d{2}$/u.test(tag));
  const unknownTag = tags.find((tag) => tag !== "P" && !/^M\d{2}$/u.test(tag));
  if (unknownTag !== undefined || moduleTags.length > 1) {
    throw new TaskManifestError(
      "TASK_TAG_INVALID",
      `Line ${String(lineNumber)} contains invalid or ambiguous task tags`
    );
  }
  const declaredModule = moduleTags[0];
  const moduleId =
    headingModule === "REVIEW_REPAIR" || headingModule === "CONVERGENCE"
      ? declaredModule
      : declaredModule ?? headingModule;
  if (moduleId === undefined) {
    throw new TaskManifestError(
      "TASK_TAG_INVALID",
      `Task ${id} must declare its module under ${headingModule}`
    );
  }
  if (
    headingModule !== "REVIEW_REPAIR" &&
    headingModule !== "CONVERGENCE" &&
    moduleId !== headingModule
  ) {
    throw new TaskManifestError(
      "TASK_MODULE_MISMATCH",
      `Task ${id} declares ${moduleId} under ${headingModule}`
    );
  }
  const parts = remaining.split(/\s+—\s*验收：/u);
  if (parts.length !== 2 || (parts[1]?.trim().length ?? 0) === 0) {
    throw new TaskManifestError(
      "TASK_ACCEPTANCE_MISSING",
      `Task ${id} must contain an explicit 验收 criterion`
    );
  }
  const description = parts[0]?.trim() ?? "";
  if (description.length === 0) {
    throw new TaskManifestError("TASK_FORMAT_INVALID", `Task ${id} has no description`);
  }
  return {
    id,
    module: moduleId,
    completed: (checkboxMatch[1] ?? " ").toUpperCase() === "X",
    parallel: tags.includes("P"),
    description,
    filePaths: extractTargetPaths(description),
    acceptanceCriteria: [parts[1]?.trim() ?? ""]
  };
}

function validateDocument(tasks: readonly ParsedTask[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new TaskManifestError("TASK_ID_DUPLICATE", `Duplicate Task ID: ${task.id}`);
    }
    ids.add(task.id);
  }
}

export function parseTasksDocument(input: string | Uint8Array): ParsedTasksDocument {
  const sourceBytes = typeof input === "string" ? Buffer.from(input, "utf8") : Uint8Array.from(input);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  if (/^\s*taskManifestMetadata\s*:/imu.test(source)) {
    throw new TaskManifestError(
      "TASKS_METADATA_UNSUPPORTED",
      "tasks.md no longer accepts taskManifestMetadata YAML; configure runtime behavior outside the task file"
    );
  }
  const tasks: ParsedTask[] = [];
  let headingModule: string | undefined;
  const lines = source.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const headingMatch = /^##\s+(M\d{2})(?:\s|$)/u.exec(line);
    if (headingMatch !== null) {
      headingModule = headingMatch[1];
      continue;
    }
    if (/^##\s+Review Repair Tasks(?:\s|$)/u.test(line)) {
      headingModule = "REVIEW_REPAIR";
      continue;
    }
    if (/^##\s+Phase\s+\d+\s*:\s*Convergence(?:\s|$)/iu.test(line)) {
      headingModule = "CONVERGENCE";
      continue;
    }
    if (/^##\s+/u.test(line)) {
      headingModule = undefined;
      continue;
    }
    if (!line.startsWith("- [")) continue;
    if (headingModule === undefined) {
      throw new TaskManifestError(
        "TASK_FORMAT_INVALID",
        `Task checkbox on line ${String(index + 1)} is outside a module heading`
      );
    }
    tasks.push(parseTaskLine(line, index + 1, headingModule));
  }
  validateDocument(tasks);
  return { sourceBytes, tasks };
}

export function selectEnabledTasks(document: ParsedTasksDocument): ParsedTask[] {
  return document.tasks.filter((task) => !task.completed);
}
