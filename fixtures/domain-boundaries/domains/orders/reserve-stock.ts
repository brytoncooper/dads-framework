import type { ProductId } from "../../libraries/product-id/src/index.js";

export type ReserveStock = (productId: ProductId) => boolean;

export function createOrders(reserveStock: ReserveStock) {
  return {
    place: (productId: ProductId) =>
      reserveStock(productId) ? "accepted" : "out-of-stock",
  };
}
