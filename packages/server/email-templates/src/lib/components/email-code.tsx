import { Section, Text } from "@react-email/components";
import React from "react";
import type { CSSProperties, ReactElement } from "react";
import { emailTheme } from "../email-theme.js";

/**
 * A code the reader has to carry somewhere else — a pickup code read aloud at
 * a gate, a verification code typed into another window. Set large, in mono,
 * letter-spaced, so the characters that get confused (0/O, 1/l) stay apart,
 * and left alone by the plain-text conversion so it survives a client that
 * shows only text.
 */

const { color, font, fontSize, lineHeight, space } = emailTheme;

const sectionStyle: CSSProperties = {
  margin: `${space.lg} 0`,
  padding: space.md,
  backgroundColor: color.muted,
  border: `1px solid ${color.border}`,
  borderRadius: emailTheme.radius.sm,
  textAlign: "center",
};

const codeStyle: CSSProperties = {
  margin: 0,
  color: color.foreground,
  fontFamily: font.mono,
  fontSize: fontSize.code,
  lineHeight: lineHeight.code,
  fontWeight: 600,
  letterSpacing: "0.12em",
};

export type EmailCodeProps = {
  readonly code: string;
};

export function EmailCode({ code }: EmailCodeProps): ReactElement {
  return (
    <Section style={sectionStyle}>
      <Text style={codeStyle}>{code}</Text>
    </Section>
  );
}
