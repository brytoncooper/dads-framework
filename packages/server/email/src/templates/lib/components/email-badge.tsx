import React from "react";
import type { CSSProperties, ReactElement } from "react";
import { emailTheme } from "../email-theme.js";

/** A status label with text and a semantic tone. */

const { color, font, space } = emailTheme;

/** The status ramp, by what the status means rather than by its colour. */
const TONE_COLORS = {
  neutral: color.mutedForeground,
  success: color.success,
  warning: color.warning,
  danger: color.destructive,
  info: color.info,
} as const;

export type EmailBadgeTone = keyof typeof TONE_COLORS;

const baseStyle: CSSProperties = {
  display: "inline-block",
  margin: `0 0 14px 0`,
  padding: `${space.xs} 10px`,
  borderRadius: emailTheme.radius.pill,
  fontFamily: font.sans,
  fontSize: "12px",
  lineHeight: "16px",
  fontWeight: 600,
};

/**
 * The outline is spelled out rather than left to `currentColor`: Outlook
 * renders through Word, which resolves neither `currentColor` nor an omitted
 * border colour.
 */
function toneStyle(tone: EmailBadgeTone): CSSProperties {
  const toneColor = TONE_COLORS[tone];
  return { color: toneColor, border: `1px solid ${toneColor}` };
}

export type EmailBadgeProps = {
  readonly tone: EmailBadgeTone;
  /** The status in words — "Ready for pickup", not a colour. */
  readonly children: string;
};

export function EmailBadge({ tone, children }: EmailBadgeProps): ReactElement {
  return <span style={{ ...baseStyle, ...toneStyle(tone) }}>{children}</span>;
}
