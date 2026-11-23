// Local launches must share durable credentials but never share an active writer.
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDevelopmentLease,
  parseDevelopmentArguments,
  prepareWorkbenchDatabase,
  markDevelopmentInitialized,
  prepareDevelopmentDirectory,
  readOrCreateDevelopmentState,
  resolveDevelopmentAdapter,
} from "./local-state.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory() {
  const root = mkdtempSync(join(tmpdir(), "dads-local-state-"));
  directories.push(root);
  return prepareDevelopmentDirectory(root, "proof");
}

describe("workbench local state", () => {
  it("keeps the same private credentials across starts", () => {
    const path = directory();
    const first = readOrCreateDevelopmentState(path);
    expect(first.id).toMatch(/^[a-f0-9]{32}$/);
    expect(first.password).toMatch(/^[a-f0-9]{64}$/);
    expect(first.token).toMatch(/^[a-f0-9]{64}$/);
    expect(first.version).toBe(2);
    expect(first.adapter).toBe("postgres");
    expect(first.password).not.toBe(first.token);
    expect(readOrCreateDevelopmentState(path)).toEqual(first);
    expect(statSync(join(path, "state.json")).mode & 0o777).toBe(0o600);
    expect(statSync(path).mode & 0o777).toBe(0o700);
  });

  it("refuses corrupt state without overwriting it or exposing its contents", () => {
    const path = directory();
    const file = join(path, "state.json");
    writeFileSync(file, '{"token":"private-value"}', { mode: 0o600 });
    expect(() => readOrCreateDevelopmentState(path)).toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
    expect(readFileSync(file, "utf8")).toContain("private-value");
  });

  it("does not create a new authorization identity beside retained application data", () => {
    const path = directory();
    writeFileSync(join(path, "workbench.sqlite"), "retained-data", {
      mode: 0o600,
    });
    expect(() => readOrCreateDevelopmentState(path)).toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
  });

  it("upgrades v1 state as a SpiceDB instance instead of silently changing its backend", () => {
    const path = directory();
    const state = {
      version: 1,
      id: "a".repeat(32),
      password: "b".repeat(64),
      token: "c".repeat(64),
      initialized: true,
    };
    writeFileSync(join(path, "state.json"), JSON.stringify(state), {
      mode: 0o600,
    });
    expect(readOrCreateDevelopmentState(path)).toMatchObject({
      version: 2,
      adapter: "spicedb",
      initialized: true,
    });
    expect(JSON.parse(readFileSync(join(path, "state.json"), "utf8"))).toMatchObject({
      version: 2,
      adapter: "spicedb",
    });
  });

  it("refuses an explicit backend mismatch instead of reinterpreting retained data", () => {
    const path = directory();
    const state = readOrCreateDevelopmentState(path, "spicedb");
    expect(() => resolveDevelopmentAdapter(state, "postgres")).toThrow(
      expect.objectContaining({ code: "INVALID_STATE" }),
    );
  });

  it("refuses a missing initialized database and linked application files", () => {
    const path = directory();
    readOrCreateDevelopmentState(path, "spicedb");
    const database = prepareWorkbenchDatabase(path, false);
    markDevelopmentInitialized(path);
    expect(readOrCreateDevelopmentState(path).initialized).toBe(true);
    rmSync(database);
    expect(() => prepareWorkbenchDatabase(path, true)).toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
    const target = join(path, "unrelated.sqlite");
    writeFileSync(target, "do-not-mutate", { mode: 0o600 });
    symlinkSync(target, database);
    expect(() => prepareWorkbenchDatabase(path, false)).toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
    expect(readFileSync(target, "utf8")).toBe("do-not-mutate");
  });

  it("holds one instance lease until the holder closes it", () => {
    const path = directory();
    const first = acquireDevelopmentLease(path);
    try {
      expect(() => acquireDevelopmentLease(path)).toThrow(expect.objectContaining({ code: "ALREADY_RUNNING" }));
    } finally {
      first.close();
    }
    const next = acquireDevelopmentLease(path);
    next.close();
    next.close();
  });
});

describe("development arguments", () => {
  it("supports explicit isolated instances and an OS-selected test port", () => {
    expect(parseDevelopmentArguments(["up", "--instance", "proof-1", "--port", "0"])).toEqual({
      action: "up",
      instance: "proof-1",
      port: 0,
    });
    expect(parseDevelopmentArguments(["stop", "--instance", "proof"])).toEqual({
      action: "stop",
      instance: "proof",
      port: 4317,
    });
    expect(parseDevelopmentArguments(["up", "--adapter", "spicedb"])).toEqual({
      action: "up",
      instance: "default",
      port: 4317,
      adapter: "spicedb",
    });
    expect(parseDevelopmentArguments(["up", "--help"]).action).toBe("help");
  });

  it.each([
    ["reset"],
    ["up", "--instance", "../escape"],
    ["up", "--instance", ""],
    ["up", "--port", "1e3"],
    ["up", "--port", "65536"],
    ["up", "--unknown"],
    ["up", "--port", "4", "--port", "5"],
    ["up", "--adapter", "mysql"],
    ["stop", "--adapter", "spicedb"],
  ])("rejects unsafe or ambiguous arguments %j", (...args) => {
    expect(() => parseDevelopmentArguments(args)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});
