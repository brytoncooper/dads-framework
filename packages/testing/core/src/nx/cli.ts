import { importNxTestingWorkspace } from "./import-nx.js";

const [workspaceRoot, shaFlag, expectedGitSha] = process.argv.slice(2);

if (!workspaceRoot || shaFlag !== "--sha" || !expectedGitSha || process.argv.length !== 5) {
  process.stderr.write("Usage: dad-test-import-nx <nx-workspace-root> --sha <full-git-sha>\n");
  process.exitCode = 2;
} else {
  importNxTestingWorkspace({ workspaceRoot, expectedGitSha })
    .then((result) => {
      process.stdout.write(
        `Imported ${String(result.manifest.tasks.length)} standalone task(s); report: ${result.reportPath}\n`,
      );
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown import failure.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
