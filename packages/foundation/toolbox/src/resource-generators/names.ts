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
