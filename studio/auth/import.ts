/** 先用临时凭据完成只读验证，再替换本机登录；验证失败不破坏已有会话。 */
import {
  MemoryCredentials,
  parseCredential,
  accountReference,
  tokenClaims,
  type CredentialStore,
  type Session,
} from './credentials.ts';
import { StudioClient, type Fetcher } from '../api/client.ts';
import { object, text, number, TripoError } from '../contracts/errors.ts';
import { usableBearer } from './session-token.ts';

export interface VerifiedCredential {
  session: Session;
  result: Record<string, unknown>;
}

/** 重新验证已有会话不能更换设备身份或导入时间，也不能修改调用方保存的快照。 */
function candidateSession(input: string | Session): Session {
  if (typeof input === 'string') return parseCredential(input);
  const parsed = parseCredential(JSON.stringify({ cookie: input.cookie, bearer: input.bearer }));
  return {
    ...parsed,
    deviceId: input.deviceId,
    importedAt: input.importedAt,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  };
}

/** 候选仅在内存中验证；登录协调器可在账号、取消和版本检查后自行原子保存。 */
export async function verifyCredential(
  input: string | Session,
  fetcher?: Fetcher,
): Promise<VerifiedCredential> {
  const temporary = new MemoryCredentials(candidateSession(input));
  const client = new StudioClient(temporary, fetcher);
  const session = temporary.load()!;
  let identity = text(tokenClaims(session.bearer ?? '').sub);
  if (session.cookie) {
    const who = object(await client.request('GET', '/v2/studio/studio/whoami?tokenizeAs=default_jwt'));
    // Cookie 先确定会话；不能用请求副本中另一个账号的旧 JWT 先读取钱包。
    // 旧端点可能只验证 Cookie 而不签发 JWT，此时不保留来源不明的导入 Bearer。
    if (text(who.tokenized) && !usableBearer(text(who.tokenized), 0))
      throw new TripoError(
        'AUTH_REQUIRED',
        'Studio did not issue a valid web session token.',
        'not_submitted',
      );
    session.bearer = text(who.tokenized) || undefined;
    const cookieIdentity = text(object(who.identity).id);
    const tokenIdentity = text(tokenClaims(session.bearer ?? '').sub);
    if (cookieIdentity && tokenIdentity && cookieIdentity !== tokenIdentity)
      throw new TripoError(
        'ACCOUNT_MISMATCH',
        'Studio returned different identities for the session and token.',
        'not_submitted',
      );
    identity = cookieIdentity || tokenIdentity;
    session.expiresAt = text(who.expires_at) || session.expiresAt;
  }
  session.accountRef = accountReference(identity || session.cookie || session.bearer!);
  temporary.save(session);
  const payment = object(await client.request('GET', '/v2/studio/user/profile/payment'));
  // 钱包读取可能已触发临期 JWT 刷新；写入验证后的最新快照，不能把导入时的旧 token 保存回去。
  const verified = temporary.load()!;
  return {
    session: verified,
    result: {
      authenticated: true,
      account_ref: verified.accountRef,
      renewable: Boolean(verified.cookie),
      expires_at: verified.expiresAt,
      balance: number(object(payment.wallet).total_credit),
    },
  };
}

/** 保留手动导入入口的原有保存语义与公开返回字段。 */
export async function importCredential(
  input: string,
  destination: CredentialStore,
  fetcher?: Fetcher,
): Promise<Record<string, unknown>> {
  const { session, result } = await verifyCredential(input, fetcher);
  destination.save(session);
  return result;
}
