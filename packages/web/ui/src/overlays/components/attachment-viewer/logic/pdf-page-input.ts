/** Keeps a page number inside 1..pageCount. */
export function clampPageNumber(page: number, pageCount: number): number {
  if (pageCount < 1) return 1;
  return Math.min(Math.max(Math.trunc(page), 1), pageCount);
}

/**
 * Reads what a person typed into the page box. A whole number past the end
 * lands on the last page; anything that is not a whole number returns null,
 * so the box can snap back to the current page.
 */
export function parsePageInput(text: string, pageCount: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return clampPageNumber(Number(trimmed), pageCount);
}
