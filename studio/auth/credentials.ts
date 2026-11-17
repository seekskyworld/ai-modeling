/** 浏览器会话只进入系统凭据库；解析导入文本不执行其中的 cURL 命令。 */
import { Entry } from './keyring-entry.ts';
import { keyringUnavailable } from './keyring-process.ts';
import { createHash, randomUUID } from 'node:crypto';
import { object, text, TripoError } from '../contracts/errors.ts';
import { isDeepStrictEqual } from 'node:util';
import { withCredentialLock } from './credential-lock.ts';

export interface Session {
  cookie?: string;
  bearer?: string;
  deviceId: string;
  accountRef?: string;
  expiresAt?: string;
  importedAt: string;
}
export interface CredentialStore {
  load(): Session | undefined;
  save(session: Session): void;
  saveIfUnchanged?(expected: Session | undefined, session: Session): boolean;
  clear(): void;
}

export class KeyringStore implements CredentialStore {
  private entry: Entry;
  private profile: string;
  constructor(profile = 'default') {
    this.profile = profile;
    this.entry = new Entry('ai-modeling', profile, { linux: { store: 'secret-service' } });
  }
  load(): Session | undefined {
    try {
      const value = this.entry.getPassword();
      return value ? (JSON.parse(value) as Session) : undefined;
    } catch (error) {
      if (error instanceof TripoError) throw error;
      throw keyringUnavailable();
    }
  }
  save(session: Session): void {
    try {
      withCredentialLock(this.profile, () => this.entry.setPassword(JSON.stringify(session)));
    } catch (error) {
      if (error instanceof TripoError) throw error;
      throw keyringUnavailable(false, 'unknown');
    }
  }
  /** 首次登录和刷新共用同一把锁；原快照（包括空值）变化后不能覆盖新凭据。 */
  saveIfUnchanged(expected: Session | undefined, session: Session): boolean {
    return withCredentialLock(this.profile, () => {
      if (!isDeepStrictEqual(this.load(), expected)) return false;
      try {
        this.entry.setPassword(JSON.stringify(session));
      } catch (error) {
        if (error instanceof TripoError) throw error;
        throw keyringUnavailable(false, 'unknown');
      }
      return true;
    });
  }
  clear(): void {
    withCredentialLock(this.profile, () => this.entry.deleteCredential());
  }
}

export class MemoryCredentials implements CredentialStore {
  private session?: Session;
  constructor(session?: Session) {
    this.session = session;
  }
  load(): Session | undefined {
    return this.session;
  }
  save(session: Session): void {
    this.session = session;
  }
  saveIfUnchanged(expected: Session | undefined, session: Session): boolean {
    if (!isDeepStrictEqual(this.session, expected)) return false;
    this.session = session;
    return true;
  }
  clear(): void {
    this.session = undefined;
  }
}

export function tokenClaims(token: string): Record<string, unknown> {
  try {
    return object(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()));
  } catch {
    return {};
  }
}

function credentialExpiry(bearer: string | undefined): Pick<Session, 'expiresAt'> {
  const exp = tokenClaims(bearer ?? '').exp;
  if (typeof exp !== 'number') return {};
  const expiry = new Date(exp * 1000);
  return Number.isFinite(expiry.getTime()) ? { expiresAt: expiry.toISOString() } : {};
}

/** 只接受明确的 Studio Cookie、JWT 或包含它们的浏览器请求副本，禁止控制字符注入。 */
export function parseCredential(input: string): Session {
  if (input.length > 131072) throw new TripoError('INVALID_CREDENTIAL', 'Credential input is too large.');
  const trimmed = input.trim();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = object(JSON.parse(trimmed));
  } catch {
    /* 浏览器 cURL 与裸 Cookie 不是 JSON。 */
  }
  const cookieMatch = trimmed.match(/ory_kratos_session=([^;\s'"\\]+)/);
  const bearerMatch = trimmed.match(/(?:Bearer\s+)?(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
  let cookie = text(parsed.cookie) || cookieMatch?.[1];
  const bearer = text(parsed.tokenized) || text(parsed.bearer) || bearerMatch?.[1];
  if (!cookie && !bearer && /^[A-Za-z0-9_+/=.-]{20,8192}$/.test(trimmed)) cookie = trimmed;
  cookie = cookie?.replace(/^ory_kratos_session=/, '');
  if (
    (!cookie && !bearer) ||
    (cookie && !/^[A-Za-z0-9_+/=.-]{20,8192}$/.test(cookie)) ||
    (bearer && !/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer))
  ) {
    throw new TripoError('INVALID_CREDENTIAL', 'No valid Studio session was found in the input.');
  }
  return {
    cookie,
    bearer,
    deviceId: randomUUID(),
    importedAt: new Date().toISOString(),
    ...credentialExpiry(bearer),
  };
}

export function accountReference(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 24);
}
