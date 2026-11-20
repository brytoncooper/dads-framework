export function databaseNameFromUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, "")).split(
    "/",
  )[0];
  if (name === undefined || name === "") {
    throw new Error("DATABASE_URL has no database name");
  }
  return name;
}

export function siblingDatabaseUrl(
  databaseUrl: string,
  databaseName: string,
): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}
