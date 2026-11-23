import console from "node:console";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, URL, URLSearchParams } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const examples = join(root, ".dads", "examples");
const roles = ["owner", "member", "outsider"];

try {
  if (process.argv[2] === "--origins") process.stdout.write(shellExports(localOrigins()));
  else await setup();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function setup() {
  const { web } = localOrigins();
  command("curl", ["--disable", "--version"], "Find curl");

  await makeOutputDirectory();
  const pending = join(examples, ".setup");
  try {
    await mkdir(pending, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("Example setup is already running or was interrupted (.dads/examples/.setup).", { cause: error });
    }
    throw error;
  }

  try {
    const { tenant, accounts } = await provision(web, pending);
    await publish(pending, tenant, accounts);
  } finally {
    await rm(pending, { recursive: true, force: true });
  }
  console.log("Example accounts and cookie jars are ready. Enter the examples directory and load the environment:");
  console.log("  cd .dads/examples && . ./env.sh");
  console.log('  curl -fsS -b owner.cookies "$customer/api/tenants/$tenant/notes"');
}

async function makeOutputDirectory() {
  const parents = [join(root, ".dads"), examples];
  for (const directory of parents) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new Error(".dads and .dads/examples must be directories.");
  }
  if (((await lstat(examples)).mode & 0o077) !== 0) throw new Error("Keep .dads/examples private (mode 0700).");
}

async function provision(web, pending) {
  const run = randomBytes(8).toString("hex");
  const accounts = [];
  for (const role of roles) accounts.push(await createAccount(web, pending, role, run));
  const [owner, member] = accounts;
  const created = await post(web, "/api/tenants", { name: `Examples ${run}` }, owner.jar, 201);
  const tenant = identifier(created.data?.id);
  await post(web, `/api/tenants/${tenant}/invitations`, { email: member.email }, owner.jar, 201);
  const invitation = await mailLink(web, member.email, "/accept-tenant-invitation");
  const token = new URLSearchParams(invitation.hash.slice(1)).get("token");
  if (!token) throw new Error("The invitation email did not include a token.");
  const accepted = await post(web, "/api/tenants/invitations/accept", { token }, member.jar);
  if (accepted.data?.tenantId !== tenant) throw new Error("The member did not join the example tenant.");
  return { tenant, accounts };
}

async function publish(pending, tenant, accounts) {
  const [owner, member] = accounts;
  const env = { tenant, ownerId: owner.id, memberId: member.id };
  await writePrivate(
    pending,
    "env.sh",
    [
      "dads_example_origins=$(node ../../examples/setup.mjs --origins) || return 1",
      'eval "$dads_example_origins"',
      "unset dads_example_origins",
      shellExports(env),
    ].join("\n"),
  );
  const credentials = accounts.map(({ role, email, password }) => ({
    role,
    email,
    password,
  }));
  await writePrivate(pending, "accounts.json", JSON.stringify(credentials, null, 2) + "\n");
  for (const file of [...roles.map(cookieFile), "accounts.json", "env.sh"])
    await rename(join(pending, file), join(examples, file));
}

function localOrigins() {
  const { running, webUrl, apiUrl, staffUrl } = dev("status");
  if (!running) throw new Error("Start the generated app with npm start.");
  return {
    web: localOrigin(webUrl),
    customer: localOrigin(apiUrl),
    staff: localOrigin(staffUrl),
  };
}

function shellExports(values) {
  return Object.entries(values)
    .map(([key, value]) => `export ${key}='${value}'\n`)
    .join("");
}

function localOrigin(value) {
  if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(value))
    throw new Error("Example setup requires loopback Compose URLs from dev:status.");
  return new URL(value).origin;
}

function identifier(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value))
    throw new Error("The API did not return an expected account or tenant ID.");
  return value;
}

function command(program, args, action, input) {
  const result = spawnSync(program, args, {
    cwd: root,
    input,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (result.status !== 0) throw new Error(`${action} failed.`);
  return result.stdout;
}

function dev(action) {
  const label = `Read local stack ${action}`;
  return parseJson(command(process.execPath, ["assembly/dev.mjs", action, "--json"], label), label);
}

function cookieFile(role) {
  return `${role}.cookies`;
}

function writePrivate(directory, file, contents) {
  return writeFile(join(directory, file), contents, {
    mode: 0o600,
    flag: "wx",
  });
}

async function createAccount(web, pending, role, run) {
  const email = `dads-examples-${role}-${run}@example.test`;
  const password = randomBytes(24).toString("hex");
  await post(web, "/api/auth/sign-up/email", {
    email,
    password,
    name: `Example ${role}`,
  });
  const verification = await mailLink(web, email, "/api/auth/verify-email");
  curl(web, ["--config", "-"], "Verify account", [200, 302], `url = ${JSON.stringify(verification.href)}\n`);
  const jar = join(pending, cookieFile(role));
  await writePrivate(pending, cookieFile(role), "");
  await post(web, "/api/auth/sign-in/email", { email, password }, jar);
  await chmod(jar, 0o600);
  const action = "Read verified session";
  const session = parseJson(curl(web, ["--cookie", jar, web + "/api/auth/get-session"], action, [200]), action);
  if (session?.account?.emailVerified !== true || session.account.email !== email || !(await hasLocalCookie(jar)))
    throw new Error("Sign-in did not save a verified session.");
  return { role, email, password, jar, id: identifier(session.account.id) };
}

async function hasLocalCookie(jar) {
  const contents = await readFile(jar, "utf8");
  return /^(?:#HttpOnly_)?127\.0\.0\.1\t/m.test(contents);
}

function post(web, path, payload, jar, expected = 200) {
  const args = ["--header", "Content-Type: application/json", "--data-binary", "@-"];
  if (jar) args.push("--cookie", jar, "--cookie-jar", jar);
  const action = `POST ${path}`;
  return parseJson(curl(web, [...args, web + path], action, [expected], JSON.stringify(payload)), action);
}

function parseJson(text, action) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${action} did not return JSON.`);
  }
}

function curl(web, args, action, expected, input) {
  const output = command(
    "curl",
    [
      "--disable",
      "--noproxy",
      "*",
      "--silent",
      "--max-time",
      "15",
      "--header",
      `Origin: ${web}`,
      "--write-out",
      "\n%{http_code}",
      ...args,
    ],
    action,
    input,
  );
  const status = Number(output.slice(-3));
  if (!expected.includes(status)) throw new Error(`${action} returned HTTP ${status}.`);
  return output.slice(0, -4);
}

async function mailLink(web, email, pathname) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const messages = dev("mail").mail.filter(({ to }) => to.some(({ address }) => address === email));
    for (const message of messages) {
      const link = findLink(message.text, web, pathname);
      if (link) return link;
    }
    await setTimeout(500);
  }
  throw new Error(`Local mail did not deliver the expected link for ${email}.`);
}

function findLink(text, web, pathname) {
  for (const [href] of text.matchAll(/https?:\/\/[^\s<>]+/g)) {
    if (!URL.canParse(href)) continue;
    const url = new URL(href);
    if (url.origin === web && !url.username && !url.password && url.pathname === pathname) return url;
  }
}
