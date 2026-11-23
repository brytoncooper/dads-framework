import type { ProductId } from "../../libraries/product-id/src/index.js";

export function createInventory(initialStock: Readonly<Record<ProductId, number>>) {
  const stock = new Map(Object.entries(initialStock));
  function available(productId: ProductId): number {
    return stock.get(productId) ?? 0;
  }
  return {
    available,
    reserve(productId: ProductId): boolean {
      const count = available(productId);
      if (count === 0) return false;
      stock.set(productId, count - 1);
      return true;
    },
  };
}
