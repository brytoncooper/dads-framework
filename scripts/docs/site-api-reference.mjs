const purposes = {
  access: "Define and compose relationship-based authorization models in TypeScript.",
  authorization: "Check permissions, look up authorized resources, and apply relationship changes with SpiceDB.",
  contract: "Share route, pagination, response, and error schemas between HTTP clients and servers.",
  http: "Register typed HTTP routes with runtime validation and authorization.",
  migrations: "Apply PostgreSQL migrations in dependency order and inspect the journal of applied files.",
  audit: "Record database changes, HTTP requests, and client diagnostics with application-owned audit scope.",
  "feature-flags": "Define flags in code, change their audience, and evaluate the flags enabled in a context.",
  plugin: "Compose typed application plugins and control how their services start and stop.",
  ui: "Build React forms, tables, and application layouts from separately importable UI kits.",
  identity: "Share account, session, and email contracts across identity adapters.",
  "identity-better-auth": "Connect account and session contracts to Better Auth and PostgreSQL.",
  tenants: "Manage tenants, memberships, and single-use invitations with relationship authorization.",
  "postgres-access":
    "Check permissions, look up authorized resources, and write relationship changes in PostgreSQL transactions.",
};

export function apiPurpose(slug) {
  const purpose = purposes[slug.slice(4)];
  if (!purpose) throw new Error(`Missing API reference introduction for ${slug}.`);
  return purpose;
}

function headingAnchor(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim()
    .replace(/ +/g, "-");
}

function backticks(text, minimum) {
  const runs = text.match(/`+/gu) ?? [];
  return "`".repeat(Math.max(minimum, ...runs.map((run) => run.length + 1)));
}

function inlineCode(text) {
  const fence = backticks(text, 1);
  return fence.length > 1 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

const DETAIL_LIMIT = 200;

function alphabetGroups(exports) {
  return [
    ...Map.groupBy(exports, ({ name }) => {
      const initial = name[0]?.toUpperCase();
      return initial && /^[A-Z]$/u.test(initial) ? initial : "Other";
    }),
  ].sort(([left], [right]) => left.localeCompare(right, "en"));
}

function symbolLink({ label, anchor }) {
  return `[${label}](#${anchor})`;
}

function exportHeading(specifier, name) {
  const subpath = specifier.split("/").slice(2).join("/");
  return subpath ? `${inlineCode(name)} · ${inlineCode(subpath)}` : inlineCode(name);
}

function indexedSection(section, anchorFor) {
  const title = `Import ${inlineCode(section.specifier)}`;
  const anchor = anchorFor(title);
  if (section.exports.length > DETAIL_LIMIT) {
    const alphabet = alphabetGroups(section.exports).map(([initial, entries]) => {
      const groupTitle = `Symbols ${initial} · ${inlineCode(section.specifier)}`;
      return {
        label: initial,
        title: groupTitle,
        anchor: anchorFor(groupTitle),
        entries,
      };
    });
    return { ...section, title, anchor, alphabet };
  }
  const symbols = section.exports.map((entry) => {
    const symbolTitle = exportHeading(section.specifier, entry.name);
    return {
      ...entry,
      title: symbolTitle,
      anchor: anchorFor(symbolTitle),
      label: inlineCode(entry.name),
    };
  });
  return { ...section, title, anchor, symbols };
}

function renderSymbol(entry) {
  const fence = backticks(entry.signature, 3);
  return [`### ${entry.title}`, "", inlineCode(entry.kind), "", `${fence}ts`, entry.signature, fence, ""];
}

function renderAlphabet(alphabet) {
  return [
    "Browse the export groups below. Open the Markdown source at the end of the page for every symbol and declaration.",
    "",
    alphabet.map(symbolLink).join(" · "),
    "",
    ...alphabet.flatMap(({ title, entries }) => [
      `### ${title}`,
      "",
      `${entries.length} symbols. Examples: ${entries
        .slice(0, 5)
        .map(({ name }) => inlineCode(name))
        .join(", ")}.`,
      "",
    ]),
  ];
}

function renderSection(section) {
  const title = [`## ${section.title}`, ""];
  if (section.alphabet) return [...title, ...renderAlphabet(section.alphabet)];
  if (section.symbols.length === 0) return [...title, "This entry point declares no exported symbols.", ""];
  return [...title, section.symbols.map(symbolLink).join(" · "), "", ...section.symbols.flatMap(renderSymbol)];
}

export function apiReferenceMarkdown({ name, purpose, readme, sections }) {
  const anchors = new Map();
  const anchorFor = (heading) => {
    const base = headingAnchor(heading);
    const used = anchors.get(base) ?? 0;
    anchors.set(base, used + 1);
    return used === 0 ? base : `${base}-${used}`;
  };
  const title = `API report: ${name}`;
  anchorFor(title);
  anchorFor("Entry points");
  const ordered = [
    ...sections.filter(({ exports }) => exports.length <= DETAIL_LIMIT),
    ...sections.filter(({ exports }) => exports.length > DETAIL_LIMIT),
  ];
  const indexed = ordered.map((section) => indexedSection(section, anchorFor));
  return [
    `# ${title}`,
    "",
    purpose,
    "",
    `[Package guide](/${readme}) · [npm registry](https://www.npmjs.com/package/${name})`,
    "",
    "## Entry points",
    "",
    ...indexed.map(
      ({ specifier, anchor, exports }) =>
        `- ${symbolLink({ label: inlineCode(specifier), anchor })} (${exports.length} ${exports.length === 1 ? "symbol" : "symbols"})`,
    ),
    "",
    ...indexed.flatMap(renderSection),
  ].join("\n");
}
