import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseNxConfiguration, resolveLocalNxCli } from "./nx-installation.js";

describe("local Nx installation boundary", () => {
  it("resolves the declared nx bin and accepts a symlinked package directory", async () => {
    const workspace = await createWorkspace({
      bin: { nx: "./dist/bin/nx.js" },
    });
    const result = await resolveLocalNxCli(workspace);
    expect(result.endsWith("/dist/bin/nx.js")).toBe(true);
  });

  it("uses the legacy bin fallback only when bin is absent", async () => {
    const workspace = await createWorkspace({ bin: undefined, legacy: true });
    expect((await resolveLocalNxCli(workspace)).endsWith("/bin/nx.js")).toBe(
      true,
    );
  });

  it("refuses malformed or escaping explicit bin entries", async () => {
    const malformed = await createWorkspace({ bin: { nx: 4 } });
    await expect(resolveLocalNxCli(malformed)).rejects.toThrow(
      "malformed bin.nx",
    );
    const escaping = await createWorkspace({ bin: { nx: "../outside.js" } });
    await expect(resolveLocalNxCli(escaping)).rejects.toThrow(
      "outside the package",
    );
  });

  it("parses comments and trailing commas without changing strings", () => {
    expect(
      parseNxConfiguration(
        '{"url":"https://example.test/a//b","escaped":"quote \\"ok\\"", /* note */ "plugins":["x",],}',
        "nx.json",
      ),
    ).toEqual({
      url: "https://example.test/a//b",
      escaped: 'quote "ok"',
      plugins: ["x"],
    });
    expect(
      parseNxConfiguration(
        '{"nested":{"items":[1,{"ok":true,},],},}',
        "nx.json",
      ),
    ).toEqual({
      nested: { items: [1, { ok: true }] },
    });
  });

  it("reports malformed JSONC", () => {
    for (const malformed of ['{"plugins":[,]}', '{"x":,}', "[1,,]"]) {
      expect(() => parseNxConfiguration(malformed, "nx.json")).toThrow(
        "Unable to parse nx.json",
      );
    }
    expect(() => parseNxConfiguration("{/* unfinished", "nx.json")).toThrow(
      "Unable to parse nx.json",
    );
    expect(() => parseNxConfiguration("1/*x*/2", "nx.json")).toThrow(
      "Unable to parse nx.json",
    );
  });
});

async function createWorkspace(options: {
  readonly bin: unknown;
  readonly legacy?: boolean;
}): Promise<string> {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "dads-testing-nx-installation-"),
  );
  const packageRoot = path.join(workspace, ".store", "nx");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  if (options.legacy)
    await writeFile(
      path.join(packageRoot, "bin", "nx.js"),
      "#!/usr/bin/env node\n",
    );
  if (isRecord(options.bin) && options.bin["nx"] === "./dist/bin/nx.js") {
    await mkdir(path.join(packageRoot, "dist", "bin"), { recursive: true });
    await writeFile(
      path.join(packageRoot, "dist", "bin", "nx.js"),
      "#!/usr/bin/env node\n",
    );
  }
  await writeFile(path.join(packageRoot, "index.js"), "export {};\n");
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "nx",
      main: "./index.js",
      ...(options.bin === undefined ? {} : { bin: options.bin }),
    }),
  );
  await mkdir(path.join(workspace, "node_modules"), { recursive: true });
  await symlink(packageRoot, path.join(workspace, "node_modules", "nx"));
  await writeFile(path.join(workspace, "package.json"), '{"name":"fixture"}\n');
  return workspace;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
