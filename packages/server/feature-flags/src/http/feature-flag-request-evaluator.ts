import type { SubjectRef } from "@dads-framework/access/runtime";
import type { FeatureFlagContext, GetEffectiveFeatureState } from "../index.js";
import type {
  FeatureStateRequestEvaluator,
  FeatureStateSnapshot,
} from "@dads-framework/http";

/**
 * The application's answer to "whose flags does this request see?". Return a
 * tenant context for a request acting inside a tenant, `platform` for one
 * that is not, and null to give the request no feature state at all.
 */
export type FeatureFlagContextResolver = (input: {
  readonly authenticatedSubject: SubjectRef;
  readonly subject: SubjectRef;
  /** The request's context header, as the HTTP kit's protocol names it. */
  readonly context: string | undefined;
}) => FeatureFlagContext | null;

/**
 * The HTTP kit's per-request evaluator: resolves the request's context with
 * the application's resolver, then evaluates it once for the whole request.
 */
export class FeatureFlagRequestEvaluator implements FeatureStateRequestEvaluator {
  constructor(
    private readonly effective: GetEffectiveFeatureState,
    private readonly resolveContext: FeatureFlagContextResolver,
  ) {}

  async evaluate(input: {
    readonly authenticatedSubject: SubjectRef;
    readonly subject: SubjectRef;
    readonly context: string | undefined;
  }): Promise<FeatureStateSnapshot | null> {
    const context = this.resolveContext(input);
    if (context === null) return null;
    const state = await this.effective.execute(context);
    return { features: [...state.features], stateHash: state.stateHash };
  }
}
