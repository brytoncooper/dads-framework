import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";

const EXTERNAL = /^(https?:|mailto:)/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const REPOSITORY_BLOB =
  "https://github.com/brytoncooper/dads-framework/blob/main/";
const PRIVATE =
  /^(?:docs\/(?:private|plans|decisions|benchmarks|agents)\/|\.agents\/plans\/|\.git\/|node_modules\/|dist\/|\.env(?:\.|$))/;

function localTarget(source, path) {
  const value = decodeURIComponent(path);
  return value.startsWith("/")
    ? posix.normalize(value.slice(1))
    : posix.join(posix.dirname(source), value);
}

function repositoryFile(root, path) {
  const absolute = resolve(root, path);
  const inside = relative(root, absolute).split(sep).join("/");
  if (inside.startsWith("../") || inside === ".." || PRIVATE.test(inside)) {
    throw new Error(`Docs link cannot expose ${path}.`);
  }
  return absolute;
}

function fileOrReadme(root, path) {
  const absolute = repositoryFile(root, path);
  const status = lstatSync(absolute, { throwIfNoEntry: false });
  if (status?.isFile()) return path;
  if (status?.isDirectory()) {
    const readme = posix.join(path, "README.md");
    if (
      lstatSync(repositoryFile(root, readme), {
        throwIfNoEntry: false,
      })?.isFile()
    ) {
      return readme;
    }
  }
  return undefined;
}

export function markdownLink({ root, pages, files, source, target }) {
  if (target.startsWith("#") || EXTERNAL.test(target) || target === "")
    return target;
  if (SCHEME.test(target) || target.startsWith("//")) {
    throw new Error(`${source}: unsupported link target ${target}.`);
  }
  const split = target.search(/[?#]/u);
  const path = split === -1 ? target : target.slice(0, split);
  const suffix = split === -1 ? "" : target.slice(split);
  const candidate = localTarget(source, path);
  repositoryFile(root, candidate);
  const page = pages.get(candidate);
  if (page) return `${page.slug}.html${suffix}`;
  const file = fileOrReadme(root, candidate);
  if (!file)
    throw new Error(
      `${source}: link ${target} has no file or directory README.`,
    );
  const readmePage = pages.get(file);
  if (readmePage) return `${readmePage.slug}.html${suffix}`;

  const relativeFile = `source/${file}`;
  if (!files.has(relativeFile)) {
    files.set(relativeFile, readPublicFile(root, file));
  }
  const encodedPath = file.split("/").map(encodeURIComponent).join("/");
  if (/\.md$/i.test(file)) return `${REPOSITORY_BLOB}${encodedPath}${suffix}`;
  return `source/${encodedPath}${suffix}`;
}

export function readPublicFile(root, path) {
  const absolute = repositoryFile(root, path);
  const canonical = realpathSync(absolute);
  repositoryFile(realpathSync(root), canonical);
  return readFileSync(canonical);
}

export function exampleFileReader(root, files) {
  const tracked = new Set(
    execFileSync("git", ["ls-files", "--full-name", "-z"], {
      cwd: root,
      encoding: "utf8",
    }).split("\0"),
  );
  const canonicalRoot = realpathSync(root);
  return (path) => {
    if (
      typeof path !== "string" ||
      path === "" ||
      path.startsWith("-") ||
      posix.isAbsolute(path) ||
      posix.normalize(path) !== path ||
      !tracked.has(path)
    ) {
      throw new Error(`Docs example needs a tracked repository file: ${path}.`);
    }
    const absolute = repositoryFile(canonicalRoot, path);
    if (realpathSync(absolute) !== absolute || !lstatSync(absolute).isFile()) {
      throw new Error(
        `Docs example must point directly to a repository file: ${path}.`,
      );
    }
    const file = readPublicFile(canonicalRoot, path);
    files.set(`source/${path}`, file);
    return file;
  };
}
