function sectionLinks(article) {
  const headings = article.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/gu);
  return Array.from(headings, ([, id, heading]) => `<li><a href="#${id}">${heading.replace(/<[^>]+>/gu, "")}</a></li>`);
}

function pageLink(page, direction, label) {
  if (page === undefined) return "";
  return `<a href="${page.href}" rel="${direction}" class="reader-page-link">
    <span class="reader-page-direction">${label}</span>
    <span class="reader-page-title">${page.title}</span>
  </a>`;
}

function pagination(links, page) {
  const entries = Array.from(
    links.matchAll(/<li><a href="([^"]+)"(?: aria-current="page")?>([^<]+)<\/a><\/li>/gu),
    ([, href, title]) => ({ href, title }),
  );
  const current = entries.findIndex(({ href }) => href === page);
  if (current === -1) return "";
  const previous = pageLink(entries[current - 1], "prev", "Previous");
  const next = pageLink(entries[current + 1], "next", "Next");
  if (!(previous || next)) return "";
  return `<nav class="reader-pages" aria-label="Documentation pages">${previous}${next}</nav>`;
}

function enhanceSearch(html) {
  const match = html.match(/<section class="search"[^>]*>[\s\S]*?<\/section>/u);
  if (!match) return html;

  let section = match[0];
  section = section.replace(/<label for="docs-search">/u, '<label for="docs-search" class="sr">');
  section = section.replace(/<input id="docs-search"([^>]*)>/u, (inputMatch, attrs) => {
    const enhancedInput = /\bautofocus\b/u.test(attrs) ? inputMatch : `<input id="docs-search"${attrs} autofocus>`;
    return `<div class="search-field">
  <svg class="search-icon" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="8.75" cy="8.75" r="5.75"/><path d="M13 13l4.25 4.25" stroke-linecap="round"/></svg>
  ${enhancedInput}
  <button type="button" class="search-close" aria-label="Close search"><kbd aria-hidden="true">Esc</kbd></button>
</div>`;
  });
  section = section.replace(
    /<\/section>/u,
    `<p class="search-hint">Type to search guides, APIs, and commands.</p>
<div class="search-footer" aria-hidden="true">
  <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
  <span><kbd>↵</kbd> open</span>
  <span><kbd>Esc</kbd> close</span>
</div>
</section>`,
  );

  const dialog = `<dialog id="docs-search-dialog" class="search-dialog" closedby="any" aria-label="Search documentation">
${section}
</dialog>`;

  html = html.replace(/<section class="search"[^>]*>[\s\S]*?<\/section>\s*/u, "");
  if (html.includes("</body>")) {
    return html.replace("</body>", () => `${dialog}\n</body>`);
  }
  if (html.includes("</main>")) {
    return html.replace("</main>", () => `</main>\n${dialog}`);
  }
  return `${html}\n${dialog}`;
}

function decorateComparisonTable(tableHtml) {
  const theadMatch = tableHtml.match(/<thead>([\s\S]*?)<\/thead>/u);
  if (!theadMatch) {
    return `<div class="reader-table"><table>${tableHtml}</table></div>`;
  }
  const headers = Array.from(theadMatch[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gu), ([, cell]) =>
    cell.replace(/<[^>]+>/gu, "").trim(),
  );
  if (headers.at(-1) !== "Dads") {
    return `<div class="reader-table"><table>${tableHtml}</table></div>`;
  }
  const decorated = tableHtml.replace(/<tbody>([\s\S]*?)<\/tbody>/u, (_, body) => {
    const styledBody = body.replace(/<tr>([\s\S]*?)<\/tr>/gu, (__, row) => {
      let colIndex = 0;
      const styledRow = row.replace(/<td([^>]*)>([\s\S]*?)<\/td>/gu, (___, attrs, content) => {
        colIndex += 1;
        if (colIndex === 1) {
          return `<td${attrs}>${content}</td>`;
        }
        const plain = content.replace(/<[^>]+>/gu, "").trim();
        let tone = "cmp-warn";
        if (/^Yes\b/iu.test(plain)) {
          tone = "cmp-yes";
        } else if (/^No\b/iu.test(plain)) {
          tone = "cmp-no";
        }
        const nextAttrs = attrs.includes('class="')
          ? attrs.replace('class="', `class="${tone} `)
          : `${attrs} class="${tone}"`;
        return `<td${nextAttrs}>${content}</td>`;
      });
      return `<tr>${styledRow}</tr>`;
    });
    return `<tbody>${styledBody}</tbody>`;
  });
  return `<div class="reader-table reader-table-compare"><table>${decorated}</table></div>`;
}

function styleArticle(article, links) {
  if (links.length > 1) {
    article = article.replace(
      "</h1>",
      () => `</h1>
<details class="reader-outline">
  <summary>On this page</summary>
  <nav aria-label="On this page"><ul>${links.join("")}</ul></nav>
</details>`,
    );
    article = article.replace(/<h2 id="([^"]+)">/gu, (_, id) => `<h2 id="${id}" tabindex="-1">`);
  }
  return article.replace(/<table>([\s\S]*?)<\/table>/gu, (_, table) => decorateComparisonTable(table));
}

function tableOfContents(links) {
  if (links.length <= 1) return "";
  return `\n<aside class="reader-toc" aria-labelledby="reader-toc-title">
  <p class="reader-toc-title" id="reader-toc-title">On this page</p>
  <ul>${links.join("")}</ul>
</aside>`;
}

export function addDocsReader(html, page) {
  const navLinks = html.match(/<nav aria-label="Documentation">([\s\S]*?)<\/nav>/u)?.[1] ?? "";
  const pager = pagination(navLinks, page);
  let toc = "";

  html = enhanceSearch(html);
  html = html.replace(/(<article(?: [^>]*)?>)([\s\S]*?)<\/article>/u, (_, opening, article) => {
    const headings = sectionLinks(article);
    toc = tableOfContents(headings);
    return `${opening}${styleArticle(article, headings)}</article>\n${pager}`;
  });

  if (toc) {
    html = html.replace("</main>", () => `</main>${toc}`);
  }
  return html;
}
