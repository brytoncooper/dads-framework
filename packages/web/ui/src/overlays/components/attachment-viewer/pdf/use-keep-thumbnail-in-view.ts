import * as React from "react";

import type { ViewRotation } from "../logic/view-rotation.js";

/** Any of these means the reader has taken over the rail's scroll. */
const USER_SCROLL_EVENTS: readonly ("wheel" | "touchstart" | "pointerdown")[] = ["wheel", "touchstart", "pointerdown"];

function thumbnailFor(rail: HTMLElement, page: number): HTMLElement | null {
  return rail.querySelector<HTMLElement>(`[data-page="${String(page)}"]`);
}

/**
 * Keeps the current page's thumbnail in view as the reader moves through the
 * document. Opening the rail or rotating mounts every thumbnail as a
 * page-shaped placeholder that resizes as it draws, which pushes the current
 * one out of view, so the rail re-aligns on each resize until the current
 * thumbnail has drawn or the reader scrolls the rail themselves.
 */
export function useKeepThumbnailInView(
  railRef: React.RefObject<HTMLElement | null>,
  currentPage: number,
  rotation: ViewRotation,
): void {
  const currentPageRef = React.useRef(currentPage);

  React.useEffect(() => {
    currentPageRef.current = currentPage;
    const rail = railRef.current;
    if (rail === null) return;
    thumbnailFor(rail, currentPage)?.scrollIntoView({ block: "nearest" });
  }, [railRef, currentPage]);

  React.useEffect(() => {
    const rail = railRef.current;
    if (rail === null) return;

    const observer = new ResizeObserver(() => {
      const active = thumbnailFor(rail, currentPageRef.current);
      if (active === null) return;
      active.scrollIntoView({ block: "nearest" });
      if (active.querySelector("img") !== null) observer.disconnect();
    });
    rail.querySelectorAll("button").forEach((thumbnail) => {
      observer.observe(thumbnail);
    });

    const stop = () => {
      observer.disconnect();
    };
    for (const type of USER_SCROLL_EVENTS) {
      rail.addEventListener(type, stop, { passive: true });
    }

    return () => {
      observer.disconnect();
      for (const type of USER_SCROLL_EVENTS) {
        rail.removeEventListener(type, stop);
      }
    };
  }, [railRef, rotation]);
}
