/** 打印扩展遵循普通输入引用和命名选项；实际交接仅消费已完成导出，CLI/MCP共用实现。 */
import type { Command } from 'commander';
import {
  printTargetsInput,
  printPlanInput,
  printOpenInput,
  printShopInput,
  listPrintTargets,
  openPrint,
  printShop,
} from './printing.ts';
import { processingInput } from './input.ts';
import { resourceOptions, resourceInput } from './resource-options.ts';
import type { CommandContext } from './support.ts';
import type { Flags } from './planning.ts';

export function registerPrinting(program: Command, ctx: Pick<CommandContext, 'emit' | 'usingApp'>): void {
  const group = program
    .command('print')
    .description('hand existing Studio exports to slicers or inspect print-shop requirements');
  group
    .command('targets')
    .description('list slicers and current-platform handoff support')
    .action(() => ctx.emit(listPrintTargets(printTargetsInput.parse({}))));
  for (const action of ['plan', 'open'] as const) {
    const schema = action === 'open' ? printOpenInput : printPlanInput;
    const options = schema.omit({ task_id: true });
    const command = group
      .command(`${action} [input]`)
      .description(
        action === 'open'
          ? 'hand off an existing OBJ or 3MF export; add --execute to open or download'
          : 'plan an existing OBJ or 3MF export handoff without opening or downloading',
      )
      .action(async (input: string | undefined, flags: Flags) => {
        const taskId = await processingInput(input);
        const params = { ...resourceInput(flags, options), task_id: taskId };
        ctx.emit(await ctx.usingApp(async (app) => await openPrint(app, params)));
      });
    resourceOptions(command, options);
  }
  const shop = group
    .command('shop <project-id>')
    .description('show JuJuBit project sharing requirements; does not publish or place an order')
    .action(async (projectId: string) =>
      ctx.emit(
        await ctx.usingApp(
          async (app) => await printShop(app, printShopInput.parse({ project_id: projectId })),
        ),
      ),
    );
  shop.addHelpText(
    'after',
    '\nPrivate models need an explicit studio project-visibility change before sharing their ID.',
  );
}
