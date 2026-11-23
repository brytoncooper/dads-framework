import type { StarterProjectFile } from "./render-starter-project.js";

/** Minimal workspace switcher view, controls, and Vite build configuration. */
export function renderMinimalWorkbenchFiles(): readonly StarterProjectFile[] {
  return [workbenchViewFile(), workspaceControlsFile(), viteConfigFile()];
}

function workbenchViewFile(): StarterProjectFile {
  return {
    path: "apps/web/workbench.tsx",
    content: `import { Button, Card, CardContent } from "@dads-framework/ui/elements";
import { Input, Label } from "@dads-framework/ui/forms";
import { useEffect, useState } from "react";
import {
  inviteToTenant,
  listTenants,
  type Tenant,
} from "../../domains/tenants/web-client/index.js";
import { describeFailure, field, useAction } from "./actions.js";
import {
  useWorkbenchCopy,
  type WorkbenchCopyKey,
} from "./copy/workbench-copy.js";
import { AcceptInvitation, WorkspacePicker } from "./workspace-controls.js";

type WorkbenchProps = {
  readonly invitation: string | null;
  readonly onJoined: () => void;
};

export function Workbench({ invitation, onJoined }: WorkbenchProps) {
  const t = useWorkbenchCopy();
  const [tenants, setTenants] = useState<Tenant[]>();
  const [selected, setSelected] = useState<Tenant["id"]>();
  const [loadError, setLoadError] = useState<WorkbenchCopyKey>();
  const [reload, setReload] = useState(0);
  const tenant =
    tenants?.find((entry) => entry.id === selected) ?? tenants?.[0];

  useEffect(() => {
    const controller = new AbortController();
    void listTenants(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setTenants(value);
      },
      (fault: unknown) => {
        if (!controller.signal.aborted) setLoadError(describeFailure(fault));
      },
    );
    return () => {
      controller.abort();
    };
  }, [reload]);

  function refresh() {
    setLoadError(undefined);
    setReload((previous) => previous + 1);
  }

  return (
    <div className="workspace-layout">
      <aside
        className="workspace-sidebar"
        aria-label={t("workbench.tenant.controls")}
      >
        {invitation && (
          <AcceptInvitation
            token={invitation}
            onAccepted={(id) => {
              onJoined();
              setSelected(id);
              refresh();
            }}
          />
        )}
        <WorkspacePicker
          tenants={tenants}
          selected={tenant?.id}
          loadError={loadError}
          onRetry={refresh}
          onSelect={setSelected}
          onCreated={(created) => {
            setTenants((previous) => [...(previous ?? []), created]);
            setSelected(created.id);
            refresh();
          }}
        />
      </aside>
      {tenant ? (
        <div className="workspace-content">
          <Card>
            <CardContent>
              <h2>{tenant.name}</h2>
              <p>{t("workbench.tenant.readyBody")}</p>
            </CardContent>
          </Card>
          <InviteMember key={tenant.id} tenantId={tenant.id} />
        </div>
      ) : (
        <Card className="empty-workspace">
          <CardContent>
            <h2>{t("workbench.tenant.emptyTitle")}</h2>
            <p>{t("workbench.tenant.emptyBody")}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function InviteMember({ tenantId }: { readonly tenantId: Tenant["id"] }) {
  const t = useWorkbenchCopy();
  const action = useAction();
  const [sent, setSent] = useState(false);

  return (
    <details className="invite">
      <summary>{t("workbench.invite.open")}</summary>
      <form
        className="fields"
        onSubmit={(event) => {
          const element = event.currentTarget;
          setSent(false);
          action.submit(event, async (form) => {
            await inviteToTenant(tenantId, field(form, "email"));
            element.reset();
            setSent(true);
          });
        }}
      >
        <div className="field">
          <Label htmlFor="invite-email">{t("workbench.invite.email")}</Label>
          <Input id="invite-email" name="email" type="email" required />
        </div>
        {sent && (
          <p role="status" className="message">
            {t("workbench.invite.sent")}
          </p>
        )}
        {action.error && (
          <p role="alert" className="error">
            {t(action.error)}
          </p>
        )}
        <Button variant="outline" disabled={action.pending}>
          {t("workbench.invite.send")}
        </Button>
      </form>
    </details>
  );
}
`,
  };
}

