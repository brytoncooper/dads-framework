import { HandlerTimeoutError } from "../http-errors.js";

type Deadline = {
  readonly promise: Promise<never>;
  readonly cancel: () => void;
  readonly didTimeOut: () => boolean;
};

type OrphanLog = { warn(obj: object, msg?: string): void };

function startDeadline(ms: number, routePath: string): Deadline {
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new HandlerTimeoutError(routePath, ms));
    }, ms);
    // The deadline must never keep the process alive on its own.
    timer.unref();
  });
  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
    },
    didTimeOut: () => timedOut,
  };
}

/**
 * A timed-out handler keeps running after its socket is released; its
 * eventual rejection must land in the log, never as an unhandled rejection
 * that kills the process.
 */
function drainOrphan(
  work: Promise<unknown>,
  routePath: string,
  log: OrphanLog,
): void {
  void work.catch((error: unknown) => {
    log.warn(
      { event: "handler.orphaned-rejection", routePath, err: error },
      "timed-out handler eventually rejected",
    );
  });
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Races work against a hard deadline (process-discipline bar: a hung
 * handler cannot pin a socket). The timer is cleared on settle and never
 * holds the event loop; on timeout the orphaned work is drained into the
 * log and a `HandlerTimeoutError` propagates to the error handler (503).
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  routePath: string,
  log: OrphanLog,
): Promise<T> {
  const deadline = startDeadline(ms, routePath);
  try {
    return await Promise.race([work, deadline.promise]);
  } catch (error) {
    if (deadline.didTimeOut()) {
      drainOrphan(work, routePath, log);
    }
    throw toError(error);
  } finally {
    deadline.cancel();
  }
}
