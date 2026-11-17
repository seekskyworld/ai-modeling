/** 对齐网页 hA 的 reference-image 准入；不伪造审核结果，也不代替用户作年龄确认。 */
import { object, text, TripoError } from '../contracts/errors.ts';

export type AdmittedImageResult = 'pass' | 'sensitive' | 'nsfw';
export interface StorageImage {
  bucket: string;
  key: string;
}
export type AuditImage = (reference: StorageImage) => Promise<unknown>;

export function admittedImageResult(audit: unknown, scene = 'reference-image'): AdmittedImageResult {
  const value = object(audit);
  if (value.result === 'pass') return 'pass';
  if (scene === 'reference-image') {
    if (value.result === 'sensitive') return 'sensitive';
    if (value.result === 'nsfw') {
      if (value.age_confirm_status === 'confirmed') return 'nsfw';
      if (value.age_confirm_status !== 'denied')
        throw new TripoError(
          'AGE_CONFIRMATION_REQUIRED',
          'Studio has not confirmed this reference image is allowed for this account. Complete any required age confirmation in Studio first.',
          'not_submitted',
        );
    }
  }
  throw new TripoError(
    'CONTENT_AUDIT_REJECTED',
    'Studio did not approve the image for this use.',
    'not_submitted',
  );
}

/** 生成结果可能尚未审核；缺失分类时补审。NSFW 查询当前准入，不缓存成年确认状态。 */
export async function referenceImageResult(
  reference: Record<string, unknown>,
  auditImage?: AuditImage,
): Promise<AdmittedImageResult> {
  const bucket = text(reference.bucket);
  const key = text(reference.key);
  if (!bucket || !key)
    throw new TripoError(
      'CONTENT_AUDIT_REJECTED',
      'Reference image is missing its audited storage identity.',
      'not_submitted',
    );
  const result = reference.image_audit_result;
  const needsAudit = result === 'nsfw' || result === undefined || result === null || result === '';
  const audit = needsAudit && auditImage ? await auditImage({ bucket, key }) : { result };
  return admittedImageResult(audit);
}
