import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

import {
  buildReport,
  REGENERATE_HINT,
} from "../checks/generate-api-report-lib.mjs";
import { readPublicFile } from "./site-links.mjs";

const CATALOG = "docs/site/catalog.json";
const SLUG = /^[a-z][a-z0-9-]*$/;

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

export function loadSiteCatalog(root) {
  const catalog = readJson(root, CATALOG);
  const { packages } = readJson(root, "dads.project.json");
  const owners = new Map(packages.map((entry) => [entry.name, entry]));
  const pages = catalog.pages.map((entry) => loadPage(root, entry));
  const api = catalog.apiPackages.map((name) =>
    referencePage(root, owners, name),
  );
  const allPages = [...pages, referenceIndex(api), ...api];
  validatePages(allPages, owners);
  return allPages;
}

function loadPage(root, entry) {
  const { path } = entry;
  if (
    typeof path !== "string" ||
    !path.endsWith(".md") ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path.startsWith("../")
  ) {
    throw new Error(
      "Catalogue pages need a repository-relative Markdown path.",
    );
  }
  return { ...entry, markdown: readPublicFile(root, path).toString("utf8") };
}

function referencePage(root, owners, name) {
  const owner = owners.get(name);
  if (!owner) throw new Error(`Unknown API reference owner ${name}.`);
  const slug = `api-${name.replace(/^@dads-framework\//, "")}`;
  const manifest = readJson(root, `${owner.root}/package.json`);
  return {
    slug,
    title: name,
    owner: name,
    section: "API reference",
    path: `docs/site/reference/${slug}.md`,
    markdown: buildReport(
      {
        directory: join(root, owner.root),
        manifest,
        name,
      },
      owner.published === true,
    ).text.replace(
      REGENERATE_HINT,
      "Build this reference with `npm run docs:build` after compiling the workspace.",
    ),
  };
}

function referenceIndex(pages) {
  const links = pages.map(({ title, slug }) => `- [${title}](./${slug}.md)`);
  return {
    slug: "api",
    title: "API reference",
    owner: "@dads-framework/toolbox",
    section: "Reference",
    path: "docs/site/reference/index.md",
    markdown: [
      "# API reference",
      "",
      "These reports are built from the exported declarations in the current workspace.",
      "",
      ...links,
      "",
    ].join("\n"),
  };
}

function validatePages(pages, owners) {
  const slugs = new Set();
  const paths = new Set();
  for (const page of pages) {
    if (!owners.has(page.owner))
      throw new Error(`${page.path}: unknown owner ${page.owner}.`);
    if (!SLUG.test(page.slug) || slugs.has(page.slug) || paths.has(page.path)) {
      throw new Error(`${page.path}: invalid slug or duplicate site page.`);
    }
    if (!page.markdown.trimStart().startsWith("# "))
      throw new Error(`${page.path}: missing H1.`);
    slugs.add(page.slug);
    paths.add(page.path);
  }
  if (!slugs.has("index"))
    throw new Error("The site catalogue needs an index page.");
}
