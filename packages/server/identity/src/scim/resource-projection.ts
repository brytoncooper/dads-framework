import { attributePath, isRecord, ScimError } from "./protocol.js";

function subset(
  value: unknown,
  paths: readonly string[],
  include: boolean,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => subset(item, paths, include));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => paths.includes(key.toLowerCase()) === include,
    ),
  );
}

export function createResourceProjection(
  parameters: URLSearchParams,
  schema: string,
) {
  if (parameters.has("attributes") && parameters.has("excludedAttributes")) {
    throw new ScimError(
      400,
      "Specify attributes or excludedAttributes.",
      "invalidValue",
    );
  }
  const include = parameters.has("attributes");
  const raw = parameters.get(include ? "attributes" : "excludedAttributes");
  const paths = raw
    ? raw.split(",").map((path) => attributePath(path, schema))
    : [];
  return (id: string, fields: Record<string, unknown>) => {
    const selected = Object.entries(fields).flatMap(
      ([key, value]): [string, unknown][] => {
        const attribute = key.toLowerCase();
        const matches = paths.includes(attribute);
        if (matches) return include ? [[key, value]] : [];
        const prefix = `${attribute}.`;
        const subPaths = paths
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length));
        if (subPaths.length) return [[key, subset(value, subPaths, include)]];
        return include ? [] : [[key, value]];
      },
    );
    return { schemas: [schema], id, ...Object.fromEntries(selected) };
  };
}
