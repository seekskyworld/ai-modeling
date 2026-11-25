/** Synthetic card presentation contracts; no Studio account or answer submission. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAnswerCard } from '../studio/api/canvas-answer.ts';

const read = (card: Record<string, unknown>, cardType = 'CARD_TYPE_CONFIRMATION') =>
  readAnswerCard({
    messageId: 'card',
    turnId: 'turn',
    cardType,
    cardJson: JSON.stringify(card),
  });
const plan = (data: Record<string, unknown> = {}) => ({ type: 'confirmation', intent: 'plan', data });

test('card headings follow Studio precedence without replacing the answer prompt', () => {
  const card = read({
    ...plan({ title: 'Plan title' }),
    title: 'Fallback title',
    heading: 'Legacy heading',
    prompt: 'Continue?',
    subtitle: ' ',
    description: 'Inspect the planned output.',
  })!;
  assert.equal(card.title, 'Plan title');
  assert.equal(card.prompt, 'Continue?');
  assert.equal(card.subtitle, 'Inspect the planned output.');
  assert.equal(read({ ...plan({ title: ' ' }), title: 'Fallback title' })!.title, 'Fallback title');
  assert.equal(read({ ...plan(), title: 3, heading: 'Legacy heading' })!.title, 'Legacy heading');
  assert.equal(read({ ...plan(), title: {}, subtitle: [] })!.title, undefined);
});

test('plan fullGroups take precedence and retain only rendered step data', () => {
  const card = read(
    plan({
      fullGroups: [
        {
          name: 'Build',
          steps: [
            { id: 'mesh', label: 'Create mesh', status: 'completed', parameters: { run: true } },
            { id: 'texture', label: 'Apply texture', status: 'running' },
            { id: ' ', label: 'Invalid step' },
            { id: 'invalid', label: 3 },
          ],
          authorization: 'secret',
        },
        { name: 'Empty', steps: [] },
        { name: 'Missing steps' },
      ],
      groups: [{ name: 'Stale plan', steps: [{ id: 'old', label: 'Do not display' }] }],
      question: 'Proceed with both steps?',
      requirements: ['A blue robot', '', '   ', 3, { invalid: true }, 'Textured model'],
    }),
  )!;
  assert.deepEqual(card.groups, [
    {
      name: 'Build',
      steps: [
        { id: 'mesh', label: 'Create mesh', status: 'completed' },
        { id: 'texture', label: 'Apply texture' },
      ],
    },
  ]);
  assert.equal(card.question, 'Proceed with both steps?');
  assert.deepEqual(card.requirements, ['A blue robot', 'Textured model']);
  assert.ok(!JSON.stringify(card).includes('secret'));
  assert.ok(!JSON.stringify(card).includes('parameters'));
});

test('an empty authoritative fullGroups never falls back to a stale plan or exposes its question', () => {
  const data = {
    groups: [{ name: ' ', steps: [{ id: 'one', label: 'One step' }] }],
    question: 'Hidden without groups',
    requirements: ['Still visible'],
  };
  assert.deepEqual(read(plan(data))!.groups, data.groups);
  const empty = read(plan({ ...data, fullGroups: [] }))!;
  assert.equal(empty.groups, undefined);
  assert.equal(empty.question, undefined);
  assert.deepEqual(empty.requirements, ['Still visible']);
  const nonPlan = read({ type: 'confirmation', intent: 'retry', data })!;
  assert.equal(nonPlan.groups, undefined);
  assert.equal(nonPlan.requirements, undefined);
});

test('card estimates validate the web range and are always explicitly diagnostic', () => {
  for (const estimate of [
    { creditsMin: 0, creditsMax: 8 },
    { credits_min: 0, credits_max: 8 },
    { creditsMin: 0, creditsMax: 8, credits_min: 4, credits_max: 12 },
  ])
    assert.deepEqual(read(plan({ estimate }))!.estimate, {
      creditsMin: 0,
      creditsMax: 8,
      diagnosticOnly: true,
    });
  for (const estimate of [
    { creditsMin: -1, creditsMax: 8 },
    { creditsMin: 0, creditsMax: 0 },
    { creditsMin: 8, creditsMax: 4 },
    { creditsMin: '0', creditsMax: 8 },
    { creditsMin: 0, creditsMax: Number.POSITIVE_INFINITY },
    { creditsMax: 8 },
  ])
    assert.equal(read(plan({ estimate }))!.estimate, undefined);
  const data = { estimate: { creditsMin: 1, creditsMax: 2 } };
  assert.equal(read({ ...plan(data), type: 'auto_confirm' })!.estimate, undefined);
  assert.equal(read({ ...plan(data), intent: 'retry' })!.estimate, undefined);
  assert.equal(
    read({ ...plan(data), type: 'selection', options: [] }, 'CARD_TYPE_SELECTION')!.estimate,
    undefined,
  );
  assert.equal(read({ intent: 'plan', data })!.estimate?.creditsMax, 2);
});

test('single and grouped option subtitles retain the web fallback without coercing objects into text', () => {
  const options = [
    { id: 'cat', subtitle: 'A small cat', description: 'Hidden fallback' },
    { id: 'dog', description: 'A large dog' },
    { id: 'none', subtitle: '', description: 'Suppressed by explicit empty subtitle' },
    { id: 'object', subtitle: { token: 'private' } },
  ];
  const single = read({ type: 'selection', options }, 'CARD_TYPE_SELECTION')!;
  assert.deepEqual(
    single.options.map(({ subtitle }) => subtitle),
    ['A small cat', 'A large dog', undefined, undefined],
  );
  const grouped = read(
    { type: 'selection', questions: [{ id: 'animal', prompt: 'Choose an animal', options }] },
    'CARD_TYPE_SELECTION',
  )!;
  assert.deepEqual(grouped.questions[0]!.options, single.options);
  assert.deepEqual(grouped.options, single.options);
  assert.equal(read({ type: 'astra', data: { title: 'Not an answer' } }, 'CARD_TYPE_ASTRA'), null);
});

test('oversized presentation is rejected rather than silently dropping decision context', () => {
  for (const card of [
    { ...plan(), subtitle: '😀'.repeat(5000) },
    plan({ fullGroups: Array.from({ length: 101 }, () => ({ steps: [] })) }),
    plan({ groups: [{ steps: Array.from({ length: 1001 }, () => ({ id: 'step', label: 'Step' })) }] }),
    plan({ requirements: Array.from({ length: 1001 }, () => 'A requirement') }),
    plan({ requirements: Array.from({ length: 20 }, () => 'x'.repeat(16000)) }),
  ])
    assert.throws(() => read(card), { code: 'CONTRACT_CHANGED' });
});
