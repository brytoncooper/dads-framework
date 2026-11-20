import type { Authorization, SubjectRef } from "@dads-framework/access/runtime";
import {
  access,
  entityHandle,
  type PermissionToken,
} from "@dads-framework/access";
import type { GetEffectiveFeatureState } from "@dads-framework/feature-flags";
import type { Identity, IdentityEmail } from "@dads-framework/identity";
import type { JobQueue } from "@dads-framework/job-queue-core";
import type { ObjectStorage } from "@dads-framework/object-storage-core";
import { defineService } from "@dads-framework/plugin";
import type { DrizzleHandle } from "@dads-framework/postgres";
import { createTenantAccess, type Tenants } from "@dads-framework/tenants";
import { z } from "zod";

export const accountEntity = entityHandle({
  wireName: "account",
  idSchema: z.string().min(1),
});

export const accountAccess = access(accountEntity, {
  roles: {},
  permissions: () => ({}),
});

export const tenantAccess = createTenantAccess(accountEntity);

type WriteTransaction = Parameters<
  Parameters<DrizzleHandle["transaction"]>[0]
>[0];

export type WriteWithPermission = <Result>(
  check: {
    readonly subject: SubjectRef;
    readonly permission: PermissionToken;
    readonly resourceId: string;
  },
  write: (
    transaction: WriteTransaction,
    authorization: Authorization,
  ) => Promise<Result>,
) => Promise<Result>;

export type StarterServices = {
  readonly db: DrizzleHandle;
  readonly authorization: Pick<Authorization, "check">;
  readonly files: ObjectStorage;
  readonly jobs: JobQueue;
  readonly writeWithPermission: WriteWithPermission;
  readonly identity: Identity;
  readonly invitationOrigin: string;
  readonly enqueueTenantInvitation: (
    email: string,
    token: string,
  ) => Promise<void>;
  readonly flags: GetEffectiveFeatureState;
  readonly tenants: Tenants;
};

export const starterServices =
  defineService("starter-services").ofType<StarterServices>();

export type StarterEmail =
  | IdentityEmail
  | {
      readonly kind: "tenant-invitation";
      readonly to: string;
      readonly url: string;
    };

export type EnqueueStarterEmail = (message: StarterEmail) => Promise<void>;
