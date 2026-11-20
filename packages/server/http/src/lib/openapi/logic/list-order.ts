import { byCodePoint } from "./by-code-point.js";

/**
 * Puts the two kinds of list that grow one name per pull request in name
 * order, recursively, and returns the result (the input is not changed):
 *
 * - every discriminated union's members, by the value each pins its tag to;
 * - every `enum` of strings, by value.
 *
 * Why: both are generated in declaration order (a registry that grows one
 * entry per feature lists its names in its own order, in a union and in an
 * enum of its names), so two pull requests that each add a name next to the
 * same existing one insert on the same line of a committed document and
 * conflict. In name order two
 * new names land apart unless they sort next to each other.
 *
 * The contract is the same: an `enum` is a set of allowed values, and a
 * `oneOf`/`anyOf` whose members each pin a distinct tag matches by that tag,
 * so neither order carries meaning. A list counts as a discriminated union
 * when every member is an object schema pinning one shared property to a
 * single string (`const`, or an `enum` of one) and no two members pin the
 * same value; any other union keeps its order.
 */
export function withListsInNameOrder(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withListsInNameOrder);
  if (typeof node !== "object" || node === null) return node;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    result[key] = inNameOrder(key, withListsInNameOrder(value));
  }
  return result;
}

function inNameOrder(key: string, value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (key === "oneOf" || key === "anyOf") return inTagOrder(value);
  if (key === "enum") return enumInValueOrder(value);
  return value;
}

function enumInValueOrder(values: readonly unknown[]): unknown[] {
  if (!values.every((value) => typeof value === "string")) return [...values];
  return [...values].sort(byCodePoint);
}

function inTagOrder(members: readonly unknown[]): unknown[] {
  const pinned = members.map(pinnedValues);
  const property = tagProperty(pinned);
  if (property === undefined) return [...members];
  return members
    .map((member, index) => ({
      member,
      tag: pinned[index]?.get(property) ?? "",
    }))
    .sort((first, second) => byCodePoint(first.tag, second.tag))
    .map(({ member }) => member);
}

/** Each property this member pins to one string value. */
function pinnedValues(member: unknown): ReadonlyMap<string, string> {
  const pinned = new Map<string, string>();
  const properties = recordOf(recordOf(member)?.["properties"]) ?? {};
  for (const [name, schema] of Object.entries(properties)) {
    const value = singleValue(recordOf(schema));
    if (value !== undefined) pinned.set(name, value);
  }
  return pinned;
}

function singleValue(
  schema: Record<string, unknown> | undefined,
): string | undefined {
  const constant = schema?.["const"];
  if (typeof constant === "string") return constant;
  const values: unknown = schema?.["enum"];
  if (!Array.isArray(values) || values.length !== 1) return undefined;
  const only: unknown = values.at(0);
  return typeof only === "string" ? only : undefined;
}

/**
 * The first property (by name) that every member pins, each to a different
 * value; none when the list has fewer than two members or no such property.
 */
function tagProperty(
  pinned: readonly ReadonlyMap<string, string>[],
): string | undefined {
  const [first] = pinned;
  if (first === undefined || pinned.length < 2) return undefined;
  return [...first.keys()].sort().find((name) => {
    const values = pinned.map((tags) => tags.get(name));
    return (
      values.every((value) => value !== undefined) &&
      new Set(values).size === values.length
    );
  });
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}
