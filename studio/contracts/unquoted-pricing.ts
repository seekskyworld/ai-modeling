/** Only these reviewed webpage operations may explicitly proceed without an advance quote. */
import { z } from 'zod';
import { TripoError } from './errors.ts';
import type { Quote } from './types.ts';

export const unquotedOperations = ['import_model', 'modification', 'retexture_apply'] as const;
export type UnquotedOperation = (typeof unquotedOperations)[number];
export function isUnquotedOperation(operation: string): operation is UnquotedOperation {
  return (unquotedOperations as readonly string[]).includes(operation);
}
export const unquotedCostConsent = z
  .literal(true)
  .optional()
  .describe(
    'Explicitly accept Studio billing without an advance quote, only when the current reviewed snapshot permits this operation. Omit max_estimated_credits; this is not a zero-credit estimate or a spending cap.',
  );

export function assertCurrentUnquotedQuote(quote: Quote): void {
  const now = Date.now();
  if (
    quote.variable !== true ||
    quote.known !== false ||
    quote.credits !== undefined ||
    !Number.isFinite(Date.parse(quote.observed_at)) ||
    Date.parse(quote.observed_at) > now ||
    !Number.isFinite(Date.parse(quote.expires_at)) ||
    Date.parse(quote.expires_at) <= now
  )
    throw new TripoError(
      'PRICE_UNKNOWN',
      'No current reviewed authorization to submit this operation without an advance quote. Refresh pricing evidence before submitting.',
      'not_submitted',
    );
}

export function acceptsUnquotedBudget(
  operation: string,
  input: Record<string, unknown>,
  quote: Quote,
  maximum: number | undefined,
): boolean {
  if (!isUnquotedOperation(operation) || (quote.known && quote.credits !== undefined)) return false;
  if (input.accept_variable_cost !== true || quote.variable !== true)
    throw new TripoError('PRICE_UNKNOWN', quote.explanation, 'not_submitted');
  assertCurrentUnquotedQuote(quote);
  if (maximum !== undefined)
    throw new TripoError(
      'UNQUOTED_BUDGET_UNSUPPORTED',
      'A numeric max_estimated_credits cannot constrain an operation without an advance quote. Omit it only when explicitly accepting the unknown Studio charge.',
      'not_submitted',
    );
  return true;
}
