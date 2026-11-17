/** 浏览器会话只进入私有本地 JSON；解析导入文本不执行其中的 cURL 命令。 */
import { JsonEntry, jsonStorageUnavailable } from './json-entry.ts';
import { createHash, randomUUID } from 'node:crypto';
import { object, text, TripoError } from '../contracts/errors.ts';
import { isDeepStrictEqual } from 'node:util';
import type { AuthStorageOptions } from './control-directory.ts';

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

function validateSession(value: unknown): Session {
  const session = object(value);
  const keys = ['cookie', 'bearer', 'deviceId', 'accountRef', 'expiresAt', 'importedAt'];
  if (
    Object.keys(session).some((key) => !keys.includes(key)) ||
    !['deviceId', 'importedAt'].every((key) => typeof session[key] === 'string' && session[key] !== '') ||
    Object.values(session).some(
      (item) =>
        item !== undefined &&
        (typeof item !== 'string' ||
          item.length > 131072 ||
          [...item].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)),
    ) ||
    !Number.isFinite(Date.parse(String(session.importedAt))) ||
    (session.expiresAt !== undefined && !Number.isFinite(Date.parse(String(session.expiresAt))))
  )
    throw jsonStorageUnavailable();
  return session as unknown as Session;
}
function decodeSession(value: string | null): Session | undefined {
  if (value === null) return undefined;
  try {
    return validateSession(JSON.parse(value));
  } catch {
    throw jsonStorageUnavailable();
  }
}

export class JsonStore implements CredentialStore {
  private entry: JsonEntry;
  constructor(profile = 'default', options: AuthStorageOptions = {}) {
    this.entry = new JsonEntry('ai-modeling', profile, options);
  }
  load(): Session | undefined {
    return decodeSession(this.entry.getPassword());
  }
  save(session: Session): void {
    this.entry.setPassword(JSON.stringify(validateSession(session)));
  }
  /** 首次登录和刷新共用同一把锁；原快照（包括空值）变化后不能覆盖新凭据。 */
  saveIfUnchanged(expected: Session | undefined, session: Session): boolean {
    const encoded = JSON.stringify(validateSession(session));
    const before =
      expected === undefined ? undefined : decodeSession(JSON.stringify(validateSession(expected)));
    let saved = false;
    this.entry.update((current) => {
      if (!isDeepStrictEqual(decodeSession(current), before)) return current;
      saved = true;
      return encoded;
    });
    return saved;
  }
  clear(): void {
    this.entry.deleteCredential();
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
