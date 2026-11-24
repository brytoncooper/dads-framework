/* global document, HTMLButtonElement, HTMLDetailsElement */
(() => {
  const SCENARIOS = {
    "db-column": {
      announcement:
        "Scenario: rename database column. Coupled graph dirties 5 modules and runs 480 tests. Independent Evolution stops at billing/store.ts and runs 3 tests.",
      coupled: {
        nodes: {
          db: ["origin", "column renamed"],
          dto: ["dirty", "row leaked"],
          web: ["dirty", "type breaks"],
          mobile: ["dirty", "older app breaks"],
          shipping: ["dirty", "reads raw row"],
          vendor: ["clean", "untouched"],
        },
        metrics: ["5 / 6 modules", "480 tests", "Mobile breaks"],
        note: "Because the database table is shared as the API DTO, renaming one internal column forces coordinated changes across web, mobile, and shipping.",
      },
      iep: {
        nodes: {
          db: ["origin", "column renamed"],
          store: ["absorbed", "mapped once"],
          wire: ["clean", "stable contract"],
          web: ["clean", "untouched"],
          shipping: ["clean", "port unchanged"],
          vendor: ["clean", "untouched"],
        },
        metrics: ["1 / 6 modules", "3 tests (99% skipped)", "Zero client impact"],
        note: "The persistence boundary absorbs the rename inside billing/store.ts. The hand-written wire contract never changes, so web, mobile, and shipping stay untouched.",
      },
    },
    "vendor-swap": {
      announcement:
        "Scenario: swap payment vendor. Coupled graph dirties 5 modules and 14 routes. Independent Evolution isolates the swap to one integration adapter.",
      coupled: {
        nodes: {
          db: ["dirty", "vendor IDs leaked"],
          dto: ["dirty", "SDK types exposed"],
          web: ["dirty", "error codes break"],
          mobile: ["dirty", "webhook shape"],
          shipping: ["dirty", "imports SDK"],
          vendor: ["origin", "Stripe -> Adyen"],
        },
        metrics: ["5 / 6 modules", "340 tests", "14 routes edited"],
        note: "Foreign SDK types and error codes bled into routes and sibling domains. Replacing one vendor turns into an application-wide rewrite.",
      },
      iep: {
        nodes: {
          db: ["clean", "app-owned IDs"],
          store: ["clean", "untouched"],
          wire: ["clean", "stable contract"],
          web: ["clean", "untouched"],
          shipping: ["clean", "untouched"],
          vendor: ["absorbed", "1 adapter swapped"],
        },
        metrics: ["1 / 6 modules", "1 conformance suite", "0 domain edits"],
        note: "Stripe lived behind one app-owned Payments capability in integrations/. Swapping to Adyen touches one adapter and runs the same conformance suite.",
      },
    },
    "mobile-field": {
      announcement:
        "Scenario: mobile adds offline draft field. Coupled graph forces DB and web changes. Independent Evolution isolates the change to the wire contract.",
      coupled: {
        nodes: {
          db: ["dirty", "forced column"],
          dto: ["origin", "shared DTO edited"],
          web: ["dirty", "rebuilds & breaks"],
          mobile: ["origin", "needs draft state"],
          shipping: ["dirty", "shared model"],
          vendor: ["clean", "untouched"],
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
        metrics: ["1 / 6 modules", "4 contract tests", "Independent deploys"],
        note: "Each client consumes an explicit, versionable wire contract. Mobile adds what it needs without dragging web or shipping into the release.",
      },
    },
    "pure-helper": {
      announcement:
        "Scenario: refactor billing tax helper. Coupled graph triggers 310 unrelated tests. Independent Evolution keeps the change inside billing pure logic and dad-test runs 2 files.",
      coupled: {
        nodes: {
          db: ["clean", "untouched"],
          dto: ["dirty", "barrel re-export"],
          web: ["dirty", "imports barrel"],
          mobile: ["dirty", "imports barrel"],
          shipping: ["origin", "internal import"],
          vendor: ["clean", "untouched"],
        },
        metrics: ["4 / 6 modules", "310 tests", "Cross-domain leak"],
        note: "Shipping reached directly into billing's internal helper, and web imported a giant shared barrel. One private refactor lights up half the repo's CI.",
      },
      iep: {
        nodes: {
          db: ["clean", "untouched"],
          store: ["origin", "billing/pure edit"],
          wire: ["clean", "unchanged"],
          web: ["clean", "untouched"],
          shipping: ["clean", "consumer port"],
          vendor: ["clean", "untouched"],
        },
        metrics: ["1 / 6 modules", "2 tests (98% skipped)", "Local refactor"],
        note: "Because domains cannot cross private files, the dependency graph matches real ownership. dad-test proves 98% of tests are unaffected and runs 2 files.",
      },
    },
  };

  function applyPanel(prefix, data) {
    for (const [key, [status, label]] of Object.entries(data.nodes)) {
      const el = document.querySelector(`[data-panel="${prefix}"][data-node="${key}"]`);
      if (!el) continue;
      el.dataset.status = status;
      const stateEl = el.querySelector(".sim-node-state");
      if (stateEl) stateEl.textContent = label;
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
