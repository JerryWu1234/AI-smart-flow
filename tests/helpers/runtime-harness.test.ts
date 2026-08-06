import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeHarness, hashTinyFixture, type RuntimeHarness } from "./runtime-harness.js";

const activeHarnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
});

function isNested(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value !== "" && !value.startsWith("..") && !isAbsolute(value);
}

describe("runtime harness", () => {
  it("creates disjoint projects and data directories without mutating the fixture", async () => {
    const before = await hashTinyFixture();

    const first = await createRuntimeHarness();
    activeHarnesses.push(first);
    await first.cleanup();
    activeHarnesses.pop();

    const second = await createRuntimeHarness();
    activeHarnesses.push(second);

    const project = await realpath(second.projectDir);
    const data = await realpath(second.dataDir);
    expect(isNested(project, data)).toBe(false);
    expect(isNested(data, project)).toBe(false);
    expect(await hashTinyFixture()).toBe(before);
  });
});
