import type { CompiledAuthorizationQuery } from "./compile-postgres-policy.js";
import type {
  AuthorizationModelDefinition,
  CompiledArrowTarget,
  CompiledPermissionExpression,
  NormalizedPermissionCheck,
} from "./policy-model.js";
import {
  analyzePermissionCycles,
  type PermissionCyclePlan,
  type RecursiveSccPlan,
} from "./permission-cycles.js";
import { compileRecursiveSharedBody } from "./compile-recursive-policy.js";
import {
  isPolymorphicRelation,
  notExpired,
  permissionIdentity,
  QueryBuilder,
  resolveArrowTargets,
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
  const cycles = analyzePermissionCycles(model);
  const compiler = new SharedPointCompiler(
    model,
    cycles,
    builder,
    binding.namespace,
  );
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
  readonly #sccAliases = new Map<string, string>();
  readonly #sccNodeAliases = new Map<string, string>();
  readonly #active = new Set<string>();

  constructor(
    private readonly model: AuthorizationModelDefinition,
    private readonly cycles: PermissionCyclePlan,
    private readonly builder: QueryBuilder,
    private readonly namespace: string,
  ) {}

  permission(entity: string, name: string): string {
    const definition = this.model.permissions.find(
      (candidate) => candidate.entity === entity && candidate.wireName === name,
    );
    if (!definition)
      throw new Error(`Postgres policy cannot find permission ${name}.`);
    const scc = this.cycles.sccFor(entity, name);
    if (scc !== undefined) return this.#sccPermission(scc, entity, name);
    const identity = permissionIdentity(entity, name);
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

  #sccPermission(scc: RecursiveSccPlan, entity: string, name: string): string {
    const identity = permissionIdentity(entity, name);
    const existing = this.#sccNodeAliases.get(identity);
    if (existing !== undefined) return existing;
    const cteName = this.#compileScc(scc);
    const alias = `point_policy_${String(this.queries.length)}`;
    const entitySql = this.builder.value(entity);
    const permSql = this.builder.value(name);
    this.queries.push(
      `${alias}(resource_kind, resource_id) AS MATERIALIZED (SELECT resource_kind, resource_id FROM ${cteName} WHERE resource_kind = ${entitySql} AND permission_name = ${permSql})`,
    );
    this.#sccNodeAliases.set(identity, alias);
    return alias;
  }

  #compileScc(scc: RecursiveSccPlan): string {
    const existing = this.#sccAliases.get(scc.id);
    if (existing !== undefined) return existing;
    const baseAliases = new Map<string, string>();
    for (const node of scc.nodes) {
      if (node.base !== undefined) {
        baseAliases.set(
          node.identity,
          this.#expression(node.entity, node.base),
        );
      }
    }
    const guardAliases = new Map<CompiledPermissionExpression, string>();
    for (const edge of scc.edges) {
      for (const guard of edge.guards) {
        if (!guardAliases.has(guard)) {
          guardAliases.set(guard, this.#expression(edge.fromEntity, guard));
        }
      }
    }
    const cteName = `rec_policy_${String(this.queries.length)}`;
    const body = compileRecursiveSharedBody({
      builder: this.builder,
      namespace: this.namespace,
      cteName,
      scc,
      baseAliases,
      guardAliases,
    });
    this.queries.push(
      `${cteName}(resource_kind, resource_id, permission_name) AS (${body})`,
    );
    this.#sccAliases.set(scc.id, cteName);
    return cteName;
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
      const targets = resolveArrowTargets(this.model, entity, expression);
      const polymorphic = isPolymorphicRelation(
        this.model,
        entity,
        expression.relation,
      );
      return this.#through(expression.relation, targets, polymorphic);
    }
    if (expression.kind === "through-all") {
      const targets = resolveArrowTargets(this.model, entity, expression);
      const polymorphic = isPolymorphicRelation(
        this.model,
        entity,
        expression.relation,
      );
      return this.#throughAll(expression.relation, targets, polymorphic);
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

  #through(
    name: string,
    targets: readonly CompiledArrowTarget[],
    polymorphic: boolean,
  ): string {
    const branches = targets.map((target) =>
      this.#throughBranch(name, target, polymorphic),
    );
    return branches.length === 1 && branches[0] !== undefined
      ? branches[0]
      : branches.map((branch) => `(${branch})`).join(" UNION ");
  }

  #throughBranch(
    name: string,
    target: CompiledArrowTarget,
    polymorphic: boolean,
  ): string {
    const child = this.permission(target.entity, target.permission);
    const relation = this.builder.value(name);
    const kindMatch = polymorphic
      ? `reached.resource_kind = ${this.builder.value(target.entity)} AND tuple.subject_kind = reached.resource_kind`
      : "tuple.subject_kind = reached.resource_kind";
    return `SELECT DISTINCT parent.resource_kind, parent.resource_id
      FROM ${child} reached
      CROSS JOIN LATERAL (
        SELECT tuple.resource_kind, tuple.resource_id
        FROM ${TUPLES} tuple
        WHERE tuple.namespace = ${this.namespace}
          AND ${kindMatch}
          AND tuple.subject_id = reached.resource_id
          AND tuple.relation = ${relation}
          AND tuple.subject_is_wildcard = false
          AND tuple.subject_relation = ''
          AND ${notExpired("tuple")}
        OFFSET 0
      ) parent`;
  }

  #throughAll(
    name: string,
    targets: readonly CompiledArrowTarget[],
    polymorphic: boolean,
  ): string {
    const compiledTargets = targets.map((target) => ({
      target,
      child: this.permission(target.entity, target.permission),
    }));
    const relation = this.builder.value(name);
    const candidateBranches = compiledTargets.map(({ target, child }) => {
      const kindMatch = polymorphic
        ? `reached.resource_kind = ${this.builder.value(target.entity)} AND tuple.subject_kind = reached.resource_kind`
        : "tuple.subject_kind = reached.resource_kind";
      return `SELECT DISTINCT parent.resource_kind, parent.resource_id
        FROM ${child} reached
        CROSS JOIN LATERAL (
          SELECT tuple.resource_kind, tuple.resource_id
          FROM ${TUPLES} tuple
          WHERE tuple.namespace = ${this.namespace}
            AND ${kindMatch}
            AND tuple.subject_id = reached.resource_id
            AND tuple.relation = ${relation}
            AND tuple.subject_is_wildcard = false
            AND tuple.subject_relation = ''
            AND ${notExpired("tuple")}
          OFFSET 0
        ) parent`;
    });
    const allowedParentChecks = compiledTargets.map(({ target, child }) => {
      if (!polymorphic) {
        return `EXISTS (SELECT 1 FROM ${child} allowed_parent WHERE allowed_parent.resource_kind = all_tuple.subject_kind AND allowed_parent.resource_id = all_tuple.subject_id)`;
      }
      const targetKind = this.builder.value(target.entity);
      return `(all_tuple.subject_kind = ${targetKind} AND EXISTS (SELECT 1 FROM ${child} allowed_parent WHERE allowed_parent.resource_kind = ${targetKind} AND allowed_parent.resource_id = all_tuple.subject_id))`;
    });
    return `SELECT DISTINCT candidate.resource_kind, candidate.resource_id
      FROM (${candidateBranches.join(" UNION ")}) candidate
      WHERE NOT EXISTS (
        SELECT 1
        FROM ${TUPLES} all_tuple
        WHERE all_tuple.namespace = ${this.namespace}
          AND all_tuple.resource_kind = candidate.resource_kind
          AND all_tuple.resource_id = candidate.resource_id
          AND all_tuple.relation = ${relation}
          AND all_tuple.subject_is_wildcard = false
          AND all_tuple.subject_relation = ''
          AND ${notExpired("all_tuple")}
          AND NOT (${allowedParentChecks.join(" OR ")})
      )`;
  }
}
