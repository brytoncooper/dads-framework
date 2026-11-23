import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Marked, Renderer } from "marked";
import type { Plugin } from "vite";
import { workbenchCopy } from "../apps/web/copy/workbench-copy.js";
import { expandGuideExcerpts } from "./example-source-excerpts.js";

const guides = [
  { id: "setup", file: "README.md", copyKey: "workbench.examples.setup" },
  {
    id: "company-sso",
    file: "company-sso.md",
    copyKey: "workbench.examples.company-sso",
  },
  {
    id: "directory-sync",
    file: "directory-sync.md",
    copyKey: "workbench.examples.directory-sync",
  },
  {
    id: "permissions-dashboard",
    file: "permissions-dashboard.md",
    copyKey: "workbench.examples.permissions-dashboard",
  },
  {
    id: "audit-export",
    file: "audit-export.md",
    copyKey: "workbench.examples.audit-export",
  },
  {
    id: "staff-impersonation",
    file: "staff-impersonation.md",
    copyKey: "workbench.examples.staff-impersonation",
  },
  {
    id: "flag-preview",
    file: "flag-preview.md",
    copyKey: "workbench.examples.flag-preview",
  },
] as const;

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function createGuideParser() {
  return new Marked().use({
    renderer: {
      heading(token) {
        const renderer = new Renderer();
        renderer.parser = this.parser;
        return renderer.heading({
          ...token,
          depth: Math.min(token.depth + 1, 6),
        });
      },
      link(token) {
        const guide = guides.find(({ file }) => token.href === `./${file}`);
        // Repository file references are readable without serving the project's source.
        if (!guide) return this.parser.parseInline(token.tokens);
        const renderer = new Renderer();
        renderer.parser = this.parser;
        return renderer.link({ ...token, href: `#${guide.id}` });
      },
      html({ text }) {
        return escapeText(text);
      },
    },
  });
}

type GuideContent = {
  readonly id: string;
  readonly body: string;
  readonly label: string;
};

function renderGuide(markup: string, { id, label, body }: GuideContent): string {
  return markup
    .replaceAll("{{id}}", id)
    .replace("{{label}}", () => label)
    .replace("{{body}}", () => body);
}

function renderGuides(html: string, guides: readonly GuideContent[]): string {
  return html.replace(
    /<template id="guide-(?:link|article)">([\s\S]*?)<\/template>/g,
    (_template: string, markup: string) => guides.map((guide) => renderGuide(markup, guide)).join("\n"),
  );
}

const createExamplesPlugin: () => Plugin = () => {
  const markdown = createGuideParser();
  return {
    name: "workbench-examples-page",
    transformIndexHtml: {
      order: "pre",
      async handler(html, context) {
        if (context.path !== "/examples.html") return html;

        const sections = await Promise.all(
          guides.map(async ({ id, file, copyKey }) => {
            const path = fileURLToPath(new URL(`../examples/${file}`, import.meta.url));
            context.server?.watcher.add(path);
            const source = await readFile(path, "utf8");
            const expanded = await expandGuideExcerpts(source, file, (sourcePath) => {
              context.server?.watcher.add(sourcePath);
            });
            const body = await markdown.parse(expanded);
            return { id, body, label: escapeText(workbenchCopy[copyKey].en) };
          }),
        );
        return renderGuides(html, sections);
      },
    },
  };
};

export const bundledExamplesPage = createExamplesPlugin;
