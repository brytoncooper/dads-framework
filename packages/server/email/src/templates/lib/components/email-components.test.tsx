/**
 * What these components must do that a reader of the JSX cannot see: survive
 * the render into email HTML. So the assertions are on the OUTPUT — that the
 * theme's hexes reach the markup as inline style (the only styling an email
 * client reliably keeps), that the layout emits a whole document, and that
 * every piece of meaning also exists as words in the plain-text twin.
 *
 * The posture rules live here too, because they are the ones a future
 * component would break quietly: no webfont request, no image but the two
 * brand logos, no URL in the markup that the template did not put there.
 */
import { Text } from "@react-email/components";
import { render } from "@react-email/render";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { EmailBranding } from "../email-branding.js";
import { emailTheme } from "../email-theme.js";
import { EmailBadge } from "./email-badge.js";
import { EmailButton } from "./email-button.js";
import { EmailCode } from "./email-code.js";
import { EmailDataTable } from "./email-data-table.js";
import { EmailLayout } from "./email-layout.js";

const LINK = "https://app.example/account-invitations/42/accept#token=abc";

const headerLogo = {
  src: "https://app.example/header.png",
  alt: "Application",
  width: 120,
  height: 20,
};
const footerLogo = {
  src: "https://app.example/footer.png",
  alt: "Publisher",
  width: 60,
  height: 16,
};

function layout(children: ReactNode, branding?: EmailBranding) {
  return (
    <EmailLayout subject="Your invitation" preview="Expires Friday" branding={branding}>
      {children}
    </EmailLayout>
  );
}

async function renderBoth(element: ReactElement) {
  const [html, text] = await Promise.all([
    render(element),
    render(element, {
      plainText: true,
      htmlToTextOptions: { wordwrap: false },
    }),
  ]);
  return { html, text };
}

describe("EmailLayout", () => {
  it("renders a whole document a mail client can open", async () => {
    const { html } = await renderBoth(layout(<Text>Body copy.</Text>));

    expect(html).toContain("<!DOCTYPE");
    expect(html).toContain("<title>Your invitation</title>");
    expect(html).toContain("Body copy.");
  });

  it("holds the message to the theme's width on the theme's paper", async () => {
    const { html } = await renderBoth(layout(<Text>Body copy.</Text>));

    expect(html).toContain(`max-width:${emailTheme.cardWidth}px`);
    expect(html).toContain(`background-color:${emailTheme.color.card}`);
  });

  it("shows application-supplied logos with alternative text", async () => {
    const { html, text } = await renderBoth(layout(<Text>Body copy.</Text>, { headerLogo, footerLogo }));

    expect(html).toContain(`src="${headerLogo.src}"`);
    expect(html).toContain(`alt="${headerLogo.alt}"`);
    expect(html).toContain(`src="${footerLogo.src}"`);
    expect(html).toContain(`alt="${footerLogo.alt}"`);
    expect(text).toContain("Body copy.");
  });

  it("reserves decorative brand color for logos", async () => {
    const { html } = await renderBoth(layout(<Text>Body copy.</Text>));

    expect(html).not.toContain(emailTheme.color.brand);
  });

  it("hides the preview line from the reader who gets the text twin", async () => {
    const { html, text } = await renderBoth(layout(<Text>Body copy.</Text>));

    expect(html).toContain("Expires Friday");
    expect(text).not.toContain("Expires Friday");
    expect(text).toContain("Body copy.");
  });

  it("omits the preview element entirely when a template names none", async () => {
    const { html } = await renderBoth(
      <EmailLayout subject="Your invitation">
        <Text>Body copy.</Text>
      </EmailLayout>,
    );

    expect(html).not.toContain("data-skip-in-text");
  });

  it("makes no network requests when application branding is omitted", async () => {
    const { html } = await renderBoth(layout(<Text>Body copy.</Text>));
    const remote = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((match) => match[1]);

    expect(html).not.toContain("@font-face");
    expect(remote).toEqual([]);
  });
});

describe("EmailButton", () => {
  it("uses the default action color", async () => {
    const { html } = await renderBoth(layout(<EmailButton href={LINK}>Accept Invitation</EmailButton>));

    expect(html).toContain(`background-color:${emailTheme.color.primary}`);
    expect(html).toContain(`href="${LINK}"`);
    // Brand red lives only in the logo file; a button wearing it would show
    // up as the hex in the markup.
    expect(html).not.toContain(emailTheme.color.brand);
  });

  it("keeps its label in the text twin, where the fill is gone", async () => {
    const { text } = await renderBoth(layout(<EmailButton href={LINK}>Accept Invitation</EmailButton>));

    expect(text).toContain("Accept Invitation");
  });
});

describe("EmailDataTable", () => {
  it("sets values in mono and labels in the sans face", async () => {
    const { html } = await renderBoth(
      layout(
        <EmailDataTable
          rows={[
            { label: "Order", value: "SO-10428" },
            { label: "Pickup", value: "2026-09-14 08:00" },
          ]}
        />,
      ),
    );

    expect(html).toContain("SO-10428");
    expect(html).toContain("IBM Plex Mono");
    expect(html).toContain("IBM Plex Sans");
  });

  it("states every row as label and value in the text twin", async () => {
    const { text } = await renderBoth(
      layout(
        <EmailDataTable
          rows={[
            { label: "Order", value: "SO-10428" },
            { label: "Pickup", value: "2026-09-14 08:00" },
          ]}
        />,
      ),
    );

    expect(text).toContain("Order");
    expect(text).toContain("SO-10428");
    expect(text).toContain("Pickup");
    expect(text).toContain("2026-09-14 08:00");
  });
});

describe("EmailBadge", () => {
  it("tints the word and its outline from the status ramp", async () => {
    const { html } = await renderBoth(layout(<EmailBadge tone="success">Ready for pickup</EmailBadge>));

    expect(html).toContain(`color:${emailTheme.color.success}`);
    expect(html).toContain(`border:1px solid ${emailTheme.color.success}`);
  });

  it("says the status in words, so colour is never the only signal", async () => {
    const { text } = await renderBoth(layout(<EmailBadge tone="danger">Cancelled</EmailBadge>));

    expect(text).toContain("Cancelled");
  });
});

describe("EmailCode", () => {
  it("sets the code large and mono, and keeps it in the text twin", async () => {
    const { html, text } = await renderBoth(layout(<EmailCode code="4F7QK2" />));

    expect(html).toContain(`font-size:${emailTheme.fontSize.code}`);
    expect(html).toContain("IBM Plex Mono");
    expect(text).toContain("4F7QK2");
  });
});
