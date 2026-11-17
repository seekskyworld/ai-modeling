/** 上传只使用 Studio 签发的临时 S3 身份；图片通过服务端审核后才能作为生成输入。 */
import { S3Client } from '@aws-sdk/client-s3';
import { StudioClient } from './client.ts';
import { object, text, TripoError } from '../contracts/errors.ts';
import { Readable } from 'node:stream';
import { modelUpload } from '../model-upload.ts';
import { admittedImageResult, type AdmittedImageResult } from '../auth/image-admission.ts';
import { uploadS3 } from './s3-upload.ts';

export interface ImageReference {
  bucket: string;
  key: string;
  image_audit_result: AdmittedImageResult;
  image_source: 'upload' | 'generate';
}
export async function uploadFile(
  client: StudioClient,
  bytes: Buffer,
  format: string,
): Promise<{ bucket: string; key: string }> {
  ({ bytes, format } = await modelUpload(bytes, format));
  const token = object(
    await client.request('POST', '/v2/studio/storage/temporary_token', { client: 'aws', format }),
  );
  for (const key of ['sts_ak', 'sts_sk', 'session_token', 'resource_bucket', 'resource_uri'])
    if (!text(token[key]))
      throw new TripoError('CONTRACT_CHANGED', 'Studio upload credentials are incomplete.');
  // SDK 负责 SigV4，传输复用环境代理；错误对象可能包含签名请求，不向上透传。
  const s3 = new S3Client({
    region: 'us-west-2',
    useAccelerateEndpoint: true,
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: text(token.sts_ak),
      secretAccessKey: text(token.sts_sk),
      sessionToken: text(token.session_token),
    },
    requestHandler: {
      handle: async (request: {
        protocol: string;
        hostname: string;
        path: string;
        method: string;
        headers: Record<string, string>;
        query?: Record<string, string | string[] | null>;
        body?: unknown;
      }) => {
        if (!request.hostname.endsWith('.amazonaws.com')) throw new Error('Unexpected upload destination');
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(request.query ?? {}))
          for (const item of Array.isArray(value) ? value : [value]) query.append(key, item ?? '');
        const url = `${request.protocol}//${request.hostname}${request.path}${query.size ? '?' + query : ''}`;
        const response = await client.fetcher(url, {
          method: request.method,
          // S3 SDK 为较大文件增加 Expect: 100-continue；Fetch 不支持该未参与签名的握手头。
          headers: Object.fromEntries(
            Object.entries(request.headers).filter(([key]) => key.toLowerCase() !== 'expect'),
          ),
          body: request.body as BodyInit,
          redirect: 'error',
          signal: AbortSignal.timeout(60000),
        });
        return {
          response: {
            statusCode: response.status,
            headers: Object.fromEntries(response.headers),
            body: response.body
              ? Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
              : Readable.from([]),
          },
        };
      },
    },
  });
  try {
    await uploadS3(s3, {
      Bucket: text(token.resource_bucket),
      Key: text(token.resource_uri),
      Body: bytes,
      ContentType: ['png', 'jpeg', 'webp'].includes(format) ? `image/${format}` : 'application/octet-stream',
    });
  } catch (error) {
    const failure = object(error);
    const code = text(failure.code) || text(object(failure.cause).code) || text(failure.name);
    throw new TripoError(
      'UPLOAD_FAILED',
      'File upload failed before generation was submitted.',
      'not_submitted',
      {
        ...(/^[A-Za-z0-9_:-]{1,80}$/.test(code) ? { upload_code: code } : {}),
        ...(typeof object(failure.$metadata).httpStatusCode === 'number'
          ? { http_status: object(failure.$metadata).httpStatusCode }
          : {}),
      },
    );
  } finally {
    s3.destroy();
  }
  const reference = { bucket: text(token.resource_bucket), key: text(token.resource_uri) };
  return reference;
}
/** 图片审核必须通过后才可进入生成请求，模型文件不经过图片审核。 */
export async function uploadImage(
  client: StudioClient,
  bytes: Buffer,
  format: string,
): Promise<ImageReference> {
  const reference = await uploadFile(client, bytes, format);
  const audit = object(await client.request('POST', '/v2/studio/audit/image', { image: reference }));
  return { ...reference, image_audit_result: admittedImageResult(audit), image_source: 'upload' };
}
