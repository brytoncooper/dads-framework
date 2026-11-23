import React from "react";
import { z } from "zod";

import { defineEmailTemplate, EmailBadge, EmailHeading, EmailText } from "@dads-framework/email/templates";

/**
 * The email that says something is newly broken.
 *
 * Deliberately dull and short. This arrives when someone is not looking for
 * it, so it has to answer two questions before anyone decides whether to care:
 * what is new, and how much of it is there. Everything else — the stack, the
 * environment, the request it belonged to — is one fingerprint lookup away and
 * does not belong in an email that might be read on a phone.
 *
 * No links, because there is no diagnostics page to link to yet and a dead
 * link in an alert is worse than no link.
 */

const props = z.object({
  faults: z.array(z.string()).meta({
    description:
      "One line per newly-seen fault type, loudest first, already formatted by `describeFaultLine`. Never empty — an alert with nothing in it is not sent.",
  }),
  totalOccurrences: z.number().int().nonnegative().meta({
    description: "Occurrences across every new fault found, including any trimmed from the list below.",
  }),
  truncated: z.boolean().meta({
    description: "True when more new faults were found than one email should carry.",
  }),
  windowHours: z.number().int().positive().meta({
    description: "How far back the sweep looked for first occurrences.",
  }),
});

export const newFaultsEmailTemplate = defineEmailTemplate({
  name: "audit.new-faults",
  description:
    "Tells the operations address that fault types never seen before have started happening, with how often and roughly where.",
  props,
  subject: ({ faults }) =>
    faults.length === 1 ? "1 new application fault" : `${faults.length} new application faults`,
  preview: ({ totalOccurrences }) => `${totalOccurrences} occurrences since the last sweep`,
  body: ({ faults, totalOccurrences, truncated, windowHours }) => (
    <>
      <EmailBadge tone="danger">{`${faults.length} new`}</EmailBadge>
      <EmailHeading>Something new is failing</EmailHeading>
      <EmailText>
        {faults.length === 1 ? "One fault type" : `${faults.length} fault types`} appeared for the first time in the
        last {windowHours} {windowHours === 1 ? "hour" : "hours"}, accounting for {totalOccurrences}{" "}
        {totalOccurrences === 1 ? "occurrence" : "occurrences"}.
      </EmailText>
      {faults.map((line) => (
        <EmailText key={line}>{line}</EmailText>
      ))}
      {truncated ? (
        <EmailText>
          More new faults were found than this email carries. Query request_log and client_diagnostic_events directly
          for the full set.
        </EmailText>
      ) : null}
    </>
  ),
  samples: {
    "one-fault": {
      faults: ["TypeError (server) — 3 occurrences at /api/orders · a1b2c3d4"],
      totalOccurrences: 3,
      truncated: false,
      windowHours: 1,
    },
    "both-origins": {
      faults: [
        "DomainError (server) — 204 occurrences at /api/orders/:orderId · 9f8e7d6c",
        "render (client) — 12 occurrences at 0192f2a0 · 1a2b3c4d",
      ],
      totalOccurrences: 216,
      truncated: false,
      windowHours: 1,
    },
    truncated: {
      faults: ["ZodError (client) — 51 occurrences · deadbeef"],
      totalOccurrences: 900,
      truncated: true,
      windowHours: 6,
    },
  } satisfies Record<string, z.infer<typeof props>>,
});
