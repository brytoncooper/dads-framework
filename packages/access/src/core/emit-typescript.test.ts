/**
 * What/why: emitTypeScript / emitTypeScriptFromZed compile SpiceDB schemas into
 * strict Dads TypeScript (defaulting to ergonomic DSL, with classic opt-in).
 * This suite executes every emitted module, proves zero semantic IR diff on
 * round-trip back to Zed, and type-checks emitted ergonomic modules with `tsc --strict`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import type { AccessModel } from "./access-model.js";
import { accessIrDefinitionsDiff } from "./compare-access-ir.js";
import { emitAccessIr } from "./emit-ir.js";
import {
  emitTypeScript,
  emitTypeScriptFromZed,
  type EmitTypeScriptStyle,
} from "./emit-typescript.js";
import { emitZed } from "./emit-zed.js";
import type { AccessIrDefinition } from "./ir.js";
import { parseZed } from "./parse-zed.js";

const coreDir = dirname(fileURLToPath(import.meta.url));
const accessIndexPath = resolve(coreDir, "../index.ts");
const accessIndexUrl = pathToFileURL(accessIndexPath).href;
const repoRoot = resolve(coreDir, "../../../..");
const tscBin = resolve(repoRoot, "node_modules/.bin/tsc");
const tempDir = mkdtempSync(join(tmpdir(), "dads-emit-ts-"));
let moduleSerial = 0;

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function isAccessModel(value: unknown): value is AccessModel {
  return (
    typeof value === "object" &&
    value !== null &&
    "definitions" in value &&
    Array.isArray(value.definitions) &&
    "bindings" in value &&
    Array.isArray(value.bindings)
  );
}

function extractModelExport(
  loaded: unknown,
  exportName: "access" | "model",
): AccessModel {
  if (typeof loaded !== "object" || loaded === null) {
    throw new Error("emitted module did not load as an object");
  }
  const exported: unknown =
    exportName === "access"
      ? "access" in loaded
        ? loaded.access
        : undefined
      : "model" in loaded
        ? loaded.model
        : undefined;
  if (!isAccessModel(exported)) {
    throw new Error(
      `emitted module export "${exportName}" is not a valid AccessModel`,
    );
  }
  return exported;
}

async function evaluateEmittedModel(
  tsSource: string,
  exportName: "access" | "model",
): Promise<AccessModel> {
  moduleSerial += 1;
  const rewritten = tsSource.replaceAll(
    '"@dads-framework/access"',
    JSON.stringify(accessIndexUrl),
  );
  const filePath = join(tempDir, `generated-${moduleSerial}.ts`);
  writeFileSync(filePath, rewritten, "utf8");
  const loaded: unknown = await import(
    /* @vite-ignore */ pathToFileURL(filePath).href
  );
  return extractModelExport(loaded, exportName);
}

async function assertZedRoundTrip(
  zed: string,
  style?: EmitTypeScriptStyle,
): Promise<{
  readonly emittedTs: string;
  readonly model: AccessModel;
  readonly roundTrippedZed: string;
}> {
  const originalIr = parseZed(zed);
  const emittedTs =
    style === undefined
      ? emitTypeScriptFromZed(zed)
      : emitTypeScriptFromZed(zed, { style });
  expect(emittedTs).not.toMatch(/\bany\b/);
  expect(emittedTs).not.toMatch(/\bas\s+[A-Z]/);

  const exportName = style === "classic" ? "model" : "access";
  const model = await evaluateEmittedModel(emittedTs, exportName);
  const roundTrippedIr = emitAccessIr(model);
  expect(accessIrDefinitionsDiff(originalIr, roundTrippedIr)).toEqual([]);

  const roundTrippedZed = emitZed(model);
  expect(
    accessIrDefinitionsDiff(originalIr, parseZed(roundTrippedZed)),
  ).toEqual([]);
  return { emittedTs, model, roundTrippedZed };
}

