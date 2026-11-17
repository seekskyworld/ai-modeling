/** 模板 ID 来自当前网页目录，避免把官方模板名称误当 UUID 或绑定易失的账号配置。 */
import { array, object, text, TripoError } from '../contracts/errors.ts';
import type { StudioClient } from './client.ts';
const titles: Record<string, string> = {
  asset_extraction: 'Asset Extraction',
  character_completion: 'Character Completion',
  t_pose: 'T Pose',
  variants: 'Variants',
  figure: 'Figure',
  '3d_enhance': '3d Enhance',
  character_extraction: 'Character Extraction',
  head_extraction: 'Head Extraction',
  print_clay: 'Print Clay',
};
export async function resolveImageTemplate(client: StudioClient, name: string): Promise<string> {
  const catalog = object(await client.request('GET', '/v2/studio/image/available_templates'));
  const found = array(catalog.templates)
    .map(object)
    .filter((t) => text(t.title).toLowerCase() === titles[name]?.toLowerCase());
  if (found.length !== 1 || !text(found[0]!.template_id))
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      `The Studio template ${name} is not currently available.`,
      'not_submitted',
    );
  return text(found[0]!.template_id);
}
