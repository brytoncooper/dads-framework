# Dads Access Formal Verification (`formal/access-proofs`)

Machine-checked Lean 4 proofs and a native differential oracle verifying the
semantics and compiler optimizations of `@dads-framework/access`,
`@dads-framework/postgres-access`, and `@dads-framework/sqlite-access`.

## Proved Theorems (`DadsAccess/Proofs.lean`)

All **25 theorems** compile under Lean 4 (`v4.36.0`) with zero `sorry`s and zero
custom axioms (only standard kernel axioms `propext`, `Classical.choice`, and
`Quot.sound`):

| Theorem                                                                                                                                                       | What it proves                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expired_tuple_not_active`, `expired_tuple_absent_from_active`                                                                                                | Tuples with `expiresAt <= now` never participate in any check or lookup.                                                                                                                            |
| `unknown_perm_fails_closed`, `unknown_perm_lookup_empty`                                                                                                      | Undeclared permissions always evaluate to `false` and return `[]`.                                                                                                                                  |
| `throughAll_vacuous_fails_closed`                                                                                                                             | `every(rel).perm` fails closed (`false`) when a resource has zero active `rel` edges.                                                                                                               |
| `per_relation_userset_shortcut_sound`                                                                                                                         | For any schema-valid store (`StoreValid`), direct PK membership (`directMember`) equals full recursive userset membership (`UsersetMember`) whenever the relation declares no `subjectSet` targets. |
| `forward_reverse_equiv`, `compileFilter_row_equiv`                                                                                                            | Actor-first `lookupResources` / `compileFilter` returns the exact same set of allowed rows as forward `check`.                                                                                      |
| `scope_columns_through_sound`, `scope_columns_anyOf_unless_sound`, `multi_scope_columns_sound`                                                                | Rewriting one or arbitrarily many `through(rel, p)` branches onto app-table foreign-key columns (`scopeColumns`) preserves exact semantics, including under `anyOf` and `unless` (`exclude`).       |
| `resolve_filter_branch_pruning_sound`, `resolve_filter_empty_false`                                                                                           | Pruning empty include/exclude branches in `resolveFilter` (and short-circuiting to `FALSE` when all include branches are empty) is 100% equivalent to evaluating every branch.                      |
| `evalExprWith_monotone`, `stepPermVal_monotone`, `iterPermVal_ascending`, `iterPermVal_monotone_fuel`, `iterPermVal_le_fixed_point`, `iterPermVal_stabilizes` | Monotonic expressions form a Kleene ascending chain bounded above by every pre-fixed point (unique least fixed point — cycles never self-justify) and remain invariant once stabilized.             |
| `unless_dominance`, `unless_dominates_anyOf`                                                                                                                  | Explicit `.unless()` exclusions always dominate: if the excluded branch holds, access is `false` regardless of direct grants, wildcards, groups, or inherited parent folders.                       |
| `revocation_no_escalation`, `revocation_check_no_escalation`                                                                                                  | Deleting any subset of tuples (`store.filter keep`) can only preserve or shrink access on positive policies — revocation can never escalate privileges.                                             |
| `namespace_isolation_check`, `namespace_isolation_lookup`                                                                                                     | Adding or mutating arbitrary tuples in any other namespace (`ns' != ns`) cannot affect any `check` or `lookupResources` decision in namespace `ns`.                                                 |

## Running the Proofs and Differential Oracles

```sh
cd formal/access-proofs
lake build
```

Building produces `.lake/build/bin/dads-access-oracle`, a native binary compiled
directly from the verified Lean 4 reference evaluator (`DadsAccess/Semantics.lean`).
The TypeScript differential fuzzers verify all three engines (Pure-TS
`InMemoryAuthorization`, SQLite, and live PostgreSQL) against the Lean 4 oracle,
including randomized AST schema generation (set `LEAN_FUZZ_SCHEMAS=1000` for
deep fuzz campaigns):

```sh
npx vitest run packages/access/src/testing/lean4-differential.test.ts
npx vitest run packages/server/sqlite-access/src/lean4-differential.test.ts packages/server/sqlite-access/src/random-schema-lean4.test.ts
npx vitest run packages/server/postgres-access/src/lean4-differential.integration.test.ts packages/server/postgres-access/src/random-schema-lean4.integration.test.ts
```
