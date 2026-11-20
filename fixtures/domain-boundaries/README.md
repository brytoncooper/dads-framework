# Orders and inventory across two APIs

Orders defines the `ReserveStock` port. Inventory implements stock reservation
without importing Orders. The composition root binds the implementation and
starts separate customer and staff APIs. The customer can place an order, and
only the staff API exposes stock.

From this directory run `npx dad check boundaries`. To observe the refusal, copy
`examples/bad-order-import.txt` to `domains/orders/bad-order-import.ts` and
run the checker again. The report points to the forbidden import and the port
the domain should use instead. Remove the copied file after the check.
