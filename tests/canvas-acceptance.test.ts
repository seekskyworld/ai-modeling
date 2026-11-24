/** Completion receipts and the real CLI/MCP boundary preserve the separate acceptance step. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import sharp from '../cli/runtime/sharp.ts';
import { jobView } from '../cli/core/service.ts';
import { taskResult } from '../cli/compat/runtime.ts';
import { CliBridge } from '../mcp/cli-bridge.ts';
import { object } from '../studio/contracts/errors.ts';
import { fixture, quote } from './helpers.ts';
import type { JobState } from '../studio/contracts/types.ts';

test('chat completion retains explicit acceptance work in native and compatible task receipts', async () => {
  const f = await fixture();
  try {
    const job = f.jobs.prepare(
      'test-account',
      'conversation',
      'canvas_turn',
      { session_id: 'session' },
      quote,
    );
    for (const [state, status] of [
      ['prepared', 'pending'],
      ['running', 'pending'],
      ['waiting_input', 'waiting_input'],
      ['failed', 'blocked'],
      ['outcome_unknown', 'blocked'],
      ['succeeded', 'needs_review'],
    ] as [JobState, string][]) {
      const view = jobView({ ...job, state, remote_ids: { task_id: 'exact-turn' } });
      const acceptance = object(view.canvas_acceptance);
      assert.equal(acceptance.status, status);
      assert.equal(acceptance.requirements_met, null);
      assert.equal(acceptance.artifacts_checked, false);
      assert.equal(acceptance.process_complete, state === 'succeeded');
      assert.deepEqual(acceptance.context, { turn_id: 'exact-turn', session_id: 'session' });
      assert.deepEqual(acceptance.next_actions, [
        { tool: 'ai_modeling_canvas_turn_get', arguments: { turnId: 'exact-turn' } },
        { tool: 'ai_modeling_canvas_session_get', arguments: { sessionId: 'session' } },
      ]);
      assert.deepEqual(taskResult(view).canvas_acceptance, acceptance);
      assert.equal(view.state, state);
    }
    const answer = jobView({ ...job, operation: 'canvas_continue', input: { turn_id: 'exact-turn' } });
    assert.equal(object(answer.canvas_acceptance).required, true);
    assert.deepEqual(object(answer.canvas_acceptance).context, { turn_id: 'exact-turn' });
    const image = jobView({ ...job, operation: 'image' });
    assert.equal(image.canvas_acceptance, undefined);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('real MCP invokes the packaged CLI inspection interface, preserves file identity and exposes audit safely', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-acceptance-protocol-'));
  const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  env.AI_MODELING_DATA_DIR = path.join(directory, 'state');
  env.AI_MODELING_INPUT_ROOTS = directory;
  env.AI_MODELING_OUTPUT_DIR = path.join(directory, 'output');
  const bridge = new CliBridge({ command: process.execPath, args: [main], env });
  const client = new Client({ name: 'canvas-acceptance-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [main, 'mcp', '--toolset', 'studio'],
    env,
    stderr: 'pipe',
  });
  try {
    const bytes = await sharp({ create: { width: 2, height: 3, channels: 4, background: '#33aa88' } })
      .png()
      .toBuffer();
    const file = path.join(directory, 'actual.png');
    await writeFile(file, bytes);
    const input = {
      file_path: file,
      expected_sha256: createHash('sha256').update(bytes).digest('hex'),
      expect: { width: 2, height: 3 },
    };
    const direct = await bridge.call('ai_modeling_artifact_inspect', input, undefined, 'studio');
    assert.equal(direct.error, undefined);
    await client.connect(transport);
    assert.match(client.getInstructions() ?? '', /ai_modeling_canvas_audit/);
    const listed = await client.listTools();
    for (const name of ['ai_modeling_canvas_audit', 'ai_modeling_artifact_inspect']) {
      const tool = listed.tools.find((entry) => entry.name === name);
      assert.ok(tool, name);
      assert.equal(tool.annotations?.readOnlyHint, true);
    }
    const inspected = await client.callTool({ name: 'ai_modeling_artifact_inspect', arguments: input });
    assert.notEqual(inspected.isError, true);
    assert.deepEqual(inspected.structuredContent, direct);
    const result = object(object(inspected.structuredContent).result);
    assert.equal(result.sha256, input.expected_sha256);
    assert.equal(result.visual_review_required, true);
    const changed = await client.callTool({
      name: 'ai_modeling_artifact_inspect',
      arguments: { ...input, expected_sha256: 'f'.repeat(64) },
    });
    assert.notEqual(changed.isError, true);
    assert.equal(object(object(changed.structuredContent).result).requirements_status, 'failed');
    const invalid = await client.callTool({
      name: 'ai_modeling_canvas_audit',
      arguments: { canvasId: 'fixture', nodeIds: [] },
    });
    assert.equal(invalid.isError, true);
    assert.equal(object(object(invalid.structuredContent).error).code, 'INVALID_INPUT');
    const pipeline = await client.readResource({ uri: 'ai-modeling://guides/pipelines' });
    assert.match(String(object(pipeline.contents[0]).text), /canvas audit/);
  } finally {
    bridge.close();
    await client.close();
    await transport.close();
    await rm(directory, { recursive: true, force: true });
  }
});