function workspaceControlsFile(): StarterProjectFile {
  return {
    path: "apps/web/workspace-controls.tsx",
    content: `import { Button, Card, CardContent } from "@dads-framework/ui/elements";
import { Input, Label } from "@dads-framework/ui/forms";
import {
  acceptTenantInvitation,
  createTenant,
  type Tenant,
} from "../../domains/tenants/web-client/index.js";
import { field, useAction } from "./actions.js";
import {
  useWorkbenchCopy,
  type WorkbenchCopyKey,
} from "./copy/workbench-copy.js";

type AcceptInvitationProps = {
  readonly token: string;
  readonly onAccepted: (tenantId: Tenant["id"]) => void;
};

export function AcceptInvitation({ token, onAccepted }: AcceptInvitationProps) {
  const t = useWorkbenchCopy();
  const action = useAction();
  return (
    <Card>
      <CardContent>
        <h2>{t("workbench.invite.title")}</h2>
        <Button
          disabled={action.pending}
          onClick={() =>
            void action.run(async () => {
              const joined = await acceptTenantInvitation(token);
              onAccepted(joined.tenantId);
            })
          }
        >
          {t("workbench.invite.accept")}
        </Button>
        {action.error && (
          <p role="alert" className="error">
            {t(action.error)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

type WorkspacePickerProps = {
  readonly tenants: readonly Tenant[] | undefined;
  readonly selected: Tenant["id"] | undefined;
  readonly loadError: WorkbenchCopyKey | undefined;
  readonly onSelect: (id: Tenant["id"]) => void;
  readonly onCreated: (value: Tenant) => void;
  readonly onRetry: () => void;
};

export function WorkspacePicker({
  tenants,
  selected,
  loadError,
  onSelect,
  onCreated,
  onRetry,
}: WorkspacePickerProps) {
  const t = useWorkbenchCopy();
  const create = useAction();
  return (
    <Card>
      <CardContent>
        <h2>{t("workbench.tenant.title")}</h2>
        {loadError && (
          <p className="error" role="alert">
            {t(loadError)}{" "}
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t("workbench.retry")}
            </Button>
          </p>
        )}
        {tenants === undefined && loadError === undefined && (
          <p role="status">{t("workbench.tenant.loading")}</p>
        )}
        {tenants && tenants.length > 0 && (
          <div className="field">
            <Label htmlFor="workspace">{t("workbench.tenant.active")}</Label>
            <select
              id="workspace"
              value={selected ?? ""}
              onChange={(event) => {
                onSelect(event.currentTarget.value);
              }}
            >
              {tenants.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <form
          className="fields workspace-create"
          onSubmit={(event) => {
            const element = event.currentTarget;
            create.submit(event, async (form) => {
              const created = await createTenant(field(form, "name"));
              element.reset();
              onCreated(created);
            });
          }}
        >
          <div className="field">
            <Label htmlFor="workspace-name">{t("workbench.tenant.name")}</Label>
            <Input id="workspace-name" name="name" maxLength={120} required />
          </div>
          {create.error && (
            <p role="alert" className="error">
              {t(create.error)}
            </p>
          )}
          <Button variant="outline" disabled={create.pending}>
            {t("workbench.tenant.create")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
`,
  };
}

function viteConfigFile(): StarterProjectFile {
  return {
    path: "vite.config.ts",
    content: `import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, posix, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const apiTarget = process.env["DADS_DEV_API_URL"] ?? "http://127.0.0.1:3000";

async function installedNotices() {
  const require = createRequire(import.meta.url);
  const styles = require.resolve("@dads-framework/ui/styles/fonts.css");
  const resolveFromStyles = createRequire(styles);
  const fonts = ["ibm-plex-sans", "ibm-plex-mono"].map((font) => ({
    fileName: \`licenses/\${font}.txt\`,
    source: join(
      dirname(resolveFromStyles.resolve(\`@fontsource/\${font}\`)),
      "LICENSE",
    ),
  }));
  const ui = resolve(
    dirname(require.resolve("@dads-framework/ui/elements")),
    "../..",
  );
  const uiLicenses = await readdir(join(ui, "third-party-licenses"));
  const uiNotices = [
    "THIRD_PARTY_NOTICES.md",
    ...uiLicenses.map((name) => posix.join("third-party-licenses", name)),
  ];
  return [
    ...fonts,
    ...uiNotices.map((name) => ({
      fileName: \`licenses/dads-ui/\${name}\`,
      source: join(ui, name),
    })),
  ];
}

// The browser build redistributes font binaries and adapted UI source notices.
function bundledAssetLicenses(): Plugin {
  return {
    name: "workbench-asset-licenses",
    apply: "build",
    async generateBundle() {
      for (const notice of await installedNotices()) {
        this.emitFile({
          type: "asset",
          fileName: notice.fileName,
          source: await readFile(notice.source),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), bundledAssetLicenses()],
  build: {
    license: { fileName: "THIRD_PARTY_LICENSES.md" },
    rolldownOptions: {
      input: { workbench: "index.html" },
      onwarn(warning, warn) {
        if (
          warning.code === "MODULE_LEVEL_DIRECTIVE" &&
          warning.message.includes("use client")
        ) {
          return;
        }
        warn(warning);
      },
    },
  },
  server: {
    strictPort: true,
    fs: {
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem,key,p12,pfx,cer,der}",
        ".npmrc",
        ".yarnrc.yml",
        "**/.git/**",
        "**/.dads/**",
      ],
    },
    proxy: { "/api": { target: apiTarget } },
  },
  preview: {
    proxy: { "/api": { target: apiTarget } },
  },
});
`,
  };
}
