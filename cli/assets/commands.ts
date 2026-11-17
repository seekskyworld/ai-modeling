/** Expose the same website inventory as ai_modeling_assets_list through ordinary CLI flags. */
import type { Command } from 'commander';
import type { CommandContext } from '../compat/support.ts';
import { assetsListSchema, listAssets } from './list.ts';

export function registerAssets(program: Command, context: Pick<CommandContext, 'emit' | 'usingApp'>): void {
  program
    .command('assets')
    .description('inspect existing Studio models and images, including assets created on the website')
    .command('list')
    .description('list account assets; follow next_offset to read another page')
    .option('--kind <kind>', 'model or image', 'model')
    .option('--offset <n>', 'first asset offset, from 0 to 1000000', Number, 0)
    .option('--limit <n>', 'assets per page, from 1 to 100', Number, 20)
    .addHelpText(
      'after',
      '\nImage outputs include their indices for studio asset-download. Use studio image-get for the exact output keys required by image-delete.\n',
    )
    .action(async (options: { kind: string; offset: number; limit: number }) => {
      // Invalid input must fail before creating account services or opening the credential store.
      const input = assetsListSchema.parse(options);
      context.emit(await context.usingApp(async (app) => await listAssets(app.studio, input)));
    });
}
