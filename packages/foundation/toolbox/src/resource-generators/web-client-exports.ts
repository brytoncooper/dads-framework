import type { GenerationPlan } from "./generation-plan.js";

const webExportMarker = "// dad:add exports";

export function exposeWebArtifact(
  plan: GenerationPlan,
  domain: string,
  exportLine: string,
): void {
  const path = `domains/${domain}/web-client/index.ts`;
  const content = plan.read(path);
  if (content === undefined) plan.create(path, `${webExportMarker}\n`);
  const marker = content?.split("\n").includes("export {};")
    ? "export {};"
    : webExportMarker;
  plan.appendLine(path, marker, exportLine);
}
