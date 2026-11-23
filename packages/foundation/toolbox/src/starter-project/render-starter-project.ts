import type { DadsProjectTemplate } from "../dads-initialization-arguments.js";
import { kitStarterFiles } from "./kit-starter.generated.js";
import { renderMinimalProjectFiles } from "./render-minimal-project.js";
import { renderStarterVerificationFiles, withStarterScriptsPackage } from "./render-starter-verification-files.js";

export type StarterProjectFile = {
  readonly path: string;
  readonly content: string;
  readonly executable?: true;
};

/** Render the tested kit app with the adopter's package name and CI templates. */
export function renderStarterProjectFiles(options: {
  readonly projectName: string;
  readonly template?: DadsProjectTemplate;
}): readonly StarterProjectFile[] {
  if (options.template === "minimal") {
    return renderMinimalProjectFiles({ projectName: options.projectName });
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(options.projectName)) {
    throw new Error("Dads project names must use lowercase letters, numbers, dots, dashes, or underscores.");
  }
  const files = kitStarterFiles.map((file) => {
    if (file.path === "package.json") {
      return {
        ...file,
        content: file.content
          .replace('"@dads-fixture/kit-workbench"', JSON.stringify(options.projectName))
          .replace('"start": "tsx assembly/main.ts"', '"start": "node assembly/dev.mjs up"')
          .replace(
            '"verify": "npm run typecheck && npm test"',
            '"verify": "node scripts/verify.mjs",\n    "verify:checks": "npm run check:boundaries && npm run typecheck && npm run build:web && npm test",\n    "check:boundaries": "dad check boundaries",\n    "hooks:install": "sh .githooks/install"',
          ),
      };
    }
    if (file.path === "dads.project.json") {
      return {
        ...file,
        content: withStarterScriptsPackage(file.content),
      };
    }
    if (file.path === "dads.testing.json") {
      return {
        ...file,
        content: file.content.replaceAll("dads-fixture-kit-workbench", options.projectName),
      };
    }
    return file;
  });
  return [...files, ...renderStarterVerificationFiles()].sort((left, right) => left.path.localeCompare(right.path));
}
