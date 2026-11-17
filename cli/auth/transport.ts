/** 登录IPC绕过外部代理，仅访问已校验的127.0.0.1端口；能力头从不进入URL。 */
import { request } from 'node:http';
import type { LoginState, LoginStatus } from './types.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

export async function contactBroker(
  state: LoginState,
  action: 'status' | 'start' | 'cancel',
): Promise<LoginStatus> {
  if (!state.port) throw new TripoError('LOGIN_BROKER_UNAVAILABLE', 'Login coordinator is still starting.');
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: state.port,
        path: '/control',
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'x-ai-modeling-login': state.control },
        timeout: 1500,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 16384) {
            res.destroy();
            reject(new TripoError('LOGIN_BROKER_UNAVAILABLE', 'Invalid login coordinator response.'));
          } else chunks.push(Buffer.from(chunk));
        });
        res.on('error', () =>
          reject(new TripoError('LOGIN_BROKER_UNAVAILABLE', 'Login coordinator stopped.')),
        );
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) throw Error('Rejected');
            const value = JSON.parse(Buffer.concat(chunks).toString()) as LoginStatus;
            if (value.login_id !== state.login_id || value.profile !== state.profile) throw Error('Changed');
            resolve(value);
          } catch {
            reject(new TripoError('LOGIN_BROKER_UNAVAILABLE', 'Invalid login coordinator response.'));
          }
        });
      },
    );
    req.on('error', () => reject(new TripoError('LOGIN_BROKER_UNAVAILABLE', 'Login coordinator stopped.')));
    req.on('timeout', () => req.destroy(new Error('Login IPC timeout')));
    req.end(JSON.stringify({ login_id: state.login_id, action }));
  });
}
