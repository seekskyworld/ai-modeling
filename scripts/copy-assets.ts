/** 非 TypeScript 的渲染代码随 dist 分发，安装包不依赖源码目录。 */
import { copyFile } from 'node:fs/promises';
for (const file of [
  'model-worker.py',
  'model_materials.py',
  'model_transform.py',
  'model_preview.py',
  'model_animation.py',
])
  await copyFile(
    new URL('../cli/local/' + file, import.meta.url),
    new URL('../dist/cli/local/' + file, import.meta.url),
  );
