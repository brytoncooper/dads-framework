/**
 * createEmailSender picks the driver MAIL_DRIVER names, and refuses to boot a
 * driver whose required dependency (a Resend key, a captured mailbox) is
 * missing rather than silently dropping email.
 */
import { describe, expect, it, vi } from "vitest";
import { CaptureEmailSender } from "./capture-email-sender.js";
import { CapturedMailbox } from "./captured-mailbox.js";
import { createEmailSender } from "./create-email-sender.js";
import { LogEmailSender } from "./log-email-sender.js";
import { MailgunEmailSender } from "./mailgun-email-sender.js";
import { VerboseLogEmailSender } from "./verbose-log-email-sender.js";

describe("createEmailSender", () => {
  it("returns the log driver", () => {
    expect(
      createEmailSender(
        { driver: "log", from: "Example App <x@y.z>" },
        { info: vi.fn() },
      ),
    ).toBeInstanceOf(LogEmailSender);
  });

  it("returns the verbose log driver so dev can read bodies in the logs", () => {
    expect(
      createEmailSender(
        { driver: "log-verbose", from: "Example App <x@y.z>" },
        { info: vi.fn() },
      ),
    ).toBeInstanceOf(VerboseLogEmailSender);
  });

  it("returns the capture driver so the development mail page has messages", () => {
    expect(
      createEmailSender(
        {
          driver: "capture",
          from: "Example App <x@y.z>",
          mailbox: new CapturedMailbox(),
        },
        { info: vi.fn() },
      ),
    ).toBeInstanceOf(CaptureEmailSender);
  });

  it("fails loudly when capture is selected without a mailbox", () => {
    expect(() =>
      createEmailSender(
        { driver: "capture", from: "Example App <x@y.z>" },
        { info: vi.fn() },
      ),
    ).toThrow(/mailbox/);
  });

  it("fails loudly when resend is selected without an api key", () => {
    expect(() =>
      createEmailSender(
        { driver: "resend", from: "Example App <x@y.z>" },
        { info: vi.fn() },
      ),
    ).toThrow(/RESEND_API_KEY/);
  });

  it("returns the mailgun driver", () => {
    expect(
      createEmailSender(
        {
          driver: "mailgun",
          from: "Example App <x@y.z>",
          mailgunApiKey: "key-secret",
          mailgunDomain: "mail.example.test",
          mailgunRegion: "us",
        },
        { info: vi.fn() },
      ),
    ).toBeInstanceOf(MailgunEmailSender);
  });

  it("fails loudly when mailgun is selected without a key or a domain", () => {
    expect(() =>
      createEmailSender(
        {
          driver: "mailgun",
          from: "Example App <x@y.z>",
          mailgunDomain: "mail.example.test",
          mailgunRegion: "us",
        },
        { info: vi.fn() },
      ),
    ).toThrow(/MAILGUN_API_KEY and MAILGUN_DOMAIN/);
    expect(() =>
      createEmailSender(
        {
          driver: "mailgun",
          from: "Example App <x@y.z>",
          mailgunApiKey: "key-secret",
          mailgunRegion: "us",
        },
        { info: vi.fn() },
      ),
    ).toThrow(/MAILGUN_API_KEY and MAILGUN_DOMAIN/);
  });
});
