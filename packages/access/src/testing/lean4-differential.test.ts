import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

import { actor, allOf, anyOf, compileAccess, emitAccessIr, every, resource, roleToken } from "../index.js";
import type { AccessIrDefinition, AccessIrTerm } from "../core/ir.js";
import type { PermissionQuery, RelationshipWrite } from "../runtime/authorization.js";
import { InMemoryAuthorization } from "./in-memory-authorization.js";

const ORACLE_BIN = path.resolve(
  import.meta.dirname,
  "../../../../formal/access-proofs/.lake/build/bin/dads-access-oracle",
);

function callLeanOracle(payload: unknown): {
  readonly checks: readonly boolean[];
  readonly lookups: readonly (readonly string[])[];
} {
  const stdout = execFileSync(ORACLE_BIN, {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed: unknown = JSON.parse(stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("checks" in parsed) ||
    !("lookups" in parsed) ||
    !Array.isArray(parsed.checks) ||
    !Array.isArray(parsed.lookups)
  ) {
    throw new Error("Unexpected Lean 4 oracle output shape");
  }
  return {
    checks: parsed.checks.map((entry) => Boolean(entry)),
    lookups: parsed.lookups.map((list) => (Array.isArray(list) ? list.map(String) : [])),
  };
}

function makeRng(seed: number) {
  let state = seed >>> 0;
  return (bound: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % bound;
  };
}

function lowerTermForOracle(
  term: AccessIrTerm,
  entityWireName: string,
  definitionsByName: ReadonlyMap<string, AccessIrDefinition>,
): unknown {
  const currentDef = definitionsByName.get(entityWireName);
  switch (term.kind) {
    case "role":
      return { kind: "relation", relation: term.name };
    case "permission": {
      const targetPerm = currentDef?.permissions.find((perm) => perm.name === term.name);
      if (targetPerm === undefined) return { kind: "any-of", expressions: [] };
      return {
        kind: "any-of",
        expressions: targetPerm.terms.map((child) => lowerTermForOracle(child, entityWireName, definitionsByName)),
      };
    }
    case "through":
    case "through-all": {
      const role = currentDef?.roles.find((entry) => entry.name === term.roleName);
      const targets = (role?.subjects ?? [])
        .filter((subject) => subject.kind === "type")
        .map((subject) => ({
          entity: subject.wireName,
          permission: term.targetPermission,
        }));
      return {
        kind: term.kind,
        relation: term.roleName,
        targets,
      };
    }
    case "gated":
      return {
        kind: "all-of",
        expressions: [
          lowerTermForOracle(term.term, entityWireName, definitionsByName),
          lowerTermForOracle(term.condition, entityWireName, definitionsByName),
        ],
      };
    case "both":
      return {
        kind: "all-of",
        expressions: [
          lowerTermForOracle(term.left, entityWireName, definitionsByName),
          lowerTermForOracle(term.right, entityWireName, definitionsByName),
        ],
      };
    case "excluding":
      return {
        kind: "exclude",
        include: lowerTermForOracle(term.term, entityWireName, definitionsByName),
        exclude: lowerTermForOracle(term.banned, entityWireName, definitionsByName),
      };
    case "or":
      return {
        kind: "any-of",
        expressions: term.terms.map((child) => lowerTermForOracle(child, entityWireName, definitionsByName)),
      };
  }
}

function buildAdversarialSchema() {
  const user = actor("user");
  const groupMemberRef = roleToken("fuzz/group", "member", user.handle);
  const group = resource("fuzz/group", {
    roles: {
      member: [user.expiring, user.anyone.expiring, groupMemberRef],
    },
    can: ({ member }) => ({ read: member }),
  });
  const workspace = resource("fuzz/workspace", {
    roles: {
      owner: user.expiring,
      member: [user.expiring, group.roles.member.expiring, user.anyone.expiring],
      banned: user,
    },
    can: ({ owner, member, banned }) => ({
      view: anyOf(owner, member).unless(banned),
    }),
  });
  const folder = resource("fuzz/folder", {
    parents: [workspace],
    recursive: true,
    roles: {
      viewer: [user.expiring, group.roles.member.expiring],
    },
    can: ({ parents, viewer }) => ({
      view: anyOf(viewer, parents.view),
    }),
  });
  const document = resource("fuzz/document", {
    parents: [workspace, folder],
    roles: {
      viewer: [user.expiring, group.roles.member.expiring, user.anyone.expiring],
      approver: user,
      banned: user,
    },
    can: ({ parents, viewer, approver, banned }) => ({
      view: anyOf(parents.view, viewer).unless(banned),
      strict_view: every(parents).view,
      publish: allOf(viewer, approver).unless(banned),
    }),
  });
  return compileAccess([user, group, workspace, folder, document]);
}

function generateRandomWrites(
  seed: number,
  nowMs: number,
  users: readonly string[],
  groups: readonly string[],
  workspaces: readonly string[],
  folders: readonly string[],
  documents: readonly string[],
): readonly RelationshipWrite[] {
  const pick = makeRng(seed);
  const maybeExpiry = (): { readonly expiresAt?: Date } => {
    const roll = pick(5);
    if (roll === 0) return { expiresAt: new Date(nowMs - 60_000) };
    if (roll === 1) return { expiresAt: new Date(nowMs + 3_600_000) };
    return {};
  };
  const writes: RelationshipWrite[] = [];

  for (const groupId of groups) {
    if (pick(2) === 0) {
      writes.push({
        resource: { type: "fuzz/group", id: groupId },
        relation: "member",
        subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
        ...maybeExpiry(),
      });
    }
    if (pick(2) === 0) {
      writes.push({
        resource: { type: "fuzz/group", id: groupId },
        relation: "member",
        subject: {
          type: "fuzz/group",
          id: groups[pick(groups.length)] ?? "g0",
          relation: "member",
        },
      });
    }
    if (pick(6) === 0) {
      writes.push({
        resource: { type: "fuzz/group", id: groupId },
        relation: "member",
        subject: { type: "user", id: "*" },
        ...maybeExpiry(),
      });
    }
  }

  for (const workspaceId of workspaces) {
    if (pick(2) === 0) {
      writes.push({
        resource: { type: "fuzz/workspace", id: workspaceId },
        relation: "owner",
        subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
        ...maybeExpiry(),
      });
    }
    if (pick(2) === 0) {
      writes.push({
        resource: { type: "fuzz/workspace", id: workspaceId },
        relation: "member",
        subject: {
          type: "fuzz/group",
          id: groups[pick(groups.length)] ?? "g0",
          relation: "member",
        },
        ...maybeExpiry(),
      });
    }
    if (pick(5) === 0) {
      writes.push({
        resource: { type: "fuzz/workspace", id: workspaceId },
        relation: "banned",
        subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
      });
    }
  }

  for (const folderId of folders) {
    if (pick(2) === 0) {
      writes.push({
        resource: { type: "fuzz/folder", id: folderId },
        relation: "parent",
        subject: {
          type: "fuzz/workspace",
          id: workspaces[pick(workspaces.length)] ?? "w0",
        },
      });
    }
    if (pick(2) === 0) {
      writes.push({
        resource: { type: "fuzz/folder", id: folderId },
        relation: "parent",
        subject: {
          type: "fuzz/folder",
          id: folders[pick(folders.length)] ?? "f0",
        },
      });
    }
    if (pick(3) === 0) {
      writes.push({
        resource: { type: "fuzz/folder", id: folderId },
        relation: "viewer",
        subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
        ...maybeExpiry(),
      });
    }
  }

  for (const docId of documents) {
    if (pick(2) === 0) {
      writes.push({
        resource: { type: "fuzz/document", id: docId },
        relation: "parent",
        subject: {
          type: "fuzz/workspace",
          id: workspaces[pick(workspaces.length)] ?? "w0",
        },
      });
    }
    if (pick(2) === 0) {
      writes.push({
        resource: { type: "fuzz/document", id: docId },
        relation: "parent",
        subject: {
          type: "fuzz/folder",
          id: folders[pick(folders.length)] ?? "f0",
        },
      });
    }
    if (pick(2) === 0) {
      writes.push({
        resource: { type: "fuzz/document", id: docId },
        relation: "viewer",
        subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
        ...maybeExpiry(),
      });
    }
    if (pick(3) === 0) {
      writes.push({
        resource: { type: "fuzz/document", id: docId },
        relation: "approver",
        subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
      });
    }
    if (pick(4) === 0) {
      writes.push({
        resource: { type: "fuzz/document", id: docId },
        relation: "banned",
        subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
      });
    }
  }

  return writes;
}

it.runIf(existsSync(ORACLE_BIN))(
  "InMemoryAuthorization matches formally verified Lean 4 oracle across 50 randomized cyclic worlds",
  () => {
    const model = buildAdversarialSchema();
    const irDefinitions = emitAccessIr(model);
    const definitionsByName = new Map(irDefinitions.map((definition) => [definition.wireName, definition]));
    const oracleModel = {
      relations: irDefinitions.flatMap((definition) =>
        definition.roles.map((role) => ({
          entity: definition.wireName,
          wireName: role.name,
          targets: role.subjects.map((subject) => {
            if (subject.kind === "wildcard") {
              return { kind: "wildcard", entity: subject.wireName };
            }
            if (subject.kind === "userset") {
              return {
                kind: "subject-set",
                entity: subject.wireName,
                relation: subject.relation,
              };
            }
            return { kind: "entity", entity: subject.wireName };
          }),
        })),
      ),
      permissions: irDefinitions.flatMap((definition) =>
        definition.permissions.map((permission) => ({
          entity: definition.wireName,
          wireName: permission.name,
          expression:
            permission.terms.length === 1 && permission.terms[0] !== undefined
              ? lowerTermForOracle(permission.terms[0], definition.wireName, definitionsByName)
              : {
                  kind: "any-of",
                  expressions: permission.terms.map((term) =>
                    lowerTermForOracle(term, definition.wireName, definitionsByName),
                  ),
                },
        })),
      ),
    };

    const nowMs = 1_700_000_000_000;
    const users = ["u0", "u1", "u2", "u3"];
    const groups = ["g0", "g1", "g2"];
    const workspaces = ["w0", "w1", "w2"];
    const folders = ["f0", "f1", "f2", "f3"];
    const documents = ["d0", "d1", "d2", "d3", "d4", "d5"];
    const permissions = ["view", "strict_view", "publish"] as const;
    let totalQueriesVerified = 0;

    for (let seed = 1; seed <= 50; seed += 1) {
      const authorization = new InMemoryAuthorization(model, {
        startTime: nowMs,
      });
      const writes = generateRandomWrites(seed * 131, nowMs, users, groups, workspaces, folders, documents);
      authorization.writeRelationshipsSync(writes);

      const checkQueries: PermissionQuery[] = [];
      for (const userId of users) {
        for (const docId of documents) {
          for (const permission of permissions) {
            checkQueries.push({
              subject: { type: "user", id: userId },
              resource: { type: "fuzz/document", id: docId },
              permission,
            });
          }
        }
      }
      const lookupSpecs = users.flatMap((userId) =>
        permissions.map((permission) => ({
          subjectKind: "user",
          subjectId: userId,
          resourceKind: "fuzz/document",
          permission,
          universe: documents,
        })),
      );

      const oracle = callLeanOracle({
        model: oracleModel,
        tuples: authorization.listStoredTuples().map((tuple) => ({
          resourceKind: tuple.resourceType,
          resourceId: tuple.resourceId,
          relation: tuple.relation,
          subjectKind: tuple.subjectType,
          subjectId: tuple.subjectId,
          subjectRelation: tuple.subjectRelation,
          subjectIsWildcard: tuple.subjectIsWildcard,
          expiresAt: tuple.expiresAtMs,
        })),
        now: nowMs,
        checks: checkQueries.map((query) => ({
          subjectKind: query.subject.type,
          subjectId: query.subject.id,
          resourceKind: query.resource.type,
          resourceId: query.resource.id,
          permission: query.permission,
        })),
        lookups: lookupSpecs,
      });

      const batchResults = authorization.checkManySync(checkQueries);
      expect(batchResults).toEqual(oracle.checks);
      totalQueriesVerified += batchResults.length;

      for (let index = 0; index < lookupSpecs.length; index += 1) {
        const spec = lookupSpecs[index];
        if (spec === undefined) continue;
        const actualIds = authorization.lookupResourcesSync({
          subject: { type: spec.subjectKind, id: spec.subjectId },
          resourceType: spec.resourceKind,
          permission: spec.permission,
        });
        expect([...actualIds].sort()).toEqual([...(oracle.lookups[index] ?? [])].sort());
        totalQueriesVerified += 1;
      }
    }

    console.log(
      JSON.stringify({
        lean4DifferentialOracle: "in-memory-ts",
        worlds: 50,
        totalQueriesVerified,
        mismatches: 0,
      }),
    );
  },
  60_000,
);