const WORKSPACE_TASK_ZED = `
  definition user {}

  definition workspace {
    relation admin: user
    relation member: user
    permission manage = admin
    permission view = admin + member
  }

  definition task {
    relation workspace: workspace
    relation assignee: user
    permission view = assignee + workspace->view
  }
`;

const POLYMORPHIC_ZED = `
  definition user {}

  definition workspace {
    relation viewer: user
    permission view = viewer
  }

  definition folder {
    relation parent: workspace | folder
    relation viewer: user
    permission view = viewer + parent->view
  }

  definition document {
    relation parent: workspace | folder
    relation viewer: user
    permission view = viewer + parent->view
  }
`;

const RECURSIVE_ZED = `
  definition user {}

  definition group {
    relation member: user | group#member
  }

  definition folder {
    relation parent: folder
    relation viewer: user | group#member
    permission view = viewer + parent->view
  }
`;

const PARTIAL_RECURSIVE_ZED = `
  definition user {}

  definition folder {
    relation parent: folder
    relation owner: user
    relation viewer: user
    permission delete = owner
    permission view = viewer + parent->view
  }
`;

const EXPIRATION_ZED = `
  use expiration

  definition user {}

  definition group {
    relation member: user
  }

  definition document {
    relation guest: user | user with expiration
    relation viewer: user with expiration | group#member with expiration
    relation public_share: user:* with expiration
    permission view = guest + viewer + public_share
  }
`;

const INTERSECTION_ARROW_ZED = `
  definition user {}

  definition group {
    relation member: user
    permission is_member = member
  }

  definition folder {
    relation required_group: group
    relation any_group: group
    permission read_all = required_group.all(is_member)
    permission read_any = any_group.any(is_member)
    permission member_arrow = any_group->member
  }
`;

const COMBINATORS_FORWARD_ZED = `
  /* Multi-line header
     describing access rules */
  definition user {}

  /* Forward-referenced userset: document appears before team */
  definition document {
    relation admin: user
    relation editor: user | team#member
    relation banned: user
    relation tenant_open: user:*
    /* Inline comment */
    permission manage = (admin + editor) & tenant_open
    permission view = manage + ((editor) - (banned))
    permission filtered = (admin + editor) - (banned)
  }

  definition team {
    relation member: user // direct member
  }
`;

const MUTUAL_CYCLE_ZED = `
  definition user {}

  definition alpha {
    relation owner: user
    relation linked_beta: beta
    permission view = owner + linked_beta->view
  }

  definition beta {
    relation owner: user
    relation linked_alpha: alpha
    permission view = owner + linked_alpha->view
  }
`;

const NAMESPACED_B2B_ZED = `
  use expiration

  definition user {}

  definition platform {
    relation super_admin: user
    permission administer = super_admin
  }

  definition organizations/organization {
    relation parent_platform: platform
    relation admin: user
    relation member: user
    relation support_agent: user with expiration
    permission manage = admin + parent_platform->administer
    permission view = manage + member + support_agent
  }

  definition organizations/facility {
    relation organization: organizations/organization
    relation manager: user
    relation auditor: user
    relation revoked: user
    permission manage = manager + organization->manage
    permission view = manage + ((auditor) - (revoked)) + organization->view
  }
`;

const RESERVED_COLLISION_IR: readonly AccessIrDefinition[] = [
  { wireName: "user", roles: [], permissions: [] },
  { wireName: "resource", roles: [], permissions: [] },
  {
    wireName: "class",
    roles: [{ name: "delete", subjects: [{ kind: "type", wireName: "user" }] }],
    permissions: [
      { name: "delete", terms: [{ kind: "role", name: "delete" }] },
    ],
  },
  {
    wireName: "work-item",
    roles: [
      { name: "parent", subjects: [{ kind: "type", wireName: "class" }] },
    ],
    permissions: [
      {
        name: "view",
        terms: [
          { kind: "through", roleName: "parent", targetPermission: "delete" },
        ],
      },
    ],
  },
  {
    wireName: "work/item",
    roles: [{ name: "viewer", subjects: [{ kind: "type", wireName: "user" }] }],
    permissions: [{ name: "view", terms: [{ kind: "role", name: "viewer" }] }],
  },
];

