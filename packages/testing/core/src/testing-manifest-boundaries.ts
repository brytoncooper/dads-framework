import { isRecord, isUnknownArray } from "./parse-guards.js";

export type TestingManifestDepConstraint = {
  readonly sourceTag: string;
  readonly onlyDependOnLibsWithTags?: readonly string[];
  readonly notDependOnLibsWithTags?: readonly string[];
  readonly bannedExternalImports?: readonly string[];
  readonly allowedExternalImports?: readonly string[];
};

export type TestingManifestWorkspaceBoundaries = {
  readonly depConstraints?: readonly TestingManifestDepConstraint[];
  readonly allow?: readonly string[];
  readonly allowCircularSelfDependency?: boolean;
  readonly enforceBuildableLibDependency?: boolean;
  readonly checkNestedImports?: boolean;
};

export function readWorkspaceBoundaries(
  value: unknown,
  where: string,
  subject: string,
): TestingManifestWorkspaceBoundaries {
  const boundaries = readObj(value, where, subject);
  rejectExtraKeys(
    boundaries,
    ["depConstraints", "allow", "allowCircularSelfDependency", "enforceBuildableLibDependency", "checkNestedImports"],
    where,
    subject,
  );
  const depConstraints =
    boundaries["depConstraints"] === undefined
      ? []
      : readDepConstraints(boundaries["depConstraints"], `${where}.depConstraints`, subject);
  const allow = readOptStrings(boundaries["allow"], `${where}.allow`, subject);
  const allowCircularSelfDependency = readOptBool(
    boundaries["allowCircularSelfDependency"],
    `${where}.allowCircularSelfDependency`,
    subject,
  );
  const enforceBuildableLibDependency = readOptBool(
    boundaries["enforceBuildableLibDependency"],
    `${where}.enforceBuildableLibDependency`,
    subject,
  );
  const checkNestedImports = readOptBool(boundaries["checkNestedImports"], `${where}.checkNestedImports`, subject);
  return {
    ...(depConstraints.length === 0 ? {} : { depConstraints }),
    ...(allow.length === 0 ? {} : { allow }),
    ...(allowCircularSelfDependency === true ? { allowCircularSelfDependency: true } : {}),
    ...(enforceBuildableLibDependency === true ? { enforceBuildableLibDependency: true } : {}),
    ...(checkNestedImports === true ? { checkNestedImports: true } : {}),
  };
}

export function serializeWorkspaceBoundaries(
  boundaries: TestingManifestWorkspaceBoundaries,
): TestingManifestWorkspaceBoundaries {
  return {
    ...(boundaries.depConstraints === undefined || boundaries.depConstraints.length === 0
      ? {}
      : { depConstraints: boundaries.depConstraints.map(serializeDepConstraint) }),
    ...(boundaries.allow === undefined || boundaries.allow.length === 0 ? {} : { allow: [...boundaries.allow] }),
    ...(boundaries.allowCircularSelfDependency === true ? { allowCircularSelfDependency: true } : {}),
    ...(boundaries.enforceBuildableLibDependency === true ? { enforceBuildableLibDependency: true } : {}),
    ...(boundaries.checkNestedImports === true ? { checkNestedImports: true } : {}),
  };
}

function readDepConstraints(value: unknown, where: string, subject: string): readonly TestingManifestDepConstraint[] {
  if (!isUnknownArray(value)) throw new Error(`${subject}: ${where} must be an array`);
  return value.map((item, idx) => {
    const loc = `${where}[${String(idx)}]`;
    const record = readObj(item, loc, subject);
    rejectExtraKeys(
      record,
      [
        "sourceTag",
        "onlyDependOnLibsWithTags",
        "notDependOnLibsWithTags",
        "bannedExternalImports",
        "allowedExternalImports",
      ],
      loc,
      subject,
    );
    const onlyTags = readOptionalExplicitStrings(
      record["onlyDependOnLibsWithTags"],
      `${loc}.onlyDependOnLibsWithTags`,
      subject,
    );
    const notTags = readOptionalExplicitStrings(
      record["notDependOnLibsWithTags"],
      `${loc}.notDependOnLibsWithTags`,
      subject,
    );
    const banned = readOptionalExplicitStrings(
      record["bannedExternalImports"],
      `${loc}.bannedExternalImports`,
      subject,
    );
    const allowed = readOptionalExplicitStrings(
      record["allowedExternalImports"],
      `${loc}.allowedExternalImports`,
      subject,
    );
    return {
      sourceTag: readStr(record["sourceTag"], `${loc}.sourceTag`, subject),
      ...(onlyTags === undefined ? {} : { onlyDependOnLibsWithTags: onlyTags }),
      ...(notTags === undefined ? {} : { notDependOnLibsWithTags: notTags }),
      ...(banned === undefined ? {} : { bannedExternalImports: banned }),
      ...(allowed === undefined ? {} : { allowedExternalImports: allowed }),
    };
  });
}

function serializeDepConstraint(constraint: TestingManifestDepConstraint): TestingManifestDepConstraint {
  return {
    sourceTag: constraint.sourceTag,
    ...(constraint.onlyDependOnLibsWithTags === undefined
      ? {}
      : { onlyDependOnLibsWithTags: [...constraint.onlyDependOnLibsWithTags] }),
    ...(constraint.notDependOnLibsWithTags === undefined
      ? {}
      : { notDependOnLibsWithTags: [...constraint.notDependOnLibsWithTags] }),
    ...(constraint.bannedExternalImports === undefined
      ? {}
      : { bannedExternalImports: [...constraint.bannedExternalImports] }),
    ...(constraint.allowedExternalImports === undefined
      ? {}
      : { allowedExternalImports: [...constraint.allowedExternalImports] }),
  };
}

function readObj(value: unknown, where: string, subject: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${subject}: ${where} must be an object`);
  return value;
}

function readStr(value: unknown, where: string, subject: string): string {
  if (typeof value !== "string") throw new Error(`${subject}: ${where} must be a string`);
  return value;
}

function readOptBool(value: unknown, where: string, subject: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${subject}: ${where} must be a boolean`);
  return value;
}

function readOptStrings(value: unknown, where: string, subject: string): readonly string[] {
  if (value === undefined) return [];
  if (!isUnknownArray(value)) throw new Error(`${subject}: ${where} must be an array`);
  return value.map((entry, idx) => readStr(entry, `${where}[${String(idx)}]`, subject));
}

function readOptionalExplicitStrings(value: unknown, where: string, subject: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!isUnknownArray(value)) throw new Error(`${subject}: ${where} must be an array`);
  return value.map((entry, idx) => readStr(entry, `${where}[${String(idx)}]`, subject));
}

function rejectExtraKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  where: string,
  subject: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`${subject}: unknown key "${key}" in ${where}`);
  }
}
