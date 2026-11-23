export function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, head: string) => head.toUpperCase());
}

export function title(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function pascal(name: string): string {
  return title(name).replaceAll(" ", "");
}

export function databaseName(domain: string, name: string): string {
  return `${domain}__${name}`.replaceAll("-", "_");
}

export function singular(name: string): string {
  if (name.endsWith("ies") && name.length > 3) return `${name.slice(0, -3)}y`;
  if (/(?:ses|xes|ches|shes)$/.test(name) && name.length > 3) return name.slice(0, -2);
  if (name.endsWith("s") && !name.endsWith("ss") && name.length > 1) return name.slice(0, -1);
  return name;
}
