import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { WorkbenchClientError } from "../../apps/workbench/dist/client-transport.js";
import { createClient } from "../../apps/workbench/dist/client.generated.js";
import {
  acquireDevelopmentLease,
  readOrCreateDevelopmentState,
} from "../../apps/workbench/dist/development/local-state.js";

// Exercise the same dependency-free launcher users run, with an exclusively owned test instance.
const root = fileURLToPath(new URL("../../", import.meta.url));
const instance = `proof-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
const spiceInstance = `spice-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
const directory = join(root, ".dads/workbench", instance);
const spiceDirectory = join(root, ".dads/workbench", spiceInstance);
const runFile = promisify(execFile);
const processes = [];
let project;
let spiceProject;
const cancelled = new globalThis.AbortController();
process.once("SIGINT", () => {
  cancelled.abort();
});
process.once("SIGTERM", () => {
  cancelled.abort();
});

try {
  assert.equal(existsSync(directory), false);
  report("first-start");
  let running = await start();
  const state = readOrCreateDevelopmentState(directory);
  assert.equal(state.adapter, "postgres");
  project = `dads-workbench-${state.id}`;
  let alice = client(running.url, "alice");
  let bob = client(running.url, "bob");
  const workspace = await alice.createWorkspace({
    body: { requestKey: randomUUID(), name: "Launcher proof" },
  });
  const task = await alice.createTask({
    params: { workspaceId: workspace.id },
    body: { requestKey: randomUUID(), title: "Persistent API journey" },
  });
  await alice.grantMember({
    params: { workspaceId: workspace.id },
    body: { userId: "bob" },
  });
  assert.equal((await bob.getTask({ params: { taskId: task.id } })).id, task.id);
  const duplicate = launch("up", ["--port", "0"]);
  assert.equal((await duplicate.done).code, 1);
  assert.match(duplicate.output(), /instance is running/);
  assert.equal((await alice.getTask({ params: { taskId: task.id } })).id, task.id);

  report("graceful-stop-and-restart");
  await stop();
  assert.equal((await running.process.done).code, 0);
  await assertStopped();
  assert.equal(
    await docker(["volume", "inspect", "--format", "{{.Name}}", `${project}-postgres-data`]),
    `${project}-postgres-data`,
  );
  running = await start();
  alice = client(running.url, "alice");
  bob = client(running.url, "bob");
  assert.equal((await bob.getTask({ params: { taskId: task.id } })).title, "Persistent API journey");
  await assert.rejects(
    () => client(running.url, "outsider").getTask({ params: { taskId: task.id } }),
    (error) => error instanceof WorkbenchClientError && error.status === 404,
  );
  await alice.revokeMember({
    params: { workspaceId: workspace.id, userId: "bob" },
  });
  await assert.rejects(
    () => bob.getTask({ params: { taskId: task.id } }),
    (error) => error instanceof WorkbenchClientError && error.status === 404,
  );

  report("explicit-spice-instance");
  const spice = await start(spiceInstance, ["--adapter", "spicedb"]);
  const spiceState = readOrCreateDevelopmentState(spiceDirectory);
  assert.equal(spiceState.adapter, "spicedb");
  spiceProject = `dads-workbench-${spiceState.id}`;
  const spiceWorkspace = await client(spice.url, "alice").createWorkspace({
    body: { requestKey: randomUUID(), name: "SpiceDB opt-in proof" },
  });
  assert.equal(spiceWorkspace.name, "SpiceDB opt-in proof");
  await stop(spiceInstance);
  assert.equal((await spice.process.done).code, 0);
  await assertStopped(spiceProject);

  report("bootstrap-crash-cleanup");
  running.process.child.kill("SIGKILL");
  await running.process.done;
  await waitUntil(async () => {
    await assertStopped();
    return true;
  });
  const lease = acquireDevelopmentLease(directory);
  lease.close();

  report("cancel-during-startup");
  const starting = launch("up", ["--port", "0"]);
  await waitUntil(() => starting.output().includes("Starting isolated workbench services"));
  starting.child.kill("SIGINT");
  await starting.done;
  await waitUntil(async () => {
    await assertStopped();
    return true;
  });
  await stop(); // Also prove an already-stopped instance is safe to stop again.
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      instance,
      proofs: [
        "one-command-api-start",
        "duplicate-launch-refusal",
        "graceful-stop-retains-data",
        "restart-retains-data-and-permissions",
        "outsider-denial-and-revocation",
        "explicit-spicedb-instance",
        "bootstrap-crash-does-not-orphan-writer",
        "startup-cancellation",
        "idempotent-stop",
      ],
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Development proof failed."}\n`);
  process.exitCode = 1;
} finally {
  try {
    for (const current of [
      { name: instance, directory, project },
      {
        name: spiceInstance,
        directory: spiceDirectory,
        project: spiceProject,
      },
    ]) {
      if (!existsSync(join(current.directory, "state.json"))) continue;
      await stop(current.name);
      const state = readOrCreateDevelopmentState(current.directory);
      const currentProject = current.project ?? `dads-workbench-${state.id}`;
      await assertStopped(currentProject);
      const volume = `${currentProject}-postgres-data`;
      const existing = await docker(["volume", "ls", "--filter", `name=^${volume}$`, "--format", "{{.Name}}"]);
      if (existing) {
        const owner = await docker(["volume", "inspect", "--format", '{{index .Labels "dev.dads.workbench"}}', volume]);
        assert.equal(existing, volume);
        assert.equal(owner, currentProject);
        await docker(["volume", "rm", volume]);
      }
      // This randomly named proof directory was absent before this run; no user instance is removed.
      rmSync(current.directory, { recursive: true });
    }
    process.stdout.write(`${JSON.stringify({ instance, cleanedUp: true })}\n`);
  } catch {
    process.stderr.write(`Proof cleanup incomplete for ${instance}; no unverified resource was removed.\n`);
    process.exitCode = 1;
  }
  for (const running of processes) if (!running.terminal()) running.child.kill("SIGTERM");
}

