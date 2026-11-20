/**
 * What: the requests the Find in Document bar sends pdf.js and how it reads
 * pdf.js's answers.
 * Why: Next Match and Previous Match must step through hits, the option
 * toggles must re-run the search, and a miss must say so instead of showing nothing.
 */
import { describe, expect, it } from "vitest";

import {
  INITIAL_FIND_BAR_STATE,
  buildFindCommand,
  findCounter,
  findResultTone,
  type FindBarState,
} from "./pdf-find.js";

const state: FindBarState = {
  query: "torque",
  caseSensitive: true,
  entireWord: false,
  highlightAll: true,
};

describe("buildFindCommand", () => {
  it("carries the bar settings on every command", () => {
    const command = buildFindCommand(state, "search");
    expect(command.query).toBe("torque");
    expect(command.caseSensitive).toBe(true);
    expect(command.entireWord).toBe(false);
    expect(command.highlightAll).toBe(true);
    expect(command.matchDiacritics).toBe(false);
  });

  it("starts a fresh search with an empty type", () => {
    expect(buildFindCommand(state, "search").type).toBe("");
  });

  it("steps forward and backward with the same type but a direction flag", () => {
    const next = buildFindCommand(state, "next");
    const previous = buildFindCommand(state, "previous");
    expect(next.type).toBe("again");
    expect(next.findPrevious).toBe(false);
    expect(previous.type).toBe("again");
    expect(previous.findPrevious).toBe(true);
  });

  it("re-runs the search with the pdf.js change type for each toggle", () => {
    expect(buildFindCommand(state, "highlight-all").type).toBe(
      "highlightallchange",
    );
    expect(buildFindCommand(state, "case-sensitive").type).toBe(
      "casesensitivitychange",
    );
    expect(buildFindCommand(state, "entire-word").type).toBe(
      "entirewordchange",
    );
  });

  it("never marks a direction on anything but a previous step", () => {
    expect(buildFindCommand(state, "search").findPrevious).toBe(false);
    expect(buildFindCommand(state, "highlight-all").findPrevious).toBe(false);
    expect(buildFindCommand(state, "case-sensitive").findPrevious).toBe(false);
  });
});

describe("findResultTone", () => {
  // pdf.js FindState: FOUND=0, NOT_FOUND=1, WRAPPED=2, PENDING=3.
  it("is idle whenever the query is blank, whatever the last code was", () => {
    expect(findResultTone(1, "")).toBe("idle");
    expect(findResultTone(0, "   ")).toBe("idle");
    expect(findResultTone(null, "")).toBe("idle");
  });

  it("maps the pdf.js codes to tones for a non-empty query", () => {
    expect(findResultTone(3, "a")).toBe("pending");
    expect(findResultTone(1, "a")).toBe("not-found");
    expect(findResultTone(0, "a")).toBe("found");
    expect(findResultTone(2, "a")).toBe("found");
  });

  it("treats an unknown or absent code as idle", () => {
    expect(findResultTone(null, "a")).toBe("idle");
    expect(findResultTone(99, "a")).toBe("idle");
  });
});

describe("findCounter", () => {
  it("is blank while idle", () => {
    expect(findCounter("idle", { current: 0, total: 0 })).toEqual({
      kind: "blank",
    });
  });

  it("says there are no matches when nothing is found", () => {
    expect(findCounter("not-found", { current: 0, total: 0 })).toEqual({
      kind: "no-matches",
    });
  });

  it("reads N of M once there is a hit", () => {
    expect(findCounter("found", { current: 3, total: 12 })).toEqual({
      kind: "match",
      current: 3,
      total: 12,
    });
  });

  it("stays blank while a hit is still being counted", () => {
    expect(findCounter("pending", { current: 0, total: 0 })).toEqual({
      kind: "blank",
    });
    expect(findCounter("found", { current: 0, total: 0 })).toEqual({
      kind: "blank",
    });
  });
});

describe("INITIAL_FIND_BAR_STATE", () => {
  it("opens empty with Highlight All on", () => {
    expect(INITIAL_FIND_BAR_STATE.query).toBe("");
    expect(INITIAL_FIND_BAR_STATE.highlightAll).toBe(true);
    expect(INITIAL_FIND_BAR_STATE.caseSensitive).toBe(false);
    expect(INITIAL_FIND_BAR_STATE.entireWord).toBe(false);
  });
});
