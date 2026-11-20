import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  RESERVED_SLUGS,
  isReservedSlug,
  isSlugShape,
  slugSchema,
} from "./slug.js";

const longhandSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "Slug must be lowercase kebab-case",
  })
  .meta({ description: "URL identity" });

const slug = slugSchema("URL identity");

describe("slugSchema", () => {
  it("emits JSON Schema identical to the longhand it replaces", () => {
    expect(z.toJSONSchema(slug)).toEqual(z.toJSONSchema(longhandSchema));
  });

  it("accepts kebab-case and refuses everything ADR-0053 excludes", () => {
    expect(slug.parse("acme-foods")).toBe("acme-foods");
    expect(slug.parse("  acme-foods  ")).toBe("acme-foods");
    for (const bad of ["Acme", "acme_foods", "-acme", "acme-", "acme--foods"]) {
      expect(() => slug.parse(bad)).toThrow();
    }
  });

  it("names the format in its message", () => {
    expect(slug.safeParse("Acme").error?.issues[0]?.message).toBe(
      "Slug must be lowercase kebab-case",
    );
  });
});

describe("isSlugShape", () => {
  it("answers the same question the schema's regex asks", () => {
    for (const good of ["acme-foods", "a", "north-mill-2", "2026"]) {
      expect(isSlugShape(good)).toBe(true);
      expect(slug.safeParse(good).success).toBe(true);
    }
    for (const bad of ["Acme", "acme_foods", "-acme", "acme-", "acme--foods"]) {
      expect(isSlugShape(bad)).toBe(false);
      expect(slug.safeParse(bad).success).toBe(false);
    }
  });
});

describe("isReservedSlug", () => {
  it("withholds the words a route root would want back", () => {
    for (const reserved of ["staff", "api", "orgs", "facilities", "admin"]) {
      expect(isReservedSlug(reserved)).toBe(true);
    }
    expect(isReservedSlug("acme-foods")).toBe(false);
  });

  it("reserves only words a slug could otherwise be", () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(isSlugShape(reserved)).toBe(true);
    }
  });
});
