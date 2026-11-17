/** Registration captures dependencies without opening runtime state; execution resolves them. */
import type { TaskService } from './core/service.ts';
import type { StudioReads } from './commands.ts';
import type { StudioGateway } from '../studio/api/gateway.ts';

export type Dependency<T> = T | (() => T);
export function resolveDependency<T>(dependency: Dependency<T>): T {
  return typeof dependency === 'function' ? (dependency as () => T)() : dependency;
}
export function toolApplication(service: Dependency<TaskService>, studio: Dependency<StudioReads>) {
  return {
    get service() {
      return resolveDependency(service);
    },
    get studio() {
      return resolveDependency(studio) as StudioGateway;
    },
    close() {},
  };
}
