# Why Dads Testing can run less than Nx

This is the practical difference: Nx normally selects at the project/task
boundary. Dads continues through the changed symbol and can remove downstream
tasks that depend on the project but do not use the changed behavior.

```mermaid
flowchart TB
    Change["Same change<br/><b>core/price.ts</b><br/>exported symbol <b>formatPrice</b> changed"]

    Change --> NX1
    Change --> D1

    subgraph NX["Nx — project-level affected fan-out"]
        direction TB
        NX1["The Core project changed"]
        NX2["Find projects that depend on Core"]
        NX3["Core · Checkout · Admin are affected"]
        NX4["RUN 3 TEST TASKS<br/><b>core:test · checkout:test · admin:test</b>"]
        NX1 --> NX2 --> NX3 --> NX4
    end

    subgraph DADS["Dads Testing — symbol-level impact proof"]
        direction TB
        D1["The formatPrice symbol changed"]
        D2["Checkout imports formatPrice"]
        D3["Admin imports a different Core symbol"]
        D4["RUN 2 TEST TASKS<br/><b>core:test · checkout:test</b>"]
        D5["SKIP admin:test<br/><b>proven unaffected</b>"]
        D1 --> D2 --> D4
        D1 --> D3 --> D5
    end

    NX4 --> Result
    D4 --> Result
    D5 --> Result

    Result["REALISTIC RESULT FOR THIS CHANGE<br/><b>Dads runs 2 test tasks instead of 3</b><br/>The saving comes from pruning an unrelated symbol path"]

    Uncertain["If Dads cannot prove a path is unrelated,<br/>it widens and runs the extra task.<br/><b>Fewer tests only when the skip is defensible.</b>"]
    Result --> Uncertain

    style NX fill:#332b1d,stroke:#e5a93d,color:#ffffff
    style DADS fill:#123b35,stroke:#65d6bd,color:#ffffff
    style NX4 fill:#5a3b16,stroke:#e5a93d,color:#ffffff
    style D4 fill:#0d594b,stroke:#65d6bd,color:#ffffff
    style D5 fill:#0d594b,stroke:#65d6bd,color:#ffffff
    style Result fill:#13243b,stroke:#ffffff,color:#ffffff
    style Uncertain fill:#1d2533,stroke:#8fa3bd,color:#ffffff
```

The gain is not result-cache reuse; Dads v1 always executes a selected task.
It runs less by making a narrower, inspectable selection before execution:

- Nx asks which tasks are affected through the configured project/task graph.
- Dads asks which task can actually observe the changed symbol.
- If that evidence is incomplete for an owned project, Dads widens through its
  declared dependency closure. Unowned uncertainty selects the complete
  workspace fallback. Neither path silently skips work.

The exact reduction depends on the repository. The generated-workspace proof
harness measures it against an emulated Nx closure, and an adopter's
plan-only shadow job measures it for that repository before Dads replaces an
existing gate.
