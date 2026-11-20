import { createHash } from "node:crypto";
import { expect } from "vitest";
import { z } from "zod";

import type { startApp } from "../assembly/start-app.js";

type Http = Awaited<ReturnType<typeof startApp>>;
const fileResponse = z.object({ data: z.object({ fileId: z.uuid() }) });
const exportResponse = z.object({
  data: z.object({ contentType: z.string(), base64: z.base64() }),
});

export async function proveNoteArtifacts(
  app: Http,
  note: string,
  allowed: Record<string, string>,
  denied: Record<string, string>,
): Promise<void> {
  const text = "UTF-8 résumé";
  const attachments = `${note}/attachments`;
  const blocked = await app.inject({
    method: "POST",
    url: attachments,
    headers: denied,
    payload: { text },
  });
  expect(blocked.statusCode).toBe(404);
  const posted = await app.inject({
    method: "POST",
    url: attachments,
    headers: allowed,
    payload: { text },
  });
  expect(posted.statusCode).toBe(201);
  const { fileId } = fileResponse.parse(posted.json()).data;
  const url = `${attachments}/${fileId}`;
  expect((await app.inject({ url, headers: denied })).statusCode).toBe(404);
  await expect
    .poll(async () => {
      const result = await app.inject({ url, headers: allowed });
      return result.json<unknown>();
    })
    .toMatchObject({
      data: {
        text,
        inspection: {
          bytes: Buffer.byteLength(text),
          sha256: createHash("sha256").update(text).digest("hex"),
        },
      },
    });
  await proveExports(app, note, allowed, denied);
}

async function proveExports(
  app: Http,
  note: string,
  allowed: Record<string, string>,
  denied: Record<string, string>,
): Promise<void> {
  const csv = await app.inject({
    url: `${note}/exports/csv`,
    headers: allowed,
  });
  const pdf = await app.inject({
    url: `${note}/exports/pdf`,
    headers: allowed,
  });
  expect(csv.statusCode).toBe(200);
  expect(pdf.statusCode).toBe(200);
  expect(
    Buffer.from(
      exportResponse.parse(csv.json()).data.base64,
      "base64",
    ).toString(),
  ).toContain("Alpha's note");
  expect(
    Buffer.from(exportResponse.parse(pdf.json()).data.base64, "base64")
      .subarray(0, 5)
      .toString(),
  ).toBe("%PDF-");
  expect(
    (await app.inject({ url: `${note}/exports/pdf`, headers: denied }))
      .statusCode,
  ).toBe(404);
}
