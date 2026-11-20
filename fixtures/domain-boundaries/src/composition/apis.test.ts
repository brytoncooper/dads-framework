import { expect, test } from "vitest";
import { createApis } from "./apis.js";

test("a customer order calls inventory through the orders port while staff owns stock routes", async () => {
  const apis = createApis();
  const customer = await apis.customer.start();
  const staff = await apis.staff.start();
  try {
    expect(customer.routes.map(({ path }) => path)).toEqual(["/orders"]);
    expect(staff.routes.map(({ path }) => path)).toEqual(["/staff/stock"]);
    const [place] = customer.routes;
    const [stock] = staff.routes;
    if (!place || !stock) throw new Error("Both APIs must have a route.");
    expect(stock.run("sample-product")).toBe(1);
    expect(place.run("sample-product")).toBe("accepted");
    expect(stock.run("sample-product")).toBe(0);
    expect(place.run("sample-product")).toBe("out-of-stock");
  } finally {
    await Promise.all([customer.stop(), staff.stop()]);
  }
});
