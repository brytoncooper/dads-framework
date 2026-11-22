import type { Authorization, SubjectRef } from "@dads-framework/access/runtime";
import { actor, type PermissionToken } from "@dads-framework/access";
import type { GetEffectiveFeatureState } from "@dads-framework/feature-flags";
import type {
  Identity,
  IdentityEmail,
  IdentitySession,
} from "@dads-framework/identity";
import type { JobQueue } from "@dads-framework/job-queue/core";
import type { ObjectStorage } from "@dads-framework/object-storage/core";
import { defineService } from "@dads-framework/plugin";
import type { DrizzleHandle } from "@dads-framework/postgres";
import {
  createTenantAccess,
  type TenantId,
  type Tenants,
} from "@dads-framework/tenants";

export const account = actor("account");
export const accountAccess = account;
export const tenantAccess = createTenantAccess(account);

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
  readonly readTenantSessionPolicy?: (headers: Headers) => Promise<{
    readonly session: IdentitySession;
    readonly allowsTenant: (tenantId: TenantId) => boolean;
  } | null>;
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
