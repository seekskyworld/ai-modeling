/** New billing consent may authorize untouched legacy steps without rewriting their frozen business intent. */
import type { Plan } from './planning.ts';
import type { Application } from './runtime.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { isUnquotedOperation } from '../../studio/contracts/unquoted-pricing.ts';
import { fingerprint } from '../core/fingerprint.ts';
import {
  affineChildRequest,
  affineContext,
  affineGroupRequest,
  affineInputKey,
  affineIntentKey,
} from '../core/smartsegment-affine-policy.ts';
import { scaleIntentKey } from '../core/smartsegment-scale-policy.ts';

const layout = (plan: Plan) =>
  fingerprint(
    plan.steps.map(({ name, operation, parameters, source }) => ({ name, operation, parameters, source })),
  );
export const affineBillingConsentKey = (request: string): string => `smartsegment-affine-billing:${request}`;

export function legacyAffineBillingPlan(
  restored: Plan,
  supplied: Plan,
  saved: Record<string, unknown>,
): Plan {
  if (
    !supplied.legacyAffineUnquotedConsent &&
    !supplied.steps.some(
      (step) => isUnquotedOperation(step.operation) && step.parameters.accept_variable_cost === true,
    )
  )
    return restored;
  const original = {
    ...restored,
    steps: restored.steps.map((step) => {
      if (!isUnquotedOperation(step.operation)) return step;
      const parameters = { ...step.parameters };
      delete parameters.accept_variable_cost;
      return { ...step, parameters };
    }),
  };
  // Only restore an exact saved layout; unrelated source/options still reach the existing identity guards.
  return { ...(layout(original) === saved.layout ? original : restored), legacyAffineUnquotedConsent: true };
}

function frozenConsent(): never {
  throw new TripoError(
    'UNQUOTED_CONSENT_FROZEN',
    'This original affine step was already prepared without unquoted billing consent. Its immutable input cannot acquire consent now. Keep the same receipt and recover only when a valid numeric quote is available; do not replace or resubmit the request.',
    'not_submitted',
  );
}

export function affineBillingParameters(
  app: Application,
  plan: Plan,
  parent: string,
  index: number,
  parameters: Record<string, unknown>,
  freeze = false,
): Record<string, unknown> {
  const operation = plan.steps[index]!.operation;
  if (
    !plan.legacyAffineUnquotedConsent ||
    !isUnquotedOperation(operation) ||
    parameters.accept_variable_cost === true
  )
    return parameters;
  const jobs = app.service.jobs,
    account = app.service.accountRef(),
    request = affineChildRequest(parent, index);
  const existing = jobs.find(account, request);
  if (existing) {
    if (existing.input.accept_variable_cost === true) return { ...parameters, accept_variable_cost: true };
    if (existing.state === 'prepared') return frozenConsent();
    return parameters;
  }
  const key = affineBillingConsentKey(request),
    saved = jobs.requestPolicy(account, key);
  const consent = {
    version: 1,
    operation,
    parent_intent: fingerprint(jobs.requestPolicy(account, affineIntentKey(parent))),
    accept_variable_cost: true,
  };
  if (saved && fingerprint(saved) !== fingerprint(consent))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'The original affine billing consent belongs to another frozen intent.',
      'not_submitted',
    );
  if (
    !saved &&
    (jobs.requestPolicy(account, affineInputKey(request)) ||
      (index === 0 && jobs.requestPolicy(account, scaleIntentKey(affineGroupRequest(parent, 'first')))))
  )
    return frozenConsent();
  if (freeze) {
    affineContext(jobs, account, parent);
    jobs.bindRequestPolicy(account, key, consent);
  }
  return { ...parameters, accept_variable_cost: true };
}
