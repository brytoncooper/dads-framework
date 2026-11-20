import type { EnqueueStarterEmail } from "../libraries/app-runtime/index.js";

export function developmentMail(enabled: boolean): EnqueueStarterEmail {
  return (message) => {
    if (!enabled)
      return Promise.reject(
        new Error("Configure the application's email transport."),
      );
    process.stdout.write(`[local mail] ${message.kind}: ${message.url}\n`);
    return Promise.resolve();
  };
}
