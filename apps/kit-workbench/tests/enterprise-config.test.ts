import { readEnterpriseConfiguration } from "../assembly/enterprise-config.js";
import { expect, it } from "vitest";

it("ignores absent configuration and fails closed on incomplete configuration", () => {
  expect(readEnterpriseConfiguration({})).toEqual({});
  expect(() => readEnterpriseConfiguration({ DADS_ENTERPRISE_SCIM: "{}" })).toThrow(
    "Invalid DADS_ENTERPRISE_SCIM configuration.",
  );
  expect(() =>
    readEnterpriseConfiguration({
      DADS_ENTERPRISE_SSO_PROVIDERS: "private fixture text",
    }),
  ).toThrow(/^Invalid DADS_ENTERPRISE_SSO_PROVIDERS configuration\.$/u);
});
