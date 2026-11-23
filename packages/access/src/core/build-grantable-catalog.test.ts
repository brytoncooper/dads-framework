import { describe, expect, it } from "vitest";

import { buildGrantableCatalog, catalogOnly, grantable, type GrantableCatalogEntry } from "../catalog.js";
import { actor, allOf, anyOf, compileAccess, resource } from "../index.js";

describe("buildGrantableCatalog()", () => {
  it("builds a validated catalog from resource(), grantable(), catalogOnly(), and compileAccess()", () => {
    const user = actor("user");
    const permissionSet = resource("permission_set", {
      roles: { member: user },
    });

    const systemAudit = catalogOnly({
      id: "billing.system_audit",
      label: { en: "System audit", es: "Auditoria del sistema" },
      description: { en: "System-only audit capability." },
      domainId: "billing",
      domainLabel: { en: "Billing" },
      scopes: ["ORGANIZATION"],
      entityWireName: "invoice",
      roleName: "system_auditor",
      permission: "audit",
    });

    const workspace = resource("workspace", {
      roles: {
        admin: user,
        project_editor: grantable({
          directSubject: user,
          groupSubject: permissionSet.roles.member,
          id: "projects.edit",
          label: { en: "Edit projects", es: "Editar proyectos" },
          description: { en: "Create and update projects." },
          group: {
            name: "projects",
            label: { en: "Projects" },
            description: { en: "Project workspace permissions." },
            order: 1,
          },
          domainId: "projects",
          domainLabel: { en: "Projects" },
          requires: ["projects.view"],
          scopes: ["WORKSPACE"],
          targetKind: "RESOURCE",
          risk: "STANDARD",
          permission: "edit",
        }),
        project_viewer: grantable({
          directSubject: user,
          id: "projects.view",
          label: { en: "View projects" },
          description: { en: "Read project records." },
          group: {
            name: "projects",
            label: { en: "Projects" },
            description: { en: "Project workspace permissions." },
            order: 1,
          },
          domainId: "projects",
          domainLabel: { en: "Projects" },
          scopes: ["WORKSPACE"],
          permission: "view",
        }),
      },
      can: ({ admin, project_editor, project_viewer }) => ({
        edit: [admin, project_editor],
        view: [admin, project_editor, project_viewer],
      }),
    });

    const invoice = resource("invoice", {
      roles: {
        admin: user,
        billing_approver: grantable({
          directSubject: user,
          id: "billing.approve",
          label: { en: "Approve invoices" },
          description: { en: "Approve outgoing customer invoices." },
          group: {
            name: "invoices",
            label: { en: "Invoices" },
            order: 2,
          },
          domainId: "billing",
          domainLabel: { en: "Billing" },
          scopes: ["ORGANIZATION"],
          risk: "DANGEROUS",
          permission: "approve",
        }),
      },
      can: ({ admin, billing_approver }) => ({
        approve: [admin, billing_approver],
      }),
      catalogOnly: [systemAudit],
    });

    const model = compileAccess([workspace, invoice]);
    const fromModel = buildGrantableCatalog(model);
    const fromDefinitions = buildGrantableCatalog(model.definitions);

    expect(fromModel).toEqual(fromDefinitions);
    expect(fromModel).toEqual<readonly GrantableCatalogEntry[]>([
      {
        id: "billing.approve",
        domainId: "billing",
        domainLabel: { en: "Billing" },
        label: { en: "Approve invoices" },
        description: { en: "Approve outgoing customer invoices." },
        placement: {
          groupId: "invoices",
          groupLabel: { en: "Invoices" },
          groupOrder: 2,
        },
        requires: [],
        allowedScopes: ["ORGANIZATION"],
        targetKind: "NONE",
        risk: "DANGEROUS",
        customerAssignable: true,
        bindings: [
          {
            scope: "ORGANIZATION",
            entityWireName: "invoice",
            roleName: "billing_approver",
            permission: "approve",
          },
        ],
      },
      {
        id: "billing.system_audit",
        domainId: "billing",
        domainLabel: { en: "Billing" },
        label: { en: "System audit", es: "Auditoria del sistema" },
        description: { en: "System-only audit capability." },
        placement: null,
        requires: [],
        allowedScopes: ["ORGANIZATION"],
        targetKind: "NONE",
        risk: "DANGEROUS",
        customerAssignable: false,
        bindings: [
          {
            scope: "ORGANIZATION",
            entityWireName: "invoice",
            roleName: "system_auditor",
            permission: "audit",
          },
        ],
      },
      {
        id: "projects.edit",
        domainId: "projects",
        domainLabel: { en: "Projects" },
        label: { en: "Edit projects", es: "Editar proyectos" },
        description: { en: "Create and update projects." },
        placement: {
          groupId: "projects",
          groupLabel: { en: "Projects" },
          groupDescription: { en: "Project workspace permissions." },
          groupOrder: 1,
        },
        requires: ["projects.view"],
        allowedScopes: ["WORKSPACE"],
        targetKind: "RESOURCE",
        risk: "STANDARD",
        customerAssignable: true,
        bindings: [
          {
            scope: "WORKSPACE",
            entityWireName: "workspace",
            roleName: "project_editor",
            permission: "edit",
          },
        ],
      },
      {
        id: "projects.view",
        domainId: "projects",
        domainLabel: { en: "Projects" },
        label: { en: "View projects" },
        description: { en: "Read project records." },
        placement: {
          groupId: "projects",
          groupLabel: { en: "Projects" },
          groupDescription: { en: "Project workspace permissions." },
          groupOrder: 1,
        },
        requires: [],
        allowedScopes: ["WORKSPACE"],
        targetKind: "NONE",
        risk: "STANDARD",
        customerAssignable: true,
        bindings: [
          {
            scope: "WORKSPACE",
            entityWireName: "workspace",
            roleName: "project_viewer",
            permission: "view",
          },
        ],
      },
    ]);
  });

  it("merges duplicate catalog IDs across scopes when metadata matches identically", () => {
    const user = actor("user");

    const sharedMeta = {
      directSubject: user,
      id: "document.edit",
      label: { en: "Edit documents" },
      description: { en: "Modify documents." },
      group: { name: "documents", label: { en: "Documents" }, order: 1 },
      domainId: "documents",
      domainLabel: { en: "Documents" },
      targetKind: "RESOURCE" as const,
      risk: "STANDARD" as const,
      permission: "edit",
    };

    const workspace = resource("workspace", {
      roles: {
        doc_editor: [
          user,
          grantable({
            ...sharedMeta,
            requires: ["document.view", "workspace.member"],
            scopes: ["WORKSPACE"],
          }),
        ],
      },
      can: ({ doc_editor }) => ({ edit: doc_editor }),
    });

    const document = resource("document", {
      roles: {
        editor: grantable({
          ...sharedMeta,
          requires: ["workspace.member", "document.view"],
          scopes: ["DOCUMENT", "WORKSPACE"],
        }),
      },
      can: ({ editor }) => ({ edit: editor }),
    });

    const catalog = buildGrantableCatalog(compileAccess([workspace, document]));
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toEqual({
      id: "document.edit",
      domainId: "documents",
      domainLabel: { en: "Documents" },
      label: { en: "Edit documents" },
      description: { en: "Modify documents." },
      placement: {
        groupId: "documents",
        groupLabel: { en: "Documents" },
        groupOrder: 1,
      },
      requires: ["document.view", "workspace.member"],
      allowedScopes: ["DOCUMENT", "WORKSPACE"],
      targetKind: "RESOURCE",
      risk: "STANDARD",
      customerAssignable: true,
      bindings: [
        {
          scope: "DOCUMENT",
          entityWireName: "document",
          roleName: "editor",
          permission: "edit",
        },
        {
          scope: "WORKSPACE",
          entityWireName: "document",
          roleName: "editor",
          permission: "edit",
        },
        {
          scope: "WORKSPACE",
          entityWireName: "workspace",
          roleName: "doc_editor",
          permission: "edit",
        },
      ],
    });
  });

  it("throws a clear error on metadata conflicts for duplicate catalog IDs, domains, or groups", () => {
    const user = actor("user");

    const baseRole = {
      directSubject: user,
      id: "project.delete",
      label: { en: "Delete projects" },
      description: { en: "Permanently remove projects." },
      group: { name: "projects", label: { en: "Projects" }, order: 1 },
      domainId: "projects",
      domainLabel: { en: "Projects" },
      scopes: ["WORKSPACE"],
      permission: "delete",
    };

    const workspace = resource("workspace", {
      roles: {
        deleter: grantable({ ...baseRole, risk: "STANDARD" }),
      },
      can: ({ deleter }) => ({ delete: deleter }),
    });

    const project = resource("project", {
      roles: {
        deleter: grantable({ ...baseRole, scopes: ["PROJECT"], risk: "DANGEROUS" }),
      },
      can: ({ deleter }) => ({ delete: deleter }),
    });

    expect(() => buildGrantableCatalog(compileAccess([workspace, project]))).toThrow(
      /Conflicting catalog metadata for "project\.delete".*risk/,
    );

    const conflictingGroupA = resource("alpha", {
      roles: {
        viewer: grantable({
          directSubject: user,
          id: "projects.alpha",
          label: { en: "Alpha" },
          description: { en: "Alpha access" },
          group: {
            name: "shared_group",
            label: { en: "Shared" },
            description: { en: "Description A" },
            order: 1,
          },
          domainId: "projects",
          domainLabel: { en: "Projects" },
          scopes: ["WORKSPACE"],
          permission: "view",
        }),
      },
      can: ({ viewer }) => ({ view: viewer }),
    });

    const conflictingGroupB = resource("beta", {
      roles: {
        viewer: grantable({
          directSubject: user,
          id: "projects.beta",
          label: { en: "Beta" },
          description: { en: "Beta access" },
          group: {
            name: "shared_group",
            label: { en: "Shared" },
            description: { en: "Description B" },
            order: 1,
          },
          domainId: "projects",
          domainLabel: { en: "Projects" },
          scopes: ["WORKSPACE"],
          permission: "view",
        }),
      },
      can: ({ viewer }) => ({ view: viewer }),
    });

    expect(() => buildGrantableCatalog(compileAccess([conflictingGroupA, conflictingGroupB]))).toThrow(
      /Conflicting group placement for group "shared_group" in domain "projects"/,
    );

    const conflictingDomainB = resource("gamma", {
      roles: {
        viewer: grantable({
          directSubject: user,
          id: "projects.gamma",
          label: { en: "Gamma" },
          description: { en: "Gamma access" },
          group: null,
          domainId: "projects",
          domainLabel: { en: "Different Domain Label" },
          scopes: ["WORKSPACE"],
          permission: "view",
        }),
      },
      can: ({ viewer }) => ({ view: viewer }),
    });

    expect(() => buildGrantableCatalog(compileAccess([conflictingGroupA, conflictingDomainB]))).toThrow(
      /Conflicting domainLabel for domain "projects"/,
    );
  });

  it("validates localized labels, group placement, scopes, and resolves expression-backed permissions", () => {
    const user = actor("user");

    const emptyLabel = resource("bad_label", {
      roles: {
        editor: grantable({
          directSubject: user,
          id: "bad.label",
          label: { en: "   " },
          description: { en: "Desc" },
          group: null,
          domainId: "core",
          domainLabel: { en: "Core" },
          scopes: ["WORKSPACE"],
          permission: "edit",
        }),
      },
      can: ({ editor }) => ({ edit: editor }),
    });
    expect(() => buildGrantableCatalog(compileAccess([emptyLabel]))).toThrow(/"label\.en" must be a non-empty string/);

    const emptyLocales = resource("no_locales", {
      roles: {
        editor: grantable({
          directSubject: user,
          id: "bad.locales",
          label: {},
          description: { en: "Desc" },
          group: null,
          domainId: "core",
          domainLabel: { en: "Core" },
          scopes: ["WORKSPACE"],
          permission: "edit",
        }),
      },
      can: ({ editor }) => ({ edit: editor }),
    });
    expect(() => buildGrantableCatalog(compileAccess([emptyLocales]))).toThrow(/at least one locale entry/);

    const badGroupOrder = resource("bad_group", {
      roles: {
        editor: grantable({
          directSubject: user,
          id: "bad.group",
          label: { en: "Edit" },
          description: { en: "Desc" },
          group: { name: "grp", label: { en: "Group" }, order: Number.NaN },
          domainId: "core",
          domainLabel: { en: "Core" },
          scopes: ["WORKSPACE"],
          permission: "edit",
        }),
      },
      can: ({ editor }) => ({ edit: editor }),
    });
    expect(() => buildGrantableCatalog(compileAccess([badGroupOrder]))).toThrow(
      /"group\.order" must be a finite number/,
    );

    const emptyScopes = resource("bad_scopes", {
      roles: {
        editor: grantable({
          directSubject: user,
          id: "bad.scopes",
          label: { en: "Edit" },
          description: { en: "Desc" },
          group: null,
          domainId: "core",
          domainLabel: { en: "Core" },
          scopes: [],
          permission: "edit",
        }),
      },
      can: ({ editor }) => ({ edit: editor }),
    });
    expect(() => buildGrantableCatalog(compileAccess([emptyScopes]))).toThrow(/"scopes" must not be empty/);

    // When permission is blank, expressions referencing the role (outside unless) are resolved.
    const inferredPerm = resource("inferred_perm", {
      roles: {
        admin: user,
        blocked: user,
        reviewer: grantable({
          directSubject: user,
          id: "review.approve",
          label: { en: "Approve" },
          description: { en: "Approve items" },
          group: null,
          domainId: "reviews",
          domainLabel: { en: "Reviews" },
          scopes: ["WORKSPACE"],
          permission: "",
        }),
      },
      can: ({ admin, blocked, reviewer }) => ({
        approve: allOf(anyOf(admin, reviewer), admin).unless(blocked),
        unrelated: admin.unless(reviewer),
      }),
    });

    const inferredCatalog = buildGrantableCatalog(compileAccess([inferredPerm]));
    expect(inferredCatalog[0]?.bindings).toEqual([
      {
        scope: "WORKSPACE",
        entityWireName: "inferred_perm",
        roleName: "reviewer",
        permission: "approve",
      },
    ]);
  });

  it("sorts entries deterministically by domainId, groupOrder (unset/null last), groupId, and id", () => {
    const user = actor("user");

    const makeRole = (id: string, domainId: string, group: { readonly name: string; readonly order?: number } | null) =>
      grantable({
        directSubject: user,
        id,
        label: { en: id },
        description: { en: `Description for ${id}` },
        group:
          group === null
            ? null
            : {
                name: group.name,
                label: { en: group.name },
                ...(group.order === undefined ? {} : { order: group.order }),
              },
        domainId,
        domainLabel: { en: domainId },
        scopes: ["WORKSPACE"],
        permission: "view",
      });

    const resA = resource("res_a", {
      roles: {
        r1: makeRole("b.null_b", "domain_a", null),
        r2: makeRole("b.null_a", "domain_a", null),
        r3: makeRole("b.unset_z", "domain_a", { name: "z_group" }),
        r4: makeRole("b.unset_a", "domain_a", { name: "a_group" }),
        r5: makeRole("b.order2", "domain_a", { name: "first_alpha", order: 2 }),
        r6: makeRole("b.order1_b", "domain_a", { name: "zebra", order: 1 }),
        r7: makeRole("b.order1_a", "domain_a", { name: "zebra", order: 1 }),
      },
      can: ({ r1 }) => ({ view: r1 }),
    });

    const resB = resource("res_b", {
      roles: {
        r1: makeRole("z.item", "domain_b", { name: "main", order: 1 }),
      },
      can: ({ r1 }) => ({ view: r1 }),
    });

    const forward = buildGrantableCatalog(compileAccess([resA, resB]));
    const reversed = buildGrantableCatalog(compileAccess([resB, resA]));

    expect(forward.map((entry) => entry.id)).toEqual([
      "b.order1_a",
      "b.order1_b",
      "b.order2",
      "b.unset_a",
      "b.unset_z",
      "b.null_a",
      "b.null_b",
      "z.item",
    ]);
    expect(reversed).toEqual(forward);
  });
});
