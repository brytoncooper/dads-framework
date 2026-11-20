export function renderLibraryFiles(packageName: string, contractName: string) {
  return {
    "package.json":
      JSON.stringify(
        {
          name: packageName,
          version: "0.1.0",
          type: "module",
          exports: {
            ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
          },
          files: ["dist"],
          scripts: {
            build: "tsc -p tsconfig.json",
            test: "npm run build && node --test test/contract.smoke.mjs",
            prepack: "npm run build",
          },
          devDependencies: { typescript: "6.0.3" },
        },
        null,
        2,
      ) + "\n",
    "tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            strict: true,
            types: [],
            rootDir: "src",
            outDir: "dist",
            declaration: true,
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      ) + "\n",
    ".gitignore": "dist/\n",
    "src/index.ts": `export type { ${contractName} } from "./contract.js";\n`,
    "src/contract.ts": `export interface ${contractName} {\n  readonly id: string;\n}\n`,
    "test/contract.smoke.mjs": `import { test } from "node:test";

test("the package entry point loads", async () => {
  await import("${packageName}");
});
`,
    "README.md": `# ${packageName}

This package owns the ${contractName} contract shared with other repositories.

Import the contract from the package entry point.

\`\`\`ts
import type { ${contractName} } from "${packageName}";
\`\`\`

Run \`npm test --workspace ${packageName}\` from the owning repository to
build the JavaScript and declarations and check the package entry point.
\`npm pack --workspace ${packageName}\` creates an installable tarball.

Keep public exports in \`src/index.ts\`. Add proof for the public behavior as
the package grows. If consumers receive untrusted data, export a runtime parser
for that contract alongside its TypeScript type.
`,
  };
}
