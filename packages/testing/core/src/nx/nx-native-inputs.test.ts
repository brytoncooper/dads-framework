import { describe, expect, it } from "vitest";
import { inputScope } from "./nx-native-inputs.js";
import type { NativeProject } from "./nx-native-graph.js";

const harbor: NativeProject = {
  name: "harbor",
  root: "apps/harbor",
  targets: {},
  namedInputs: { shared: ["{workspaceRoot}/harbor-config/**/*"] },
  dependencies: ["shared"],
};
const shared: NativeProject = {
  name: "shared",
  root: "libs/shared",
  targets: {},
  namedInputs: { shared: ["{workspaceRoot}/library-config/*.json"] },
  dependencies: [],
};
const globalPolicyPaths = [
  "nx.json",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
];

const projects = new Map([
  [harbor.name, harbor],
  [shared.name, shared],
]);

describe("native Nx conservative input scopes", () => {
  it("retains global policy and cross-project extglob prefixes when a root project owns globals", () => {
    const rootProject: NativeProject = {
      name: "workspace",
      root: ".",
      targets: {},
      namedInputs: undefined,
      dependencies: [],
    };
    const withRootProject = new Map([...projects, [rootProject.name, rootProject]]);
    for (const pattern of ["+(alpha|beta)", "@(alpha|beta)", "!(alpha)"]) {
      const scope = inputScope(
        harbor,
        "test",
        { inputs: [`{workspaceRoot}/other-libraries/${pattern}/**/*.ts`] },
        withRootProject,
        {},
      );
      expect(scope.mode).toBe("changed-files");
      expect(scope.paths).toEqual([...globalPolicyPaths, "apps/harbor", "libs/shared", "other-libraries"].sort());
    }
  });

  it("expands named inputs using each dependency project's overrides", () => {
    const scope = inputScope(harbor, "test", { inputs: ["shared", "^shared"] }, projects, {
      namedInputs: {
        default: ["{projectRoot}/**/*", "global"],
        global: ["{workspaceRoot}/config/global.json"],
        shared: ["{workspaceRoot}/unused/**/*"],
      },
    });
    expect(scope.mode).toBe("changed-files");
    expect(scope.paths).toEqual(
      [
        ...globalPolicyPaths,
        "apps/harbor",
        "config/global.json",
        "harbor-config",
        "library-config",
        "libs/shared",
      ].sort(),
    );
  });

  it("widens glob prefixes and ignores exclusions instead of subtracting inputs", () => {
    const scope = inputScope(
      harbor,
      "test",
      {
        inputs: [
          "!{workspaceRoot}/config/private/**",
          "{workspaceRoot}/config/tsconfig?.json",
          "{workspaceRoot}/assets/[ab]/**",
          "{workspaceRoot}/settings/{ci,local}.json",
        ],
      },
      projects,
      {},
    );
    expect(scope.mode).toBe("changed-files");
    expect(scope.paths).toEqual(
      [...globalPolicyPaths, "apps/harbor", "assets", "config", "libs/shared", "settings"].sort(),
    );
  });

  it("uses always for unresolved, runtime and environment inputs", () => {
    for (const inputs of [
      ["missing"],
      [{ runtime: "node --version" }],
      [{ env: "CI" }],
      [{ input: "default", projects: ["shared"] }],
      [{ fileset: 7 }],
      ["{workspaceRoot}/../outside"],
      ["{unknown}/file"],
      "malformed",
    ]) {
      const scope = inputScope(harbor, "test", { inputs }, projects, {});
      expect(scope.mode).toBe("always");
      expect(scope.reason.length).toBeGreaterThan(0);
    }
  });

  it("locates named files and defers external and dependent-output inputs to paths already held", () => {
    const scope = inputScope(
      harbor,
      "test",
      {
        inputs: [
          { externalDependencies: ["typescript"] },
          { dependentTasksOutputFiles: "**/*.d.ts", transitive: true },
          { json: "{workspaceRoot}/release/versions.json", fields: ["name"] },
          { fileset: "{projectRoot}/src/**/*.ts" },
        ],
      },
      projects,
      {},
    );
    expect(scope.mode).toBe("changed-files");
    expect(scope.paths).toEqual(
      [...globalPolicyPaths, "apps/harbor", "apps/harbor/src", "libs/shared", "release/versions.json"].sort(),
    );
  });

  it("keeps plugins, targetDefaults, prerequisites and configurations out of the reasons", () => {
    const scope = inputScope(
      harbor,
      "test",
      {
        dependsOn: ["^build", "typecheck"],
        defaultConfiguration: "ci",
        configurations: { ci: {}, local: {} },
      },
      projects,
      {
        plugins: ["@nx/vite/plugin"],
        targetDefaults: { serve: { inputs: ["{workspaceRoot}/never.json"] } },
      },
    );
    expect(scope.mode).toBe("changed-files");
    expect(scope.reason).toContain("plugin-inferred inputs assumed");
    expect(scope.paths).toEqual([...globalPolicyPaths, "apps/harbor", "libs/shared"].sort());
  });

  it("takes targetDefaults inputs only for a target that declares none of its own", () => {
    const configuration = {
      targetDefaults: {
        test: { inputs: ["{workspaceRoot}/vitest.setup.ts"] },
        "@nx/vite:test": { inputs: ["{workspaceRoot}/vite-shared"] },
        "*": { inputs: ["{workspaceRoot}/every-target"] },
        lint: { inputs: [{ runtime: "eslint --version" }] },
      },
    };
    const inherited = inputScope(harbor, "test", { executor: "@nx/vite:test" }, projects, configuration);
    expect(inherited.mode).toBe("changed-files");
    expect(inherited.paths).toEqual(
      [...globalPolicyPaths, "apps/harbor", "every-target", "libs/shared", "vite-shared", "vitest.setup.ts"].sort(),
    );
    const declared = inputScope(
      harbor,
      "test",
      { executor: "@nx/vite:test", inputs: ["{projectRoot}/src/**"] },
      projects,
      configuration,
    );
    expect(declared.paths).toEqual([...globalPolicyPaths, "apps/harbor", "apps/harbor/src", "libs/shared"].sort());
    expect(inputScope(harbor, "lint", {}, projects, configuration).mode).toBe("always");
  });

  it("unions the inputs every configuration adds to the default ones", () => {
    const scope = inputScope(
      harbor,
      "test",
      {
        inputs: ["{projectRoot}/src/**"],
        configurations: {
          ci: { inputs: ["{workspaceRoot}/ci/matrix.json"] },
          local: { inputs: ["{workspaceRoot}/local-overrides"] },
        },
      },
      projects,
      {},
    );
    expect(scope.paths).toEqual(
      [
        ...globalPolicyPaths,
        "apps/harbor",
        "apps/harbor/src",
        "ci/matrix.json",
        "libs/shared",
        "local-overrides",
      ].sort(),
    );
    expect(inputScope(harbor, "test", { configurations: 4 }, projects, {}).mode).toBe("always");
    expect(inputScope(harbor, "test", { configurations: { ci: 4 } }, projects, {}).mode).toBe("always");
  });

  it("follows a prerequisite to the exact projects Nx names for it", () => {
    const tooling: NativeProject = {
      name: "tooling",
      root: "tools/codegen",
      targets: { build: { inputs: ["{workspaceRoot}/codegen-config"] } },
      namedInputs: undefined,
      dependencies: [],
    };
    const withTooling = new Map([...projects, [tooling.name, tooling]]);
    const scope = inputScope(
      harbor,
      "test",
      { dependsOn: [{ projects: ["tooling"], target: "build" }] },
      withTooling,
      {},
    );
    expect(scope.mode).toBe("changed-files");
    expect(scope.paths).toEqual(
      [...globalPolicyPaths, "apps/harbor", "codegen-config", "libs/shared", "tools/codegen"].sort(),
    );
    expect(
      inputScope(harbor, "test", { dependsOn: [{ projects: ["tag:missing"], target: "build" }] }, withTooling, {}).mode,
    ).toBe("always");
    expect(inputScope(harbor, "test", { dependsOn: "build" }, withTooling, {}).mode).toBe("always");
  });

  it("falls back for cyclic definitions and invalid configuration boundaries", () => {
    for (const configuration of [
      null,
      { namedInputs: [] },
      { targetDefaults: 4 },
      { namedInputs: { default: ["first"], first: ["default"] } },
    ]) {
      expect(inputScope(harbor, "test", {}, projects, configuration).mode).toBe("always");
    }
    expect(inputScope(harbor, "test", { inputs: ["{workspaceRoot}/**/*"] }, projects, {}).mode).toBe("always");
  });

  it("keeps a workspace-root project and an unresolved dependency at always", () => {
    const rooted: NativeProject = {
      name: "workspace",
      root: ".",
      targets: {},
      namedInputs: undefined,
      dependencies: [],
    };
    const dependent: NativeProject = {
      name: "dependent",
      root: "apps/dependent",
      targets: {},
      namedInputs: undefined,
      dependencies: ["workspace"],
    };
    const withRoot = new Map([...projects, [rooted.name, rooted], [dependent.name, dependent]]);
    expect(inputScope(rooted, "test", {}, withRoot, {}).reason).toContain("workspace-root project");
    expect(inputScope(dependent, "test", {}, withRoot, {}).mode).toBe("always");
    const orphan: NativeProject = { ...harbor, dependencies: ["absent"] };
    expect(inputScope(orphan, "test", {}, projects, {}).reason).toContain("unresolved project dependency");
  });
});
