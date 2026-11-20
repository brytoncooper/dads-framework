import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { buildReport } from "../checks/generate-api-report-lib.mjs";
import { apiPurpose, apiReferenceMarkdown } from "./site-api-reference.mjs";
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
  const readme = `${owner.root}/README.md`;
  readPublicFile(root, readme);
  const purpose = apiPurpose(slug);
  const report = buildReport(
    { directory: join(root, owner.root), manifest, name },
    owner.published === true,
  );
  return {
    slug,
    title: name,
    owner: name,
    section: "API reference",
    path: `docs/site/reference/${slug}.md`,
    purpose,
    sourceMarkdown: report.text,
    markdown: apiReferenceMarkdown({
      name,
      purpose,
      readme,
      sections: report.sections,
    }),
  };
}

function referenceIndex(pages) {
  const links = pages.map(
    ({ title, slug, purpose }) => `- [${title}](./${slug}.md) — ${purpose}`,
  );
  return {
    slug: "api",
    title: "API reference",
    navigationGroup: "API reference",
    owner: "@dads-framework/toolbox",
    section: "Reference",
    path: "docs/site/reference/index.md",
    markdown: [
      "# API reference",
      "",
      "Browse each package’s import paths and exported symbols. The reference uses the declarations emitted by this build. Follow a package’s registry link to check availability.",
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
