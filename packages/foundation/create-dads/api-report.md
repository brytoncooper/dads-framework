# API report: create-dads

Published: no

Regenerate with `npm run api-report`.

Entry point: create-dads

```
- type CreateDadsDependencies: export type CreateDadsDependencies = { readonly installDependencies: (projectRoot: string) => Promise<void>; readonly startDevelopment?: (projectRoot: string) => Promise<DadsDevelopmentUrls>; /** * Where the doctor's report is written, before anything is created. A caller * that only wants the report as data leaves it out and reads `doctor` on the * result instead. */ readonly write?: (text: string) => void; };
- type DadsDevelopment: export type DadsDevelopment = ({ readonly status: "started"; } & DadsDevelopmentUrls) | { readonly status: "deferred"; readonly reason: string; } | { readonly status: "skipped"; };
- type DadsDevelopmentUrls: export type DadsDevelopmentUrls = { readonly webUrl: string; readonly apiUrl: string; readonly staffUrl: string; };
- type DadsProjectCreation: export type DadsProjectCreation = { readonly initialization: DadsProjectInitialization; readonly installed: boolean; readonly development: DadsDevelopment; /** * What the doctor read over the existing project before anything changed, or * `null` when there was no project to read and when `--skip-doctor` said not * to look. */ readonly doctor: DoctorReport | null; };
- function createDads: export declare function createDads(argumentsAfterExecutable: readonly string[], dependencies: CreateDadsDependencies): Promise<DadsProjectCreation>;
```
