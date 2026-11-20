/**
 * What: a feature's hook resolves that feature's words in the reader's
 * language.
 * Why: the hook must read the LOCALE from context and the CATALOG from its
 * closure. If it ever read a merged catalog instead, every label edit in the
 * app would re-render every screen and mark every feature affected — the one
 * regression this kit's shape exists to prevent, and it would look like working
 * code.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { copy } from "./copy-descriptor.js";
import { createCopyHook } from "./create-copy-hook.js";
import { LocaleProvider } from "./locale-provider.js";
import { defineCopy } from "./localized-text.js";

afterEach(cleanup);

const ordersCopy = defineCopy({
  "orders.page.title": { en: "Orders" },
  "orders.holders_one": { en: "1 person" },
  "orders.holders_other": { en: "{count} people" },
});

const useOrdersCopy = createCopyHook(ordersCopy);

function OrdersHeading() {
  const t = useOrdersCopy();
  return <h1>{t("orders.page.title")}</h1>;
}

function OrdersHolders({ count }: { readonly count: number }) {
  const t = useOrdersCopy();
  return <output>{t(copy("orders.holders", {}, count))}</output>;
}

describe("createCopyHook", () => {
  it("resolves a feature's own words", () => {
    render(
      <LocaleProvider>
        <OrdersHeading />
      </LocaleProvider>,
    );

    expect(screen.getByRole("heading").textContent).toBe("Orders");
  });

  it("resolves a descriptor a pure function handed the component", () => {
    render(
      <LocaleProvider>
        <OrdersHolders count={4} />
      </LocaleProvider>,
    );

    expect(screen.getByRole("status").textContent).toBe("4 people");
  });

  it("renders outside a provider, in the default language", () => {
    render(<OrdersHeading />);

    expect(screen.getByRole("heading").textContent).toBe("Orders");
  });

  it("refuses a key this feature's catalog does not declare", () => {
    function Typo() {
      const t = useOrdersCopy();
      // Calls from plain JavaScript still get a runtime error for undeclared copy.
      Reflect.apply(t, undefined, ["orders.page.titel"]);
      return null;
    }

    expect(() => render(<Typo />)).toThrow(/is not declared/);
  });
});
