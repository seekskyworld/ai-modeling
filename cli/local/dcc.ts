/** 独立 DCC 文件交接；导出/下载由已有命令组合，避免在传输失败时重新生成模型。 */
import { z } from 'zod';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dccTargets, DccConnection, transferDcc } from '../../studio/api/dcc-bridge.ts';
import { readBoundedFile, detectFormat } from '../../studio/files.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { LocalSpec } from './operations.ts';
const target = z
  .object({
    target: z.enum([
      'blender',
      'unity',
      'unreal',
      '3ds_max',
      'maya',
      'godot',
      'cocos',
      'zbrush',
      'metatailor',
      'roblox',
      'sketchup',
    ]),
    port: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .optional()
      .describe('Optional loopback plugin port; default follows the Studio DCC preset.'),
    timeout_seconds: z.number().min(1).max(600).default(60),
  })
  .strict();
const fileName = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (value) =>
      value !== '.' &&
      value !== '..' &&
      [...value].every((char) => char.charCodeAt(0) >= 32 && !['/', '\\'].includes(char)),
    'Use a file name without directory separators or control characters.',
  );
const transfer = target.extend({
  file_path: z.string().min(1),
  file_id: z.uuid().optional().describe('Correlation ID, not an upstream deduplication guarantee.'),
  name: fileName.optional(),
  wait_import: z.boolean().default(true).describe('Wait for file_loaded; false only confirms transfer.'),
});
function port(input: z.infer<typeof target>) {
  return input.port ?? dccTargets.find((t) => t.name === input.target)!.port;
}
export const dccOperations: LocalSpec[] = [
  {
    name: 'dcc_targets',
    description: 'list Studio DCC Bridge targets, loopback ports and recommended export settings',
    schema: z.object({}).strict(),
    readOnly: true,
    run: async () => ({
      protocol_version: '1.1.0',
      targets: dccTargets,
      requires: 'The corresponding official Bridge plugin must be running.',
    }),
  },
  {
    name: 'dcc_status',
    description: 'check the selected local DCC Bridge handshake without importing a file',
    schema: target,
    readOnly: true,
    run: async (_config, input) => {
      const x = target.parse(input),
        { connection, peer } = await DccConnection.open(port(x), x.timeout_seconds * 1000);
      connection.close();
      return { connected: true, target: x.target, port: port(x), peer };
    },
  },
  {
    name: 'dcc_send',
    description: 'send an exported model to a local Studio DCC Bridge and wait for its import receipt',
    schema: transfer,
    run: async (config, input) => {
      const x = transfer.parse(input),
        file = await readBoundedFile(x.file_path, config.inputRoots, 150 * 1024 * 1024);
      const format = detectFormat(file.bytes, true);
      if (!['glb', 'fbx', 'obj', 'zip'].includes(format))
        throw new TripoError(
          'INPUT_FORMAT',
          'DCC transfer accepts GLB, FBX, OBJ or a model ZIP.',
          'not_submitted',
        );
      const id = x.file_id ?? randomUUID(),
        name = fileName.parse(x.name ?? path.basename(x.file_path, path.extname(x.file_path)));
      const { connection, peer } = await DccConnection.open(port(x), x.timeout_seconds * 1000);
      try {
        return {
          ...(await transferDcc(
            connection,
            {
              bytes: file.bytes,
              id,
              name,
              type: format === 'zip' || format === 'glb' ? format : format.toUpperCase(),
            },
            x.timeout_seconds * 1000,
            x.wait_import,
          )),
          file_id: id,
          sha256: file.sha256,
          bytes: file.bytes.length,
          target: x.target,
          port: port(x),
          peer,
        };
      } finally {
        connection.close();
      }
    },
  },
];
