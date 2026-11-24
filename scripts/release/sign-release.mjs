import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { releaseSubjects, repositorySlug } from "./release-subjects.mjs";
import { normalizeReleaseScope } from "./release-version.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const npmVersion = "11.21.2";
const issuer = "https://token.actions.githubusercontent.com";

function parseArgs(argv) {
  const positional = [];
  let scope;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scope") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("Expected --scope all|testing.");
      }
      scope = normalizeReleaseScope(value);
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const [command, directory, npmInstall, expectedCommit, ...extra] = positional;
  if (!directory || !npmInstall || !["sign", "verify"].includes(command) || extra.length > 0) {
    throw new Error(
      "Usage: sign-release.mjs sign|verify <release-dir> <npm-install-dir> [expected-commit-for-verify] [--scope all|testing]",
    );
  }
  return { command, directory, npmInstall, expectedCommit, scope };
}

async function main() {
  const { command, directory, npmInstall, expectedCommit, scope: requestedScope } = parseArgs(process.argv.slice(2));
  const npmRoot = resolve(npmInstall);
  const npmManifest = JSON.parse(readFileSync(join(npmRoot, "package.json"), "utf8"));
  if (npmManifest.name !== "npm" || npmManifest.version !== npmVersion) {
    throw new Error(`Use the pinned official npm@${npmVersion} distribution.`);
  }
  const loadNpm = createRequire(join(npmRoot, "package.json"));
  const { generateProvenance, verifyProvenance } = loadNpm("libnpmpublish/lib/provenance.js");
  const npa = loadNpm("npm-package-arg");
  const sigstore = loadNpm("sigstore");
  const repository = repositorySlug(root);
  const workflow = ".github/workflows/release-artifacts.yml";
  const manifestPath = join(directory, "release.json");
  const manifest =
    command === "sign"
      ? githubBuild(repository, workflow, requestedScope ?? "all")
      : JSON.parse(readFileSync(manifestPath, "utf8"));
  const scope = normalizeReleaseScope(manifest.scope ?? "all");
  if (command === "verify" && requestedScope !== undefined && requestedScope !== scope) {
    throw new Error(`Release manifest scope "${scope}" does not match requested "${requestedScope}".`);
  }
  const commit =
    expectedCommit ||
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  if (
    manifest.repository !== repository ||
    manifest.workflow !== workflow ||
    manifest.commit !== commit ||
    !/^[a-f0-9]{40}$/.test(commit) ||
    manifest.ref !== "refs/heads/main" ||
    !/^\d+$/.test(manifest.runId) ||
    !/^\d+$/.test(manifest.runAttempt)
  )
    throw new Error("Release build identity does not match the expected source.");
  const packages = releaseSubjects(root, directory, scope);
  if (command === "verify" && JSON.stringify(manifest.packages) !== JSON.stringify(packages)) {
    throw new Error("Release inventory or tarball integrity differs from the manifest.");
  }

  for (const entry of packages) {
    const subject = {
      name: npa.toPurl(npa.resolve(entry.name, entry.version)),
      digest: {
        sha512: Buffer.from(entry.integrity.slice("sha512-".length), "base64").toString("hex"),
      },
    };
    const bundlePath = join(directory, entry.provenance);
    if (command === "sign") {
      const bundle = await generateProvenance([subject], {});
      writeFileSync(bundlePath, JSON.stringify(bundle) + "\n", { flag: "wx" });
    }
    const bundle = await verifyProvenance(subject, bundlePath);
    await sigstore.verify(bundle, {
      certificateIssuer: issuer,
      certificateIdentityURI: `https://github.com/${repository}/${workflow}@${manifest.ref}`,
    });
    verifySource(bundle, manifest);
  }
  if (command === "sign") {
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, packages }, null, 2) + "\n", {
      flag: "wx",
    });
  }
  process.stdout.write(
    `Verified ${packages.length} release tarballs (${scope}) and provenance bundles at ${commit}.\n`,
  );
}

function githubBuild(repository, workflow, scope) {
  const env = process.env;
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.GITHUB_SERVER_URL !== "https://github.com" ||
    env.GITHUB_REPOSITORY !== repository ||
    env.GITHUB_WORKFLOW_REF !== `${repository}/${workflow}@${env.GITHUB_REF}` ||
    !env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  )
    throw new Error("Signing requires the canonical GitHub-hosted workflow and OIDC access.");
  return {
    repository,
    workflow,
    scope: normalizeReleaseScope(scope),
    ref: env.GITHUB_REF,
    commit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  };
}

function verifySource(bundle, manifest) {
  const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  const { buildDefinition, runDetails } = statement.predicate;
  const source = `https://github.com/${manifest.repository}`;
  const invocation = `${source}/actions/runs/${manifest.runId}/attempts/${manifest.runAttempt}`;
  const workflow = buildDefinition.externalParameters.workflow;
  if (
    statement.predicateType !== "https://slsa.dev/provenance/v1" ||
    workflow.repository !== source ||
    workflow.path !== manifest.workflow ||
    workflow.ref !== manifest.ref ||
    !buildDefinition.resolvedDependencies.some(
      (dependency) =>
        dependency.uri === `git+${source}@${manifest.ref}` && dependency.digest.gitCommit === manifest.commit,
    ) ||
    runDetails.metadata.invocationId !== invocation
  )
    throw new Error("Provenance does not identify the expected release build.");
}

await main();
