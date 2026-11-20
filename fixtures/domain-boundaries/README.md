# Orders and inventory across two APIs

Orders defines the `ReserveStock` port. Inventory implements stock reservation
without importing Orders. The composition root binds the implementation and
starts separate customer and staff APIs. The customer can place an order, and
only the staff API exposes stock.

From a built checkout with dependencies installed, check the fixture's
boundaries:

```sh
cd fixtures/domain-boundaries
npx --no-install dad check boundaries
```

To observe a failure, copy `examples/bad-order-import.txt` to
`domains/orders/bad-order-import.ts` in a disposable checkout and rerun the
command. The report points to the forbidden import and the port Orders should
use. Delete the copied example when you are done.
