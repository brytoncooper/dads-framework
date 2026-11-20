import { composeApi, definePlugin } from "@dads-framework/plugin";
import { createInventory } from "../../domains/inventory/index.js";
import { createOrders } from "../../domains/orders/index.js";

export function createApis() {
  const inventory = createInventory({ "sample-product": 1 });
  const orders = createOrders((productId) => inventory.reserve(productId));

  const orderRoutes = definePlugin({
    name: "orders-routes",
    setup: () => ({
      routes: [{ path: "/orders", run: orders.place }],
    }),
  });
  const inventoryRoutes = definePlugin({
    name: "inventory-routes",
    setup: () => ({
      routes: [{ path: "/staff/stock", run: inventory.available }],
    }),
  });

  return {
    customer: composeApi("customer", {
      services: [],
      routes: [orderRoutes],
      jobs: [],
    }),
    staff: composeApi("staff", {
      services: [],
      routes: [inventoryRoutes],
      jobs: [],
    }),
  };
}
