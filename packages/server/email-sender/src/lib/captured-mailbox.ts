/** One attachment as the development mail page names it — never its bytes. */
export type CapturedAttachment = {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
};

/** One outbound email as the development mail page shows it. */
export type CapturedEmail = {
  /** Stable for as long as this capture is held — `mail-1`, `mail-2`, … */
  readonly id: string;
  /** When the send happened, ISO 8601 UTC. */
  readonly capturedAt: string;
  readonly from: string;
  /** Every recipient, already rendered into one header value. */
  readonly to: string;
  /** Present only when the message carried carbon copies. */
  readonly cc?: string;
  /** Present only when the message carried blind carbon copies. */
  readonly bcc?: string;
  /** Present only when the message named a reply address. */
  readonly replyTo?: string;
  readonly subject: string;
  readonly text: string;
  /** Present only when the message carried an HTML body. */
  readonly html?: string;
  /** Present only when the message carried attachments. */
  readonly attachments?: readonly CapturedAttachment[];
  /** Present only when the message carried vendor tags. */
  readonly tags?: readonly string[];
  /** Present only when the message carried extra headers. */
  readonly headers?: Readonly<Record<string, string>>;
};

export type CapturedMailboxOptions = {
  /** Oldest captures fall off past this many. Defaults to 200. */
  readonly capacity?: number;
  /** Clock for `capturedAt`; inject a fixed one in tests. */
  readonly now?: () => Date;
};

const DEFAULT_CAPACITY = 200;

/**
 * The development mail page's store: every message `CaptureEmailSender` sent,
 * whole, held in this process's memory and lost on restart.
 *
 * NEVER run this outside a developer's own machine. Bodies carry one-time
 * invitation and verification tokens, so everything in here is credential
 * material — the point of the driver is that a developer can read the email
 * and click the link without a mail vendor.
 */
export class CapturedMailbox {
  private readonly capacity: number;
  private readonly now: () => Date;
  /** Oldest first; `list()` is what reverses it for the page. */
  private readonly captured: CapturedEmail[] = [];
  private nextNumber = 1;

  constructor(options: CapturedMailboxOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Stamps the capture with an id and the current time, then holds it, and
   * hands back the id so the driver can report it as the send receipt.
   */
  record(email: Omit<CapturedEmail, "id" | "capturedAt">): string {
    const id = `mail-${this.nextNumber}`;
    this.captured.push({
      ...email,
      id,
      capturedAt: this.now().toISOString(),
    });
    this.nextNumber += 1;
    this.dropOldestPastCapacity();
    return id;
  }

  /** Newest first — the order the page renders. */
  list(): readonly CapturedEmail[] {
    return [...this.captured].reverse();
  }

  /**
   * Empties the mailbox. Ids keep counting up, so a cleared id is never handed
   * out again and a page still holding the old list cannot match a new message.
   */
  clear(): void {
    this.captured.length = 0;
  }

  private dropOldestPastCapacity(): void {
    while (this.captured.length > this.capacity) {
      this.captured.shift();
    }
  }
}
