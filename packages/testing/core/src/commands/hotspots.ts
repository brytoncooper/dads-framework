import type { OptionSpecification } from "../cli-arguments.js";
import { readPositiveInteger } from "../cli-arguments.js";
import { writeCommandSuccess } from "../cli-output.js";
import type { DadTestCommand } from "../dad-test-cli.js";
import { hotspotsTesting } from "../testing-api.js";
import type { TestingHotspotFile, TestingHotspotProject, TestingHotspotsResult } from "../testing-api.js";
import { enrichMissingManifestError, plural } from "./diagnose.js";

const hotspotsOptions: readonly OptionSpecification[] = [
  { name: "--manifest", kind: "value" },
  { name: "--limit", kind: "value" },
  { name: "--min-projects", kind: "value" },
  { name: "--barrels-only", kind: "flag" },
];

/**
 * `dad-test hotspots` traverses the workspace import graph to rank the
 * highest-blast-radius source files, barrel re-export hubs, and projects.
 */
export const hotspotsCommand: DadTestCommand = {
  options: hotspotsOptions,
  execute: async (parsed, io, json) => {
    const manifestPath = parsed.values.get("--manifest");
    const rawLimit = parsed.values.get("--limit");
    const rawMinProjects = parsed.values.get("--min-projects");
    const limit = rawLimit === undefined ? undefined : readPositiveInteger(rawLimit, "--limit");
    const minProjects =
      rawMinProjects === undefined ? undefined : readPositiveInteger(rawMinProjects, "--min-projects");
    const barrelsOnly = parsed.flags.has("--barrels-only");

    const result = await runHotspots(io.cwd, manifestPath, limit, minProjects, barrelsOnly, io.nativeBinary);
    if (json) {
      writeCommandSuccess(io, json, "hotspots", result);
    } else {
      io.stdout(renderHotspots(result));
    }
    return 0;
  },
};

async function runHotspots(
  workspaceRoot: string,
  manifestPath: string | undefined,
  limit: number | undefined,
  minProjects: number | undefined,
  barrelsOnly: boolean,
  nativeBinary: string | undefined,
): Promise<TestingHotspotsResult> {
  try {
    return await hotspotsTesting({
      workspaceRoot,
      ...(manifestPath === undefined ? {} : { manifestPath }),
      ...(limit === undefined ? {} : { limit }),
      ...(minProjects === undefined ? {} : { minProjects }),
      ...(barrelsOnly ? { barrelsOnly: true } : {}),
      ...(nativeBinary === undefined ? {} : { nativeBinary }),
    });
  } catch (error: unknown) {
    throw enrichMissingManifestError(error, manifestPath);
  }
}

/** Renders a human-readable blast-radius hotspot table for files and projects. */
export function renderHotspots(result: TestingHotspotsResult): string {
  const { summary } = result;
  const barrelNote = summary.barrelsOnly ? ", barrels-only" : "";
  const lines: string[] = [
    `hotspots: ${plural(summary.totalFiles, "file")} (${plural(summary.totalBarrels, "barrel")}) across ${plural(summary.totalProjects, "project")} (limit ${String(summary.limit)}, min-projects >= ${String(summary.minProjects)}${barrelNote})`,
  ];
  appendFileTable(lines, result.files);
  appendProjectTable(lines, result.projects);
  return `${lines.join("\n")}\n`;
}

function appendFileTable(lines: string[], files: readonly TestingHotspotFile[]): void {
  lines.push("");
  if (files.length === 0) {
    lines.push("Top files: none");
    return;
  }
  lines.push(`Top files (${String(files.length)}):`);
  const rows = files.map((file) => [
    String(file.affectedProjects),
    String(file.affectedFiles),
    String(file.directImporters),
    file.isBarrel ? "yes" : "no",
    file.project ?? "-",
    file.path,
  ]);
  renderAlignedTable(lines, ["PROJECTS", "FILES", "IMPORTERS", "BARREL", "PROJECT", "PATH"], rows, [
    "right",
    "right",
    "right",
    "left",
    "left",
    "left",
  ]);
}

function appendProjectTable(lines: string[], projects: readonly TestingHotspotProject[]): void {
  lines.push("");
  if (projects.length === 0) {
    lines.push("Top projects: none");
    return;
  }
  lines.push(`Top projects (${String(projects.length)}):`);
  const rows = projects.map((project) => [
    String(project.affectedProjects),
    String(project.affectedFiles),
    String(project.directDependentProjects),
    String(project.fileCount),
    String(project.barrelCount),
    project.project,
  ]);
  renderAlignedTable(lines, ["PROJECTS", "FILES", "DIRECT_DEPS", "TOTAL_FILES", "BARRELS", "PROJECT"], rows, [
    "right",
    "right",
    "right",
    "right",
    "right",
    "left",
  ]);
}

function renderAlignedTable(
  lines: string[],
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  alignments: readonly ("left" | "right")[],
): void {
  const widths = headers.map((header, column) => {
    let width = header.length;
    for (const row of rows) {
      const cell = row[column] ?? "";
      if (cell.length > width) width = cell.length;
    }
    return width;
  });
  lines.push(`  ${formatRow(headers, widths, alignments)}`);
  for (const row of rows) {
    lines.push(`  ${formatRow(row, widths, alignments)}`);
  }
}

function formatRow(
  cells: readonly string[],
  widths: readonly number[],
  alignments: readonly ("left" | "right")[],
): string {
  return cells
    .map((cell, index) => {
      if (index === cells.length - 1) return cell;
      const width = widths[index] ?? cell.length;
      const alignment = alignments[index] ?? "left";
      return alignment === "right" ? cell.padStart(width) : cell.padEnd(width);
    })
    .join("  ");
}
