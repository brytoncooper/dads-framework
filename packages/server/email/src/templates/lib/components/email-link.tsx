import { Link } from "@react-email/components";
import React from "react";
import type { CSSProperties, ReactElement } from "react";

import { emailTheme } from "../email-theme.js";

/** An inline link for secondary actions and references. */

const linkStyle: CSSProperties = {
  color: emailTheme.color.link,
  textDecoration: "underline",
  wordBreak: "break-all",
};

export type EmailLinkProps = {
  readonly href: string;
  readonly children: string;
};

export function EmailLink({ href, children }: EmailLinkProps): ReactElement {
  return (
    <Link href={href} style={linkStyle}>
      {children}
    </Link>
  );
}
