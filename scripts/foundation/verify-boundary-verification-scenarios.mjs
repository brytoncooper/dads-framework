/**
 * What the boundary fixture proves, one named scenario at a time.
 *
 * The proof used to be one long sequence: mutate, verify, commit, mutate again.
 * Read closely it is not a sequence at all. Every scenario asks the same
 * question — given a committed project whose receipts came from a real run,
 * does this one change make the right tasks execute, reuse, fail, or block? —
 * and none of them reads what the one before it left behind. So the shared part
 * is a shared setup, `proveBaseline`, and everything after it is an independent
 * unit that gets its own copy of that baseline.
 *
 * Two pairs genuinely are chains, and each pair stays inside one unit. An
 * injected consumer failure is verified twice against the *same* broken tree,
 * because the second run is what proves a failure is re-run rather than
 * remembered; and the injected type-test failure runs against the tree the
 * injected Vitest failure left behind, because what the second run plans
 * depends on what the first run discarded.
 *
 * Outside a chain, a unit never commits its own mutation and never restores the
 * file it broke. Both were only ever there to hand a clean tree to the next
 * scenario, and a unit's copy is deleted the moment it is done.
 */

import { controlledConsumer } from "./verify-boundary-verification-project.mjs";

const ALL_EXECUTED = {
  "policy:check": "executed",
  "policy:build": "executed",
  "consumer:artifact-check": "executed",
  "consumer:vitest": "executed",
  "consumer:typecheck": "executed",
  "authorization:live": "executed",
};

/** Rough seconds per unit, compared only with each other so the pool starts
 * the long ones first. A unit is one `dad verify` unless it says otherwise. */
const UNIT_SECONDS = { oneRun: 2, twoRuns: 4 };

/**
 * The one state every other scenario starts from: the fixture copied out,
 * committed, verified once so that real receipts exist, and committed again.
 *
 * This is a scenario in its own right — it asserts that a first run executes
 * every task — and it is also the setup, which is why it is not in the list.
 */
export async function proveBaseline({ project, expectations }) {
  project.prepareIsolatedProject();
  project.append("src/access.ts", "\n// baseline verification trigger\n");
  expectations.expectStates("baseline", await expectations.runVerification(), ALL_EXECUTED);
  project.commit("baseline");
}