describe("emitTypeScript & emitTypeScriptFromZed (ergonomic default)", () => {
  it("emits minimal ergonomic DSL for workspace + task inheritance without zod", async () => {
    const { emittedTs } = await assertZedRoundTrip(WORKSPACE_TASK_ZED);
    expect(emittedTs).toContain(
      'import { actor, compileAccess, resource } from "@dads-framework/access";',
    );
    expect(emittedTs).not.toContain('from "zod"');
    expect(emittedTs).toContain('export const user = actor("user");');
    expect(emittedTs).toContain("manage: admin,");
    expect(emittedTs).toContain("view: [admin, member],");
    expect(emittedTs).toContain("view: [assignee, workspace.view],");
    expect(emittedTs).toContain(
      "export const access = compileAccess([user, workspace, task]);",
    );
  });

  it("round-trips multi-target polymorphic relations (workspace | folder)", async () => {
    const { emittedTs } = await assertZedRoundTrip(POLYMORPHIC_ZED);
    expect(emittedTs).toContain("parents: [workspace],");
    expect(emittedTs).toContain("recursive: true,");
    expect(emittedTs).toContain("parent: [workspace, folder],");
    expect(emittedTs).toContain("view: [viewer, parent.view],");
  });

  it("round-trips recursive folders, partial self-inheritance, and self-referential usersets", async () => {
    const { emittedTs } = await assertZedRoundTrip(RECURSIVE_ZED);
    expect(emittedTs).toContain("recursive: true,");
    expect(emittedTs).toContain("viewer: [user, group.roles.member],");
    expect(emittedTs).toContain(
      '{ kind: "userset", entityWireName: "group", roleName: "member" }',
    );

    const partial = await assertZedRoundTrip(PARTIAL_RECURSIVE_ZED);
    expect(partial.emittedTs).not.toContain("recursive: true");
    expect(partial.emittedTs).toContain("parent: () => folder,");
    expect(partial.emittedTs).toContain("view: [viewer, parent.view],");
  });

  it("round-trips expiring roles, wildcards, and expirable usersets", async () => {
    const { emittedTs, roundTrippedZed } =
      await assertZedRoundTrip(EXPIRATION_ZED);
    expect(emittedTs).toContain("guest: [user, user.expiring],");
    expect(emittedTs).toContain(
      "viewer: [user.expiring, withExpiration(membersOf(group.roles.member))],",
    );
    expect(emittedTs).toContain("public_share: withExpiration(user.anyone),");
    expect(roundTrippedZed).toContain("use expiration");
    expect(roundTrippedZed).toContain(
      "relation guest: user | user with expiration",
    );
    expect(roundTrippedZed).toContain(
      "relation public_share: user:* with expiration",
    );
  });

  it("round-trips intersection arrows (every), .any() arrows, and role-target arrows", async () => {
    const { emittedTs, roundTrippedZed } = await assertZedRoundTrip(
      INTERSECTION_ARROW_ZED,
    );
    expect(emittedTs).toContain("read_all: every(required_group).is_member,");
    expect(emittedTs).toContain("read_any: any_group.is_member,");
    expect(roundTrippedZed).toContain(
      "permission read_all = required_group.all(is_member)",
    );
    expect(roundTrippedZed).toContain(
      "permission read_any = any_group->is_member",
    );
    expect(roundTrippedZed).toContain(
      "permission member_arrow = any_group->member",
    );
  });

  it("round-trips forward usersets, wildcards, allOf, anyOf, .unless(), and sibling permissions", async () => {
    const { emittedTs } = await assertZedRoundTrip(COMBINATORS_FORWARD_ZED);
    expect(emittedTs).toContain("editor: [user, team.roles.member],");
    expect(emittedTs).toContain("tenant_open: user.anyone,");
    expect(emittedTs).toContain("allOf(anyOf(admin, editor), tenant_open),");
    expect(emittedTs).toContain("editor.unless(banned)");
    expect(emittedTs).toContain("anyOf(admin, editor).unless(banned),");
    expect(emittedTs).toContain(
      "export const access = compileAccess([user, document, team]);",
    );
  });

  it("round-trips mutual cross-entity cyclic references", async () => {
    const { emittedTs } = await assertZedRoundTrip(MUTUAL_CYCLE_ZED);
    expect(emittedTs).toContain("linked_alpha: () => alpha,");
    expect(emittedTs).toContain("view: [owner, linked_beta.view],");
    expect(emittedTs).toContain("view: [owner, linked_alpha.view],");
  });

  it("round-trips namespaced B2B schema, reserved words, and colliding wire names", async () => {
    const { emittedTs: b2bTs } = await assertZedRoundTrip(NAMESPACED_B2B_ZED);
    expect(b2bTs).toContain(
      'export const organizationsOrganization = resource("organizations/organization", {',
    );
    expect(b2bTs).toContain("support_agent: user.expiring,");

    const emittedTs = emitTypeScript(RESERVED_COLLISION_IR);
    expect(emittedTs).toContain(
      'export const resourceEntity = actor("resource");',
    );
    expect(emittedTs).toContain(
      'export const classEntity = resource("class", {',
    );
    expect(emittedTs).toContain(
      'export const workItem = resource("work-item", {',
    );
    expect(emittedTs).toContain(
      'export const workItem_2 = resource("work/item", {',
    );

    const model = await evaluateEmittedModel(emittedTs, "access");
    expect(
      accessIrDefinitionsDiff(RESERVED_COLLISION_IR, emitAccessIr(model)),
    ).toEqual([]);
  });

  it("emits minimal ergonomic module for an empty definition list", async () => {
    const emittedTs = emitTypeScript([]);
    expect(emittedTs).toBe(
      'import { compileAccess } from "@dads-framework/access";\n\nexport const access = compileAccess([]);\n',
    );
    const model = await evaluateEmittedModel(emittedTs, "access");
    expect(model.definitions).toEqual([]);
  });

  it("type-checks every emitted ergonomic scenario cleanly under tsc --strict", () => {
    const tcDir = mkdtempSync(join(tempDir, "tsc-strict-"));
    const cases: readonly (readonly [string, string])[] = [
      ["workspace-task.ts", emitTypeScriptFromZed(WORKSPACE_TASK_ZED)],
      ["polymorphic.ts", emitTypeScriptFromZed(POLYMORPHIC_ZED)],
      ["recursive.ts", emitTypeScriptFromZed(RECURSIVE_ZED)],
      ["partial-recursive.ts", emitTypeScriptFromZed(PARTIAL_RECURSIVE_ZED)],
      ["expiration.ts", emitTypeScriptFromZed(EXPIRATION_ZED)],
      ["intersection-arrow.ts", emitTypeScriptFromZed(INTERSECTION_ARROW_ZED)],
      ["combinators.ts", emitTypeScriptFromZed(COMBINATORS_FORWARD_ZED)],
      ["mutual-cycle.ts", emitTypeScriptFromZed(MUTUAL_CYCLE_ZED)],
      ["namespaced-b2b.ts", emitTypeScriptFromZed(NAMESPACED_B2B_ZED)],
      ["reserved-collision.ts", emitTypeScript(RESERVED_COLLISION_IR)],
      ["empty.ts", emitTypeScript([])],
    ];
    for (const [name, source] of cases) {
      writeFileSync(join(tcDir, name), source, "utf8");
    }
    const tsconfigPath = join(tcDir, "tsconfig.json");
    writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noUnusedLocals: false,
            noUnusedParameters: true,
            noEmit: true,
            skipLibCheck: true,
            typeRoots: [resolve(repoRoot, "node_modules/@types")],
            types: ["node"],
            paths: {
              "@dads-framework/access": [accessIndexPath],
            },
          },
          include: ["*.ts"],
        },
        null,
        2,
      ),
      "utf8",
    );
    const result = spawnSync(tscBin, ["--noEmit", "-p", tsconfigPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails with accurate 1-based line numbers on unsupported SpiceDB constructs", () => {
    const withCaveat = [
      "/* line 1",
      " * line 2",
      " * line 3 */",
      "definition user {}",
      "caveat ip_allowlist(ip string) {",
      "  ip == '127.0.0.1'",
      "}",
    ].join("\n");
    expect(() => emitTypeScriptFromZed(withCaveat)).toThrow(/line 5:.*caveat/);

    const withCaveatSubject = [
      "definition user {}",
      "definition doc {",
      "  relation viewer: user with ip_allowlist",
      "}",
    ].join("\n");
    expect(() => emitTypeScriptFromZed(withCaveatSubject)).toThrow(
      /line 3:.*with ip_allowlist/,
    );

    const withNil = [
      "definition user {}",
      "definition doc {",
      "  permission never = nil",
      "}",
    ].join("\n");
    expect(() => emitTypeScriptFromZed(withNil)).toThrow(/line 3:.*nil/);
  });
});

