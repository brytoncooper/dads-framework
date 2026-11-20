import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";

const EXTERNAL = /^(https?:|mailto:)/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
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
  const page = pages.get(candidate);
  if (page) return `${page.slug}.html${suffix}`;
  const file = fileOrReadme(root, candidate);
  if (!file)
    throw new Error(
      `${source}: link ${target} has no file or directory README.`,
    );
  const relativeFile = `source/${file.split(sep).join("/")}`;
  if (!files.has(relativeFile)) {
    files.set(relativeFile, readPublicFile(root, file));
  }
  return `${relativeFile.split("/").map(encodeURIComponent).join("/")}${suffix}`;
}

export function readPublicFile(root, path) {
  const absolute = repositoryFile(root, path);
  const canonical = realpathSync(absolute);
  repositoryFile(realpathSync(root), canonical);
  return readFileSync(canonical);
}
