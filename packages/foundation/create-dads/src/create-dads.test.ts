/** Proves guided and noninteractive creation share one deterministic recipe. */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDads, type CreateDadsDependencies } from "./create-dads.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("create Dads", () => {
  it("creates the named APIs and their modern dependencies", async () => {
    const targetDirectory = join(temporaryDirectory(), "kit-api");
    const creation = await createDads(
      [targetDirectory, "--skip-install"],
      dependencies(),
    );
    expect(creation.installed).toBe(false);
    expect(creation.initialization.created).toContain("apps/customer/app.ts");
    expect(creation.initialization.created).toContain("apps/staff/app.ts");
    const manifest = readFileSync(
      join(targetDirectory, "package.json"),
      "utf8",
    );
    expect(manifest).toContain("@dads-framework/postgres-access");
    expect(manifest).toContain("@dads-framework/http");
    expect(manifest).not.toMatch(/legacy-(?:http|authorization)/);
  });

  it("installs once, then leaves the same project unchanged", async () => {
    const targetDirectory = join(temporaryDirectory(), "kit-api");
    const installedProjects: string[] = [];
    const installer = {
      installDependencies: (projectRoot: string) => {
        installedProjects.push(projectRoot);
        simulateInstalledProject(projectRoot);
        return Promise.resolve();
      },
    };
    expect((await createDads([targetDirectory], installer)).installed).toBe(
      true,
    );
    const rerun = await createDads([targetDirectory], installer);
    expect(rerun.initialization.created).toEqual([]);
    expect(rerun.installed).toBe(false);
    expect(installedProjects).toEqual([targetDirectory]);
  });

  it("retries a failed dependency installation without rewriting project files", async () => {
    const targetDirectory = join(temporaryDirectory(), "retry-api");
    const installationAttempts: string[] = [];

    await expect(
      createDads([targetDirectory, "--yes"], {
        installDependencies: (projectRoot) => {
          installationAttempts.push(projectRoot);
          return Promise.reject(new Error("Registry unavailable."));
        },
      }),
    ).rejects.toThrow("Registry unavailable");

    const recovered = await createDads([targetDirectory, "--yes"], {
      installDependencies: (projectRoot) => {
        installationAttempts.push(projectRoot);
        simulateInstalledProject(projectRoot);
        return Promise.resolve();
      },
    });
    const healthyRerun = await createDads([targetDirectory, "--yes"], {
      installDependencies: () =>
        Promise.reject(new Error("Healthy rerun must not reinstall.")),
    });

    expect(recovered.initialization.created).toEqual([]);
    expect(recovered.installed).toBe(true);
    expect(healthyRerun.installed).toBe(false);
    expect(installationAttempts).toEqual([targetDirectory, targetDirectory]);
  });

  it("retries the development stack without reinstalling a successful install", async () => {
    const targetDirectory = join(temporaryDirectory(), "local-api");
    let installs = 0;
    let starts = 0;
    const services = {
      installDependencies(projectRoot: string) {
        installs += 1;
        simulateInstalledProject(projectRoot);
        return Promise.resolve();
      },
      startDevelopment(projectRoot: string) {
        expect(projectRoot).toBe(targetDirectory);
        expect(existsSync(join(projectRoot, "package-lock.json"))).toBe(true);
        starts += 1;
        return starts === 1
          ? Promise.reject(new Error("Docker is unavailable"))
          : Promise.resolve({
              webUrl: "http://127.0.0.1:4000",
              apiUrl: "http://127.0.0.1:4001",
              staffUrl: "http://127.0.0.1:4002",
            });
      },
    };
    const first = await createDads([targetDirectory], services);
    expect(first.development).toEqual({
      status: "deferred",
      reason: "Docker is unavailable",
    });
    const retry = await createDads([targetDirectory], services);
    expect(retry.development).toEqual({
      status: "started",
      webUrl: "http://127.0.0.1:4000",
      apiUrl: "http://127.0.0.1:4001",
      staffUrl: "http://127.0.0.1:4002",
    });
    expect(retry.installed).toBe(false);
    expect(installs).toBe(1);
    expect(starts).toBe(2);
  });

  it("rejects unknown options and extra positional arguments before writing", async () => {
    const targetDirectory = join(temporaryDirectory(), "parsed-api");

    await expect(
      createDads(
        [targetDirectory, "--profil", "strict", "--skip-install"],
        dependencies(),
      ),
    ).rejects.toThrow("Unknown option --profil");
    await expect(
      createDads(
        [targetDirectory, "unexpected", "--skip-install"],
        dependencies(),
      ),
    ).rejects.toThrow("Unexpected positional argument unexpected");
    expect(() => readFileSync(join(targetDirectory, "package.json"))).toThrow();
  });

  it("rejects retired recipe options before writing", async () => {
    const targetDirectory = temporaryDirectory();
    for (const option of ["--profile", "--adapter", "--client"]) {
      await expect(
        createDads([targetDirectory, option, "legacy"], dependencies()),
      ).rejects.toThrow(`Unknown option ${option}.`);
    }
    expect(existsSync(join(targetDirectory, "package.json"))).toBe(false);
  });

  it("runs no installation for a dry run", async () => {
    const targetDirectory = join(temporaryDirectory(), "planned-api");

    const creation = await createDads([targetDirectory, "--yes", "--dry-run"], {
      installDependencies: () =>
        Promise.reject(new Error("A dry run must not install.")),
    });

    expect(creation.installed).toBe(false);
    expect(creation.initialization.created).toContain("package.json");
    expect(existsSync(join(targetDirectory, "package.json"))).toBe(false);
  });

  it("adds an isolated project to an existing app", async () => {
    const targetDirectory = temporaryDirectory();
    writeFileSync(
      join(targetDirectory, "package.json"),
      '{"name":"existing-app"}\n',
    );

    const creation = await createDads(
      [targetDirectory, "--existing", "--yes", "--skip-install"],
      dependencies(),
    );

    expect(creation.initialization.projectRoot).toBe(
      join(targetDirectory, "dads"),
    );
    expect(readFileSync(join(targetDirectory, "package.json"), "utf8")).toBe(
      '{"name":"existing-app"}\n',
    );
  });

  it("diagnoses an existing project before it writes, and creates the same files either way", async () => {
    const diagnosed = existingApplication();
    const written: string[] = [];
    const projectRootExistedWhenWritten: boolean[] = [];

    const creation = await createDads(
      [diagnosed, "--existing", "--yes", "--skip-install"],
      {
        ...dependencies(),
        write: (text) => {
          written.push(text);
          projectRootExistedWhenWritten.push(
            existsSync(join(diagnosed, "dads", "package.json")),
          );
        },
      },
    );
    const undiagnosed = await createDads(
      [
        existingApplication(),
        "--existing",
        "--yes",
        "--skip-install",
        "--skip-doctor",
      ],
      dependencies(),
    );

    expect(creation.doctor?.ok).toBe(true);
    expect(creation.doctor?.profile).toBe("standard");
    expect(creation.doctor?.issues).toHaveLength(17);
    expect(written.join("")).toContain("Anxious attachment");
    expect(projectRootExistedWhenWritten).toEqual([false]);
    expect(creation.initialization.created).toEqual(
      undiagnosed.initialization.created,
    );
  });

  it("says so in one line and reads nothing when the target is fresh", async () => {
    const targetDirectory = join(temporaryDirectory(), "fresh-api");
    const written: string[] = [];

    const creation = await createDads(
      [targetDirectory, "--yes", "--skip-install"],
      {
        ...dependencies(),
        write: (text) => {
          written.push(text);
        },
      },
    );

    expect(creation.doctor).toBeNull();
    expect(written).toEqual([
      `No existing project at ${targetDirectory}: skipping the doctor.\n`,
    ]);
  });

  it("skips the doctor entirely for --skip-doctor and refuses a repeated one", async () => {
    const targetDirectory = existingApplication();
    const written: string[] = [];

    const creation = await createDads(
      [
        targetDirectory,
        "--existing",
        "--yes",
        "--skip-install",
        "--skip-doctor",
      ],
      {
        ...dependencies(),
        write: (text) => {
          written.push(text);
        },
      },
    );

    expect(creation.doctor).toBeNull();
    expect(written).toEqual([]);
    await expect(
      createDads(
        [targetDirectory, "--skip-doctor", "--skip-doctor"],
        dependencies(),
      ),
    ).rejects.toThrow("Option --skip-doctor was provided more than once.");
    await expect(
      createDads([targetDirectory, "--today", "yesterday"], dependencies()),
    ).rejects.toThrow("--today must be a date written YYYY-MM-DD.");
  });

  it("carries the report in the --json result and writes nothing before it", async () => {
    const targetDirectory = existingApplication();
    const written: string[] = [];

    const creation = await createDads(
      [
        targetDirectory,
        "--existing",
        "--json",
        "--skip-install",
        "--today",
        "2026-09-07",
      ],
      {
        ...dependencies(),
        write: (text) => {
          written.push(text);
        },
      },
    );

    expect(written).toEqual([]);
    expect(creation.doctor).toMatchObject({
      ok: true,
      root: targetDirectory,
      profile: "standard",
      today: "2026-09-07",
    });
  });

  it("scaffolds the lean minimal template when --template minimal is requested", async () => {
    const targetDirectory = join(temporaryDirectory(), "minimal-api");
    const creation = await createDads(
      [targetDirectory, "--template", "minimal", "--skip-install"],
      dependencies(),
    );

    expect(creation.initialization.created).toContain("apps/customer/app.ts");
    expect(creation.initialization.created).toContain("apps/staff/app.ts");
    expect(creation.initialization.created).toContain(
      "domains/tenants/index.ts",
    );
    expect(
      creation.initialization.created.some((path) =>
        path.startsWith("domains/notes/"),
      ),
    ).toBe(false);
    expect(
      creation.initialization.created.some((path) =>
        path.startsWith("domains/support/"),
      ),
    ).toBe(false);
    expect(
      creation.initialization.created.some((path) =>
        path.startsWith("examples/"),
      ),
    ).toBe(false);
    expect(existsSync(join(targetDirectory, "domains/notes"))).toBe(false);
  });

  it("keeps --template example identical to the default starter and rejects unknown templates", async () => {
    const exampleDirectory = join(temporaryDirectory(), "example-api");
    const creation = await createDads(
      [exampleDirectory, "--template", "example", "--skip-install"],
      dependencies(),
    );
    expect(creation.initialization.created).toContain(
      "domains/notes/server/routes.ts",
    );

    const invalidDirectory = join(temporaryDirectory(), "invalid-template");
    await expect(
      createDads(
        [invalidDirectory, "--template", "blank", "--skip-install"],
        dependencies(),
      ),
    ).rejects.toThrow("--template must be minimal or example.");
    expect(existsSync(invalidDirectory)).toBe(false);
  });
});

/** A directory that already holds an application, for the doctor to read. */
function existingApplication(): string {
  const directory = temporaryDirectory();
  writeFileSync(join(directory, "package.json"), '{"name":"existing-app"}\n');
  return directory;
}

function simulateInstalledProject(projectRoot: string): void {
  mkdirSync(join(projectRoot, "node_modules"));
  writeFileSync(
    join(projectRoot, "package-lock.json"),
    '{"lockfileVersion":3}\n',
  );
}

function dependencies(): CreateDadsDependencies {
  return { installDependencies: () => Promise.resolve() };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "create-dads-"));
  temporaryDirectories.push(directory);
  return directory;
}
