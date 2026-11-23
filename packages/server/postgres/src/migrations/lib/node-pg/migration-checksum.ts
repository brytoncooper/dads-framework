import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function fileSha256(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}
