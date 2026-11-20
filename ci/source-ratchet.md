# Standalone TypeScript ratchet

A repository can adopt Dads' code-health ceilings by installing Toolbox as a
development dependency. It needs a Git checkout and a tracked TypeScript
project. It does not need a Dads project manifest or a starter.

Stage the TypeScript files and their project config. From the repository root,
run the locally installed command and review the result:

```sh
npx --no-install dad baseline init --reason "Existing source debt at adoption"
npx --no-install dad doctor --gate
```

Commit `.agents/source-budgets.json` and `.agents/source-ratchet.json`. The first
records each existing violation as a measure, key, number, and reason. Replace
the initial adoption reason with a specific explanation where you have one.
After fixing debt, run `npx --no-install dad doctor --update` and commit the
downward changes with the source fix.

The policy defaults to Dads' strict code-health ceilings. To start with a
different ceiling, create `.agents/source-ratchet.json` before initialization.
Override only the measures you intend to change. For example:

```json
{
  "schemaVersion": 1,
  "thresholds": {
    "fileLines": 350,
    "testFileLines": 550
  }
}
```

The profile measures file and test length, oversized functions, explicit
`any`, type assertions, non-null assertions, interface declarations, and
unexplained or misplaced suppressions. It has no floors for package, test, or
documentation counts.

## Check a change in CI

Land the initial policy and baseline on the protected target branch. For
each proposed change, check out the proposed tree, install locked dependencies,
and make the trusted target commit available through Git. Run:

```sh
npm ci
npx --no-install dad doctor --gate --base "$BASE_REF"
```

`BASE_REF` is the target commit or another locally available trusted ref, such
as `origin/main`. Use the exact target commit when the runner gives you one.
Missing Git history fails the gate. The command measures the proposed code
and rejects added or raised exceptions, changed thresholds or exclusions,
missing reasons, and added ESLint suppressions. It accepts dropping an
exception once the source is healthy or deleted. Review policy changes
separately through your repository's protected maintenance process.

The [GitHub Actions example](./github-actions/source-ratchet.yml) supplies a base
commit to the same command. Copy the command into any runner that can fetch the
base and install the repository's dependencies.
