/** 对齐网页 token manager：有效期前 60 秒更新，旧异步刷新不能覆盖新登录。 */
import { isDeepStrictEqual } from 'node:util';
import { accountReference, tokenClaims, type CredentialStore, type Session } from './credentials.ts';
import { object, text, TripoError } from '../contracts/errors.ts';

export function usableBearer(bearer: string | undefined, skewSeconds = 60): boolean {
  if (!bearer) return false;
  const claims = tokenClaims(bearer);
  return (
    typeof claims.exp === 'number' &&
    Number.isFinite(claims.exp) &&
    claims.exp * 1000 > Date.now() + skewSeconds * 1000 &&
    Boolean(text(claims.sub))
  );
}

function sameIdentity(original: Session, current: Session | undefined): asserts current is Session {
  if (!current || current.accountRef !== original.accountRef)
    throw new TripoError(
      'ACCOUNT_MISMATCH',
      'The Studio account changed during session refresh.',
      'not_submitted',
    );
  const oldSubject = text(tokenClaims(original.bearer ?? '').sub);
  const newSubject = text(tokenClaims(current.bearer ?? '').sub);
  if (oldSubject && newSubject && oldSubject !== newSubject)
    throw new TripoError(
      'ACCOUNT_MISMATCH',
      'The refreshed session belongs to a different Studio identity.',
      'not_submitted',
    );
}

function refreshedIdentity(original: Session, response: Record<string, unknown>): Session {
  const bearer = text(response.tokenized);
  if (!usableBearer(bearer, 0))
    throw new TripoError('AUTH_REQUIRED', 'Studio did not issue a valid web session token.', 'not_submitted');
  const updated = {
    ...original,
    bearer,
    ...(text(response.expires_at) ? { expiresAt: text(response.expires_at) } : {}),
  };
  sameIdentity(original, updated);
  const identity = text(object(response.identity).id);
  if (identity && original.accountRef && accountReference(identity) !== original.accountRef)
    throw new TripoError(
      'ACCOUNT_MISMATCH',
      'The refreshed browser session belongs to a different Studio account.',
      'not_submitted',
    );
  // 没有旧 JWT subject 时，必须用 whoami 身份或最初由 JWT subject 建立的账号引用核对。
  if (
    !text(tokenClaims(original.bearer ?? '').sub) &&
    !identity &&
    original.accountRef &&
    accountReference(text(tokenClaims(bearer).sub)) !== original.accountRef
  )
    throw new TripoError(
      'ACCOUNT_MISMATCH',
      'The refreshed Studio identity could not be matched to this account.',
      'not_submitted',
    );
  return updated;
}

async function refreshBeforeSubmission(original: Session, refresh: () => Promise<unknown>): Promise<Session> {
  try {
    return refreshedIdentity(original, object(await refresh()));
  } catch (error) {
    // 此时只执行了 whoami；不能把登录刷新网络失败误记为后续付费请求结果未知。
    if (error instanceof TripoError)
      throw new TripoError(error.code, error.message, 'not_submitted', error.details);
    throw new TripoError(
      'AUTH_REFRESH_FAILED',
      'Studio session refresh failed before submission.',
      'not_submitted',
    );
  }
}

/** refresh 只能执行 whoami 读取；从不在业务请求失败后重放付费 POST。 */
export async function refreshSessionToken(
  credentials: CredentialStore,
  refresh: () => Promise<unknown>,
  requireBearer = false,
  observe?: (session: Session | undefined) => void,
): Promise<Session | undefined> {
  const saved = credentials.load();
  observe?.(saved);
  if (!saved) {
    if (requireBearer) throw new TripoError('AUTH_REQUIRED', 'Sign in to Studio first.', 'not_submitted');
    return;
  }
  const original = { ...saved };
  if ((!original.bearer && !requireBearer) || usableBearer(original.bearer)) return original;
  if (!original.cookie)
    throw new TripoError(
      'AUTH_REQUIRED',
      'The Studio token is expired or invalid and has no renewable browser session. Sign in again.',
      'not_submitted',
    );
  const updated = await refreshBeforeSubmission(original, refresh);
  const current = credentials.load();
  sameIdentity(original, current);
  let persisted = false;
  if (credentials.saveIfUnchanged) persisted = credentials.saveIfUnchanged(original, updated);
  else if (isDeepStrictEqual(current, original)) {
    credentials.save(updated);
    persisted = true;
  }
  if (persisted) return updated;
  const newer = credentials.load();
  sameIdentity(original, newer);
  if (!usableBearer(newer.bearer))
    throw new TripoError(
      'SESSION_CHANGED',
      'The Studio session changed during refresh. Retry the original action with the current session.',
      'not_submitted',
    );
  return { ...newer };
}
