import { Column, Row, Section } from "@react-email/components";
import React from "react";
import type { CSSProperties, ReactElement } from "react";
import { emailTheme } from "../email-theme.js";

/** Renders the facts a reader needs to act on a message. */

const { color, font, fontSize, lineHeight, space } = emailTheme;

/** A soft grey box under the words, left-aligned inside the centered card. */
const sectionStyle: CSSProperties = {
  margin: `${space.md} 0 0 0`,
  padding: `${space.xs} 0`,
  borderRadius: emailTheme.radius.lg,
  backgroundColor: color.muted,
  textAlign: "left",
};

const labelStyle: CSSProperties = {
  width: "45%",
  padding: `${space.sm} ${space.md}`,
  color: color.mutedForeground,
  fontFamily: font.sans,
  fontSize: fontSize.label,
  lineHeight: lineHeight.label,
  verticalAlign: "top",
};

const valueStyle: CSSProperties = {
  padding: `${space.sm} ${space.md}`,
  color: color.foreground,
  textAlign: "right",
  fontFamily: font.mono,
  fontSize: fontSize.label,
  lineHeight: lineHeight.label,
  verticalAlign: "top",
};

/** One stated fact: what it is, and what it is. */
export type EmailDataFact = {
  readonly label: string;
  readonly value: string;
};

export type EmailDataTableProps = {
  readonly rows: readonly EmailDataFact[];
};

export function EmailDataTable({ rows }: EmailDataTableProps): ReactElement {
  return (
    <Section style={sectionStyle}>
      {rows.map((row) => (
        <Row key={row.label}>
          <Column style={labelStyle}>{row.label}</Column>
          <Column style={valueStyle}>{row.value}</Column>
        </Row>
      ))}
    </Section>
  );
}
