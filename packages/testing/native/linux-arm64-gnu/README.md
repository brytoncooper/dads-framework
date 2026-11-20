# Dads Testing native runtime (Linux arm64, glibc)

This package contains the platform-native `dad-test` executable used by
`@dads-framework/testing` on Linux arm64 with glibc.

## Try it

Use a POSIX shell and Node.js 22 or newer in an empty directory on Linux arm64 with glibc.
Normally, npm selects this runtime when you install
[`@dads-framework/testing`](../../core/README.md). Use this direct install
after the public release when optional dependencies are unavailable.

```sh
node -p 'process.platform + "-" + process.arch'
getconf GNU_LIBC_VERSION
npm init -y
npm install --save-dev @dads-framework/testing-native-linux-arm64-gnu
binary=$(node -p 'require.resolve("@dads-framework/testing-native-linux-arm64-gnu")')
printf '%s\n' "$binary"
test -x "$binary" && printf 'Executable found\n'

cat > dads.testing.json <<'JSON'
{
  "schemaVersion": 1,
  "workspace": { "root": ".", "fullFallback": { "taskIds": ["app:test"] } },
  "projects": [{ "id": "app", "root": ".", "fallbackDependencies": [] }],
  "tasks": [{
    "id": "app:test",
    "project": "app",
    "kind": "test",
    "execution": { "executable": "node", "args": ["--version"], "cwd": "." },
    "dependsOn": [],
    "impact": { "mode": "always" }
  }]
}
JSON
node -p 'JSON.stringify({ schemaVersion: 1, operation: "plan", workspaceRoot: process.cwd(), all: true })' | "$binary"
```

The host check prints `linux-arm64` and a glibc version. The binary path ends in
`bin/dad-test`, followed by `Executable found` from the file check.
The native response contains `"ok":true` and a task with `"id":"app:test"`
and `"decision":"run"`. A plan shows which tasks would run.

In the repository, the
[native release workflow](../../../../.github/workflows/testing-native-release.yml)
packs this platform's package from `packages/testing/native/linux-arm64-gnu/`
and installs the tarball with the facade in a fresh `testing-consumer`
directory to check planning through the installed artifact.

## Commands

The native executable reads one JSON request from standard input. Set
`workspaceRoot` to an absolute directory containing `dads.testing.json`. It accepts
`plan` and `run` as the `operation` field. For the flag-based CLI, including
`init` and `explain`, use the
[testing facade](../../core/README.md#commands).

## What it refuses to do

This build supports Linux arm64 with glibc only. Use a glibc environment to run it on Linux.

## Contract

The executable returns a JSON response with `schemaVersion` and `ok`. On
success, `result.plan` describes task selection. An invalid request returns
`ok: false`, an `error` message, and exit code 1. Use the
[testing facade](../../core/README.md#contract) for the supported application
interface.
