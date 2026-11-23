/**
 * Which tracked files are continuous integration, and what a command line is.
 *
 * Three readings under "It's not you. It's my boundaries." ask something of
 * the commands a repository runs without a person present: does any of them
 * run the gate, does any of them bypass the hooks, does any of them force the
 * default branch. All three need the same two facts, and neither is worth
 * guessing at twice.
 *
 * The workflow list is a list of well-known locations rather than a search,
 * because a file that merely mentions a command is not a file that runs it,
 * and the only thing that distinguishes the two is where it sits.
 */

const WORKFLOW_DIRECTORIES = [".github/workflows/", ".buildkite/", ".circleci/"];
const WORKFLOW_FILES = [".gitlab-ci.yml", ".gitlab-ci.yaml", ".travis.yml", "azure-pipelines.yml", "Jenkinsfile"];
const WORKFLOW_EXTENSIONS = [".yml", ".yaml"];

/** Every continuous-integration definition in the file list. */
export function ciWorkflowFiles(files: readonly string[]): readonly string[] {
  return files.filter(isWorkflowFile);
}

/** The places a repository writes a command line other than a workflow. */
export function isShellScript(path: string): boolean {
  return path.endsWith(".sh") || path.startsWith(".githooks/");
}

function isWorkflowFile(path: string): boolean {
  if (WORKFLOW_FILES.includes(path)) return true;
  if (!WORKFLOW_DIRECTORIES.some((directory) => path.startsWith(directory))) {
    return false;
  }
  return WORKFLOW_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** The 1-based lines of `text` that match `pattern`, with the line's text. */
export function matchingLines(
  text: string,
  pattern: RegExp,
): readonly { readonly line: number; readonly text: string }[] {
  return text
    .split("\n")
    .map((content, offset) => ({ line: offset + 1, text: content }))
    .filter((entry) => pattern.test(entry.text));
}
