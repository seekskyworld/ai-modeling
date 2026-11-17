/** 独立进程用于验证数据库提交租约，不依赖 JS 共享内存锁。 */
import { JobStore } from '../cli/storage/jobs.ts';
const store = new JobStore(process.argv[2]!);
process.stdout.write(String(store.claim(process.argv[3]!)));
store.close();
