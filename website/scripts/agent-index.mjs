import { URL } from "node:url";
const ENTITY_TEXT = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["#39", "'"],
  ["quot", '"'],
  ["lt", "<"],
  ["gt", ">"],
]);

function markdownLabel(html) {
  return html
    .replace(/&(amp|apos|#39|quot|lt|gt);/gu, (_, entity) => ENTITY_TEXT.get(entity))
    .trim()
    .replace(/[\s]+/gu, " ")
    .replace(/[\\[\]]/gu, "\\$&");
}

function packageGroup(pages, indexed) {
  const index = pages.get("packages.html");
  if (!index) return [];
  const lookup = index.match(/<article class="package-index">([\s\S]*?)<\/article>/u)?.[1];
  if (!lookup) throw new Error("Missing documentation package lookup.");

  const entries = [];
  for (const [, filename, label] of lookup.matchAll(/<a href="(package-[a-z0-9-]+\.html)#try-it">([^<]+)<\/a>/gu)) {
    const html = pages.get(filename);
    if (!html?.includes('id="try-it"') || indexed.has(filename))
      throw new Error(`Invalid documentation package example: ${filename}.`);
    indexed.add(filename);
    entries.push({
      label: markdownLabel(label),
      markdownPath: `/docs/${filename.slice(0, -5)}.md#try-it`,
    });
  }
  if (!entries.length) throw new Error("Empty documentation package lookup.");
  return [["Packages", entries]];
}

function documentationGroups(renderedPages) {
  const pages = new Map(renderedPages);
  const index = pages.get("index.html");
  const navigation = index?.match(/<nav aria-label="Documentation">([\s\S]*?)<\/nav>/u)?.[1];
  if (!navigation) throw new Error("The docs index must contain documentation navigation.");
  if (pages.size !== renderedPages.length) throw new Error("Duplicate rendered documentation page.");

  const groups = [];
  const indexed = new Set();
  for (const [, title, links] of navigation.matchAll(/<h2>([^<]+)<\/h2>\s*<ul>([\s\S]*?)<\/ul>/gu)) {
    const group = [];
    for (const [, filename, label] of links.matchAll(/<a href="([a-z0-9-]+\.html)"(?: [^>]*)?>([^<]+)<\/a>/gu)) {
      const html = pages.get(filename);
      if (html === undefined || indexed.has(filename))
        throw new Error(`Invalid documentation navigation entry: ${filename}.`);
      indexed.add(filename);
      const slug = filename.slice(0, -5);
      const page = {
        label: markdownLabel(label),
        markdownPath: `/docs/${slug}.md`,
      };
      if (slug.startsWith("api-")) {
        const source = `source/docs/site/reference/${slug}.md`;
        if (!html.includes(`href="${source}"`) && !html.includes(`href="/docs/${source}"`)) {
          throw new Error(`Missing raw API reference link for ${filename}.`);
        }
        page.declarationsPath = `/docs/${source}`;
      }
      group.push(page);
    }
    if (!group.length) throw new Error(`Empty documentation navigation group: ${title}.`);
    groups.push([markdownLabel(title), group]);
  }
  groups.push(...packageGroup(pages, indexed));
  const missing = [...pages.keys()].filter((filename) => !indexed.has(filename));
  if (missing.length) throw new Error(`Rendered documentation missing from navigation: ${missing.join(", ")}.`);
  return groups;
}

function indexText({ title, description, origin, groups }) {
  const lines = [`# ${title}`, "", `> ${description}`];
  for (const [group, pages] of groups) {
    lines.push("", `## ${group}`, "");
    for (const { label, markdownPath, declarationsPath } of pages) {
      const raw = declarationsPath ? ` — [Raw API declarations](${new URL(declarationsPath, origin).href})` : "";
      lines.push(`- [${label}](${new URL(markdownPath, origin).href})${raw}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function createAgentIndexes({ origin = "https://dadsframework.dev", renderedPages }) {
  const docs = documentationGroups(renderedPages);
  const site = [
    "Site",
    [
      { label: "Dads Framework", markdownPath: "/index.md" },
      { label: "Credits", markdownPath: "/credits.md" },
    ],
  ];
  const description =
    "Dads is a TypeScript backend framework for building APIs with explicit contracts and relationship-based permissions.";
  return {
    rootIndex: indexText({
      title: "Dads Framework",
      description,
      origin,
      groups: [site, ...docs],
    }),
    docsIndex: indexText({
      title: "Dads Framework documentation",
      description,
      origin,
      groups: [...docs, site],
    }),
  };
}
