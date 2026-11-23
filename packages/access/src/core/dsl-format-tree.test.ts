import { describe, expect, it } from "vitest";

import { actor, compileAccess, formatAccessTree, resource } from "../index.js";
import { isLookupResourcesAllowed, scopeBindings } from "../scopes.js";

describe("formatAccessTree and compileAccess options", () => {
  it("renders a deterministic ASCII tree via formatAccessTree(model)", () => {
    const user = actor("user");
    const team = resource("team", {
      roles: { member: user },
      can: ({ member }) => ({ view: member }),
    });
    const organization = resource("organization", {
      roles: {
        admin: user,
        guest: user.expiring,
        public_link: user.anyone,
        team_member: team.roles.member,
      },
      can: ({ admin, guest, public_link, team_member }) => ({
        manage: admin,
        view: [admin, guest, public_link, team_member],
      }),
      children: {
        task: {
          inherit: "all",
          roles: { assignee: user },
          can: ({ assignee }) => ({
            view: assignee,
            comment: assignee,
          }),
          children: {
            photo: {
              inherit: "all",
            },
          },
        },
        billing: {
          inherit: ["manage"],
          roles: { accountant: user },
          can: ({ accountant }) => ({ view: accountant }),
        },
      },
    });

    const model = compileAccess([organization]);
    const tree = formatAccessTree(model);

    expect(tree).toBe(
      [
        "actors: user",
        "",
        "organization",
        "├── roles: admin (user), guest (user [expiring]), public_link (user:*), team_member (team#member)",
        "├── can:",
        "│   ├── manage = admin",
        "│   └── view = admin + guest + public_link + team_member",
        "├── task",
        "│   ├── roles: organization (organization), assignee (user)",
        "│   ├── can:",
        "│   │   ├── manage = organization->manage [inherited]",
        "│   │   ├── view = organization->view + assignee [inherited+local]",
        "│   │   └── comment = assignee [local]",
        "│   └── photo",
        "│       ├── roles: task (task)",
        "│       └── can:",
        "│           ├── manage = task->manage [inherited]",
        "│           ├── view = task->view [inherited]",
        "│           └── comment = task->comment [inherited]",
        "└── billing",
        "    ├── roles: organization (organization), accountant (user)",
        "    └── can:",
        "        ├── manage = organization->manage [inherited]",
        "        └── view = accountant [local]",
        "",
        "team",
        "├── roles: member (user)",
        "└── can:",
        "    └── view = member",
      ].join("\n"),
    );
  });

  it("annotates recursive resources in formatAccessTree(model)", () => {
    const user = actor("user");
    const folder = resource("folder", {
      recursive: true,
      roles: { editor: user },
      can: ({ editor }) => ({ edit: editor }),
    });
    const tree = formatAccessTree(compileAccess([folder]));
    expect(tree).toBe(
      [
        "actors: user",
        "",
        "folder (recursive)",
        "├── roles: parent (folder), editor (user)",
        "└── can:",
        "    └── edit = editor + parent->edit",
      ].join("\n"),
    );
  });

  it("attaches migrations, bindings, and allowLookupResourcesOn in compileAccess", () => {
    const user = actor("user");
    const org = resource("organization", {
      roles: { admin: user },
      can: ({ admin }) => ({ view: admin }),
    });
    const record = resource("record", {
      roles: { owner: org },
      can: ({ owner }) => ({ view: owner.view }),
    });

    const binding = scopeBindings(record, {
      owner: { kind: "scope-column" },
    });

    const model = compileAccess([org, record, org], {
      bindings: [binding],
      allowLookupResourcesOn: [org, "organization"],
      migrations: [
        {
          id: "001-rename-owner",
          kind: "rename-relation",
          from: "org",
          to: "owner",
          description: "Rename org relation to owner on record",
        },
      ],
    });

    expect(model.bindings).toHaveLength(1);
    expect(model.lookupResourceAllowlist).toEqual(["organization"]);
    expect(isLookupResourcesAllowed(model, "organization")).toBe(true);
    expect(isLookupResourcesAllowed(model, "record")).toBe(false);
    expect(model.migrations).toEqual([
      {
        id: "001-rename-owner",
        kind: "rename-relation",
        from: "org",
        to: "owner",
        description: "Rename org relation to owner on record",
      },
    ]);
    // Deduplicates repeated org entry cleanly.
    expect(model.definitions.filter((def) => def.entity.wireName === "organization")).toHaveLength(1);

    // Rejects two distinct resources with the same wireName.
    const duplicate = resource("organization", {
      roles: { admin: user },
      can: ({ admin }) => ({ view: admin }),
    });
    expect(() => compileAccess([org, duplicate])).toThrow('duplicate DSL resource wireName "organization"');
  });
});
