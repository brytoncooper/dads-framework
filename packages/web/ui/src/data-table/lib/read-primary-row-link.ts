const HIT_AREA_SLOT = "data-table-row-hit-area";

export function readPrimaryRowAnchor(row: Element): HTMLAnchorElement | null {
  const links = [...row.querySelectorAll("a[href]")];
  const primary = links.find(
    (link) => link.getAttribute("data-slot") !== HIT_AREA_SLOT,
  );
  return primary instanceof HTMLAnchorElement ? primary : null;
}

export function readPrimaryRowLink(row: Element): {
  href: string;
  cellIndex: number;
} | null {
  const primary = readPrimaryRowAnchor(row);
  if (!primary) {
    return null;
  }
  const href = primary.getAttribute("href");
  if (href === null || href === "") {
    return null;
  }
  const cell = primary.closest('[data-slot="table-cell"]');
  if (!cell) {
    return null;
  }
  const cells = [...row.querySelectorAll('[data-slot="table-cell"]')];
  const cellIndex = cells.indexOf(cell);
  if (cellIndex < 0) {
    return null;
  }
  return { href, cellIndex };
}

export function samePrimaryRowLink(
  current: { href: string; cellIndex: number } | null,
  next: { href: string; cellIndex: number } | null,
): boolean {
  return current?.href === next?.href && current?.cellIndex === next?.cellIndex;
}

/**
 * The href of a phone card's primary link — the same first link its table row
 * would open — or null when the card shows no link.
 */
export function readPrimaryCardHref(card: Element): string | null {
  const href = readPrimaryRowAnchor(card)?.getAttribute("href");
  return href === undefined || href === null || href === "" ? null : href;
}
