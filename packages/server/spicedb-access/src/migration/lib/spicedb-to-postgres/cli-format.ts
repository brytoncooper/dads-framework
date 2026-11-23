import type { AccessIrDefinition } from "@dads-framework/access";

import type { ImportSpiceDbCliOptions } from "./cli-args.js";
import type { MigrateSpiceDbToPostgresResult } from "./migrate-spicedb-to-postgres.js";
import type { ParityMismatch, ParityVerificationResult } from "./verify-parity.js";

export function formatDryRunOutput(input: {
  readonly options: ImportSpiceDbCliOptions;
  readonly definitions: readonly AccessIrDefinition[];
  readonly zedToken: string | undefined;
  readonly generatedTypeScript: string;
}): string {
  const names = input.definitions.map((def) => def.wireName);
  if (input.options.json) {
    return `${JSON.stringify(
      {
        ok: true,
        dryRun: true,
        endpoint: input.options.endpoint,
        namespace: input.options.namespace,
        definitions: names,
        ...(input.zedToken === undefined ? {} : { zedToken: input.zedToken }),
        generatedTypeScript: input.generatedTypeScript,
      },
      null,
      2,
    )}\n`;
  }
  return [
    `Dry run: parsed ${names.length} definitions from ${input.options.endpoint} (no Postgres or disk writes).`,
    "",
    input.generatedTypeScript,
  ].join("\n");
}

export function formatLiveJsonOutput(
  options: ImportSpiceDbCliOptions,
  migration: MigrateSpiceDbToPostgresResult,
  parity: ParityVerificationResult | undefined,
  ok: boolean,
): string {
  return `${JSON.stringify(
    {
      ok,
      dryRun: false,
      endpoint: options.endpoint,
      namespace: options.namespace,
      definitions: migration.definitions.map((def) => def.wireName),
      exportedCount: migration.exportedCount,
      writtenCount: migration.writtenCount,
      ...(migration.zedToken === undefined ? {} : { zedToken: migration.zedToken }),
      ...(options.out === undefined ? {} : { outPath: options.out }),
      ...(parity === undefined ? {} : { parity }),
    },
    null,
    2,
  )}\n`;
}

export function formatLiveTextOutput(
  options: ImportSpiceDbCliOptions,
  migration: MigrateSpiceDbToPostgresResult,
  parity: ParityVerificationResult | undefined,
): string {
  const lines = [
    `Migrated ${migration.exportedCount} relationships (${migration.writtenCount} upserted) into Postgres namespace "${options.namespace}" (${migration.definitions.length} definitions).`,
  ];
  if (options.out !== undefined) {
    lines.push(`Wrote generated TypeScript access model to ${options.out}.`);
  }
  if (parity !== undefined && parity.mismatches.length === 0) {
    lines.push(`Parity verified: ${parity.matched}/${parity.total} queries matched (0 mismatches).`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatParityFailureText(parity: ParityVerificationResult): string {
  const preview = parity.mismatches.slice(0, 5).map(describeMismatch);
  const lines = [
    `Parity check failed: ${parity.matched}/${parity.total} queries matched (${parity.mismatches.length} mismatches).`,
    ...preview,
  ];
  if (parity.mismatches.length > preview.length) {
    lines.push(`...and ${parity.mismatches.length - preview.length} more.`);
  }
  return `${lines.join("\n")}\n`;
}

function describeMismatch(mismatch: ParityMismatch): string {
  if (mismatch.kind === "check") {
    const q = mismatch.query;
    return `  - check ${q.subject.type}:${q.subject.id} ${q.permission} ${q.resource.type}:${q.resource.id} (SpiceDB=${String(mismatch.spiceDb)}, Postgres=${String(mismatch.postgres)})`;
  }
  const q = mismatch.query;
  return `  - lookup ${q.subject.type}:${q.subject.id} ${q.permission} ${q.resourceType} (SpiceDB=[${mismatch.spiceDb.join(",")}], Postgres=[${mismatch.postgres.join(",")}])`;
}

export function formatArgError(message: string, usage: string, asJson: boolean): string {
  if (asJson) {
    return `${JSON.stringify({ ok: false, error: message })}\n`;
  }
  return `dads-import-spicedb: ${message}\n\n${usage}\n`;
}

export function formatRuntimeError(message: string, asJson: boolean): string {
  if (asJson) {
    return `${JSON.stringify({ ok: false, error: message })}\n`;
  }
  return `dads-import-spicedb: ${message}\n`;
}
