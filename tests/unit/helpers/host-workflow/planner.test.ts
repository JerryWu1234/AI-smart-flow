import { describe, expect, it } from "vitest";

import { PlanningSession } from "../../../helpers/host-workflow/planner.js";

describe("Host PlanningSession", () => {
  it("numbers confirmation drafts without using business Revision terminology", () => {
    const planning = new PlanningSession();
    const first = planning.revise("# Tasks\n\n- first\n");
    const second = planning.revise("# Tasks\n\n- approved\n");

    expect(first.draftNumber).toBe(1);
    expect(second.draftNumber).toBe(2);
    expect(second.diff.added).toContain("- approved");
    expect(second.diff.removed).toContain("- first");
    expect(second).not.toHaveProperty("revision");
    expect(planning.current()).toEqual(second);
  });
});
