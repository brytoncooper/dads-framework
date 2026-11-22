# Dads Access Formal Verification (`formal/access-proofs`)

Machine-checked Lean 4 proofs and a native differential oracle verifying the
semantics and compiler optimizations of `@dads-framework/access`,
`@dads-framework/postgres-access`, and `@dads-framework/sqlite-access`.

## Proved Theorems (`DadsAccess/Proofs.lean`)

Every theorem compiles under Lean 4 (`v4.36.0`) with zero `sorry`s and zero
custom axioms (only standard kernel axioms `propext`, `Classical.choice`, and
`Quot.sound`):

| Theorem                                                                  | What it proves                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expired_tuple_not_active`, `expired_tuple_absent_from_active`           | Tuples with `expiresAt <= now` never participate in any check or lookup.                                                                                                                            |
| `unknown_perm_fails_closed`, `unknown_perm_lookup_empty`                 | Undeclared permissions always evaluate to `false` and return `[]`.                                                                                                                                  |
| `throughAll_vacuous_fails_closed`                                        | `every(rel).perm` fails closed (`false`) when a resource has zero active `rel` edges.                                                                                                               |
| `per_relation_userset_shortcut_sound`                                    | For any schema-valid store (`StoreValid`), direct PK membership (`directMember`) equals full recursive userset membership (`UsersetMember`) whenever the relation declares no `subjectSet` targets. |
| `forward_reverse_equiv`, `compileFilter_row_equiv`                       | Actor-first `lookupResources` / `compileFilter` returns the exact same set of allowed rows as forward `check`.                                                                                      |
| `scope_columns_through_sound`, `scope_columns_anyOf_unless_sound`        | Rewriting `through(rel, p)` onto an app table's foreign-key column (`scopeColumns`) preserves exact semantics, including under `anyOf` and `unless` (`exclude`).                                    |
| `resolve_filter_branch_pruning_sound`, `resolve_filter_empty_false`      | Pruning empty include/exclude branches in `resolveFilter` (and short-circuiting to `FALSE` when all include branches are empty) is 100% equivalent to evaluating every branch.                      |
| `evalExprWith_monotone`, `stepPermVal_monotone`, `iterPermVal_ascending` | Monotonic expressions form a Kleene ascending chain, guaranteeing unique least-fixed-point convergence on arbitrary cyclic tuple graphs and diamond DAGs.                                           |

## Running the Proofs and Differential Oracle

```sh
cd formal/access-proofs
lake build
```

Building produces `.lake/build/bin/dads-access-oracle`, a native binary compiled
directly from the verified Lean 4 reference evaluator (`DadsAccess/Semantics.lean`).
The TypeScript differential fuzzers run randomized cyclic worlds (wildcards,
nested group cycles, recursive folder cycles, expirations, `allOf`, `unless`,
`every`, `scopeColumns`, and `resolveFilter`) against real PostgreSQL and real
SQLite and assert 100% agreement with the Lean 4 oracle:

```sh
npx vitest run packages/server/sqlite-access/src/lean4-differential.test.ts
npx vitest run packages/server/postgres-access/src/lean4-differential.integration.test.ts
```
