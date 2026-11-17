/** Only private pipes carry credential values between the CLI and native-store helper. */
export const keyringMessageLimit = 1024 * 1024;
export type KeyringRequest = {
  version: 1;
  service: string;
  account: string;
  secretService: boolean;
} & ({ operation: 'get' | 'delete' } | { operation: 'set'; value: string });

export function isKeyringRequest(value: unknown): value is KeyringRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const keys = ['version', 'service', 'account', 'secretService', 'operation'];
  if (request.operation === 'set') keys.push('value');
  return (
    request.version === 1 &&
    [request.service, request.account].every(
      (item) =>
        typeof item === 'string' &&
        item.length > 0 &&
        item.length <= 4096 &&
        !Array.from(item).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    ) &&
    typeof request.secretService === 'boolean' &&
    ['get', 'set', 'delete'].includes(String(request.operation)) &&
    (request.operation !== 'set' || typeof request.value === 'string') &&
    Object.keys(request).length === keys.length &&
    Object.keys(request).every((key) => keys.includes(key))
  );
}
