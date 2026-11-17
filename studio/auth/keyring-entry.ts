/** Synchronous store contract; the native call itself lives in a killable child process. */
import { runKeyring } from './keyring-process.ts';

export class Entry {
  private service: string;
  private account: string;
  private secretService: boolean;
  constructor(service: string, account: string, options?: { linux: { store: 'secret-service' } }) {
    this.service = service;
    this.account = account;
    this.secretService = options?.linux.store === 'secret-service';
  }
  private request() {
    return {
      version: 1 as const,
      service: this.service,
      account: this.account,
      secretService: this.secretService,
    };
  }
  getPassword(): string | null {
    return runKeyring({ ...this.request(), operation: 'get' });
  }
  setPassword(value: string): void {
    runKeyring({ ...this.request(), operation: 'set', value });
  }
  deleteCredential(): void {
    runKeyring({ ...this.request(), operation: 'delete' });
  }
}
