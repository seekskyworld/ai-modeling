/** Project only selection metadata; signed media URLs, storage keys and account fields stay internal. */
import { object, sanitize, TripoError } from '../contracts/errors.ts';
import { id } from '../contracts/primitives.ts';

function identifier(value: unknown): string {
  const parsed = id.safeParse(value);
  if (!parsed.success)
    throw new TripoError('CONTRACT_CHANGED', 'Studio returned an asset without a usable identifier.');
  return parsed.data;
}

function label(value: unknown, maximum = 1000): string | undefined {
  if (typeof value !== 'string') return;
  return (sanitize(value) as string).replace(/https?:\/\/[^\s<>"'`]+/gi, '[URL omitted]').slice(0, maximum);
}

function token(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,127}$/i.test(value) ? value : undefined;
}

function created(value: unknown): string | number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return label(value, 128);
}

function available(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function modelAssetSummary(input: unknown) {
  const value = object(input);
  const visibility =
    typeof value.visibility === 'string' && ['public', 'private', 'shareable'].includes(value.visibility)
      ? value.visibility
      : undefined;
  const covers = Array.isArray(value.cover_image) ? value.cover_image : [];
  const coverObjects = Array.isArray(value.cover_image_object) ? value.cover_image_object : [];
  return {
    project_id: identifier(value.id),
    name: label(value.project_name),
    create_time: created(value.create_time),
    visibility,
    type: token(value.type),
    status: token(value.status),
    collected: typeof value.collected === 'boolean' ? value.collected : null,
    is_owner: typeof value.is_owner === 'boolean' ? value.is_owner : null,
    running: 'running_operator' in value ? value.running_operator != null : null,
    thumbnail_available: covers.some(available) || coverObjects.some((cover) => available(object(cover).url)),
  };
}

export function imageAssetSummary(input: unknown) {
  const value = object(input);
  const source = object(value.input);
  const data = object(value.output).data;
  if (data !== undefined && (!Array.isArray(data) || data.length > 16))
    throw new TripoError('CONTRACT_CHANGED', 'Studio returned an unsupported image output list.');
  const outputs = (data ?? []) as unknown[];
  return {
    asset_id: identifier(value.asset_id),
    status: token(value.status),
    type: token(value.type),
    create_time: created(value.create_time),
    input: {
      model_version: token(source.model_version),
      prompt: label(source.prompt ?? source.prompt_text),
    },
    output_count: outputs.length,
    outputs: outputs.map((entry, index) => {
      const output = object(entry);
      return {
        index,
        url_available: available(output.url),
        deletion_key_available:
          typeof output.key === 'string' && output.key.length > 0 && output.key.length <= 2048,
      };
    }),
  };
}
