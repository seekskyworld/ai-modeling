/** 从服务端产物路径读取格式提示；下载器仍需核验实际字节，签名参数不参与格式判断。 */
export function artifactFormat(url: string, fallback: string): string {
  try {
    const ext = new URL(url).pathname.split('.').at(-1)?.toLowerCase();
    return ext &&
      ['glb', 'fbx', 'obj', 'stl', 'usdz', '3mf', 'zip', 'png', 'jpeg', 'jpg', 'webp'].includes(ext)
      ? ext === 'jpg'
        ? 'jpeg'
        : ext
      : fallback;
  } catch {
    return fallback;
  }
}
