/**
 * The generated-project proof, expressed as independent tasks.
 *
 * A clean generated app and an existing-project safety proof share a creator
 * installed from its tarball. That install is started as a promise rather than
 * queued as a task, so it never waits for a free slot and the projects simply
 * await it.
 */

import { join } from "node:path";

import { createTaskTranscript } from "./adoption-commands.mjs";
import { generatedCommands, runGeneratedCommands, verifyGeneratedCommands } from "./verify-generated-commands.mjs";
import {
  assertGeneratedArtifacts,
  lockGeneratedProject,
  verifyExistingProjectSafety,
} from "./verify-generated-project-recipes.mjs";
import { installCreator, runCreator } from "./verify-generated-project-workspace.mjs";

export function generatedProjectReceipt(concurrency, timings) {
  return {
    ok: true,
    generatedApis: ["customer", "staff"],
    generatedCommands,
    existingProject: "isolated-idempotent-conflict-safe",
    concurrency,
    timings,
  };
}

/**
 * Install the packed creator without occupying a task slot.
 *
 * `start()` is called once the tarballs exist, and every generated project
 * awaits `ready()`. Because the install is a promise rather than a queued task
 * it can never be the task that never gets a slot, so the projects cannot
 * deadlock waiting for it however small the job budget is.
 */
export function prepareCreatorInstall(context) {
  const transcript = createTaskTranscript("install creator");
  let installing = null;
  return {
    transcript,
    start() {
      if (installing) throw new Error("The creator install was started twice.");
      installing = context.time("creator-install", () => installCreator(transcript, context));
      // Every project awaits this, but a run that fails before the first await
      // would leave the rejection unobserved; the failure itself is reported
      // by whichever task awaited it.
      installing.catch(() => {});
    },
    ready() {
      if (!installing) throw new Error("The creator install has not been started.");
      return installing;
    },
  };
}

export function createGeneratedProjectTasks(context, creator) {
  return [
    {
      name: "kit-starter",
      cost: 25,
      run: async (transcript) => {
        const projectRoot = join(context.workRoot, "kit-starter");
        const ready = await creator.ready();
        await context.time("project-generate", () =>
          runCreator(transcript, ready, [projectRoot, "--skip-install", "--json"]),
        );
        assertGeneratedArtifacts(projectRoot);
        await context.time("project-add", () => runGeneratedCommands(transcript, ready, projectRoot));
        await context.time("project-install", () => lockGeneratedProject(transcript, projectRoot, context));
        await context.time("project-verify", () => verifyGeneratedCommands(transcript, projectRoot));
      },
    },
    {
      name: "adopt-existing-project",
      cost: 3,
      run: async (transcript) =>
        verifyExistingProjectSafety({
          transcript,
          context,
          creator: await creator.ready(),
        }),
    },
  ];
}
