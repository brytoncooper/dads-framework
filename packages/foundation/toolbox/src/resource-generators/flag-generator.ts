import type { GenerationPlan } from "./generation-plan.js";
import { camel, title } from "./names.js";

export function addFlag(plan: GenerationPlan, domain: string, name: string): void {
  const flag = `${camel(name)}Flag`;
  const directory = `domains/${domain}/server`;
  plan.create(
    `${directory}/${name}-flag.ts`,
    `import { defineFeatureFlag } from "@dads-framework/feature-flags";

export const ${flag} = defineFeatureFlag({
  slug: "${domain}.${name}",
  name: "${title(name)}",
  description: "Enables ${title(name)} for selected audiences.",
  owner: "${domain}",
  defaultEnabled: false,
  affectedPages: ["/${domain}/${name}"],
  affectedApiCapabilities: [],
  cleanupTrigger: "Remove after the feature is stable for everyone.",
  globalStabilityDays: 14,
});
`,
  );
  plan.appendLine(`${directory}/flags.ts`, "// dad:add imports", `import { ${flag} } from "./${name}-flag.js";`);
  plan.appendLine(`${directory}/flags.ts`, "// dad:add flags", `  ${flag},`);
}
