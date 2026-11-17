/** 只清理本包生成目录，避免架构迁移后将旧入口一并打包。 */
import { rm } from 'node:fs/promises';
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
