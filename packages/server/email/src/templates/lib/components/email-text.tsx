import { Text } from "@react-email/components";
import React from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { emailTheme } from "../email-theme.js";

/**
 * Body copy and fine print. They exist because react-email's `Text` ships its
 * own 14px size and 16px margins, and a default is exactly the kind of style
 * that ends up in every email nobody chose.
 */

const { color, font } = emailTheme;

const textStyle: CSSProperties = {
  margin: "0 0 12px 0",
  color: color.foreground,
  fontFamily: font.sans,
  fontSize: "15px",
  lineHeight: "24px",
};

const finePrintStyle: CSSProperties = {
  margin: "16px 0 0 0",
  color: color.mutedForeground,
  fontFamily: font.sans,
  fontSize: "13px",
  lineHeight: "20px",
};

export type EmailTextProps = {
  readonly children: ReactNode;
};

/** One short paragraph of the message. Most emails need one; never more than two. */
export function EmailText({ children }: EmailTextProps): ReactElement {
  return <Text style={textStyle}>{children}</Text>;
}

/**
 * Small grey line under the button: when a link expires, the raw URL for a
 * client that strips the button (and for the plain-text twin, which keeps
 * only the anchor's text), or "Didn't ask for this? Ignore this email."
 */
export function EmailFinePrint({ children }: EmailTextProps): ReactElement {
  return <Text style={finePrintStyle}>{children}</Text>;
}
