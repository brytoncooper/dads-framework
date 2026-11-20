/* global process */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const configPath = join(root, ".agents/instruction-budgets.json");
const budgets = JSON.parse(readFileSync(configPath, "utf8"));
const agentEntrypoint = requireRecord(budgets, "agentEntrypoint");
const skills = requireRecord(budgets, "skills");
requireString(agentEntrypoint, "path", "agentEntrypoint");
requirePositiveNumber(
  agentEntrypoint,
  "maxApproximateTokens",
  "agentEntrypoint",
);
requireString(skills, "directory", "skills");
requirePositiveNumber(skills, "maxApproximateTokensPerSkill", "skills");
requirePositiveNumber(skills, "maxApproximateTokensPerWorkflowSkill", "skills");
requirePositiveNumber(
  skills,
  "maxApproximateTokensPerSupportingReference",
  "skills",
);
requirePositiveNumber(skills, "maxApproximateTokensTotal", "skills");

const entrypointTokens = approximateTokens(
  readFileSync(join(root, agentEntrypoint.path), "utf8"),
);
assertWithinBudget(
  agentEntrypoint.path,
  entrypointTokens,
  agentEntrypoint.maxApproximateTokens,
);

const skillDirectory = join(root, skills.directory);
const entries = readdirSync(skillDirectory, { withFileTypes: true }).sort(
  (left, right) => left.name.localeCompare(right.name),
);
if (entries.length === 0) {
  throw new Error(`${skills.directory} contains no canonical skill folders.`);
}

let totalSkillTokens = 0;
let supportingReferenceTokens = 0;
let supportingReferenceCount = 0;
const supportingReferences = [];
for (const entry of entries) {
  if (!entry.isDirectory()) {
    throw new Error(
      `${skills.directory}/${entry.name} is an unexpected skill entry; expected a directory.`,
    );
  }

  const skillFolder = join(skillDirectory, entry.name);
  const skillFile = join(skillFolder, "SKILL.md");
  const skillText = readRegularFile(skillFile, "canonical skill entrypoint");
  const metadata = parseFrontmatter(skillText, relative(root, skillFile));
  if (metadata.name !== entry.name) {
    throw new Error(
      `${relative(root, skillFile)} declares name ${JSON.stringify(metadata.name)}; expected ${JSON.stringify(entry.name)}.`,
    );
  }
  const workflow = classifySkill(metadata, relative(root, skillFile));
  const tokens = approximateTokens(skillText);
  totalSkillTokens += tokens;
  assertWithinBudget(
    relative(root, skillFile),
    tokens,
    workflow
      ? skills.maxApproximateTokensPerWorkflowSkill
      : skills.maxApproximateTokensPerSkill,
  );

  for (const markdownFile of findSupportingMarkdown(skillFolder, skillFile)) {
    const text = readRegularFile(markdownFile, "supporting Markdown reference");
    const referenceTokens = approximateTokens(text);
    const referencePath = relative(root, markdownFile);
    assertWithinBudget(
      referencePath,
      referenceTokens,
      skills.maxApproximateTokensPerSupportingReference,
    );
    supportingReferenceTokens += referenceTokens;
    supportingReferenceCount += 1;
    supportingReferences.push({ path: referencePath, tokens: referenceTokens });
  }
}

// This combined ceiling intentionally includes both ordinary and workflow entrypoints.
assertWithinBudget(
  "all canonical skills",
  totalSkillTokens,
  skills.maxApproximateTokensTotal,
);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    entrypointTokens,
    skillTokens: totalSkillTokens,
    skillCount: entries.length,
    supportingReferenceTokens,
    supportingReferenceCount,
    supportingReferences,
  })}\n`,
);

function approximateTokens(text) {
  return Math.ceil(text.length / 4);
}

function assertWithinBudget(name, actual, maximum) {
  if (actual > maximum) {
    throw new Error(
      `${name} uses approximately ${actual} tokens; budget is ${maximum}.`,
    );
  }
}

function requireRecord(parent, key) {
  const value = parent[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Instruction budget field ${key} must be an object.`);
  }
  return value;
}

function requireString(parent, key, scope) {
  if (typeof parent[key] !== "string" || parent[key].length === 0) {
    throw new Error(
      `Instruction budget field ${scope}.${key} must be a non-empty string.`,
    );
  }
}

function requirePositiveNumber(parent, key, scope) {
  if (
    typeof parent[key] !== "number" ||
    !Number.isFinite(parent[key]) ||
    parent[key] <= 0
  ) {
    throw new Error(
      `Instruction budget field ${scope}.${key} must be positive.`,
    );
  }
}

function readRegularFile(file, description) {
  let stats;
  try {
    stats = statSync(file);
  } catch (error) {
    throw new Error(`Missing ${description}: ${relative(root, file)}.`, {
      cause: error,
    });
  }
  if (!stats.isFile()) {
    throw new Error(`${relative(root, file)} is not a regular file.`);
  }
  return readFileSync(file, "utf8");
}

function findSupportingMarkdown(directory, canonicalFile) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...findSupportingMarkdown(file, canonicalFile));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `${relative(root, file)} is an unexpected skill resource; expected a file or directory.`,
      );
    }
    if (!entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }
    if (file === canonicalFile) {
      continue;
    }
    if (entry.name.toLowerCase() === "skill.md") {
      throw new Error(
        `${relative(root, file)} is an unexpected nested canonical skill entrypoint.`,
      );
    }
    files.push(file);
  }
  return files;
}

function parseFrontmatter(text, file) {
  const lines = text.split("\n");
  if (lines[0] !== "---") {
    throw new Error(`${file} is missing YAML frontmatter.`);
  }
  const end = lines.indexOf("---", 1);
  if (end < 0) {
    throw new Error(`${file} has unterminated YAML frontmatter.`);
  }
  const metadata = {};
  for (const line of lines.slice(1, end)) {
    const match = /^(?<key>[A-Za-z0-9_-]+):\s*(?<value>.*)$/.exec(line);
    if (!match) {
      throw new Error(`${file} has malformed frontmatter line: ${line}`);
    }
    if (Object.hasOwn(metadata, match.groups.key)) {
      throw new Error(`${file} repeats frontmatter field ${match.groups.key}.`);
    }
    metadata[match.groups.key] = unquote(match.groups.value);
  }
  return metadata;
}

function classifySkill(metadata, file) {
  const hasRole = Object.hasOwn(metadata, "role");
  const hasInvocationPolicy = Object.hasOwn(
    metadata,
    "disable-model-invocation",
  );
  if (!hasRole && !hasInvocationPolicy) {
    return false;
  }
  if (
    metadata.role !== "workflow" ||
    metadata["disable-model-invocation"] !== "true"
  ) {
    throw new Error(
      `${file} has ambiguous workflow metadata; role: workflow and disable-model-invocation: true are required together.`,
    );
  }
  return true;
}

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
