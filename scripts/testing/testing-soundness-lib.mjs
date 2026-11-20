import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";

export function parseArguments(argv, supported) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--"))
      throw new Error(`Unexpected argument ${argument}.`);
    if (!supported.has(argument))
      throw new Error(`Unsupported option ${argument}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${argument} requires a value.`);
    values.set(argument, value);
    index += 1;
  }
  return values;
}

export function requireOption(values, option) {
  const value = values.get(option);
  if (!value) throw new Error(`${option} is required.`);
  return value;
}

export function stableIds(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

export function isInside(root, candidate) {
  const path = resolve(candidate);
  return path === root || path.startsWith(`${root}${sep}`);
}

export function assertTemporaryDirectory(path, prefix) {
  const expectedParent = resolve(process.env.TMPDIR || "/tmp");
  const absolute = resolve(path);
  if (
    dirname(absolute) !== expectedParent ||
    !basename(absolute).startsWith(prefix)
  ) {
    throw new Error(`Refusing to remove non-harness directory ${absolute}.`);
  }
}

export function removeTemporaryDirectory(path, prefix) {
  assertTemporaryDirectory(path, prefix);
  rmSync(path, { recursive: true, force: true });
}

export function copyDirectory(source, destination) {
  const sourceRoot = resolve(source);
  const destinationRoot = resolve(destination);
  if (sourceRoot === destinationRoot)
    throw new Error("Fixture copy source and destination must differ.");
  mkdirSync(destinationRoot, { recursive: true });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const from = join(sourceRoot, entry.name);
    const to = join(destinationRoot, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) {
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(from));
    } else {
      throw new Error(`Fixture contains unsupported filesystem entry ${from}.`);
    }
  }
}

export function writeWorkspaceFile(root, path, contents) {
  const target = resolve(root, path);
  if (!isInside(resolve(root), target))
    throw new Error(`Fixture operation escapes workspace: ${path}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

export function deleteWorkspaceFile(root, path) {
  const target = resolve(root, path);
  if (!isInside(resolve(root), target) || !existsSync(target))
    throw new Error(`Fixture delete target is invalid: ${path}`);
  rmSync(target);
}

export function renameWorkspaceFile(root, from, to) {
  const source = resolve(root, from);
  const target = resolve(root, to);
  if (
    !isInside(resolve(root), source) ||
    !isInside(resolve(root), target) ||
    !existsSync(source)
  ) {
    throw new Error(`Fixture rename target is invalid: ${from} -> ${to}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  // Node's rename is atomic within this synthetic workspace.
  renameSync(source, target);
}

export function applyFixtureOperations(root, operations) {
  for (const operation of operations) {
    if (
      operation.kind === "write" &&
      typeof operation.path === "string" &&
      typeof operation.contents === "string"
    )
      writeWorkspaceFile(root, operation.path, operation.contents);
    else if (operation.kind === "delete" && typeof operation.path === "string")
      deleteWorkspaceFile(root, operation.path);
    else if (
      operation.kind === "rename" &&
      typeof operation.from === "string" &&
      typeof operation.to === "string"
    )
      renameWorkspaceFile(root, operation.from, operation.to);
    else
      throw new Error(
        `Invalid fixture operation ${JSON.stringify(operation)}.`,
      );
  }
}

export async function invoke(binary, request, cwd, environment = {}) {
  if (!isAbsolute(binary) || !existsSync(binary))
    throw new Error(`Executable does not exist: ${binary}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, [], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...environment },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const raw = stdout.join("").trim();
      try {
        const response = JSON.parse(raw);
        if (
          code !== 0 ||
          response.ok !== true ||
          response.result === undefined
        ) {
          reject(
            new Error(
              response.error ??
                (stderr.join("").trim() || `Engine exited ${String(code)}.`),
            ),
          );
          return;
        }
        resolvePromise(response.result);
      } catch (error) {
        reject(
          new Error(
            `Engine did not return protocol JSON: ${error instanceof Error ? error.message : "unknown parse error"}. ${stderr.join("").trim()}`,
          ),
        );
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function selectedTaskIds(plan) {
  if (!Array.isArray(plan.tasks))
    throw new Error("Engine plan has no task decisions.");
  return stableIds(
    plan.tasks
      .filter((task) => task?.decision === "run")
      .map((task) => task.id),
  );
}

export function compareSoundness(requiredTaskIds, selectedTaskIdsValue) {
  const required = stableIds(requiredTaskIds);
  const selected = stableIds(selectedTaskIdsValue);
  return {
    required,
    selected,
    falseNegatives: required.filter((id) => !selected.includes(id)),
    extra: selected.filter((id) => !required.includes(id)),
  };
}

export function jsonWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function relativeSafe(root, value) {
  const result = relative(root, value).replaceAll(sep, "/");
  return result.length === 0 ? "." : result;
}

export function validateSoundnessCase(testCase, allTaskIds) {
  if (
    !testCase ||
    typeof testCase.id !== "string" ||
    !Array.isArray(testCase.operations) ||
    !Array.isArray(testCase.requiredTaskIds) ||
    !Array.isArray(testCase.expectedChangedTaskIds) ||
    !["breaking", "control"].includes(testCase.classification) ||
    !["required", "forbidden"].includes(testCase.fullFallbackPolicy)
  ) {
    throw new Error("Soundness corpus contains an invalid case.");
  }
  if (
    (testCase.classification === "breaking") !==
    testCase.expectedChangedTaskIds.length > 0
  ) {
    throw new Error(`${testCase.id} has an invalid outcome classification.`);
  }
  for (const key of [
    "requiredTaskIds",
    "expectedSelectionTaskIds",
    "expectedChangedTaskIds",
  ]) {
    for (const id of testCase[key] ?? []) {
      if (!allTaskIds.includes(id))
        throw new Error(`${testCase.id} declares unknown ${key} task ${id}.`);
    }
  }
}

export function normalizeIssues(issues) {
  return Array.isArray(issues)
    ? issues
        .map((issue) => ({
          code: String(issue.code),
          message: String(issue.message),
          ...definedIssueFields(issue),
        }))
        .sort(
          (left, right) =>
            left.code.localeCompare(right.code) ||
            (left.path ?? "").localeCompare(right.path ?? "") ||
            (left.line ?? 0) - (right.line ?? 0) ||
            (left.column ?? 0) - (right.column ?? 0) ||
            left.message.localeCompare(right.message),
        )
    : [];
}

export function exactSelectionDifference(expected, selected) {
  const missing = expected.filter((id) => !selected.includes(id));
  const extra = selected.filter((id) => !expected.includes(id));
  return {
    matches: missing.length === 0 && extra.length === 0,
    expectedTaskIds: expected,
    missingTaskIds: missing,
    extraTaskIds: extra,
  };
}

export function fallbackPolicyFailureFor(policy, fullFallback) {
  if (policy === "required" && fullFallback !== true)
    return {
      policy,
      observedFullFallback: fullFallback,
      message: "This ambiguous case requires complete fallback.",
    };
  if (policy === "forbidden" && fullFallback !== false)
    return {
      policy,
      observedFullFallback: fullFallback,
      message: "This precision case must not collapse to complete fallback.",
    };
  return null;
}

function definedIssueFields(issue) {
  const fields = {};
  for (const key of ["severity", "scope", "path", "line", "column", "project"])
    if (issue[key] !== undefined) fields[key] = issue[key];
  return fields;
}
