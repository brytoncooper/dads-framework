import { z } from "zod";

export type WorkbenchClientOptions = {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
};

export type WorkbenchRequest = {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: {
    readonly page?: string | number;
    readonly perPage?: string | number;
  };
  readonly body?: unknown;
};

export class WorkbenchClientError extends Error {
  constructor(readonly status: number) {
    super(`Workbench request failed with status ${status}`);
  }
}

export function workbenchFetch(options: WorkbenchClientOptions) {
  return async function request(method: string, template: string, input: WorkbenchRequest): Promise<unknown> {
    const path = template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/gu, (_part, key: string) => {
      const argument = input.params?.[key];
      if (argument === undefined) throw new Error(`Missing route parameter ${key}`);
      return encodeURIComponent(argument);
    });
    const url = new URL(path, options.baseUrl);
    for (const [name, value] of Object.entries<string | number | undefined>(input.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const headers = new Headers(options.headers);
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await (options.fetch ?? fetch)(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok) throw new WorkbenchClientError(response.status);
    if (response.status === 204) return undefined;
    const payload: unknown = await response.json();
    return z.object({ data: z.unknown() }).parse(payload).data;
  };
}
