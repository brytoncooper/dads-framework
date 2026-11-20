import type { CompiledAuthorizationQuery } from "./compile-postgres-policy.js";
import type {
  AuthorizationModelDefinition,
  CompiledPermissionExpression,
  NormalizedPermissionCheck,
} from "./policy-model.js";
import {
  QueryBuilder,
  relatedEntity,
  subjectReachability,
  TUPLES,
} from "./policy-sql.js";

/** Compact Boolean point evaluation for a policy whose forward expansion is large. */
export function compileSharedPointCheck(
  model: AuthorizationModelDefinition,
  namespace: string,
  check: NormalizedPermissionCheck,
): CompiledAuthorizationQuery & { readonly canPrepare: false } {
  const builder = new QueryBuilder();
  const namespaceSql = builder.value(namespace);
  const subjectKind = builder.value(check.subject.type);
  const subjectId = builder.value(check.subject.id);
  const resourceKind = builder.value(check.resource.type);
  const resourceId = builder.value(check.resource.id);
  const compiled = compileSharedPointPlan(model, builder, {
    namespace: namespaceSql,
    subjectKind,
    subjectId,
    resourceEntity: check.resource.type,
    permission: check.permission,
  });
  return {
    kind: "check",
    canPrepare: false,
    text: `${compiled.withClause}
      SELECT EXISTS (
        SELECT 1 FROM ${compiled.allowed}
        WHERE resource_kind = ${resourceKind} AND resource_id = ${resourceId}
      ) AS allowed`,
    values: builder.values,
  };
}

type SharedPointBinding = {
  readonly namespace: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly resourceEntity: string;
  readonly permission: string;
};

/** Rows retain the actual persisted kind, including on nested arrow edges. */
export function compileSharedPointRows(
  model: AuthorizationModelDefinition,
  builder: QueryBuilder,
  binding: SharedPointBinding,
): string {
  const compiled = compileSharedPointPlan(model, builder, binding);
  return `${compiled.withClause}
    SELECT resource_kind, resource_id FROM ${compiled.allowed}`;
}

function compileSharedPointPlan(
  model: AuthorizationModelDefinition,
  builder: QueryBuilder,
  binding: SharedPointBinding,
): { readonly withClause: string; readonly allowed: string } {
  const compiler = new SharedPointCompiler(model, builder, binding.namespace);
  const allowed = compiler.permission(
    binding.resourceEntity,
    binding.permission,
  );
  const reachable = subjectReachability(
    binding.namespace,
    binding.subjectKind,
    binding.subjectId,
  );
  return {
    withClause: `WITH RECURSIVE ${reachable}, ${compiler.queries.join(",\n")}`,
    allowed,
  };
}

class SharedPointCompiler {
  readonly queries: string[] = [];
  readonly #compiled = new Map<
    string,
    Map<CompiledPermissionExpression, string>
  >();
  readonly #active = new Set<string>();

  constructor(
    private readonly model: AuthorizationModelDefinition,
    private readonly builder: QueryBuilder,
    private readonly namespace: string,
  ) {}

  permission(entity: string, name: string): string {
    const definition = this.model.permissions.find(
      (candidate) => candidate.entity === entity && candidate.wireName === name,
    );
    if (!definition)
      throw new Error(`Postgres policy cannot find permission ${name}.`);
    const identity = `${entity}\u0000${name}`;
    if (this.#active.has(identity))
      throw new Error(
        "Postgres SQL compilation does not support a cycle through permissions.",
      );
    this.#active.add(identity);
    try {
      return this.#expression(entity, definition.expression);
    } finally {
      this.#active.delete(identity);
    }
  }

  #expression(
    entity: string,
    expression: CompiledPermissionExpression,
  ): string {
    let expressions = this.#compiled.get(entity);
    if (expressions === undefined) {
      expressions = new Map();
      this.#compiled.set(entity, expressions);
    }
    const compiled = expressions.get(expression);
    if (compiled !== undefined) return compiled;
    const body = this.#body(entity, expression);
    const alias = `point_policy_${String(this.queries.length)}`;
    this.queries.push(
      `${alias}(resource_kind, resource_id) AS MATERIALIZED (${body})`,
    );
    expressions.set(expression, alias);
    return alias;
  }

  #body(entity: string, expression: CompiledPermissionExpression): string {
    if (expression.kind === "relation") {
      const relation = this.builder.value(expression.relation);
      return `SELECT resource_kind, resource_id FROM subject_reachable WHERE relation = ${relation}`;
    }
    if (expression.kind === "through") {
      return this.#through(entity, expression.relation, expression.permission);
    }
    if (expression.kind === "exclude") {
      const include = this.#expression(entity, expression.include);
      const exclude = this.#expression(entity, expression.exclude);
      return `SELECT * FROM ${include} EXCEPT SELECT * FROM ${exclude}`;
    }
    const operator = expression.kind === "any-of" ? "UNION" : "INTERSECT";
    const children = new Set(
      expression.expressions.map((child) => this.#expression(entity, child)),
    );
    return [...children]
      .map((child) => `SELECT * FROM ${child}`)
      .join(` ${operator} `);
  }

  #through(entity: string, name: string, permission: string): string {
    const related = relatedEntity(this.model, entity, name);
    const child = this.permission(related, permission);
    const relation = this.builder.value(name);

    // A stored direct edge determines the actual target kind in a point
    // check. Keep both columns through the set algebra and constrain the
    // final kind only at the requested resource.
    return `SELECT DISTINCT parent.resource_kind, parent.resource_id
      FROM ${child} reached
      CROSS JOIN LATERAL (
        SELECT tuple.resource_kind, tuple.resource_id
        FROM ${TUPLES} tuple
        WHERE tuple.namespace = ${this.namespace}
          AND tuple.subject_kind = reached.resource_kind
          AND tuple.subject_id = reached.resource_id
          AND tuple.relation = ${relation}
          AND tuple.subject_is_wildcard = false
          AND tuple.subject_relation = ''
        OFFSET 0
      ) parent`;
  }
}
