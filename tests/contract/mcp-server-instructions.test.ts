import { describe, expect, it } from "vitest";

import {
  SMARTFLOW_EXECUTE_DESCRIPTION,
  SMARTFLOW_MCP_INSTRUCTIONS
} from "@smartflow/mcp-server";

describe("SmartFlow MCP Host policy", () => {
  it("gates execution intent and requires a fresh canonical request file", () => {
    expect(SMARTFLOW_MCP_INSTRUCTIONS).toContain("implementation-intent gate");
    expect(SMARTFLOW_MCP_INSTRUCTIONS).toContain("casual chat");
    expect(SMARTFLOW_MCP_INSTRUCTIONS).toContain("planning-only requests");
    expect(SMARTFLOW_MCP_INSTRUCTIONS).toContain("tell the user what is missing");
    expect(SMARTFLOW_MCP_INSTRUCTIONS).toContain("every new implementation request");
    expect(SMARTFLOW_MCP_INSTRUCTIONS).toContain("fresh filesystem-safe requestId");
    expect(SMARTFLOW_MCP_INSTRUCTIONS).toContain(
      ".smartflow/tasks/<requestId>/tasks.md"
    );
    expect(SMARTFLOW_MCP_INSTRUCTIONS).toContain("Never reuse a previous execute requestId");
    expect(SMARTFLOW_MCP_INSTRUCTIONS).toContain("chat context, one source file, or multiple source files");
    expect(SMARTFLOW_MCP_INSTRUCTIONS).toContain("do not create or pass a business Revision");
  });

  it("orders disk display and explicit confirmation before hashing and execute", () => {
    const orderedPhrases = [
      "After writing the canonical file",
      "re-read it from disk",
      "show the user its project-relative path and complete contents",
      "explicitly ask whether to execute",
      "explicitly confirms the displayed file",
      "compute approvedSourceHash",
      "call smartflow_execute"
    ];
    const indexes: number[] = [];
    let cursor = 0;
    for (const phrase of orderedPhrases) {
      const index = SMARTFLOW_MCP_INSTRUCTIONS.indexOf(phrase, cursor);
      indexes.push(index);
      cursor = index + phrase.length;
    }
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
    expect(SMARTFLOW_MCP_INSTRUCTIONS).toContain("The user's initial implementation request");
    expect(SMARTFLOW_MCP_INSTRUCTIONS).toContain("exact separator ' — 验收：'");
  });

  it("describes execute as a consumer of one already confirmed file", () => {
    expect(SMARTFLOW_EXECUTE_DESCRIPTION).toContain("does not plan or generate tasks");
    expect(SMARTFLOW_EXECUTE_DESCRIPTION).toContain("showed in full");
    expect(SMARTFLOW_EXECUTE_DESCRIPTION).toContain("explicit user confirmation");
    expect(SMARTFLOW_EXECUTE_DESCRIPTION).toContain("fresh requestId");
    expect(SMARTFLOW_EXECUTE_DESCRIPTION).toContain("exact confirmed disk bytes");
  });
});
