import { describe, expect, it } from "vitest";
import type { AuditActor } from "./audit-actor.js";
import {
  anonymousActor,
  currentAuditActor,
  runWithAuditActor,
  systemActor,
  withReason,
  withSystemActor,
} from "./audit-actor-context.js";

const REQUEST_ID = "01990000-0000-7000-8000-000000000001";
const OTHER_REQUEST_ID = "01990000-0000-7000-8000-000000000002";

function userActor(id: string, requestId: string): AuditActor {
  return { kind: "user", id, requestId };
}

function afterATick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 1);
  });
}

describe("currentAuditActor", () => {
  it("is undefined outside any context, so an unattributed write is refused", () => {
    expect(currentAuditActor()).toBeUndefined();
  });

  it("holds the actor for the duration of the work", async () => {
    const actor = userActor("user-1", REQUEST_ID);

    const seen = await runWithAuditActor(actor, () => currentAuditActor());

    expect(seen).toEqual(actor);
    expect(currentAuditActor()).toBeUndefined();
  });
});

describe("runWithAuditActor", () => {
  it("keeps two interleaved contexts apart", async () => {
    const first = userActor("user-1", REQUEST_ID);
    const second = userActor("user-2", OTHER_REQUEST_ID);

    const actorAcrossAwait = async (actor: AuditActor) =>
      runWithAuditActor(actor, async () => {
        const before = currentAuditActor();
        await afterATick();
        return { before, after: currentAuditActor() };
      });

    const [firstSaw, secondSaw] = await Promise.all([actorAcrossAwait(first), actorAcrossAwait(second)]);

    expect(firstSaw).toEqual({ before: first, after: first });
    expect(secondSaw).toEqual({ before: second, after: second });
  });

  it("restores the outer actor after a nested context ends", async () => {
    const outer = userActor("user-1", REQUEST_ID);
    const inner = userActor("user-2", OTHER_REQUEST_ID);

    const seen = await runWithAuditActor(outer, async () => {
      const innerSaw = await runWithAuditActor(inner, () => currentAuditActor());
      return { innerSaw, afterInner: currentAuditActor() };
    });

    expect(seen).toEqual({ innerSaw: inner, afterInner: outer });
  });
});

describe("withReason", () => {
  it("annotates the actor already in force without inventing one", async () => {
    const actor = userActor("user-1", REQUEST_ID);

    const seen = await runWithAuditActor(actor, () =>
      withReason("void requested by customer", () => currentAuditActor()),
    );

    expect(seen).toEqual({ ...actor, reason: "void requested by customer" });
  });

  it("leaves the surrounding context unannotated", async () => {
    const actor = userActor("user-1", REQUEST_ID);

    const afterAnnotating = await runWithAuditActor(actor, async () => {
      await withReason("corrected weight", () => undefined);
      return currentAuditActor();
    });

    expect(afterAnnotating).toEqual(actor);
  });

  it("runs the work unchanged outside any context", async () => {
    const seen = await withReason("no actor to annotate", () => currentAuditActor());

    expect(seen).toBeUndefined();
  });
});

describe("systemActor", () => {
  it("mints a request id when the caller has none", () => {
    const actor = systemActor("migration");

    expect(actor.kind).toBe("system");
    expect(actor.id).toBe("migration");
    expect(actor.requestId.length).toBeGreaterThan(0);
  });

  it("mints a different request id per run, so one run's rows group together", () => {
    expect(systemActor("seed").requestId).not.toBe(systemActor("seed").requestId);
  });

  it("keeps a supplied request id", () => {
    expect(systemActor("job:prune-request-log", REQUEST_ID).requestId).toBe(REQUEST_ID);
  });
});

describe("withSystemActor", () => {
  it("takes over inside a user context and gives it back after", async () => {
    const user = userActor("user-1", REQUEST_ID);

    const seen = await runWithAuditActor(user, async () => {
      const systemSaw = await withSystemActor("job:rebuild-index", () => currentAuditActor());
      return { systemSaw, afterJob: currentAuditActor() };
    });

    expect(seen.systemSaw?.kind).toBe("system");
    expect(seen.systemSaw?.id).toBe("job:rebuild-index");
    expect(seen.afterJob).toEqual(user);
  });
});

describe("anonymousActor", () => {
  it("carries the request id and no identity", () => {
    expect(anonymousActor(REQUEST_ID)).toEqual({
      kind: "anonymous",
      id: "",
      requestId: REQUEST_ID,
    });
  });
});
