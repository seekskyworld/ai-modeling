/** 网页以 10 MiB 分片，等待 CompleteMultipartUpload 后才交给审核/Canvas；临时权限不持久化。 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
  type CompletedPart,
} from '@aws-sdk/client-s3';

const partSize = 10 * 1024 * 1024;
type Upload = { Bucket: string; Key: string; Body: Buffer; ContentType: string };

export async function uploadS3(client: S3Client, input: Upload): Promise<void> {
  if (input.Body.length <= partSize) {
    await client.send(new PutObjectCommand({ ...input, ContentLength: input.Body.length }));
    return;
  }
  const { Body, ...identity } = input;
  const created = await client.send(new CreateMultipartUploadCommand(identity));
  if (!created.UploadId) throw new Error('Multipart upload identity is missing');
  const upload = { Bucket: input.Bucket, Key: input.Key, UploadId: created.UploadId };
  try {
    const parts: CompletedPart[] = [];
    for (let start = 0; start < Body.length; start += partSize * 4) {
      // 同一批在途分片全部结束后才清理，避免失败分片与 Abort 的迟到写入竞态。
      const pending: Promise<CompletedPart>[] = [];
      for (let offset = start; offset < Math.min(start + partSize * 4, Body.length); offset += partSize) {
        const PartNumber = Math.floor(offset / partSize) + 1;
        const bytes = Body.subarray(offset, Math.min(offset + partSize, Body.length));
        pending.push(
          client
            .send(
              new UploadPartCommand({
                ...upload,
                PartNumber,
                Body: bytes,
                ContentLength: bytes.length,
              }),
            )
            .then((result) => {
              if (!result.ETag) throw new Error('Multipart part receipt is missing');
              return { PartNumber, ETag: result.ETag };
            }),
        );
      }
      const outcomes = await Promise.allSettled(pending);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') throw outcome.reason;
        parts.push(outcome.value);
      }
    }
    await client.send(new CompleteMultipartUploadCommand({ ...upload, MultipartUpload: { Parts: parts } }));
  } catch (error) {
    // 只清理本次临时上传；失败不重启上传、不审核、不重新创建生成意图。
    await client.send(new AbortMultipartUploadCommand(upload)).catch(() => {});
    throw error;
  }
}
