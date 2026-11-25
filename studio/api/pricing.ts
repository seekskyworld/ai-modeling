/** 价格仅采用有来源和有效期的已审阅快照；未知或过期时阻止付费提交。 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Operation, Quote } from '../contracts/types.ts';
import { text, object, array } from '../contracts/errors.ts';
import { variableCanvasOperations } from '../contracts/canvas-agent.ts';
import { isUnquotedOperation, unquotedOperations } from '../contracts/unquoted-pricing.ts';
export const priceSchema = z
  .object({
    reviewed_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    source: z.string().min(1),
    credits: z.record(z.string(), z.number().nonnegative()),
    evidence: z.array(z.object({ url: z.url(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).default([]),
    unquoted_operations: z
      .array(z.enum(unquotedOperations))
      .max(unquotedOperations.length)
      .refine((values) => new Set(values).size === values.length, 'Unquoted operations must be unique.')
      .optional(),
  })
  .strict()
  .refine(
    (value) => !value.unquoted_operations?.some((operation) => unquotedPriceKey[operation] in value.credits),
    'An operation cannot have both a numeric price and an unquoted declaration.',
  );
const unquotedPriceKey = {
  import_model: 'ImportOwnModel',
  modification: 'SaveSegmentation',
  retexture_apply: 'ApplyTextureBasic',
} as const;
export type PriceSnapshot = z.infer<typeof priceSchema>;
export interface Pricing {
  quote(operation: Operation, input: Record<string, unknown>): Promise<Quote>;
}
const imageKeys: Record<string, string> = {
  'flux.1_kontext_pro': 'FLUX_1_pro',
  gpt_4o: 'GPT_4o',
  gpt_image_2: 'GPT_image_2',
  'gpt_image_2.5_sunburst': 'GPT_image_2_5',
  midjourney: 'Midjourney',
  'gemini_2.5_flash_image_preview': 'NanoBanana',
  'gemini_3.1_flash_image_preview': 'NanoBanana_2',
  gemini_3_pro_image_preview: 'NanoBanana_pro',
};
function modelKeys(input: Record<string, unknown>): string[] {
  const base =
    input.model_version === 'Nexus-v2.0-20260801'
      ? 'GenerateBaseNexusV2'
      : input.model_version === 'Nexus-v1.0-20260214'
        ? 'GenerateBaseNexus'
        : input.texture
          ? 'GenerateWithTexture'
          : 'GenerateBase';
  const keys = [base];
  if (input.smart_poly) keys.push('GenerateSmartPoly');
  if (input.generate_parts) keys.push('GenerateGenerateParts');
  // 当前网页 P2 公式固定为 GenerateBaseNexusV2；只有 P1/HD 再加四边面价格。
  if (input.quad && input.model_version !== 'Nexus-v2.0-20260801') keys.push('GenerateQuad');
  if (input.model_version === 'v3.1-20260211' && input.geometry_quality === 'detailed')
    keys.push('GenerateGeometryQualityDetailed');
  if (input.texture && input.pbr) keys.push('PBR');
  if (input.texture && input.texture_quality === 'detailed') keys.push('GenerateTextureQualityDetailed');
  if (input.texture && input.texture_quality === 'ultra') keys.push('GenerateTextureQualityExtreme');
  return keys;
}
function textureKeys(input: Record<string, unknown>): string[] {
  if (input.action === 'pbr') return ['PBR'];
  if (input.action === 'upscale') return [input.texture_quality === 'ultra' ? 'UpscalerExtreme' : 'Upscaler'];
  const keys = ['TextureGeneration'];
  if (input.texture_quality === 'detailed') keys.push('TextureQualityDetailed');
  if (input.texture_quality === 'ultra') keys.push('TextureQualityExtreme');
  if (input.style_image_path || input.style_image_asset || input.style_preset || input.style_image)
    keys.push('TextureStyle');
  return keys;
}
/** 高级操作价格按当前网页按钮公式取折扣前金额；未核对的图片操作仍拒绝提交。 */
function extraKeys(operation: Operation, input: Record<string, unknown>): string[] {
  if (operation === 'export' || operation === 'export_lite')
    return [input.public_model ? 'Export' : 'ExportOwnProject'];
  const fixed: Partial<Record<Operation, string>> = {
    rig: 'Rigging',
    animate: 'Retarget',
    export: 'ExportOwnProject',
    segment: 'Segmentation',
    resegment: 'Segmentation',
    local_edit: 'EditMesh',
    motion: 'Motion',
    copy: 'ProjectCopy',
    retexture: 'MagicBrush',
    import_model: 'ImportOwnModel',
    // 旧快照将 ApplyRetexture 误记为 0；更换证据键使旧文件不能继续给出免费报价。
    retexture_apply: 'ApplyTextureBasic',
    modification: 'SaveSegmentation',
    retry: 'FreeRetry',
  };
  if (fixed[operation]) return [fixed[operation]!];
  if (operation === 'remesh')
    return [
      input.quad ? 'Retopology_Quad' : 'Retopology_Triangle',
      ...(input.smart_poly ? ['Retopology_SmartPoly'] : []),
    ];
  if (operation === 'complete') return [input.completion_mode === 'quick_cap' ? 'QuickCap' : 'AICompletion'];
  if (operation === 'uv_generate') return [input.action === 'retry' ? 'UvEditRetry' : 'UvEditGenerate'];
  if (operation === 'image_process') return imageProcessKeys(input);
  return ['UnreviewedOperation'];
}
function imageProcessKeys(input: Record<string, unknown>): string[] {
  if (input.action === 'multiview') return ['ImageMultiview'];
  if (input.action === 'split') return ['ImageSplit'];
  if (input.action === 'upscale') return ['ImageUpscale4K'];
  if (input.action === 'regenerate_multiview' && object(input._image_source).kind === 'multiview')
    return ['ImageMultiview'];
  if (['regenerate', 'regenerate_multiview'].includes(text(input.action))) {
    const original = object(input._image_source);
    return [
      imageKeys[text(original.model_version)] ?? 'UnreviewedImage',
      ...(original.resolution === '4K' ? ['ImageUpscale4K'] : []),
    ];
  }
  return ['UnreviewedImageProcess'];
}
function submissionCount(operation: Operation, input: Record<string, unknown>): number {
  if (operation === 'image') return Number(input.amount);
  if (operation === 'image_process' && text(input.action).startsWith('regenerate'))
    return Number(object(input._image_source).amount);
  if (operation !== 'model') return 1;
  return input.mode === 'batch'
    ? array(input.image_paths ?? input.image_assets ?? input.image_sources).length
    : Math.max(1, array(input.variations).length);
}
function metadataQuote(operation: Operation): Quote {
  return {
    known: true,
    credits: 0,
    hard_limit: false,
    source:
      operation === 'project_edit'
        ? 'Studio metadata save (no generation)'
        : 'Studio UV candidate application (generation separately billed)',
    observed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    explanation: 'Apply existing model data without generating a new model.',
  };
}
function invalidReviewExplanation(snapshot: PriceSnapshot, now: Date): string {
  // 说清是过期还是未来日期，以及怎么恢复；不自动延期，也不放行提交。
  return Date.parse(snapshot.reviewed_at) > now.getTime()
    ? `Pricing review is dated in the future (reviewed_at ${snapshot.reviewed_at}). Check the system clock, then run "ai-modeling pricing status".`
    : `Pricing review expired at ${snapshot.expires_at}. Run "ai-modeling pricing status", then install a newer reviewed snapshot with "ai-modeling pricing update" from the latest Release notes.`;
}
function unquotedQuote(snapshot: PriceSnapshot, operation: Operation, base: Quote): Quote | undefined {
  if (
    !isUnquotedOperation(operation) ||
    !snapshot.unquoted_operations?.includes(operation) ||
    snapshot.evidence.length === 0
  )
    return undefined;
  return {
    ...base,
    variable: true,
    source: snapshot.source,
    expires_at: new Date(Math.min(Date.parse(snapshot.expires_at), Date.now() + 300000)).toISOString(),
    explanation:
      'The current reviewed Studio webpage submits this operation without an advance price. Explicit accept_variable_cost=true is required, and max_estimated_credits must be omitted. The actual charge is unknown; this is not free or a spending cap.',
  };
}
function reviewedOperationQuote(
  snapshot: PriceSnapshot,
  operation: Operation,
  base: Quote,
  now: Date,
): Quote | undefined {
  if (Date.parse(snapshot.expires_at) <= now.getTime() || Date.parse(snapshot.reviewed_at) > now.getTime())
    return {
      ...base,
      source: snapshot.source,
      explanation: invalidReviewExplanation(snapshot, now),
    };
  return unquotedQuote(snapshot, operation, base);
}
export class PricingService implements Pricing {
  private file: string;
  private fallback?: PriceSnapshot;
  constructor(file: string, fallback?: PriceSnapshot) {
    this.file = file;
    this.fallback = fallback;
  }
  private async batchQuote(input: Record<string, unknown>): Promise<Quote> {
    const single = await this.quote('export', { public_model: false });
    return {
      ...single,
      credits: single.credits === undefined ? undefined : single.credits * array(input.projects).length,
      explanation:
        'Native Studio batch export of owned projects; individual receipts and actual charges remain authoritative.',
    };
  }
  private async canvasQuote(input: Record<string, unknown>): Promise<Quote> {
    const rows = array(input._canvas_quotes).map(object);
    const quotes = await Promise.all(
      rows.map((x) => this.quote(x.operation as Operation, object(x.parameters))),
    );
    const first = quotes[0];
    if (!first || quotes.some((q) => !q.known))
      return {
        known: false,
        hard_limit: false,
        source: 'Canvas node pricing',
        observed_at: new Date().toISOString(),
        expires_at: new Date().toISOString(),
        explanation: 'One or more Canvas node prices are unknown.',
      };
    return {
      ...first,
      credits: quotes.reduce((sum, q) => sum + (q.credits ?? 0), 0),
      explanation:
        'Sum of reviewed listed prices for explicitly selected Canvas nodes; server billing remains authoritative.',
    };
  }
  async quote(operation: Operation, input: Record<string, unknown>): Promise<Quote> {
    if (operation === 'canvas_node_stop')
      return {
        known: false,
        hard_limit: false,
        source: 'Studio node execution control',
        observed_at: new Date().toISOString(),
        expires_at: new Date().toISOString(),
        explanation:
          'This requests stopping the existing node execution. It does not quote or refund the work already started; inspect its original run billing separately.',
      };
    if (operation === 'uv_commit' || operation === 'project_edit') return metadataQuote(operation);
    if (operation === 'refine_submit')
      return {
        known: false,
        variable: true,
        hard_limit: false,
        source: 'Studio human refinement service',
        observed_at: new Date().toISOString(),
        expires_at: new Date().toISOString(),
        explanation:
          'This submits a human-service request, not a generated model. Studio determines allowance and any required payment; no payment is executed automatically.',
      };
    if (operation === 'export_batch') return await this.batchQuote(input);
    if (variableCanvasOperations.has(operation))
      return {
        known: false,
        variable: true,
        hard_limit: false,
        source: 'Studio creative agent variable billing',
        observed_at: new Date().toISOString(),
        expires_at: new Date().toISOString(),
        explanation:
          'The agent chooses work dynamically. Studio exposes no advance quote or hard spending cap; accept_variable_cost is required. This is not a zero-credit estimate.',
      };
    if (operation === 'canvas_run') return await this.canvasQuote(input);
    const now = new Date();
    const base: Quote = {
      known: false,
      hard_limit: false,
      source: 'No current reviewed Studio price snapshot',
      observed_at: now.toISOString(),
      expires_at: now.toISOString(),
      explanation: 'Refresh local pricing evidence before submitting.',
    };
    let snapshot: PriceSnapshot;
    try {
      snapshot = priceSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !this.fallback) return base;
      snapshot = this.fallback;
    }
    const reviewed = reviewedOperationQuote(snapshot, operation, base, now);
    if (reviewed) return reviewed;
    let keys: string[];
    if (operation === 'image')
      keys = [
        imageKeys[text(input.model_version)] ?? 'UnreviewedImage',
        ...(input.resolution === '4K' ? ['ImageUpscale4K'] : []),
      ];
    else if (operation === 'model') keys = modelKeys(input);
    else if (operation === 'texture') keys = textureKeys(input);
    else keys = extraKeys(operation, input);
    const prices = keys.map((key) => snapshot.credits[key]);
    if (prices.some((price) => price === undefined))
      return { ...base, source: snapshot.source, explanation: `No verified price for ${keys.join(', ')}.` };
    const credits =
      prices.reduce<number>((sum, price) => sum + price!, 0) * submissionCount(operation, input);
    if (!Number.isFinite(credits)) return { ...base, explanation: 'Original image amount is missing.' };
    return {
      ...base,
      known: true,
      credits,
      source: snapshot.source,
      expires_at: new Date(Math.min(Date.parse(snapshot.expires_at), Date.now() + 300000)).toISOString(),
      explanation:
        'Conservative listed-price estimate before membership discounts and free trials; actual billing is controlled by Studio.',
    };
  }
}
