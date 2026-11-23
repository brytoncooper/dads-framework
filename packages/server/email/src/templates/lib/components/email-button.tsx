import { Button, Section } from "@react-email/components";
import React from "react";
import type { CSSProperties, ReactElement } from "react";

import { emailTheme } from "../email-theme.js";

/** The primary call to action, styled inline for email clients. */

const { color, font, lineHeight, space } = emailTheme;

/** Centered under the words, the same place in every message. */
const sectionStyle: CSSProperties = {
  margin: `${space.lg} 0 0 0`,
  textAlign: "center",
};

const buttonStyle: CSSProperties = {
  display: "inline-block",
  minWidth: "180px",
  padding: `13px ${space.lg}`,
  backgroundColor: color.primary,
  color: color.primaryForeground,
  fontFamily: font.sans,
  fontSize: "15px",
  lineHeight: lineHeight.label,
  fontWeight: 600,
  textAlign: "center",
  textDecoration: "none",
  borderRadius: emailTheme.radius.lg,
};

export type EmailButtonProps = {
  readonly href: string;
  /** The action, in Title Case — "Accept Invitation", not "click here". */
  readonly children: string;
};

export function EmailButton({ href, children }: EmailButtonProps): ReactElement {
  return (
    <Section style={sectionStyle}>
      <Button href={href} style={buttonStyle}>
        {children}
      </Button>
    </Section>
  );
}
