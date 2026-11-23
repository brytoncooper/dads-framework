import type { GenerationPlan } from "./generation-plan.js";
import { camel, pascal, title } from "./names.js";
import { exposeWebArtifact } from "./web-client-exports.js";

export function resourcePages(
  plan: GenerationPlan,
  domain: string,
  name: string,
): void {
  const dir = `domains/${domain}/web-client`;
  const record = pascal(name);
  exposeWebArtifact(
    plan,
    domain,
    `export { list${record}, read${record}, save${record} } from "./${name}-client.js";`,
  );
  exposeWebArtifact(
    plan,
    domain,
    `export { ${record}ListPage, ${record}DetailPage } from "./${name}-pages.js";`,
  );
  plan.create(`${dir}/${name}-client.ts`, renderClient(name));
  plan.create(`${dir}/${name}-pages.ts`, renderPages(name));
}

function renderClient(name: string): string {
  const id = camel(name);
  return `import { getFromApi, getPageFromApi, saveWithRefresh, sendToApi } from "@dads-framework/client";

import { ${id}ListRoute, ${id}Query, ${id}ReadRoute, ${id}Record, ${id}SaveRoute, ${id}Update, type ${pascal(name)}Update } from "../contract/${name}-resource.js";

export function list${pascal(name)}(tenantId: string, page = 1) {
  return getPageFromApi({
    route: ${id}ListRoute.bind(tenantId),
    query: { schema: ${id}Query, value: { page } },
    returns: ${id}Record,
  });
}

export function read${pascal(name)}(tenantId: string, id: string) {
  return getFromApi({ route: ${id}ReadRoute.bind(tenantId, id), returns: ${id}Record });
}

export function save${pascal(name)}(tenantId: string, id: string, draft: ${pascal(name)}Update) {
  return saveWithRefresh({
    save: () => sendToApi({
      route: ${id}SaveRoute.bind(tenantId, id),
      body: { schema: ${id}Update, value: draft },
      returns: ${id}Record,
    }),
    refresh: () => read${pascal(name)}(tenantId, id),
  });
}
`;
}

function renderPages(name: string): string {
  const record = pascal(name);
  return `import { createElement } from "react";

import type { ${record} } from "../contract/${name}-resource.js";

export function ${record}ListPage({
  items,
  detailUrl,
}: {
  readonly items: readonly ${record}[];
  readonly detailUrl: (id: string) => string;
}) {
  return createElement("main", null,
    createElement("h1", null, "${title(name)}"),
    createElement("ul", null, items.map((item) =>
      createElement("li", { key: item.id },
        createElement("a", { href: detailUrl(item.id) }, item.title),
      ),
    )),
  );
}

export function ${record}DetailPage({
  item,
  onSave,
}: {
  readonly item: ${record};
  readonly onSave: (title: string, expectedRowVersion: number) => void;
}) {
  return createElement("main", null,
    createElement("h1", null, item.title),
    createElement("form", {
      action: (form: FormData) => {
        const title = form.get("title");
        if (typeof title === "string") onSave(title, item.rowVersion);
      },
    },
    createElement("label", null, "Title", createElement("input", { name: "title", defaultValue: item.title, required: true })),
    createElement("button", { type: "submit" }, "Save")),
  );
}
`;
}
