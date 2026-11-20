import { Heading } from "@react-email/components";
import React from "react";
import type { CSSProperties, ReactElement } from "react";

import { emailTheme } from "../email-theme.js";

/**
 * The one heading a message gets — its title, usually the subject again for
 * the reader who is now looking at the message rather than the inbox.
 *
 * Size and margin are spelled out because a bare `<h1>` is sized by whatever
 * is rendering it, and Outlook renders through Word: the same heading comes
 * out at one size in Gmail and another in Outlook unless the message says.
 */

const headingStyle: CSSProperties = {
  margin: "0 0 10px 0",
  color: emailTheme.color.foreground,
  fontFamily: emailTheme.font.sans,
  fontSize: emailTheme.fontSize.heading,
  lineHeight: "30px",
  fontWeight: 600,
  letterSpacing: "-0.015em",
};

export type EmailHeadingProps = {
  readonly children: string;
};

export function EmailHeading({ children }: EmailHeadingProps): ReactElement {
  return (
    <Heading as="h1" style={headingStyle}>
      {children}
    </Heading>
  );
}
