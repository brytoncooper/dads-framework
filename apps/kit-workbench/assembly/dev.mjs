import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { readLocalState } from "./local-state.mjs";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const [command = "up", option, ...extra] = process.argv.slice(2);
const json = option === "--json";

try {
  if (
    !["up", "down", "status", "restart", "mail"].includes(command) ||
    (option && !json) ||
    extra.length
  ) {
    throw new Error(
      "Usage: node assembly/dev.mjs up|down|status|restart|mail [--json]",
    );
  }
  if (command === "up" || command === "restart") {
    if (!existsSync(join(root, "package-lock.json"))) {
      throw new Error(
        "Run npm install to create package-lock.json before starting the local stack.",
      );
    }
    diagnoseDocker();
  }
  const state = readLocalState(root, command === "up" || command === "restart");
  if (!state && command === "mail") {
    throw new Error(
      "Start the local stack with npm start before reading mail.",
    );
  }
  if (!state && command !== "down" && command !== "status") {
    throw new Error("Could not initialize local development state.");
  }
  if (command === "down" || command === "restart") {
    if (state) compose(state, ["down"]);
    if (command === "down") finish({ ok: true, running: false });
  }
  if (command === "up" || command === "restart") {
    await start(state);
  }
  if (command === "mail") {
    compose(
      state,
      [
        "exec",
        "-T",
        "api",
        "node",
        "assembly/read-local-mail.mjs",
        ...(json ? ["--json"] : []),
      ],
      { stdout: 1 },
    );
  }
  if (command === "status") {
    const urls = state ? serviceUrls(state) : undefined;
    const running = urls ? await ready(urls) : false;
    finish(running ? { ok: true, running, ...urls } : { ok: true, running });
  }
} catch (error) {
  const message =
    error instanceof Error ? error.message : "Local stack failed.";
  if (json)
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  else process.stderr.write(message + "\n");
  process.exitCode = 1;
}

async function start(state) {
  compose(state, ["run", "--rm", "--no-deps", "dependencies"]);
  compose(state, [
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "120",
    "database",
    "web",
  ]);
  const webUrl = serviceUrl(state, "web", "5173");
  if (!webUrl)
    throw new Error("Docker did not publish the local browser port.");
  compose(state, ["run", "--rm", "--no-deps", "api", "npm", "run", "migrate"], {
    webUrl,
  });
  compose(state, ["up", "-d", "--no-deps", "api", "staff"], { webUrl });
  const urls = serviceUrls(state);
  for (let attempt = 0; urls && attempt < 60; attempt += 1) {
    if (await ready(urls)) return finish({ ok: true, running: true, ...urls });
    await setTimeout(1000);
  }
  throw new Error(
    "The local stack did not become ready. Run npm run dev:status and inspect docker logs.",
  );
}

async function ready({ webUrl, apiUrl, staffUrl }) {
  const results = await Promise.all([
    endpointIsReady(webUrl),
    endpointIsReady(`${webUrl}/api/health`, true),
    endpointIsReady(`${apiUrl}/api/health`, true),
    endpointIsReady(`${staffUrl}/api/health`, true),
  ]);
  return results.every(Boolean);
}

async function endpointIsReady(url, health = false) {
  try {
    const response = await globalThis.fetch(url, {
      signal: globalThis.AbortSignal.timeout(1500),
    });
    if (response.ok && health)
      return (await response.json())?.data?.status === "ok";
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

function finish(result) {
  if (json) process.stdout.write(JSON.stringify(result) + "\n");
  else if (result.running) {
    process.stdout.write(
      `Open ${result.webUrl}\nCustomer API ${result.apiUrl}\nStaff API ${result.staffUrl}\n`,
    );
  } else process.stdout.write("The local stack is stopped.\n");
}

function serviceUrls(state) {
  const webUrl = serviceUrl(state, "web", "5173");
  const apiUrl = serviceUrl(state, "api", "3000");
  const staffUrl = serviceUrl(state, "staff", "3000");
  if (webUrl && apiUrl && staffUrl) return { webUrl, apiUrl, staffUrl };
}

function serviceUrl(state, service, port) {
  const output = compose(state, ["port", service, port], { capture: true });
  const address = /^127\.0\.0\.1:(\d{1,5})$/.exec(output);
  return address && Number(address[1]) >= 1 && Number(address[1]) <= 65535
    ? `http://${address[0]}`
    : undefined;
}

function diagnoseDocker() {
  const version = spawnSync("docker", ["compose", "version"], {
    stdio: "ignore",
  });
  if (version.status !== 0)
    throw new Error("Docker with the Compose v2 plugin is required.");
  const daemon = spawnSync(
    "docker",
    ["info", "--format", "{{.ServerVersion}}"],
    { stdio: "ignore" },
  );
  if (daemon.status !== 0)
    throw new Error(
      "Start Docker and confirm that your shell can access its daemon.",
    );
}

function compose(
  state,
  args,
  { capture = false, webUrl = "", stdout = 2 } = {},
) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-directory",
      root,
      "--project-name",
      state.project,
      "--file",
      join(root, "assembly/compose.yml"),
      ...args,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DADS_LOCAL_POSTGRES_PASSWORD: state.databasePassword,
        DADS_LOCAL_IDENTITY_SECRET: state.identitySecret,
        DADS_LOCAL_WEB_URL: webUrl,
      },
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "ignore"] : ["ignore", stdout, 2],
    },
  );
  if (capture) return result.status === 0 ? result.stdout.trim() : "";
  if (result.status !== 0)
    throw new Error(`Docker Compose ${args[0]} failed. See its output above.`);
}
