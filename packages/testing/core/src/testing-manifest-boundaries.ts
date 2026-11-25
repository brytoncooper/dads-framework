import { isUnknownArray } from "./parse-guards.js";
import { readObj, readOptStrings, readStr, rejectExtraKeys } from "./testing-manifest-sql.js";

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
  readonly banTransitiveDependencies?: boolean;
  readonly ignorePaths?: readonly string[];
  readonly excludeProjects?: readonly string[];
};

export function readWorkspaceBoundaries(
  value: unknown,
  where: string,
  subject: string,
): TestingManifestWorkspaceBoundaries {
  const boundaries = readObj(value, where, subject);
  rejectExtraKeys(
    boundaries,
    [
      "depConstraints",
      "allow",
      "allowCircularSelfDependency",
      "enforceBuildableLibDependency",
      "checkNestedImports",
      "banTransitiveDependencies",
      "ignorePaths",
      "excludeProjects",
    ],
    where,
    subject,
  );
  const depConstraints =
    boundaries["depConstraints"] === undefined
      ? []
      : parseManifestDepConstraints(boundaries["depConstraints"], `${where}.depConstraints`, subject);
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
  const banTransitiveDependencies = readOptBool(
    boundaries["banTransitiveDependencies"],
    `${where}.banTransitiveDependencies`,
    subject,
  );
  const ignorePaths = readOptStrings(boundaries["ignorePaths"], `${where}.ignorePaths`, subject);
  const excludeProjects = readOptStrings(boundaries["excludeProjects"], `${where}.excludeProjects`, subject);
  return {
    ...(depConstraints.length === 0 ? {} : { depConstraints }),
    ...(allow.length === 0 ? {} : { allow }),
    ...(allowCircularSelfDependency === true ? { allowCircularSelfDependency: true } : {}),
    ...(enforceBuildableLibDependency === true ? { enforceBuildableLibDependency: true } : {}),
    ...(checkNestedImports === true ? { checkNestedImports: true } : {}),
    ...(banTransitiveDependencies === true ? { banTransitiveDependencies: true } : {}),
    ...(ignorePaths.length === 0 ? {} : { ignorePaths }),
    ...(excludeProjects.length === 0 ? {} : { excludeProjects }),
  };
}

export function serializeWorkspaceBoundaries(
  boundaries: TestingManifestWorkspaceBoundaries,
): TestingManifestWorkspaceBoundaries {
  const depConstraints = nonEmpty(boundaries.depConstraints)?.map(serializeDepConstraint);
  const allow = copyNonEmpty(boundaries.allow);
  const ignorePaths = copyNonEmpty(boundaries.ignorePaths);
  const excludeProjects = copyNonEmpty(boundaries.excludeProjects);
  return {
    ...(depConstraints === undefined ? {} : { depConstraints }),
    ...(allow === undefined ? {} : { allow }),
    ...serializeBoundaryFlags(boundaries),
    ...(ignorePaths === undefined ? {} : { ignorePaths }),
    ...(excludeProjects === undefined ? {} : { excludeProjects }),
  };
}

function serializeBoundaryFlags(boundaries: TestingManifestWorkspaceBoundaries): TestingManifestWorkspaceBoundaries {
  return {
    ...(boundaries.allowCircularSelfDependency === true ? { allowCircularSelfDependency: true } : {}),
    ...(boundaries.enforceBuildableLibDependency === true ? { enforceBuildableLibDependency: true } : {}),
    ...(boundaries.checkNestedImports === true ? { checkNestedImports: true } : {}),
    ...(boundaries.banTransitiveDependencies === true ? { banTransitiveDependencies: true } : {}),
  };
}

function nonEmpty<T>(items: readonly T[] | undefined): readonly T[] | undefined {
  return items === undefined || items.length === 0 ? undefined : items;
}

function copyNonEmpty(items: readonly string[] | undefined): readonly string[] | undefined {
  const list = nonEmpty(items);
  return list === undefined ? undefined : [...list];
}

function parseManifestDepConstraints(
  value: unknown,
  where: string,
  subject: string,
): readonly TestingManifestDepConstraint[] {
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

function readOptBool(value: unknown, where: string, subject: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${subject}: ${where} must be a boolean`);
  return value;
}

function readOptionalExplicitStrings(value: unknown, where: string, subject: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!isUnknownArray(value)) throw new Error(`${subject}: ${where} must be an array`);
  return value.map((entry, idx) => readStr(entry, `${where}[${String(idx)}]`, subject));
}
