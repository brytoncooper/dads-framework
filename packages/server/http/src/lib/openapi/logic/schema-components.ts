type SchemaObject = Record<string, unknown>;

/** Lifts schema-local definitions into namespaced OpenAPI components. */
export function schemaComponents(schemas: ReadonlyMap<string, SchemaObject>): Record<string, SchemaObject> {
  const components: Record<string, SchemaObject> = {};
  for (const [name, schema] of schemas) {
    const { definitions, ...root } = schema;
    components[name] = relocateObject(root, name);
    if (!isObject(definitions)) continue;
    for (const [definitionName, definition] of Object.entries(definitions)) {
      if (isObject(definition)) {
        components[`${name}_${definitionName}`] = relocateObject(definition, name);
      }
    }
  }
  return components;
}

function isObject(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relocateObject(schema: SchemaObject, name: string): SchemaObject {
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (key === "$ref" && typeof value === "string") {
        return [key, relocateReference(value, name)];
      }
      if (["example", "examples", "default", "enum", "const"].includes(key)) {
        return [key, value];
      }
      return [key, relocateValue(value, name)];
    }),
  );
}

function relocateValue(value: unknown, name: string): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => relocateValue(item, name));
  return isObject(value) ? relocateObject(value, name) : value;
}

function relocateReference(reference: string, name: string): string {
  if (reference.startsWith("#/definitions/")) {
    return `#/components/schemas/${name}_${reference.slice("#/definitions/".length)}`;
  }
  if (reference === "#") return `#/components/schemas/${name}`;
  if (reference.startsWith("#/")) {
    return `#/components/schemas/${name}${reference.slice(1)}`;
  }
  return reference;
}
