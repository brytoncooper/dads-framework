function sectionLinks(article) {
  const headings = article.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/gu);
  return Array.from(
    headings,
    ([, id, heading]) =>
      `<li><a href="#${id}">${heading.replace(/<[^>]+>/gu, "")}</a></li>`,
  );
}

function pageLink(page, direction, label) {
  if (page === undefined) return "";
  return `<a href="${page.href}" rel="${direction}" class="reader-page-link">
    <span class="reader-page-direction">${label}</span>
    <span>${page.title}</span>
  </a>`;
}

function pagination(links, page) {
  const entries = Array.from(
    links.matchAll(
      /<li><a href="([^"]+)"(?: aria-current="page")?>([^<]+)<\/a><\/li>/gu,
    ),
    ([, href, title]) => ({ href, title }),
  );
  const current = entries.findIndex(({ href }) => href === page);
  if (current === -1) return "";
  const previous = pageLink(entries[current - 1], "prev", "Previous");
  const next = pageLink(entries[current + 1], "next", "Next");
  if (!(previous || next)) return "";
  return `<nav class="reader-pages" aria-label="Documentation pages">${previous}${next}</nav>`;
}

function styleArticle(article) {
  const links = sectionLinks(article);
  if (links.length > 1) {
    article = article.replace(
      "</h1>",
      () => `</h1>
<details class="reader-outline">
  <summary>On this page</summary>
  <nav aria-label="On this page"><ul>${links.join("")}</ul></nav>
</details>`,
    );
    article = article.replace(
      /<h2 id="([^"]+)">/gu,
      '<h2 id="$1" tabindex="-1">',
    );
  }
  return article.replace(
    /<table>([\s\S]*?)<\/table>/gu,
    (_, table) => `<div class="reader-table"><table>${table}</table></div>`,
  );
}

export function addDocsReader(html, page) {
  const links =
    html.match(/<nav aria-label="Documentation">([\s\S]*?)<\/nav>/u)?.[1] ?? "";
  const pager = pagination(links, page);
  return html.replace(
    /(<article(?: [^>]*)?>)([\s\S]*?)<\/article>/u,
    (_, opening, article) =>
      `${opening}${styleArticle(article)}</article>\n${pager}`,
  );
}