export const boundaryScenarios = [
  {
    name: "clean checkout fallback",
    cost: UNIT_SECONDS.oneRun,
    async run({ expectations }) {
      expectations.expectAllExecuted("clean checkout fallback", await expectations.runVerification());
    },
  },
  {
    name: "clean checkout full fallback",
    cost: UNIT_SECONDS.oneRun,
    async run({ expectations }) {
      expectations.expectAllExecuted(
        "clean checkout full fallback",
        await expectations.runVerification({ full: true }),
      );
    },
  },
  {
    name: "unchanged artifact",
    cost: UNIT_SECONDS.oneRun,
    async run({ project, expectations }) {
      project.append("src/access.ts", "// source-only authoring extraction\n");
      expectations.expectStates("unchanged artifact", await expectations.runVerification(), {
        ...ALL_EXECUTED,
        "consumer:artifact-check": "reused",
      });
    },
  },
  {
    name: "unchanged artifact in CI",
    cost: UNIT_SECONDS.oneRun,
    async run({ project, expectations }) {
      project.append("src/access.ts", "// source-only authoring extraction\n");
      expectations.expectStates(
        "unchanged artifact in CI",
        await expectations.runVerification({ ci: true }),
        ALL_EXECUTED,
      );
    },
  },
  {
    name: "changed artifact",
    cost: UNIT_SECONDS.oneRun,
    async run({ project, expectations }) {
      project.replace(
        "src/access.ts",
        '{ kind: "through", roleName: "workspace", targetPermission: "view" },\n          { kind: "role", name: "reader" }',
        '{ kind: "role", name: "reader" },\n          { kind: "through", roleName: "workspace", targetPermission: "view" }',
      );
      await expectations.expectConsumerExecuted("changed artifact");
    },
  },
  {
    // The one real chain: both runs read the same broken working tree, and the
    // second is the one that proves a failed consumer is never remembered.
    name: "injected consumer failure",
    cost: UNIT_SECONDS.twoRuns,
    async run({ project, expectations }) {
      project.replace("src/read-document-result.ts", "`document:${request.documentId}`", "undefined");
      expectations.expectConsumerFailed(
        "injected consumer failure",
        await expectations.runVerification({ allowFailure: true }),
      );
      expectations.expectConsumerFailed(
        "injected consumer failure full",
        await expectations.runVerification({ allowFailure: true, full: true }),
      );
    },
  },
  {
    // The second chain. The type-test run inherits the vitest run's discarded
    // receipt, and that is the point: a task that failed is planned again on
    // the next run even when the change that follows has nothing to do with it.
    // Split apart, the type-test run would plan four tasks instead of six and
    // stop saying so.
    name: "injected test failures",
    cost: UNIT_SECONDS.twoRuns,
    async run({ project, expectations }) {
      const vitestPath = "src/read-document-unit.test.ts";
      const vitestSource = project.read(vitestPath);
      project.append(vitestPath, '\nit("injected failure", () => { throw new Error("vitest proof executed"); });\n');
      expectations.expectTaskFailed(
        "injected Vitest failure",
        "consumer:vitest",
        await expectations.runVerification({ allowFailure: true }),
      );
      project.write(vitestPath, vitestSource);

      project.append("type-tests/consumer.ts", "\nconst injectedTypeFailure: string = 1;\n");
      expectations.expectTaskFailed(
        "injected type-test failure",
        "consumer:typecheck",
        await expectations.runVerification({ allowFailure: true }),
      );
    },
  },
  identityScenario("consumer source", "src/read-document.ts"),
  identityScenario("consumer test", "src/read-document.test.ts"),
  identityScenario("consumer config", "tsconfig.json", "\n"),
  identityScenario("engine", "verification/vendor/access/core/parse-zed.js"),
  identityScenario("binding", "verification/consumer-runner.mjs"),
  identityScenario("lockfile", "package-lock.json", "\n"),
  {
    name: "toolchain runner version",
    cost: UNIT_SECONDS.oneRun,
    async run({ project, expectations }) {
      project.updateManifest((manifest) => {
        controlledConsumer(manifest).runnerVersion = "boundary-consumer-v2";
      });
      await expectations.expectConsumerExecuted("toolchain runner version");
    },
  },
  {
    name: "declared environment",
    cost: UNIT_SECONDS.oneRun,
    async run({ project, expectations }) {
      project.updateManifest((manifest) => {
        controlledConsumer(manifest).environment[0].value = "changed-environment";
      });
      await expectations.expectConsumerExecuted("declared environment");
    },
  },
  {
    name: "missing receipt",
    cost: UNIT_SECONDS.oneRun,
    async run({ project, expectations }) {
      project.append("src/access.ts", "// missing receipt trigger\n");
      project.removeConsumerReceipts();
      await expectations.expectConsumerExecuted("missing receipt");
    },
  },
  {
    name: "corrupt receipt",
    cost: UNIT_SECONDS.oneRun,
    async run({ project, expectations }) {
      project.append("src/access.ts", "// corrupt receipt trigger\n");
      project.corruptConsumerReceipts();
      await expectations.expectConsumerExecuted("corrupt receipt");
    },
  },
  {
    name: "provider failure",
    cost: UNIT_SECONDS.oneRun,
    async run({ project, expectations }) {
      project.write("verification/fail-provider", "fail\n");
      expectations.expectStates("provider failure", await expectations.runVerification({ allowFailure: true }), {
        "policy:check": "failed",
        "policy:build": "blocked",
        "consumer:artifact-check": "blocked",
        "consumer:vitest": "blocked",
        "consumer:typecheck": "blocked",
        "authorization:live": "blocked",
      });
    },
  },
  {
    name: "full",
    cost: UNIT_SECONDS.oneRun,
    async run({ project, expectations }) {
      project.append("src/access.ts", "// explicit full verification\n");
      expectations.expectStates("full", await expectations.runVerification({ full: true }), ALL_EXECUTED);
    },
  },
];

/**
 * One input's identity: touching it has to make the controlled consumer run
 * again, whether it is the consumer's own source, its config, the engine it
 * resolved, the runner that binds them, or the lockfile underneath all of it.
 */
function identityScenario(name, path, suffix = `\n// ${name} identity change\n`) {
  return {
    name,
    cost: UNIT_SECONDS.oneRun,
    async run({ project, expectations }) {
      project.append(path, suffix);
      await expectations.expectConsumerExecuted(name);
    },
  };
}