describe('emitTypeScript & emitTypeScriptFromZed ({ style: "classic" })', () => {
  it("preserves exact classic entityHandle + access + accessModel output across schemas", async () => {
    const poly = await assertZedRoundTrip(POLYMORPHIC_ZED, "classic");
    expect(poly.emittedTs).toContain("parent: [workspace, folder]");
    expect(poly.emittedTs).toContain(
      "through(roles.parent, workspaceAccess.permissions.view)",
    );

    const rec = await assertZedRoundTrip(RECURSIVE_ZED, "classic");
    expect(rec.emittedTs).toContain(
      'membersOf(roleToken(group.wireName, "member", group))',
    );
    expect(rec.emittedTs).toContain("membersOf(groupAccess.roles.member)");

    const exp = await assertZedRoundTrip(EXPIRATION_ZED, "classic");
    expect(exp.emittedTs).toContain("withExpiration(user)");
    expect(exp.emittedTs).toContain(
      "withExpiration(membersOf(groupAccess.roles.member))",
    );
    expect(exp.emittedTs).toContain("withExpiration(wildcard(user))");

    const arrow = await assertZedRoundTrip(INTERSECTION_ARROW_ZED, "classic");
    expect(arrow.emittedTs).toContain(
      "throughAll(roles.required_group, groupAccess.permissions.is_member)",
    );
    expect(arrow.emittedTs).toContain(
      "through(roles.any_group, groupAccess.permissions.is_member)",
    );

    const comb = await assertZedRoundTrip(COMBINATORS_FORWARD_ZED, "classic");
    expect(comb.emittedTs).toContain(
      "asPermissionTerm([roles.admin, roles.editor])",
    );
    expect(comb.emittedTs).toContain("excluding(roles.editor, roles.banned)");
    expect(comb.emittedTs).toContain(
      "export const model = accessModel([userAccess, documentAccess, teamAccess]);",
    );

    const b2b = await assertZedRoundTrip(NAMESPACED_B2B_ZED, "classic");
    expect(b2b.emittedTs).toContain(
      'export const organizationsOrganization = entityHandle({ wireName: "organizations/organization", idSchema: z.string().min(1) });',
    );
  });

  it("emits minimal classic module for an empty definition list", async () => {
    const emittedTs = emitTypeScript([], { style: "classic" });
    expect(emittedTs).toBe(
      'import { accessModel } from "@dads-framework/access";\n\nexport const model = accessModel([]);\n',
    );
    const model = await evaluateEmittedModel(emittedTs, "model");
    expect(model.definitions).toEqual([]);
  });
});
