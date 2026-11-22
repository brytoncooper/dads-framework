import {
  emitAccessIr,
  type AccessIrDefinition,
  type AccessModel,
} from "@dads-framework/access";
import type {
  AuthorizationModelDefinition,
  CompiledAuthorizationPermission,
  CompiledAuthorizationRelation,
} from "./policy/policy-model.js";

import {
  lowerPermissions,
  type PermissionLowering,
} from "./lower-permissions.js";
import {
  compileColumnRelations,
  type ColumnRelationBinding,
} from "./policy/column-relations.js";
import { analyzePermissionCycles } from "./policy/permission-cycles.js";

export type CompiledAccessPolicy = {
  readonly model: AuthorizationModelDefinition;
  /** The engine's permission name for an authored permission or direct relation. */
  permissionName(entity: string, name: string): string | undefined;
};

export function compileAccessPolicy(
  access: AccessModel,
  columnRelations?: readonly ColumnRelationBinding[],
): CompiledAccessPolicy {
  const definitions = emitAccessIr(access);
  const byName = new Map(definitions.map((entry) => [entry.wireName, entry]));
  const generated = new Map(
    definitions.map((entry) => [entry.wireName, rolePermissions(entry)]),
  );
  const baseModel: AuthorizationModelDefinition = {
    entities: definitions.map((entry, index) => ({
      wireName: entry.wireName,
      sourceName: `entity_${index}`,
    })),
    relations: definitions.flatMap(lowerRelations),
    permissions: definitions.flatMap((entry) =>
      compiledPermissions(entry, { byName, generated }),
    ),
    lifecycle: [],
  };
  const compiledColumns = compileColumnRelations(baseModel, columnRelations);
  const model: AuthorizationModelDefinition =
    compiledColumns.length === 0
      ? baseModel
      : { ...baseModel, columnRelations: compiledColumns };
  analyzePermissionCycles(model);
  return {
    model,
    permissionName: (entity, name) => {
      const definition = byName.get(entity);
      if (definition?.permissions.some((entry) => entry.name === name))
        return name;
      return generated.get(entity)?.get(name);
    },
  };
}

function lowerRelations(
  definition: AccessIrDefinition,
): readonly CompiledAuthorizationRelation[] {
  return definition.roles.map((role, index) => ({
    authority: "system",
    entity: definition.wireName,
    sourceName: `relation_${index}`,
    wireName: role.name,
    targets: role.subjects.map((subject) => {
      if (subject.kind === "userset") {
        return {
          kind: "subject-set",
          entity: subject.wireName,
          relation: subject.relation,
        };
      }
      return {
        kind: subject.kind === "type" ? "entity" : "wildcard",
        entity: subject.wireName,
      };
    }),
  }));
}

function compiledPermissions(
  definition: AccessIrDefinition,
  context: PermissionLowering,
): readonly CompiledAuthorizationPermission[] {
  const authored = lowerPermissions(definition, context);
  const wrappers =
    context.generated.get(definition.wireName) ?? new Map<string, string>();
  return [
    ...authored,
    ...[...wrappers].map(
      ([relation, wireName], index): CompiledAuthorizationPermission => ({
        entity: definition.wireName,
        sourceName: `relation_permission_${index}`,
        wireName,
        expression: { kind: "relation", relation },
      }),
    ),
  ];
}

function rolePermissions(
  definition: AccessIrDefinition,
): ReadonlyMap<string, string> {
  const names = new Set([
    ...definition.roles.map((entry) => entry.name),
    ...definition.permissions.map((entry) => entry.name),
  ]);
  const wrappers = new Map<string, string>();
  let suffix = 0;
  for (const role of definition.roles) {
    let generated: string;
    do {
      generated = `dads_relation_${suffix}`;
      suffix += 1;
    } while (names.has(generated));
    wrappers.set(role.name, generated);
  }
  return wrappers;
}
