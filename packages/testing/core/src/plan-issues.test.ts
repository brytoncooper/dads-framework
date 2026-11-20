import { describe, expect, it } from "vitest";
import {
  formatIssueLocation,
  issueScope,
  issueSeverity,
} from "./plan-issues.js";

describe("plan issue classification", () => {
  it("prefers the severity the engine declared", () => {
    expect(
      issueSeverity({ code: "graph-missing", message: "", severity: "error" }),
    ).toBe("error");
  });

  it("derives severity from the issue code for an older engine", () => {
    expect(issueSeverity({ code: "graph-missing", message: "" })).toBe("info");
    expect(issueSeverity({ code: "snapshot-stale", message: "" })).toBe("info");
    expect(issueSeverity({ code: "unknown-changed-path", message: "" })).toBe(
      "uncertainty",
    );
  });

  it("prefers the scope the engine declared", () => {
    expect(
      issueScope({
        code: "unknown-changed-path",
        message: "",
        scope: "module",
      }),
    ).toBe("module");
  });

  it("derives scope from the issue code for an older engine", () => {
    expect(issueScope({ code: "unknown-changed-path", message: "" })).toBe(
      "workspace",
    );
    expect(issueScope({ code: "reachable-module-unowned", message: "" })).toBe(
      "workspace",
    );
    expect(issueScope({ code: "unresolved-import", message: "" })).toBe(
      "module",
    );
    expect(issueScope({ code: "graph-missing", message: "" })).toBe("unknown");
  });

  it("formats the location it has and no more", () => {
    expect(formatIssueLocation({ code: "c", message: "" })).toBeUndefined();
    expect(formatIssueLocation({ code: "c", message: "", path: "a.ts" })).toBe(
      "a.ts",
    );
    expect(
      formatIssueLocation({ code: "c", message: "", path: "a.ts", line: 3 }),
    ).toBe("a.ts:3");
    expect(
      formatIssueLocation({
        code: "c",
        message: "",
        path: "a.ts",
        line: 3,
        column: 9,
      }),
    ).toBe("a.ts:3:9");
    expect(
      formatIssueLocation({ code: "c", message: "", path: "a.ts", column: 9 }),
    ).toBe("a.ts");
  });
});
