/** 对外只返回稳定错误码和脱敏上下文，底层网络异常不携带请求头进入工具输出。 */
export class TripoError extends Error {
  code: string;
  certainty: 'not_submitted' | 'unknown' | 'read';
  details: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    certainty: TripoError['certainty'] = 'read',
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'TripoError';
    this.code = code;
    this.certainty = certainty;
    this.details = details;
  }
}

export function errorResult(error: unknown): Record<string, unknown> {
  if (error instanceof TripoError)
    return object(
      sanitize({ code: error.code, message: error.message, certainty: error.certainty, ...error.details }),
    );
  return {
    code: 'INTERNAL_ERROR',
    message: 'Unexpected local failure; check the operation and local environment.',
  };
}

export function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
export function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const paginationFields = new Set(['pageToken', 'nextPageToken', 'page_token', 'next_page_token']);
const sensitiveField =
  /cookie|authorization|token|secret|password|signature|email|phone|bearer|api[_-]?key|credential/i;

function diagnosticUrl(value: string): string {
  const suffix = value.match(/[),.;!\]}]+$/)?.[0] ?? '';
  try {
    const url = new URL(value.slice(0, value.length - suffix.length));
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString() + suffix;
  } catch {
    return '[invalid URL]' + suffix;
  }
}

/** 诊断消息也可能嵌入完整请求、签名 URL 或认证头；不只检查整串 URL。 */
function diagnosticText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"'`]+/gi, diagnosticUrl)
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)\b["']?\s*[=:]\s*[^\r\n]+/gi,
      '[redacted header]',
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '[redacted authorization]')
    .replace(
      /\b(?:ory_kratos_session|x-auth-token|(?:access|refresh|session)[_-]?token|token|api[_-]?key|password|secret|signature)\b["']?\s*[=:]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi,
      '[redacted credential]',
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted]');
}

/** 不信任上游诊断和 URL 查询参数；成功产物 URL 不应经过此诊断过滤器。 */
export function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => paginationFields.has(key) || !sensitiveField.test(key))
        // 游标可能是 URL 或 JWT 形态的 opaque string；不得破坏后续只读分页输入。
        .map(([key, val]) => [
          key,
          paginationFields.has(key) && typeof val === 'string' ? val : sanitize(val),
        ]),
    );
  }
  if (typeof value === 'string') return diagnosticText(value);
  return value;
}
