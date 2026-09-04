import { describe, expect, it } from "vitest";

import {
  createSmartFlowExecuteDescription,
  createSmartFlowMcpInstructions
} from "@smartflow/mcp-server";

const tasksPath = ".smartflow/tasks/session-test/tasks.md";
const instructions = createSmartFlowMcpInstructions(tasksPath);
const description = createSmartFlowExecuteDescription(tasksPath);

describe("SmartFlow MCP Host policy", () => {
  it("gates execution intent and binds preparation to the session path", () => {
    expect(instructions).toContain("implementation-intent gate");
    expect(instructions).toContain("casual chat");
    expect(instructions).toContain("planning-only requests");
    expect(instructions).toContain("tell the user what is missing");
    expect(instructions).toContain(tasksPath);
    expect(instructions).toContain("fixed for the session");
    expect(instructions).toContain("only after the previous Job is done");
    expect(instructions).toContain("replace the file");
    expect(instructions).toContain("chat context, one source file, or multiple source files");
  });

  it("orders disk display and explicit confirmation before empty execute", () => {
    const orderedPhrases = [
      "After writing the canonical file",
      "re-read it from disk",
      "show the user its project-relative path and complete contents",
      "explicitly ask whether to execute",
      "explicitly confirms the displayed file",
      "call smartflow_execute with an empty object"
    ];
    const indexes: number[] = [];
    let cursor = 0;
    for (const phrase of orderedPhrases) {
      const index = instructions.indexOf(phrase, cursor);
      indexes.push(index);
      cursor = index + phrase.length;
    }
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
    expect(instructions).toContain("The user's initial implementation request");
    expect(instructions).toContain("exact separator ' — 验收：'");
    expect(instructions).toContain(
      "Do not pass projectRoot, tasksPath, approvedSourceHash, requestId"
    );
  });

  it("describes execute as a zero-argument consumer of one confirmed file", () => {
    expect(description).toContain(tasksPath);
    expect(description).toContain("does not plan or generate tasks");
    expect(description).toContain("showed it in full");
    expect(description).toContain("explicit user confirmation");
    expect(description).toContain("accepts no arguments");
    expect(description).toContain(
      "MCP session supplies the project root, path, source hash, and execute idempotency identity"
    );
  });
});
