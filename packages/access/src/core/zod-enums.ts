import { z } from "zod";

export function zodEnumFromNames(names: readonly string[]): z.ZodType<string> {
  const [firstName, ...otherNames] = names;
  if (firstName === undefined) {
    throw new Error("an access definition must declare at least one name");
  }
  return z.enum([firstName, ...otherNames]);
}
