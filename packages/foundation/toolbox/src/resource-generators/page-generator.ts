import type { GenerationPlan } from "./generation-plan.js";
import { camel, title } from "./names.js";
import { exposeWebArtifact } from "./web-client-exports.js";

export function addPage(plan: GenerationPlan, domain: string, name: string): void {
  const functionName = `render${capitalized(camel(name))}Page`;
  const path = `domains/${domain}/web-client`;
  exposeWebArtifact(plan, domain, `export { ${functionName} } from "./${name}-page.js";`);
  plan.create(
    `${path}/${name}-page.ts`,
    `export function ${functionName}(): string {
  return "<main><h1>${title(name)}</h1></main>";
}
`,
  );
  plan.create(
    `${path}/${name}-page.test.ts`,
    `import { expect, it } from "vitest";

import { ${functionName} } from "./${name}-page.js";

it("renders the page heading", () => {
  expect(${functionName}()).toContain("<h1>${title(name)}</h1>");
});
`,
  );
}

function capitalized(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
