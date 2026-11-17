/** 网页把有效附件节点序列化成标记，但标记本身不占正文限额；未知标记仍是用户文字。 */
export function canvasTurnCharacterCount(content: string, assetIds: readonly string[]): number {
  const known = new Set(assetIds);
  const prose = content.replace(/\[Attachment: ([^\]]+)\]/g, (marker, assetId: string) =>
    known.has(assetId) ? '' : marker,
  );
  return [...prose].length;
}
