/** Proves ergonomic access declarations preserve the workbench's persisted SpiceDB contract. */

import { accessIrDefinitionsDiff, emitAccessIr, parseZed } from "@dads-framework/access";
import { describe, expect, it } from "vitest";
import { workbenchAccessModel } from "./access.js";

describe("workbench access model", () => {
  it("keeps persisted SpiceDB definitions and permissions stable", () => {
    const previous = parseZed(`definition user {}

definition workspace {
  relation owner: user
  relation member: user
  permission view = owner + member
  permission manage = owner
}

definition task {
  relation workspace: workspace
  permission view = workspace->view
  permission manage = workspace->manage
}
`);
    expect(accessIrDefinitionsDiff(previous, emitAccessIr(workbenchAccessModel))).toEqual([]);
  });
});
