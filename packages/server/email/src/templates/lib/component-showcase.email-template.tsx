import { Text } from "@react-email/components";
import React from "react";
import { z } from "zod";

import { EmailBadge, type EmailBadgeTone } from "./components/email-badge.js";
import { EmailButton } from "./components/email-button.js";
import { EmailCode } from "./components/email-code.js";
import { EmailDataTable } from "./components/email-data-table.js";
import { EmailHeading } from "./components/email-heading.js";
import { EmailLink } from "./components/email-link.js";
import { defineEmailTemplate } from "./email-template.js";

/**
 * The reference template: every shared component, once, in a message that
 * reads like a real one. It is three things at the same time —
 *
 * - the file to copy when writing a new template,
 * - the component sheet in the preview gallery, where a designer checks how
 *   the brand actually lands in Gmail and Outlook,
 * - the target of the `email.send-test` operator action, so "can this
 *   deployment send mail at all?" is answerable without inventing a message.
 *
 * It belongs to the kit rather than to a domain because it says nothing about
 * the business; `email-templates` is its owner, which is why its name starts
 * with that word.
 */

const SHOWCASE_STATUSES = ["ready", "scheduled", "cancelled"] as const;

/** The status ramp, said in words as well as colour. */
const STATUS_PRESENTATION: Record<
  (typeof SHOWCASE_STATUSES)[number],
  { readonly tone: EmailBadgeTone; readonly label: string }
> = {
  ready: { tone: "success", label: "Ready for pickup" },
  scheduled: { tone: "info", label: "Scheduled" },
  cancelled: { tone: "danger", label: "Cancelled" },
};

const props = z.object({
  recipientName: z
    .string()
    .meta({ description: "Who the message greets, as they are addressed" }),
  orderNumber: z
    .string()
    .meta({ description: "The order this message is about" }),
  pickupCode: z
    .string()
    .meta({ description: "The code the driver reads out at the gate" }),
  status: z
    .enum(SHOWCASE_STATUSES)
    .meta({ description: "Where the order stands" }),
});

const SHOWCASE_LINK = "https://app.example/orders/SO-10428";

export const componentShowcaseEmailTemplate = defineEmailTemplate({
  name: "email-templates.component-showcase",
  description:
    "Every shared email component in one message — the file to copy when writing a new template, the gallery's component sheet, and the message the send-test action delivers.",
  props,
  subject: ({ orderNumber }) => `Order ${orderNumber} is ready`,
  preview: ({ pickupCode }) => `Pickup code ${pickupCode}`,
  body: ({ recipientName, orderNumber, pickupCode, status }) => {
    const presentation = STATUS_PRESENTATION[status];
    return (
      <>
        <EmailHeading>{`Order ${orderNumber}`}</EmailHeading>
        <Text>
          {recipientName}, your order is{" "}
          <EmailBadge tone={presentation.tone}>{presentation.label}</EmailBadge>
        </Text>
        <EmailDataTable
          rows={[
            { label: "Order", value: orderNumber },
            { label: "Status", value: presentation.label },
          ]}
        />
        <Text>Read this code out at the gate:</Text>
        <EmailCode code={pickupCode} />
        <EmailButton href={SHOWCASE_LINK}>View Order</EmailButton>
        <Text>
          Or open <EmailLink href={SHOWCASE_LINK}>{SHOWCASE_LINK}</EmailLink>
        </Text>
      </>
    );
  },
  samples: {
    default: {
      recipientName: "Dana",
      orderNumber: "SO-10428",
      pickupCode: "4F7QK2",
      status: "ready",
    },
    "long-names": {
      recipientName: "Bartholomew Featherstonehaugh-Wetherby",
      orderNumber: "SO-10428-REV-C-SUPERSEDES-SO-10402",
      pickupCode: "WQ8N4TH2XR6",
      status: "cancelled",
    },
  },
});
