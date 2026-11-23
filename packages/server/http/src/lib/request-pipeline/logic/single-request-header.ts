/** Single-valued context/resource headers cannot borrow the first of several values. */
export function singleRequestHeader(
  name: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  rawHeaders: readonly string[] = [],
): string | undefined {
  const normalizedName = name.toLowerCase();
  const headerValue = headers[normalizedName];
  if (typeof headerValue !== "string" || headerValue.trim().length === 0 || headerValue.includes(",")) return undefined;
  let occurrences = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === normalizedName) occurrences += 1;
  }
  return occurrences > 1 ? undefined : headerValue;
}
