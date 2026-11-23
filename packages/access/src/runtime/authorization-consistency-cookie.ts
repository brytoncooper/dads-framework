export const AUTHORIZATION_CONSISTENCY_COOKIE = "dads_authz_consistency";

export function authorizationConsistencyTokenFromCookieHeader(
  cookieHeader: string | readonly string[] | undefined,
): string | undefined {
  const header = headerText(cookieHeader);
  if (header === "") return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== AUTHORIZATION_CONSISTENCY_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    if (value === "") return undefined;
    return decodeURIComponent(value);
  }
  return undefined;
}

export function authorizationConsistencySetCookie(token: string, options: { readonly secure?: boolean } = {}): string {
  return authorizationConsistencyCookie(encodeURIComponent(token), options);
}

export function authorizationConsistencyClearCookie(options: { readonly secure?: boolean } = {}): string {
  return authorizationConsistencyCookie("", options, ["Max-Age=0"]);
}

function authorizationConsistencyCookie(
  value: string,
  options: { readonly secure?: boolean },
  extra: readonly string[] = [],
): string {
  const parts = [`${AUTHORIZATION_CONSISTENCY_COOKIE}=${value}`, "Path=/api", "HttpOnly", "SameSite=Lax", ...extra];
  if (options.secure === true) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function headerText(cookieHeader: string | readonly string[] | undefined): string {
  if (typeof cookieHeader === "string") return cookieHeader;
  if (Array.isArray(cookieHeader)) return cookieHeader.join("; ");
  return "";
}
