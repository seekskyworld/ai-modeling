/** 账单按页查询；只读第一页会把较早任务的已有扣费误报成未知。 */
import { isDeepStrictEqual } from 'node:util';
import type { StudioClient } from './client.ts';
import { object, TripoError } from '../contracts/errors.ts';

export async function transactionHistory(client: StudioClient): Promise<Record<string, unknown>[]> {
  const pageSize = 100;
  const pages: Array<{ records: Record<string, unknown>[]; total?: number; have_more?: boolean }> = [];
  const records: Record<string, unknown>[] = [];
  const read = async (page: number) => {
    const value = object(
      await client.request('GET', `/v2/studio/txn/records?page_num=${page}&page_size=${pageSize}`),
    );
    if (
      !Array.isArray(value.records) ||
      value.records.length > pageSize ||
      (value.total !== undefined && (!Number.isSafeInteger(value.total) || Number(value.total) < 0)) ||
      (value.have_more !== undefined && typeof value.have_more !== 'boolean')
    )
      throw new TripoError('CONTRACT_CHANGED', 'Studio transaction pagination has an unexpected shape.');
    return {
      records: value.records.map(object),
      total: value.total as number | undefined,
      have_more: value.have_more as boolean | undefined,
    };
  };
  for (let page = 1; page <= 100; page++) {
    const next = await read(page);
    if (
      (pages.length && next.total !== pages[0]!.total) ||
      (next.records.length > 0 && pages.some((previous) => isDeepStrictEqual(previous.records, next.records)))
    )
      throw new TripoError(
        'BILLING_HISTORY_CHANGED',
        'Studio transaction pages changed or repeated; retry the read later.',
      );
    pages.push(next);
    records.push(...next.records);
    const more =
      next.have_more ??
      (next.total === undefined ? next.records.length === pageSize : records.length < next.total);
    if (more && next.records.length === 0)
      throw new TripoError(
        'BILLING_HISTORY_INCOMPLETE',
        'Studio returned an empty page before the transaction history ended.',
      );
    if (!more) {
      if (next.total !== undefined && records.length !== next.total)
        throw new TripoError(
          'BILLING_HISTORY_INCOMPLETE',
          'Studio transaction count does not match the retrieved pages.',
        );
      // 无游标的 offset 分页可能被新账单挤动；末尾重读第一页，变化时绝不保存部分金额。
      if (pages.length > 1 && !isDeepStrictEqual(await read(1), pages[0]))
        throw new TripoError(
          'BILLING_HISTORY_CHANGED',
          'Studio transactions changed during pagination; retry the read later.',
        );
      return records;
    }
  }
  throw new TripoError(
    'BILLING_HISTORY_LIMIT',
    'Studio transaction history exceeds 10000 records; the cost remains unconfirmed.',
  );
}
