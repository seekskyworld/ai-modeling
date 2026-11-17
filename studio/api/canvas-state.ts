/** 快照保留真实身份/版本/状态，仅归一下载授权查询参数与对象键序；不能去掉资源路径或业务查询参数。 */
export function stableCanvasResource(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    if (
      ![...url.searchParams.keys()].some((key) =>
        /^(signature|x-amz-signature|x-goog-signature|x-oss-signature)$/i.test(key),
      )
    )
      return value;
    const temporary =
      /^(signature|policy|key-pair-id|expires|security-token|awsaccesskeyid|googleaccessid|ossaccesskeyid|x-amz-(algorithm|credential|date|expires|signedheaders|signature|security-token)|x-goog-(algorithm|credential|date|expires|signedheaders|signature)|x-oss-(signature|signature-version|credential|date|expires|security-token|additional-headers))$/i;
    for (const key of [...url.searchParams.keys()]) if (temporary.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value;
  }
}
function stableValue(value: unknown, field = ''): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry, field));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry, key)]),
    );
  const resourceField = /(?:url|uri)$/i.test(field) || ['resource', 'preview', 'thumbnail'].includes(field);
  return typeof value === 'string' && resourceField ? stableCanvasResource(value) : value;
}
export function canvasStateFingerprint(value: unknown): string {
  return JSON.stringify(stableValue(value));
}
