/**
 * The first eight issues `DAD.md` raises, from the escape hatches to the
 * babysitter. Text only: every sentence is quoted from `DAD.md` and every cure
 * and question from `docs/daddy-issues.md`, so a reader can diff this file
 * against those documents line by line.
 *
 * `issue-catalog-enforcement.ts` carries the last nine. The split is the file
 * ceiling `files-over-ceiling` measures, nothing else.
 */

import { ESLINT_DISABLES_SIGNAL, ESLINT_DISABLE_MARK, TS_EXPECT_ERROR_MARK, TS_IGNORE_MARK } from "./hatch-names.js";
import type { DaddyIssue } from "./issues.js";

export const ATTACHMENT_ISSUES: readonly DaddyIssue[] = [
  {
    id: "daddy-issues",
    title: "Daddy issues",
    anchor: "#daddy-issues",
    sentence: "You can smell a fatherless codebase. The `any`s. The hope.",
    questions: [
      {
        signals: ["explicit-any"],
        text: "Does any hand-written file annotate a value `any`, or write `as any`?",
      },
      {
        signals: ["type-assertions", "non-null-assertions"],
        text: "Does any hand-written file use `as` other than `as const`, or a postfix `!`?",
      },
      {
        signals: ["ts-suppressions"],
        text: `Is there a \`${TS_IGNORE_MARK}\` or \`@ts-nocheck\`, or a \`${TS_EXPECT_ERROR_MARK}\` outside a \`type-tests/\` directory?`,
      },
      {
        signals: [ESLINT_DISABLES_SIGNAL],
        text: `Does any TypeScript file carry an \`${ESLINT_DISABLE_MARK}\` comment?`,
      },
    ],
    cure: "Each hatch is a lint error rather than a preference, and the count of each is a ratchet ceiling locked at zero.",
  },
  {
    id: "anxious-attachment",
    title: "Anxious attachment",
    anchor: "#anxious-attachment",
    sentence:
      "Fear of abandonment is not love. It is a foreign type that crossed the boundary because being alone with an interface felt worse.",
    questions: [
      {
        signals: ["kind-inversions"],
        text: "Does any workspace dependency edge violate the kind matrix?",
      },
      {
        signals: ["vendor-outside-adapter"],
        text: "Is a vendor module imported outside the integration package declaring it?",
      },
      {
        signals: ["vendor-types-in-surface"],
        text: "Does an emitted `.d.ts` name a type from outside its package and its allowed dependencies?",
      },
      {
        signals: ["copied-types"],
        text: "Is the same exported type name declared in more than one package with a similar shape?",
      },
      {
        signals: ["duplicated-helpers"],
        text: "Is the same function name defined in more than one production file of one package?",
      },
    ],
    cure: "Every package declares its kind and allowed dependencies in one place, and a program compares imports, manifest, and emitted surface against it.",
  },
  {
    id: "avoidant-attachment",
    title: "Avoidant attachment",
    anchor: "#avoidant-attachment",
    sentence: "You will not be known, so you keep no contracts.",
    questions: [
      {
        signals: ["routes-without-schema"],
        text: "Does any route blueprint lack an input or an output schema?",
      },
      {
        signals: ["routes-without-access"],
        text: "Does any route blueprint carry no access declaration?",
      },
      {
        signals: ["responses-outside-envelope"],
        text: "Does any handler return a raw array or object rather than the envelope?",
      },
      {
        signals: ["readme-missing", "readme-nonconformant"],
        text: "Does any package lack a README, or carry one outside the template?",
      },
      {
        signals: ["invariants-missing"],
        text: "Does any non-artifact package lack an `INVARIANTS.md`?",
      },
    ],
    cure: "A route without a schema and an access declaration does not register, and README and invariants coverage is a floor that may rise and never fall.",
  },
  {
    id: "disorganized-attachment",
    title: "Disorganized attachment",
    anchor: "#disorganized-attachment",
    sentence: "The compiler is not confused. The compiler is the only one being honest with you.",
    questions: [
      {
        signals: ["interface-type-mix"],
        text: "Does any file declare an `interface` where the house rule is `type`?",
      },
      {
        signals: ["unparsed-boundary-reads"],
        text: "Is the result of a boundary read used without passing through a parser in the same function?",
      },
      {
        signals: ["duplicate-wire-schemas"],
        text: "Do two schemas describe one wire shape?",
      },
      {
        signals: ["assertions-in-tests"],
        text: "Does any test file use `as`?",
      },
      {
        signals: ["jsonb-without-schema"],
        text: "Does a `jsonb` column carry no `.$type<T>()`, or one whose type is not a named, imported or declared type?",
      },
      {
        signals: ["migrations-out-of-order"],
        text: "Is a migration added past the base stamped older than its journal's newest on the base, or does one state prerequisites the runner cannot satisfy?",
      },
    ],
    cure: "One representation per wire shape, every boundary read parsed at the read, and the assertion rules applied in test and type-test scopes too.",
  },
  {
    id: "enmeshment",
    title: "Enmeshment",
    anchor: "#enmeshment",
    sentence: "Dad’s answer is not a bigger house. It is a wall. One responsibility per file.",
    questions: [
      {
        signals: ["files-over-ceiling", "test-files-over-ceiling"],
        text: "Does any source file exceed 400 counted lines, or any test file 600?",
      },
      {
        signals: ["functions-over-ceiling"],
        text: "Does any production function exceed complexity 10, 20 statements, depth 3, or 2 nested callbacks?",
      },
      {
        signals: ["barrel-impurity"],
        text: "Does a package's `src/index.ts` contain a statement that is not `export ... from`?",
      },
      {
        signals: ["intra-package-cycles"],
        text: "Is there an import cycle inside a package?",
      },
      {
        signals: ["rust-inline-tests", "clippy-allows"],
        text: "In Rust, is there a `#[cfg(test)] mod tests` outside `tests.rs`, or an `#[allow(clippy::` mark in production?",
      },
    ],
    cure: "One responsibility per file, with a counted-line ceiling per file and per function that only ever moves down; splitting is the only way past it.",
  },
  {
    id: "you-are-looking-for-a-father-figure",
    title: "You are looking for a father figure",
    anchor: "#you-are-looking-for-a-father-figure",
    sentence: "A vendor can implement a capability. It cannot tell you what the capability _is_.",
    questions: [
      {
        signals: ["framework-in-core"],
        text: "Does a `core` package import a framework or ORM?",
      },
      {
        signals: ["vendor-named-domain"],
        text: "Does any domain type extend or alias a vendor type?",
      },
      {
        signals: ["stale-docs"],
        text: "Is a document that cites code untouched for longer than the profile's threshold while the code it cites changed?",
      },
      {
        signals: ["scripture"],
        text: "Does a package with no recorded invariants have one author holding more than 80% of its commits?",
      },
      {
        signals: ["hardcoded-ui-copy"],
        text: "Does a renderer in a package that uses a copy catalog write customer-visible words inline?",
      },
    ],
    cure: "`core` names the capability in its own words and the kind matrix keeps vendors out of it; every rule that matters is a program, not a precedent.",
  },
  {
    id: "you-repeat-the-cycle",
    title: "You repeat the cycle",
    anchor: "#you-repeat-the-cycle",
    sentence: "Latchkey routes. Nobody home. No access declaration. Dinner is `console.log`.",
    questions: [
      {
        signals: ["tenant-column-authorization"],
        text: "For every table or column named like a tenant, is it used as the access check in a `WHERE` clause rather than a relationship lookup?",
      },
      {
        signals: ["role-if-ladders"],
        text: "Does an `if` or `switch` branch on a role outside the authorization model?",
      },
      {
        signals: ["per-feature-authorization"],
        text: "Is a function named `authorize*`, `can*`, or `isAllowed*` defined outside the authorization package?",
      },
      {
        signals: ["latchkey-routes"],
        text: "Does a route carry no access declaration?",
      },
      {
        signals: ["console-in-production", "junk-drawer-directories"],
        text: "Is there a `console.*` call outside scripts and tests, or a directory named `helpers/`, `utils/`, `common/`, `misc/`, or `shared/`?",
      },
    ],
    cure: "Access is a relationship check against one authorization model and no feature package declares its own; a directory with no owner is not a place to put code.",
  },
  {
    id: "you-let-the-babysitter-raise-them",
    title: "You let the babysitter raise them",
    anchor: "#you-let-the-babysitter-raise-them",
    sentence: "So the house has to say no out loud, in a form he can run.",
    questions: [
      {
        signals: ["agent-entrypoint-missing"],
        text: "Is there no agent entrypoint — `AGENTS.md` or equivalent — at the repository root?",
      },
      {
        signals: ["entrypoint-over-budget"],
        text: "Do the entrypoint or the skills exceed their recorded token budgets?",
      },
      {
        signals: ["agent-hooks-unwired"],
        text: "Is no edit-time guard wired for any agent harness?",
      },
      {
        signals: ["orphan-paths"],
        text: "Is there a file `dad orient` cannot assign to an owning package?",
      },
    ],
    cure: "The house rules are one entrypoint under a measured budget, and the same checks run at edit time, at commit, and in CI.",
  },
];
