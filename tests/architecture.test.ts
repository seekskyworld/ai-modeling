/** 依赖边界是本项目的产品约束，迁移后防止 MCP 绕过 CLI 或网页层反向依赖。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
async function sources(dir: string): Promise<string[]> {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) files.push(...(await sources(file)));
    else if (file.endsWith('.ts')) files.push(file);
  }
  return files;
}
test('MCP has no business imports and Studio has no CLI/MCP dependencies', async () => {
  for (const dir of ['cli', 'mcp', 'studio'])
    for (const file of await sources(dir)) {
      const contents = await readFile(file, 'utf8');
      if (dir !== 'studio')
        assert.ok(
          !/\/v2\/studio\/|https:\/\/msapi\.tripo3d/.test(contents),
          `${file} embeds a Studio endpoint outside studio/`,
        );
      for (const match of contents.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)) {
        const imported = match[1]!;
        if (dir === 'mcp')
          assert.ok(!/studio|cli\/|storage|keyring|sqlite|node:fs/.test(imported), `${file}: ${imported}`);
        if (dir === 'studio') assert.ok(!/cli\/|mcp\//.test(imported), `${file}: ${imported}`);
      }
    }
});
