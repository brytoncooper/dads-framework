import type * as React from "react";

import { readPrimaryRowAnchor } from "../../lib/read-primary-row-link.js";

const ROW_OR_CARD = 'tr, [data-slot="data-table-card"]';

/**
 * An invisible link stretched over a row cell or a whole card, so a tap
 * anywhere opens the row's primary link. Hidden from assistive technology and
 * the tab order: the primary link itself is the accessible way in.
 */
export function DataTableRowHitArea({ href }: { readonly href: string }) {
  return (
    <a
      data-slot="data-table-row-hit-area"
      href={href}
      tabIndex={-1}
      aria-hidden="true"
      className="absolute inset-0"
      onClick={openPrimaryRowLink}
    />
  );
}

function openPrimaryRowLink(event: React.MouseEvent<HTMLAnchorElement>): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  const row = event.currentTarget.closest(ROW_OR_CARD);
  const primary = row ? readPrimaryRowAnchor(row) : null;
  if (!primary) {
    return;
  }
  event.preventDefault();
  primary.click();
}
