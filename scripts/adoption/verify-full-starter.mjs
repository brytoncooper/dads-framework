/**
 * Opt-in smoke test for the packed npm creator and the live development stack.
 * Run from a built checkout on a Linux Docker host with headless Chrome:
 *   node scripts/adoption/verify-full-starter.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isIP } from "node:net";
import process from "node:process";
import { URL } from "node:url";

import {
  loadAdoptionPackages,
  packAdoptionPackages,
} from "./adoption-packing.mjs";
import {
  createAdoptionWorkspace,
  createPhaseTimer,
  createProofContext,
  reportFatal,
} from "./adoption-proof-run.mjs";
import { runAdoptionTasks } from "./adoption-task-runner.mjs";
import { proveStarterFrontend } from "./full-starter-browser.mjs";
import { startStarterRegistry } from "./full-starter-registry.mjs";
import { proveStarterScenario } from "./full-starter-scenario.mjs";

const appName = "starter-proof";

async function main() {
  const root = process.cwd();
  const workspace = createAdoptionWorkspace("dads-full-starter-");
  try {
    const context = createProofContext({
      root,
      workRoot: await realpath(workspace.subdirectory("adopter")),
      packages: loadAdoptionPackages(root),
      timer: createPhaseTimer(),
    });
    await packAdoptionPackages({
      context,
      tarballRoot: workspace.tarballRoot,
      jobs: 3,
    });
    await runAdoptionTasks({
      tasks: [
        {
          name: "packed creator and live starter",
          run: (transcript) => verifyStarter(transcript, context, workspace),
        },
      ],
      jobs: 1,
      label: "full starter",
    });
  } finally {
    workspace.dispose();
  }
}

async function verifyStarter(transcript, context, workspace) {
  const gateway = await transcript.run("docker", [
    "network",
    "inspect",
    "bridge",
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
  ]);
  const registryHost = gateway.stdout.trim();
  assert.equal(
    isIP(registryHost),
    4,
    "The proof requires an IPv4 Docker bridge gateway",
  );
  const env = {
    ...process.env,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_cache: workspace.subdirectory("npm-cache"),
    npm_config_userconfig: "/dev/null",
  };
  const project = join(context.workRoot, appName);
  const projectLabel =
    "label=com.docker.compose.project=dads-" +
    createHash("sha256").update(project).digest("hex").slice(0, 20);
  const run = (program, args) =>
    transcript.run(program, args, { cwd: project, env });
  const docker = (args) => transcript.run("docker", args);
  const registry = await startStarterRegistry(
    context,
    workspace.tarballRoot,
    registryHost,
  );
  env.npm_config_registry = registry.origin;
  try {
    const created = await transcript.run(
      "npm",
      ["--silent", "--yes", "create", "dads@latest", appName, "--", "--json"],
      {
        cwd: context.workRoot,
        env,
      },
    );
    const receipt = JSON.parse(created.stdout);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.installed, true);
    assert.equal(receipt.development.status, "started");
    const urls = readUrls(receipt.development);
    const lock = await proveLock(project, registry.origin);
    await proveStarterFrontend(urls.webUrl, workspace.subdirectory("browser"));
    const api = await docker([
      "ps",
      "-q",
      "--filter",
      projectLabel,
      "--filter",
      "label=com.docker.compose.service=api",
    ]);
    const apiContainer = api.stdout.trim();
    assert.match(apiContainer, /^[a-f0-9]+$/);
    const proveRetainedData = await proveStarterScenario(
      urls,
      apiContainer,
      project,
    );
    const resumed = await run("npm", ["--silent", "start", "--", "--json"]);
    assert.deepEqual(readUrls(JSON.parse(resumed.stdout)), urls);
    await proveRetainedData(urls.webUrl);
    await run("npm", ["run", "--silent", "dev:down"]);
    await assertStopped(docker, projectLabel);
    const restarted = await run("npm", ["--silent", "start", "--", "--json"]);
    await proveRetainedData(readUrls(JSON.parse(restarted.stdout)).webUrl);
    await run("sh", ["ci/verify.sh"]);
    assert.equal(
      await proveLock(project, registry.origin),
      lock,
      "The generated lock changed during restart or npm ci",
    );
    await run("npm", ["run", "--silent", "dev:down"]);
    await assertStopped(docker, projectLabel);
    process.stdout.write(
      "Full starter passed: packed npm create, two APIs, rendered frontend, accounts, invitations, revocation, attachments, exports, restart, and CI.\n",
    );
  } finally {
    try {
      await removeProjectResources(docker, projectLabel);
    } finally {
      await registry.close();
    }
  }
}

function readUrls(value) {
  const { webUrl, apiUrl, staffUrl } = value;
  const urls = [webUrl, apiUrl, staffUrl].map((url) => new URL(url));
  assert.ok(
    urls.every(
      (url) =>
        url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port,
    ),
  );
  assert.equal(new Set(urls.map((url) => url.port)).size, 3);
  return { webUrl, apiUrl, staffUrl };
}

async function proveLock(project, registry) {
  const manifest = JSON.parse(
    await readFile(join(project, "package.json"), "utf8"),
  );
  const rawLock = await readFile(join(project, "package-lock.json"), "utf8");
  const lock = JSON.parse(rawLock);
  const scoped = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  }).filter((name) => name.startsWith("@dads-framework/"));
  assert.ok(scoped.length > 0);
  for (const name of scoped) {
    const resolved = lock.packages["node_modules/" + name].resolved;
    assert.ok(resolved.startsWith(registry + "/tarballs/"), name);
  }
  return createHash("sha256").update(rawLock).digest("hex");
}

async function assertStopped(docker, label) {
  const [containers, networks] = await Promise.all([
    docker(["container", "ls", "--all", "--quiet", "--filter", label]),
    docker(["network", "ls", "--quiet", "--filter", label]),
  ]);
  assert.equal(
    containers.stdout.trim(),
    "",
    "dev:down should remove project containers",
  );
  assert.equal(
    networks.stdout.trim(),
    "",
    "dev:down should remove the project network",
  );
}

async function removeProjectResources(docker, label) {
  for (const [resource, flags] of [
    ["container", ["-f"]],
    ["network", []],
    ["volume", []],
  ]) {
    const list = () =>
      docker([
        resource,
        "ls",
        "--quiet",
        "--filter",
        label,
        ...(resource === "container" ? ["--all"] : []),
      ]);
    const existing = (await list()).stdout.trim();
    if (existing)
      await docker([resource, "rm", ...flags, ...existing.split(/\s+/)]);
    assert.equal(
      (await list()).stdout.trim(),
      "",
      "Expected disposable Docker " + resource + " cleanup",
    );
  }
}

await main().catch(reportFatal);
