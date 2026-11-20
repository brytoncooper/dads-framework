import {
  Body,
  Container,
  Head,
  Html,
  Img,
  Preview,
  Section,
} from "@react-email/components";
import React from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { emailTheme } from "../email-theme.js";

import type { EmailBranding } from "../email-branding.js";

/** The frame shared by every template, with optional application branding. */
const { color, font, fontSize, lineHeight, space } = emailTheme;

const bodyStyle: CSSProperties = {
  margin: 0,
  padding: `${space.xl} ${space.sm}`,
  backgroundColor: color.background,
  color: color.foreground,
  fontFamily: font.sans,
  fontSize: fontSize.body,
  lineHeight: lineHeight.body,
};

const cardStyle: CSSProperties = {
  maxWidth: `${emailTheme.cardWidth}px`,
  margin: "0 auto",
  padding: `40px 36px ${space.xl} 36px`,
  backgroundColor: color.card,
  border: `1px solid ${color.border}`,
  borderRadius: emailTheme.radius.card,
  textAlign: "center",
};

const headerLogoStyle: CSSProperties = {
  display: "block",
  margin: `0 auto 36px auto`,
};

const footerStyle: CSSProperties = {
  marginTop: "40px",
};

const footerLogoStyle: CSSProperties = {
  display: "block",
  margin: "0 auto",
};

export type EmailLayoutProps = {
  /** The subject line. Also the document title, which some clients show. */
  readonly subject: string;
  /**
   * The line an inbox shows beside the subject. Rendered hidden, and skipped
   * by the plain-text conversion, so it never appears twice to one reader.
   */
  readonly preview?: string;
  readonly branding?: EmailBranding | undefined;
  readonly children: ReactNode;
};

export function EmailLayout({
  subject,
  preview,
  branding,
  children,
}: EmailLayoutProps): ReactElement {
  const headerLogo = branding?.headerLogo;
  const footerLogo = branding?.footerLogo;
  return (
    <Html lang="en">
      <Head>
        <title>{subject}</title>
      </Head>
      {preview === undefined ? null : <Preview>{preview}</Preview>}
      <Body style={bodyStyle}>
        <Container style={cardStyle}>
          {headerLogo === undefined ? null : (
            <Img {...headerLogo} style={headerLogoStyle} />
          )}
          {children}
          {footerLogo === undefined ? null : (
            <Section style={footerStyle}>
              <Img {...footerLogo} style={footerLogoStyle} />
            </Section>
          )}
        </Container>
      </Body>
    </Html>
  );
}
