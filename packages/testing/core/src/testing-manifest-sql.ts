import { isRecord, isUnknownArray } from "./parse-guards.js";

export type TestingManifestSqlEdge = {
  readonly from: string;
  readonly to: string;
};

export type TestingManifestSqlSnapshotPattern = {
  readonly prefix: string;
  readonly suffix: string;
};

export type TestingManifestWorkspaceSql = {
  readonly migrationRoots: readonly string[];
  readonly objects?: readonly string[];
  readonly edges?: readonly TestingManifestSqlEdge[];
  readonly snapshotPatterns?: readonly TestingManifestSqlSnapshotPattern[];
};

export type TestingManifestTaskSqlImpact = {
  readonly isMigrationRunner?: boolean;
  readonly tables?: readonly string[];
  readonly hasUnmappedSql?: boolean;
};

export function readWorkspaceSql(value: unknown, where: string, subject: string): TestingManifestWorkspaceSql {
  const sql = readObj(value, where, subject);
  rejectExtraKeys(sql, ["migrationRoots", "objects", "edges", "snapshotPatterns"], where, subject);
  const migrationRoots = readOptStrings(sql["migrationRoots"], `${where}.migrationRoots`, subject);
  const objects = readOptStrings(sql["objects"], `${where}.objects`, subject);
  const edges = sql["edges"] === undefined ? [] : readEdges(sql["edges"], `${where}.edges`, subject);
  const snapshotPatterns =
    sql["snapshotPatterns"] === undefined
      ? []
      : readSnapshotPatterns(sql["snapshotPatterns"], `${where}.snapshotPatterns`, subject);
  return {
    migrationRoots,
    ...(objects.length === 0 ? {} : { objects }),
    ...(edges.length === 0 ? {} : { edges }),
    ...(snapshotPatterns.length === 0 ? {} : { snapshotPatterns }),
  };
}

export function serializeWorkspaceSql(sql: TestingManifestWorkspaceSql): TestingManifestWorkspaceSql {
  return {
    migrationRoots: [...sql.migrationRoots],
    ...(sql.objects === undefined || sql.objects.length === 0 ? {} : { objects: [...sql.objects] }),
    ...(sql.edges === undefined || sql.edges.length === 0
      ? {}
      : { edges: sql.edges.map((edge) => ({ from: edge.from, to: edge.to })) }),
    ...(sql.snapshotPatterns === undefined || sql.snapshotPatterns.length === 0
      ? {}
      : { snapshotPatterns: sql.snapshotPatterns.map((p) => ({ prefix: p.prefix, suffix: p.suffix })) }),
  };
}

export function readTaskSqlImpact(value: unknown, where: string, subject: string): TestingManifestTaskSqlImpact {
  const impact = readObj(value, where, subject);
  rejectExtraKeys(impact, ["isMigrationRunner", "tables", "hasUnmappedSql"], where, subject);
  const isMigrationRunner = impact["isMigrationRunner"];
  const hasUnmappedSql = impact["hasUnmappedSql"];
  if (isMigrationRunner !== undefined && typeof isMigrationRunner !== "boolean") {
    throw new Error(`${subject}: ${where}.isMigrationRunner must be a boolean`);
  }
  if (hasUnmappedSql !== undefined && typeof hasUnmappedSql !== "boolean") {
    throw new Error(`${subject}: ${where}.hasUnmappedSql must be a boolean`);
  }
  const tables = readOptStrings(impact["tables"], `${where}.tables`, subject);
  return {
    ...(isMigrationRunner === true ? { isMigrationRunner: true } : {}),
    ...(tables.length === 0 ? {} : { tables }),
    ...(hasUnmappedSql === true ? { hasUnmappedSql: true } : {}),
  };
}

export function serializeTaskSqlImpact(impact: TestingManifestTaskSqlImpact): TestingManifestTaskSqlImpact {
  return {
    ...(impact.isMigrationRunner === true ? { isMigrationRunner: true } : {}),
    ...(impact.tables === undefined || impact.tables.length === 0 ? {} : { tables: [...impact.tables] }),
    ...(impact.hasUnmappedSql === true ? { hasUnmappedSql: true } : {}),
  };
}

function readEdges(value: unknown, where: string, subject: string): readonly TestingManifestSqlEdge[] {
  if (!isUnknownArray(value)) throw new Error(`${subject}: ${where} must be an array`);
  return value.map((item, idx) => {
    const loc = `${where}[${String(idx)}]`;
    const record = readObj(item, loc, subject);
    rejectExtraKeys(record, ["from", "to"], loc, subject);
    return {
      from: readStr(record["from"], `${loc}.from`, subject),
      to: readStr(record["to"], `${loc}.to`, subject),
    };
  });
}

function readSnapshotPatterns(
  value: unknown,
  where: string,
  subject: string,
): readonly TestingManifestSqlSnapshotPattern[] {
  if (!isUnknownArray(value)) throw new Error(`${subject}: ${where} must be an array`);
  return value.map((item, idx) => {
    const loc = `${where}[${String(idx)}]`;
    const record = readObj(item, loc, subject);
    rejectExtraKeys(record, ["prefix", "suffix"], loc, subject);
    return {
      prefix: readStr(record["prefix"], `${loc}.prefix`, subject),
      suffix: readStr(record["suffix"], `${loc}.suffix`, subject),
    };
  });
}

export function readObj(value: unknown, where: string, subject: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${subject}: ${where} must be an object`);
  return value;
}

export function readStr(value: unknown, where: string, subject: string): string {
  if (typeof value !== "string") throw new Error(`${subject}: ${where} must be a string`);
  return value;
}

export function readOptStrings(value: unknown, where: string, subject: string): readonly string[] {
  if (value === undefined) return [];
  if (!isUnknownArray(value)) throw new Error(`${subject}: ${where} must be an array`);
  return value.map((entry, idx) => readStr(entry, `${where}[${String(idx)}]`, subject));
}

export function rejectExtraKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  where: string,
  subject: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`${subject}: unknown key "${key}" in ${where}`);
  }
}
