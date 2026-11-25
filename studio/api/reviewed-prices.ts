/** Reviewed public price feed; source and packaged runtime use the same snapshot. */
import snapshot from './reviewed-prices.json' with { type: 'json' };
import { priceSchema } from './pricing.ts';

export const reviewedPrices = priceSchema.parse(snapshot);
