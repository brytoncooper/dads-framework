import type { ImpersonationAuditEvent, ImpersonationOptions } from "./types.js";

type AttemptFields = Omit<ImpersonationAuditEvent, "outcome" | "occurredAtMs">;
export type AuditContext = {
  -readonly [Key in keyof AttemptFields]: AttemptFields[Key];
};

export class ImpersonationAuditError extends Error {
  constructor(
    readonly event: ImpersonationAuditEvent,
    cause: unknown,
  ) {
    super("Impersonation audit write failed", { cause });
    this.name = "ImpersonationAuditError";
  }
}

export function createImpersonationAudit(
  writeAudit: ImpersonationOptions["writeAudit"],
  now: () => number,
  context: AuditContext,
) {
  function eventFor(
    outcome: ImpersonationAuditEvent["outcome"],
  ): ImpersonationAuditEvent {
    return { ...context, outcome, occurredAtMs: now() };
  }

  const audit = async (outcome: ImpersonationAuditEvent["outcome"]) => {
    const event = eventFor(outcome);
    try {
      await writeAudit(event);
    } catch (error) {
      throw new ImpersonationAuditError(event, error);
    }
  };
  return { audit, authorizedEvent: () => eventFor("authorized") };
}
