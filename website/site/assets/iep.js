/* global document, HTMLButtonElement, HTMLDetailsElement */
(() => {
  const SCENARIOS = {
    "db-column": {
      announcement:
        "Scenario: rename database column. Coupled graph cascades from invoices table through shared DTO into Web, Mobile, and Shipping (480 tests). Independent Evolution stops at the persistence boundary in billing/store.ts (3 tests).",
      coupled: {
        nodes: {
          db: ["origin", "column renamed"],
          dto: ["dirty", "row leaked"],
          web: ["dirty", "type breaks"],
          mobile: ["dirty", "older app breaks"],
          shipping: ["dirty", "reads raw row"],
          vendor: ["clean", "untouched"],
        },
        edges: {
          "db-dto": "dirty",
          "dto-web": "dirty",
          "dto-mobile": "dirty",
          "dto-shipping": "dirty",
          "vendor-dto": "neutral",
        },
        metrics: ["5 / 6 modules", "480 tests", "Mobile breaks"],
        note: "Because the database table is shared as the API DTO, renaming one internal column cascades through every client and sibling domain.",
      },
      iep: {
        nodes: {
          db: ["origin", "column renamed"],
          store: ["absorbed", "mapped once"],
          wire: ["clean", "contract frozen"],
          web: ["clean", "untouched"],
          shipping: ["clean", "port unchanged"],
          vendor: ["clean", "untouched"],
        },
        edges: {
          "db-store": "absorbed",
          "store-wire": "blocked",
          "wire-web": "neutral",
          "wire-shipping": "neutral",
          "vendor-store": "neutral",
        },
        wallActive: true,
        wallLabel: "STOPPED AT STORE",
        metrics: ["1 / 6 modules", "3 tests (99% skipped)", "Zero client impact"],
        note: "The persistence boundary absorbs the rename inside billing/store.ts. The hand-written wire contract never moves, so clients and shipping stay untouched.",
      },
    },
    "vendor-swap": {
      announcement:
        "Scenario: swap Stripe to Adyen. Coupled graph leaks SDK types across DTO, Web, Mobile, and Shipping (340 tests). Independent Evolution isolates the swap to one integration adapter.",
      coupled: {
        nodes: {
          db: ["dirty", "stripe_id column"],
          dto: ["dirty", "SDK types exposed"],
          web: ["dirty", "error codes break"],
          mobile: ["dirty", "webhook shape"],
          shipping: ["dirty", "imports SDK"],
          vendor: ["origin", "Stripe -> Adyen"],
        },
        edges: {
          "db-dto": "dirty",
          "dto-web": "dirty",
          "dto-mobile": "dirty",
          "dto-shipping": "dirty",
          "vendor-dto": "dirty",
        },
        metrics: ["6 / 6 modules", "340 tests", "14 routes edited"],
        note: "Foreign SDK types and error codes bled into routes and sibling domains. Replacing one vendor turns into an application-wide rewrite.",
      },
      iep: {
        nodes: {
          db: ["clean", "app-owned IDs"],
          store: ["clean", "untouched"],
          wire: ["clean", "contract frozen"],
          web: ["clean", "untouched"],
          shipping: ["clean", "untouched"],
          vendor: ["absorbed", "1 adapter swapped"],
        },
        edges: {
          "db-store": "neutral",
          "store-wire": "neutral",
          "wire-web": "neutral",
          "wire-shipping": "neutral",
          "vendor-store": "blocked",
        },
        wallActive: true,
        wallLabel: "STOPPED AT PORT",
        metrics: ["1 / 6 modules", "1 conformance suite", "0 domain edits"],
        note: "Stripe lived behind one app-owned Payments capability in integrations/. Swapping to Adyen touches one adapter and runs the same conformance suite.",
      },
    },
    "mobile-field": {
      announcement:
        "Scenario: mobile adds offline draft field. Coupled graph forces DB and web rebuilds (290 tests). Independent Evolution isolates the additive change to the wire contract.",
      coupled: {
        nodes: {
          db: ["dirty", "forced column"],
          dto: ["origin", "shared DTO edited"],
          web: ["dirty", "rebuilds & breaks"],
          mobile: ["origin", "needs draft state"],
          shipping: ["dirty", "shared model"],
          vendor: ["clean", "untouched"],
        },
        edges: {
          "db-dto": "dirty",
          "dto-web": "dirty",
          "dto-mobile": "dirty",
          "dto-shipping": "dirty",
          "vendor-dto": "neutral",
        },
        metrics: ["5 / 6 modules", "290 tests", "Web blocked on mobile"],
        note: "Web and mobile share one coupled server shape, so a mobile-only field forces web deploys and unrelated domain tests to move in lockstep.",
      },
      iep: {
        nodes: {
          db: ["clean", "untouched"],
          store: ["clean", "untouched"],
          wire: ["absorbed", "additive contract"],
          web: ["clean", "ignores optional"],
          shipping: ["clean", "untouched"],
          vendor: ["clean", "untouched"],
        },
        edges: {
          "db-store": "neutral",
          "store-wire": "neutral",
          "wire-web": "blocked",
          "wire-shipping": "neutral",
          "vendor-store": "neutral",
        },
        wallActive: true,
        wallLabel: "ABSORBED AT WIRE",
        metrics: ["1 / 6 modules", "4 contract tests", "Independent deploys"],
        note: "Each client consumes an explicit, versionable wire contract. Mobile adds what it needs without dragging web, storage, or shipping into the release.",
      },
    },
    "pure-helper": {
      announcement:
        "Scenario: refactor billing tax helper. Coupled graph leaks through shared barrel into Web, Mobile, and Shipping (310 tests). Independent Evolution keeps the edit inside billing pure logic and dad-test runs 2 files.",
      coupled: {
        nodes: {
          db: ["clean", "untouched"],
          dto: ["origin", "shared barrel"],
          web: ["dirty", "imports barrel"],
          mobile: ["dirty", "imports barrel"],
          shipping: ["dirty", "internal import"],
          vendor: ["clean", "untouched"],
        },
        edges: {
          "db-dto": "neutral",
          "dto-web": "dirty",
          "dto-mobile": "dirty",
          "dto-shipping": "dirty",
          "vendor-dto": "neutral",
        },
        metrics: ["4 / 6 modules", "310 tests", "Cross-domain leak"],
        note: "Shipping reached directly into billing's internal helper, and clients imported a giant shared barrel. One private refactor lights up half the repo's CI.",
      },
      iep: {
        nodes: {
          db: ["clean", "untouched"],
          store: ["origin", "billing/pure edit"],
          wire: ["clean", "contract frozen"],
          web: ["clean", "untouched"],
          shipping: ["clean", "port unchanged"],
          vendor: ["clean", "untouched"],
        },
        edges: {
          "db-store": "neutral",
          "store-wire": "blocked",
          "wire-web": "neutral",
          "wire-shipping": "neutral",
          "vendor-store": "neutral",
        },
        wallActive: true,
        wallLabel: "STOPPED IN DOMAIN",
        metrics: ["1 / 6 modules", "2 tests (98% skipped)", "Local refactor"],
        note: "Because domains cannot cross private files, the dependency graph matches real ownership. dad-test proves 98% of tests are unaffected and runs 2 files.",
      },
    },
  };

  const FRAMEWORKS = {
    nextjs: {
      title: "Next.js (Server Actions & RSC)",
      rule: "Breaks: Wire ↔ Clients & Persistence ↔ Wire",
      badLabel: "What Next.js nudges you into",
      badCode: `// app/invoices/page.tsx (Server Component)
import { db } from "@/lib/db";
import { InvoiceCard } from "./invoice-card";

export default async function Page() {
  // DB row handed straight to UI props — zero wire contract
  const rows = await db.select().from(invoicesTable);
  return <InvoiceCard invoices={rows} />;
}

// app/invoices/actions.ts ("use server")
export async function renameInvoice(id: string, title: string) {
  // Tied to Next's RPC transport; unreachable from mobile or webhooks
}`,
      badCopy:
        "Server Components and 'use server' actions erase the wire boundary completely. Your SQL columns become React props, and mutations live behind a Next-only RPC protocol. The day you add an iOS app, public API, or partner webhook, you have to build a real backend boundary from scratch.",
      goodLabel: "What Dads enforces instead",
      goodCode: `// domains/billing/contract/wire.ts (owned wire boundary)
export const invoiceResponse = z.strictObject({
  id: invoiceId,
  amountMinor: z.number().int(),
});

// apps/web uses typed callApi() — same contract as iOS & webhooks.
// apps/customer exposes OpenAPI 3.1 + compile-time access checks.`,
      goodCopy:
        "Web is just one client of an explicit Zod wire contract. Your React UI, mobile app, and external integrations share the exact same typed contract without leaking a single Postgres column.",
    },
    nestjs: {
      title: "NestJS (Global DI + Decorated Entity/DTO Classes)",
      rule: "Breaks: Domain ↔ Domain & Persistence ↔ Wire",
      badLabel: "What NestJS nudges you into",
      badCode: `// One class owns SQL schema + validation + OpenAPI + wire DTO
@Entity("invoices")
export class Invoice {
  @PrimaryGeneratedColumn("uuid")
  @ApiProperty()
  id: string;
}

@Injectable()
export class ShippingService {
  // Global DI + forwardRef() hides cross-domain coupling until runtime
  constructor(
    @Inject(forwardRef(() => InvoicesRepository))
    private invoices: InvoicesRepository,
  ) {}
}`,
      badCopy:
        "Decorated entity classes weld persistence, validation, and wire docs into one class, while Nest's DI container lets any module inject another domain's repository directly. Circular dependencies pile up, runtime boot fails silently, and every CI graph turns into a hairball.",
      goodLabel: "What Dads enforces instead",
      goodCode: `// domains/shipping/server/ports.ts (consumer-owned port)
export type OrderPaymentStatus = {
  isPaid(orderId: OrderId): Promise<boolean>;
};

// Bound explicitly in assembly/services.ts — zero reflection, zero DI magic.
// dad check boundaries fails CI on any cross-domain internal import.`,
      goodCopy:
        "Plain TypeScript functions and explicit composition in assembly/. No decorators, no reflection metadata, no circular DI, and cross-domain leaks are caught statically before tests even start.",
    },
    laravel: {
      title: "Laravel & Rails (ActiveRecord God-Models)",
      rule: "Breaks: Persistence ↔ Domain ↔ Wire ↔ UI",
      badLabel: "What Laravel / Rails nudge you into",
      badCode: `class Invoice extends Model {
  // Storage, validation, auth scopes, domain rules, AND JSON wire shape
  protected $hidden = ['internal_cost_cents'];
  protected $appends = ['formatted_total'];

  public function customer() { return $this->belongsTo(Customer::class); }
}

// And Blade / Inertia views lazy-load $invoice->customer->plan mid-render`,
      badCopy:
        "ActiveRecord puts your database table, business policy, JSON wire format, and lazy-loaded view queries onto one mutable object. Renaming a column or changing an eager-load rule forces you to audit every controller, policy, serializer, and template in the repo.",
      goodLabel: "What Dads enforces instead",
      goodCode: `// 1. domains/billing/pure/   -> deterministic rules, zero DB/IO
// 2. domains/billing/access/ -> typed Zanzibar rules in Postgres
// 3. domains/billing/contract/ -> hand-written Zod wire schemas
// 4. domains/billing/server/ -> thin store + routes mapping DB <-> wire`,
      goodCopy:
        "Pure rules stay pure (zero I/O, instant unit + DST tests), permissions compile into your Postgres transaction, and database rows never escape the store boundary unmapped.",
    },
    trpc: {
      title: "tRPC (Server AST as Your 'Contract')",
      rule: "Breaks: Wire ↔ Independently Deployed Clients",
      badLabel: "What tRPC nudges you into",
      badCode: `// server/router.ts
export const appRouter = router({
  getInvoice: publicProcedure.query(({ ctx }) =>
    // Inferred return type = raw Drizzle/Prisma row!
    ctx.db.query.invoices.findFirst(),
  ),
});
export type AppRouter = typeof appRouter;

// web/client.ts imports server TypeScript directly`,
      badCopy:
        "Sharing typeof appRouter feels magical on day one because your frontend and backend look identical. On day two, returning an extra DB column silently leaks it to the browser, renaming a field breaks clients in lockstep, and non-TS clients (Swift, Kotlin, partners) get no contract at all.",
      goodLabel: "What Dads enforces instead",
      goodCode: `// Hand-written contract owns validation, OpenAPI 3.1, AND typed clients
export const getInvoice = defineHttpOperation({
  route: { method: "GET", template: "/invoices/:invoiceId" },
  params: invoiceParams,
  response: invoiceResponse, // strict Zod strips unknown fields
});`,
      goodCopy:
        "You still get full end-to-end TypeScript safety in web and Node clients — plus strict runtime stripping of accidental DB fields and real OpenAPI 3.1 specs for mobile and external consumers.",
    },
    orm: {
      title: "ORM-Derived DTOs (createSelectSchema / Prisma Payloads)",
      rule: "Breaks: Similarity Is Not Ownership",
      badLabel: "What ORM-to-DTO helpers nudge you into",
      badCode: `// "Why write two schemas? They have the same fields today!"
export const userApiResponse = createSelectSchema(usersTable);

// 6 months later: someone adds password_hash or stripe_id to usersTable
// OR wants to split full_name into first_name + last_name
// -> instant data leak or breaking API change.`,
      badCopy:
        "Deriving wire schemas from table definitions is the purest violation of 'similarity is not ownership'. Every schema migration becomes a breaking API change, and every new internal column is one missed .omit() away from leaking on the wire.",
      goodLabel: "What Dads enforces instead",
      goodCode: `// Internal row types ARE derived from Drizzle (same owner: storage).
export type InvoiceRow = typeof invoicesTable.$inferSelect;

// Wire schemas are ALWAYS hand-written (different owner: external wire).
export const invoiceResponse = z.strictObject({
  id: invoiceId,
  amountMinor: z.number().int(),
});`,
      goodCopy:
        "Dads keeps internal row types derived (no fake boundary inside storage) while requiring hand-written strict Zod schemas at the wire edge — checked mechanically by dad doctor.",
    },
  };

  function markerFor(state) {
    if (state === "dirty") return "url(#flow-arrow-dirty)";
    if (state === "absorbed" || state === "blocked") return "url(#flow-arrow-absorbed)";
    return "url(#flow-arrow-neutral)";
  }

  function applyPanel(prefix, data) {
    for (const [key, [status, label]] of Object.entries(data.nodes)) {
      const el = document.querySelector(`[data-panel="${prefix}"][data-node="${key}"]`);
      if (!el) continue;
      el.dataset.status = status;
      const stateEl = el.querySelector(".fn-state");
      if (stateEl) stateEl.textContent = label;
    }
    for (const [edgeKey, state] of Object.entries(data.edges)) {
      const edge = document.querySelector(`[data-panel="${prefix}"][data-edge="${edgeKey}"]`);
      if (!edge) continue;
      edge.dataset.edgeState = state;
      edge.setAttribute("marker-end", markerFor(state));
    }
    if (prefix === "iep") {
      const wallLine = document.getElementById("iep-wall-line");
      const wallText = document.getElementById("iep-wall-text");
      if (wallLine) wallLine.dataset.wallActive = String(Boolean(data.wallActive));
      if (wallText && data.wallLabel) wallText.textContent = data.wallLabel;
    }
    const metricEls = document.querySelectorAll(`[data-metrics="${prefix}"] .sim-metric-val`);
    data.metrics.forEach((value, idx) => {
      if (metricEls[idx]) metricEls[idx].textContent = value;
    });
    const noteEl = document.querySelector(`[data-note="${prefix}"]`);
    if (noteEl) noteEl.textContent = data.note;
  }

  function selectScenario(id, announce) {
    const scenario = SCENARIOS[id];
    if (!scenario) return;
    for (const btn of document.querySelectorAll("[data-scenario]")) {
      btn.setAttribute("aria-pressed", String(btn.dataset.scenario === id));
    }
    applyPanel("coupled", scenario.coupled);
    applyPanel("iep", scenario.iep);
    if (announce) {
      const live = document.getElementById("sim-live-status");
      if (live) live.textContent = scenario.announcement;
    }
  }

  for (const btn of document.querySelectorAll("[data-scenario]")) {
    btn.addEventListener("click", () => selectScenario(btn.dataset.scenario, true));
  }
  selectScenario("db-column", false);

  function selectFramework(id, announce) {
    const fw = FRAMEWORKS[id];
    if (!fw) return;
    for (const btn of document.querySelectorAll("[data-framework]")) {
      btn.setAttribute("aria-pressed", String(btn.dataset.framework === id));
    }
    const set = (elId, text) => {
      const el = document.getElementById(elId);
      if (el) el.textContent = text;
    };
    set("fw-title", fw.title);
    set("fw-rule", fw.rule);
    set("fw-bad-label", fw.badLabel);
    set("fw-bad-code", fw.badCode);
    set("fw-bad-copy", fw.badCopy);
    set("fw-good-label", fw.goodLabel);
    set("fw-good-code", fw.goodCode);
    set("fw-good-copy", fw.goodCopy);
    if (announce) {
      const live = document.getElementById("fw-live-status");
      if (live) live.textContent = `${fw.title}: ${fw.rule}`;
    }
  }

  for (const btn of document.querySelectorAll("[data-framework]")) {
    btn.addEventListener("click", () => selectFramework(btn.dataset.framework, true));
  }
  selectFramework("nextjs", false);

  // Accordion expand/collapse all with native command event + click fallback
  const accordion = document.getElementById("iep-cases-accordion");
  const toggleBtn = document.getElementById("iep-toggle-all");
  if (accordion && toggleBtn) {
    const syncToggleButton = () => {
      const items = accordion.querySelectorAll(":scope > details");
      const allOpen = items.length > 0 && Array.prototype.every.call(items, (d) => d.open);
      toggleBtn.setAttribute("aria-expanded", String(allOpen));
    };

    const toggleAll = () => {
      const expand = toggleBtn.getAttribute("aria-expanded") !== "true";
      for (const details of accordion.querySelectorAll(":scope > details")) {
        details.open = expand;
      }
      syncToggleButton();
    };

    if (Object.hasOwn(HTMLButtonElement.prototype, "commandForElement")) {
      accordion.addEventListener(
        "command",
        (event) => {
          if (event.command === "--toggle-all") toggleAll();
        },
        { capture: true },
      );
    } else {
      toggleBtn.addEventListener("click", toggleAll);
    }

    accordion.addEventListener(
      "toggle",
      (event) => {
        if (event.target instanceof HTMLDetailsElement && event.target.parentElement === accordion) {
          syncToggleButton();
        }
      },
      { capture: true },
    );
    syncToggleButton();
  }
})();