async function start(selectedInstance = instance, extra = []) {
  const running = launch("up", ["--port", "0", ...extra], selectedInstance);
  let url;
  await waitUntil(() => {
    url = /Workbench API ready: (http:\/\/127\.0\.0\.1:\d+)/.exec(running.output())?.[1];
    if (!url && running.terminal()) throw new Error("Launcher exited before readiness.");
    return Boolean(url);
  });
  assert.ok(url);
  return { url, process: running };
}

async function stop(selectedInstance = instance) {
  const result = await launch("stop", [], selectedInstance).done;
  assert.equal(result.code, 0, "The workbench stop command must succeed.");
}

function launch(action, extra = [], selectedInstance = instance) {
  const child = spawn(
    process.execPath,
    ["scripts/workbench/workbench-dev.mjs", action, "--instance", selectedInstance, ...extra],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let terminal = false;
  const capture = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-128_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      terminal = true;
      resolve({ code, signal });
    });
  });
  const running = {
    child,
    done,
    output: () => output,
    terminal: () => terminal,
  };
  processes.push(running);
  return running;
}

function client(url, identity) {
  return createClient({
    baseUrl: url,
    headers: { "x-workbench-user": identity },
    fetch: (input, init) =>
      globalThis.fetch(input, {
        ...init,
        signal: globalThis.AbortSignal.timeout(10_000),
      }),
  });
}

async function assertStopped(projectName = project) {
  assert.equal(
    await docker([
      "container",
      "ls",
      "--all",
      "--filter",
      `label=dev.dads.workbench=${projectName}`,
      "--format",
      "{{.ID}}",
    ]),
    "",
  );
  assert.equal(
    await docker(["network", "ls", "--filter", `label=dev.dads.workbench=${projectName}`, "--format", "{{.ID}}"]),
    "",
  );
}

async function docker(args) {
  const { stdout } = await runFile("docker", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
  });
  return stdout.trim();
}

async function waitUntil(check) {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    cancelled.signal.throwIfAborted();
    try {
      if (await check()) return;
    } catch {
      /* Readiness/state transition still pending. */
    }
    await setTimeout(200, undefined, { signal: cancelled.signal });
  }
  throw new Error("Timed out waiting for the real workbench lifecycle proof.");
}

function report(stage) {
  process.stdout.write(`${JSON.stringify({ stage, instance })}\n`);
}
