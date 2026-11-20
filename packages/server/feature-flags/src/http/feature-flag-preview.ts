import type { SubjectRef } from "@dads-framework/access/runtime";
import type {
  FeatureFlagContext,
  FeatureFlagDefinition,
  FeatureFlagPreviewReader,
} from "../index.js";
import {
  currentFeatureStatePreview,
  type FeatureStatePreviewResolver,
} from "@dads-framework/http";

import type { FeatureFlagContextResolver } from "./feature-flag-request-evaluator.js";

export type FeatureFlagPreviewRecord = {
  readonly owner: SubjectRef;
  readonly context: FeatureFlagContext;
  readonly feature: string;
  readonly active: boolean;
  readonly allowsWrites: boolean;
  readonly expiresAt: Date;
};

export type FeatureFlagPreviewResolverOptions = {
  readonly definitions: readonly FeatureFlagDefinition[];
  readonly resolveContext: FeatureFlagContextResolver;
  readonly findPreview: (
    previewId: string,
  ) => Promise<FeatureFlagPreviewRecord | null>;
  readonly canPreview: (input: {
    readonly subject: SubjectRef;
    readonly context: FeatureFlagContext;
    readonly feature: string;
  }) => Promise<boolean>;
  readonly now?: () => Date;
};

function scopeKey(context: FeatureFlagContext): string {
  return context.kind === "platform"
    ? "platform"
    : `tenant:${context.tenantId}`;
}

function sameSubject(left: SubjectRef, right: SubjectRef): boolean {
  return (
    left.type === right.type &&
    left.id === right.id &&
    left.relation === right.relation
  );
}

function matchesPreview(
  preview: FeatureFlagPreviewRecord,
  subject: SubjectRef,
  key: string,
  definedSlugs: ReadonlySet<string>,
): boolean {
  return (
    sameSubject(preview.owner, subject) &&
    scopeKey(preview.context) === key &&
    definedSlugs.has(preview.feature)
  );
}

/** Resolves only live, authorized records owned by the caller in their current context. */
export function createFeatureFlagPreviewResolver(
  options: FeatureFlagPreviewResolverOptions,
): FeatureStatePreviewResolver {
  const slugs = new Set(options.definitions.map(({ slug }) => slug));
  const now = options.now ?? (() => new Date());
  return {
    async resolve({ previewId, authenticatedSubject, subject, context }) {
      if (subject === null || !sameSubject(subject, authenticatedSubject))
        return null;
      const resolvedContext = options.resolveContext({
        authenticatedSubject,
        subject,
        context,
      });
      if (resolvedContext === null) return null;
      const preview = await options.findPreview(previewId);
      const key = scopeKey(resolvedContext);
      if (
        preview === null ||
        !matchesPreview(preview, authenticatedSubject, key, slugs)
      ) {
        return null;
      }
      const authorized = await options.canPreview({
        subject: authenticatedSubject,
        context: resolvedContext,
        feature: preview.feature,
      });
      if (!authorized || !(preview.expiresAt > now())) return null;
      return {
        feature: preview.feature,
        active: preview.active,
        allowsWrites: preview.allowsWrites,
        scopeKey: key,
      };
    },
  };
}

/** Reads the authorized request override when evaluating the same context. */
export const readFeatureFlagPreview: FeatureFlagPreviewReader = (context) => {
  const preview = currentFeatureStatePreview();
  return preview?.scopeKey === scopeKey(context) ? preview : undefined;
};
