/**
 * The time seam (docs/architecture/where-things-go.md#shared-dependencies):
 * anything that needs "now" injects Clock instead of calling `new Date()`,
 * so tests pin time with a fake. Abstract class = type + injection token.
 * SystemClock is bound globally by ClockModule — inject and go.
 */
export abstract class Clock {
  abstract now(): Date;
}

/** The real thing — wall-clock time. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
