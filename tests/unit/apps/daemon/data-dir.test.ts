import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveProjectDataDirectory } from "../../../../apps/daemon/src/config/data-dir.js";

describe("SmartFlow data directory", () => {
  it("places project state outside the active project", () => {
    const projectRoot = resolve("/workspace", "active-project");
    const result = resolveProjectDataDirectory({
      projectRoot,
      projectId: "project-123",
      userDataRoot: resolve("/user-data")
    });
    expect(result).toBe(resolve("/user-data", "smartflow", "projects", "project-123"));
    expect(result.startsWith(`${projectRoot}/`)).toBe(false);
  });

  it("rejects a configured data root nested inside the project", () => {
    const projectRoot = resolve("/workspace", "active-project");
    expect(() =>
      resolveProjectDataDirectory({
        projectRoot,
        projectId: "project-123",
        userDataRoot: resolve(projectRoot, ".data")
      })
    ).toThrow(/outside the active project/u);
  });
});
