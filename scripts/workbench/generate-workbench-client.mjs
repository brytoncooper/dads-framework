import { readFileSync, writeFileSync } from "node:fs";
import { URL } from "node:url";
import process from "node:process";
import { format } from "prettier";
import ts from "typescript";

const routes = new URL("../../apps/workbench/src/routes.ts", import.meta.url);
const output = new URL(
  "../../apps/workbench/src/client.generated.ts",
  import.meta.url,
);
const source = ts.createSourceFile(
  "workbench.ts",
  readFileSync(routes, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);

const verbs = {
  listRoute: "GET",
  getRoute: "GET",
  postRoute: "POST",
  patchRoute: "PATCH",
  deleteRoute: "DELETE",
};

function declaration(node) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression)
  )
    return;
  const name = node.expression.name.text;
  const method = verbs[name];
  const config = node.arguments[0];
  if (
    method === undefined ||
    config === undefined ||
    !ts.isObjectLiteralExpression(config)
  )
    return;
  const operation = /@operation ([a-zA-Z0-9]+)/u.exec(
    source.text.slice(node.getFullStart(), node.getStart(source)),
  )?.[1];
  const properties = new Map(
    config.properties.flatMap((prop) =>
      ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)
        ? [[prop.name.text, prop.initializer]]
        : [],
    ),
  );
  const path = properties.get("path");
  if (
    operation === undefined ||
    path === undefined ||
    !ts.isStringLiteral(path)
  ) {
    throw new Error(
      "Every Workbench card needs an @operation comment and literal path.",
    );
  }
  const response = properties.get("item") ?? properties.get("response");
  return {
    operation,
    method,
    path: path.text,
    hasParams: properties.has("params"),
    hasBody: properties.has("body"),
    body: properties.get("body")?.getText(source),
    list: properties.has("item"),
    response: response?.getText(source),
  };
}

function operationSource(card) {
  const parameters = [...card.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/gu)].map(
    (match) => `readonly ${match[1]}: string;`,
  );
  const fields = [
    ...(card.hasParams
      ? [`readonly params: { ${parameters.join(" ")} };`]
      : []),
    ...(card.list
      ? ["readonly query: NonNullable<WorkbenchRequest['query']>;"]
      : []),
    ...(card.hasBody
      ? [`readonly body: z.input<typeof contract.${card.body}>;`]
      : []),
  ];
  const call = `request(${JSON.stringify(card.method)}, ${JSON.stringify(card.path)}, input)`;
  const decode =
    card.response === undefined
      ? `await ${call};`
      : `return ${card.list ? `z.array(contract.${card.response})` : `contract.${card.response}`}.parse(await ${call});`;
  return `${card.operation}: async (input: { ${fields.join(" ")} }) => { ${decode} },`;
}

const cards = [];
function visit(node) {
  const card = declaration(node);
  if (card !== undefined) cards.push(card);
  ts.forEachChild(node, visit);
}
visit(source);
if (
  cards.length === 0 ||
  new Set(cards.map(({ operation }) => operation)).size !== cards.length
) {
  throw new Error("Workbench operation names must be present and unique.");
}
const generated = await format(
  `// Generated from routes.ts. Run npm run workbench:generate; do not edit.
import { z } from "zod";
import { workbenchFetch, type WorkbenchClientOptions, type WorkbenchRequest } from "./client-transport.js";
import * as contract from "./contracts.js";
export function createClient(options: WorkbenchClientOptions) {
  const request = workbenchFetch(options);
  return {
    ${cards.map(operationSource).join("\n")}
  };
}
`,
  { parser: "typescript" },
);
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== generated)
    throw new Error(
      "Workbench client drifted. Run npm run workbench:generate.",
    );
} else {
  writeFileSync(output, generated);
}
process.stdout.write(`Workbench client: ${cards.length} operations\n`);
