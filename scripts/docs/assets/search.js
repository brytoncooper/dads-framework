const pageDocument = globalThis.document;
const index = globalThis.dadsDocsSearch;
const search = pageDocument.querySelector("#docs-search");
const results = pageDocument.querySelector("#search-results");
const status = pageDocument.querySelector("#search-status");

function searchPages(query) {
  const terms = query.toLowerCase().split(/\s+/u);
  return index
    .map((page) => ({ page, score: relevance(page, terms) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 10);
}

function relevance(page, terms) {
  const title = page.title.toLowerCase();
  const content = page.text.toLowerCase();
  if (!terms.every((term) => title.includes(term) || content.includes(term))) return 0;
  return 1 + terms.filter((term) => title.includes(term)).length;
}

function displayResults() {
  const query = search.value.trim();
  const found = query === "" ? [] : searchPages(query);
  const items = found.map(({ page }) => {
    const item = pageDocument.createElement("li");
    const link = pageDocument.createElement("a");
    link.href = page.path;
    link.textContent = page.title;
    item.append(link);
    return item;
  });
  results.replaceChildren(...items);
  if (query === "") status.textContent = "";
  else if (found.length === 0) status.textContent = "No results";
  else status.textContent = `${String(found.length)} ${found.length === 1 ? "result" : "results"}`;
}

search.addEventListener("input", displayResults);
