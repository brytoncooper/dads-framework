/**
 * The last nine issues `DAD.md` raises, from people-pleasing to the rules Dad
 * holds himself to. Text only: every sentence is quoted from `DAD.md` and every
 * cure and question from `docs/daddy-issues.md`, so a reader can diff this file
 * against those documents line by line.
 *
 * `issue-catalog-attachment.ts` carries the first eight. The split is the file
 * ceiling `files-over-ceiling` measures, nothing else.
 */

import { ESLINT_DISABLE_MARK, TS_EXPECT_ERROR_MARK, TS_IGNORE_MARK } from "./hatch-names.js";
import type { DaddyIssue } from "./issues.js";

export const ENFORCEMENT_ISSUES: readonly DaddyIssue[] = [
  {
    id: "people-pleasing",
    title: "People-pleasing",
    anchor: "#people-pleasing",
    sentence: "Existence is not a prize you owe a stranger. Dad said just 404.",
    questions: [
      { signals: ["forbidden-403"], text: "Does any route return 403?" },
      {
        signals: ["denial-with-body"],
        text: "Does a denial response carry a message beyond the envelope?",
      },
      {
        signals: ["multi-shape-responses"],
        text: "Is a route's output a union, or does its handler return more than one shape?",
      },
      {
        signals: ["optional-creep"],
        text: "Is the share of optional fields in output schemas above the profile's threshold?",
      },
      {
        signals: ["deprecated-still-consumed"],
        text: "Does a `@deprecated` export still have importers?",
      },
      {
        signals: ["loose-contract-objects"],
        text: "Does a published request shape use `z.object` or `z.looseObject` without a comment naming the authority that allows it?",
      },
      {
        signals: ["raw-errors-in-ui"],
        text: "Does a renderer show a failure's raw message instead of copy it chose for the failure's code?",
      },
    ],
    cure: "One output schema per route, one envelope, and a denial that returns 404 with no body; the shape is the contract, so a change to it is a diff.",
  },
  {
    id: "you-stay-with-people-who-cannot-meet-you",
    title: "You stay with people who cannot meet you",
    anchor: "#you-stay-with-people-who-cannot-meet-you",
    sentence: "Moving out is not a boundary. A contract is.",
    questions: [
      {
        signals: ["controlling-peers"],
        text: "Does any peer dependency pin engines or a Node version?",
      },
      {
        signals: ["transport-at-root"],
        text: "Is fastify or express imported outside the http-server adapter?",
      },
      {
        signals: ["shared-database"],
        text: "Does more than one package open the same database client?",
      },
      {
        signals: ["shared-catchall"],
        text: "Is there a package named `shared`, `common`, or `utils` with more than three importers?",
      },
      {
        signals: ["unmaintained-dependencies"],
        text: "Has any dependency's last publish been more than 24 months ago?",
      },
    ],
    cure: "Every vendor enters through one adapter package that names it, and the kind matrix makes reaching around that package a build failure.",
  },
  {
    id: "commitment-issues",
    title: "Commitment issues",
    anchor: "#commitment-issues",
    sentence: "You went no-contact with tests, then checked their status every five minutes in CI.",
    questions: [
      {
        signals: ["mutations-without-ownership"],
        text: "Does a create route write no ownership tuple and carry no ownership proof?",
      },
      {
        signals: ["todo-check-permission", "todo-age"],
        text: "Is there a TODO or FIXME mentioning permission or auth within twenty lines of a route, or older than the profile's threshold?",
      },
      {
        signals: ["denial-tests-zero"],
        text: "Does a package with protected routes have no denial test or denial proof?",
      },
      {
        signals: ["skipped-tests"],
        text: "Is any `it.only`, `it.skip`, or `it.todo` present?",
      },
      {
        signals: ["test-count"],
        text: "Has any package's passing test count fallen below its recorded floor?",
      },
      {
        signals: ["access-without-denial-test"],
        text: "Does a package that publishes a generated access schema have no test proving a denial?",
      },
      {
        signals: ["sequential-authz-writes"],
        text: "Does a function insert a row and write its relationships as a separate step, rather than handing the facts to the insert's transaction?",
      },
    ],
    cure: "A mutation writes its ownership tuple and proves a denial by executing one, and the passing test count per package is a floor that may only rise.",
  },
  {
    id: "gaslighting",
    title: "Gaslighting",
    anchor: "#gaslighting",
    sentence: "If you need the euphemism to live with it, you already know.",
    questions: [
      {
        signals: ["baseline-entries-without-reason"],
        text: "Does any ratchet baseline entry have an empty or boilerplate reason?",
      },
      {
        signals: ["exempt-globs"],
        text: "Does a baseline exemption cover anything beyond generated files?",
      },
      {
        signals: ["suppressions-without-description"],
        text: `Is there an \`${ESLINT_DISABLE_MARK}\` with no reason, or a \`${TS_EXPECT_ERROR_MARK}\` whose description is under ten characters?`,
      },
      {
        signals: ["marks-raised-in-history"],
        text: "Does the baseline's history contain a diff where a ceiling mark went up or a floor came down?",
      },
      {
        signals: ["migrations-edited"],
        text: "Was a migration the base line already holds modified, deleted, or renamed by a commit past the base?",
      },
      {
        signals: ["generated-tables-hand-edited", "generated-access-hand-edited"],
        text: "Was a generated table module or a generated access schema changed in a commit that changed nothing it is generated from?",
      },
    ],
    cure: "Every exception carries a reason and the baseline may only ever move toward its threshold; the comparison against a git ref, not trust, enforces it.",
  },
  {
    id: "the-silent-treatment",
    title: "The silent treatment",
    anchor: "#the-silent-treatment",
    sentence: "That is not a boundary. That is refusing to talk about it.",
    questions: [
      {
        signals: ["suppressed-violations"],
        text: "Does the suppressions file hold more entries than its recorded ceiling?",
      },
      {
        signals: ["suppression-age"],
        text: "Is any suppression older than 90 days with no downward move?",
      },
      {
        signals: ["unused-suppressions"],
        text: "Does the suppressions file list a rule and file that no longer produce a violation?",
      },
      {
        signals: ["ts-suppressions"],
        text: `Is there a \`${TS_IGNORE_MARK}\`, a \`@ts-nocheck\`, or a \`${TS_EXPECT_ERROR_MARK}\` outside \`type-tests/\`?`,
      },
    ],
    cure: "An exception is written down, dated, given a reason, and only ever allowed to shrink; the record is written and read by the tool, never by hand.",
  },
  {
    id: "failure-to-launch",
    title: "Failure to launch",
    anchor: "#failure-to-launch",
    sentence: "You don’t need another reorganization. You need a strict profile.",
    questions: [
      {
        signals: ["logic-in-controllers"],
        text: "Does a route handler exceed the profile's statement threshold, or import persistence directly?",
      },
      {
        signals: ["packages-without-surface"],
        text: "Does a package declaring `publishConfig` have no api report?",
      },
      {
        signals: ["lists-without-filter"],
        text: "Does a list route have no query schema?",
      },
      {
        signals: ["strict-profile-absent"],
        text: "Does an application with routes make no strict-profile assertion?",
      },
      {
        signals: ["reorganization-churn"],
        text: "Is the share of rename-only commits in the last 90 days above the profile's threshold?",
      },
    ],
    cure: "Behavior gets a named owner with a published surface, and the surface report is regenerated in the same change that alters it.",
  },
  {
    id: "its-not-you-its-my-boundaries",
    title: "“It’s not you. It’s my boundaries.”",
    anchor: "#its-not-you-its-my-boundaries",
    sentence: "A boundary is not a vibe. It is a place a change has to stop.",
    questions: [
      {
        signals: ["kinds-undeclared"],
        text: "Does any package declare no `kind`?",
      },
      {
        signals: ["hooks-not-wired"],
        text: "Is `core.hooksPath` unset, or are the hooks it names missing?",
      },
      {
        signals: ["ci-without-verify"],
        text: "Does no CI workflow run the gate?",
      },
      {
        signals: ["rules-at-warn", "lint-rules"],
        text: "Does `eslint --print-config` resolve any rule at `warn`?",
      },
      {
        signals: ["compiler-flags-off"],
        text: "Is any strictness flag from the base list missing from the compiler configuration?",
      },
      {
        signals: ["no-verify-in-scripts", "force-push-in-workflows"],
        text: "Does the commit-hook bypass appear in a script, document, or workflow, or does any workflow force-push the default branch?",
      },
      {
        signals: ["rows-sent-whole"],
        text: "Does response code spread, return, or send a whole row, or bind an object rest, instead of naming each field it sends?",
      },
      {
        signals: ["cross-domain-foreign-keys"],
        text: "When `strictForeignKeys: true` is set in `dads.project.json`, does any domain migration declare a SQL foreign key referencing a table owned by a different domain?",
      },
    ],
    cure: "The declaration is one file, every rule is an error or is not a rule, and the same gate runs at edit time, at commit, at push, and in CI, with the bypass denied before the shell sees it.",
  },
  {
    id: "the-paper-wall",
    title: "The paper wall",
    anchor: "#the-paper-wall",
    sentence: "You built a door in the hallway and left the wall out.",
    questions: [
      {
        signals: ["wrapper-without-conformance"],
        text: "Does a package presented as an adapter, port, or boundary have no conformance suite that more than one provider runs?",
      },
      {
        signals: ["no-in-memory-provider"],
        text: "Does a capability have exactly one implementer and no in-memory stand-in?",
      },
      {
        signals: ["vendor-types-in-surface"],
        text: "Does a vendor type, error, or identifier appear in the emitted surface on the consumer side of the boundary?",
      },
      {
        signals: ["provider-chosen-outside-root"],
        text: "Is the provider constructed anywhere other than the composition root?",
      },
    ],
    cure: "`core` defines the capability in its own words, at least two providers implement it, and one conformance suite runs against both; a provider that cannot be stood in for in memory has not been bounded.",
  },
  {
    id: "dad-has-issues-too",
    title: "Dad has issues too",
    anchor: "#dad-has-issues-too",
    sentence: "A no that cannot explain itself is a no the kids will route around.",
    questions: [
      {
        signals: ["rules-at-warn"],
        text: "Does any lint rule resolve at `warn`?",
      },
      {
        signals: ["thresholds-raised"],
        text: "Has any threshold been raised, or any floor lowered, in the baseline's history?",
      },
      {
        signals: ["guards-fail-closed"],
        text: "Does any guard block a change when its own tool is missing, rather than failing open?",
      },
      {
        signals: ["stagnant-debt"],
        text: "Is any baseline entry older than the profile's threshold whose mark never moved?",
      },
      {
        signals: ["nondeterministic-generated-files"],
        text: "Does any generated file churn without its input changing?",
      },
      {
        signals: ["hook-runtime"],
        text: "How much of the runtime budget do local Git hooks typically use?",
      },
      {
        signals: ["doctor-cases"],
        text: "Does any rule fail to name the change it stops, or ship without a case that trips it?",
      },
    ],
    cure: "Every rule names the change it stops and ships with a case that trips it; nothing sits at `warn`; a missing tool fails open; and every ratchet entry carries a reason and a direction it must move.",
  },
];
