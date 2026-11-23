import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SystemClock } from "@dads-framework/core/runtime/clock";
import {
  createEmailDelivery,
  createEmailDeliveryJobs,
  DrizzleOutboundEmailStore,
  type EmailDeliveryLog,
} from "@dads-framework/email/delivery";
import type { EmailMessage, EmailSender } from "@dads-framework/email/core";
import type { JobQueue } from "@dads-framework/job-queue/core";
import type { DrizzleHandle } from "@dads-framework/postgres";

import type { EnqueueStarterEmail } from "../libraries/app-runtime/index.js";
import {
  starterMailTemplate,
  starterMailTemplates,
  renderStarterMail,
} from "./local-mail-template.js";

export function createLocalMail(
  database: DrizzleHandle,
  queue: JobQueue,
  directory: string,
) {
  const store = new DrizzleOutboundEmailStore(database);
  const emailSender = spoolSender(directory);
  const clock = new SystemClock();
  const log: EmailDeliveryLog = {
    info: () => undefined,
    warn: (_details, message) => {
      writeMailStatus(message);
    },
    error: (_details, message) => {
      writeMailStatus(message);
    },
  };
  const deps = { store, emailSender, clock, render: renderStarterMail, log };
  const emailDelivery = createEmailDelivery({ ...deps, jobQueue: queue });
  const jobs = createEmailDeliveryJobs({
    ...deps,
    emailDelivery,
    catalog: starterMailTemplates,
  });
  const enqueueEmail: EnqueueStarterEmail = async ({ kind, to, url }) => {
    await emailDelivery.sendNow(
      starterMailTemplate,
      { kind, url },
      { to: [{ address: to }] },
    );
  };
  return { jobs, enqueueEmail };
}

function spoolSender(directory: string): EmailSender {
  return {
    async send(message: EmailMessage) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const pending = join(directory, `${id}.tmp`);
      try {
        await writeFile(pending, JSON.stringify(message), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(pending, join(directory, `${id}.json`));
      } finally {
        await rm(pending, { force: true });
      }
      return { providerMessageId: id };
    },
  };
}

function writeMailStatus(message: string | undefined): void {
  if (message) process.stderr.write(`${message}\n`);
}
