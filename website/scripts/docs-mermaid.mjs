import { renderMermaidSVG } from "beautiful-mermaid";

const SVG_ID_ATTRIBUTE = /\bid="([^"]+)"/gu;
const SVG_STYLE_TAG = /<style>[\s\S]*?<\/style>/gu;
const INLINE_STYLE_ATTR = /\s+style="[^"]*"/gu;

function escapeAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function scopeSvgIds(svg, prefix) {
  const ids = new Set();
  for (const match of svg.matchAll(SVG_ID_ATTRIBUTE)) {
    ids.add(match[1]);
  }
  let scoped = svg;
  for (const id of ids) {
    const next = `${prefix}-${id}`;
    scoped = scoped
      .replaceAll(`id="${id}"`, `id="${next}"`)
      .replaceAll(`url(#${id})`, `url(#${next})`)
      .replaceAll(`href="#${id}"`, `href="#${next}"`);
  }
  return scoped;
}

/**
 * Renders a Mermaid definition into a CSP-safe inline SVG (no <style> tags, no
 * inline style attributes, no external font imports). Visual styling is driven
 * by CSS custom properties in docs.css so dark and light themes stay in sync.
 */
export function renderMermaidDiagram(source, index, label = "Architecture diagram") {
  const raw = renderMermaidSVG(source.trim(), { font: "Instrument Sans" });
  const cspSafe = raw.replace(SVG_STYLE_TAG, "").replace(INLINE_STYLE_ATTR, "");
  const scoped = scopeSvgIds(cspSafe, `mermaid-${String(index)}`);
  return scoped.replace("<svg ", `<svg role="img" aria-label="${escapeAttribute(label)}" `);
}
