/** 官方声明默认只影响新的兼容意图；网页原生默认、显式参数和已登记任务保持原契约。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyExportDefaultValues, type ExportDefaultField } from '../cli/compat/export-default-values.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { fingerprint } from '../cli/core/fingerprint.ts';

const fields: ExportDefaultField[] = [
  'with_animation',
  'texture_size',
  'animate_in_place',
  'export_orientation',
  'texture_format',
];
const native = (): Record<string, unknown> => normalize('export', { project_id: 'project', format: 'glb' });
test('new compatible export resolves the three verified declared defaults without injecting JPEG or animation', () => {
  const raw = native(),
    parameters = { ...raw };
  applyExportDefaultValues(parameters, fields);
  assert.deepEqual(
    {
      size: parameters.texture_size,
      inPlace: parameters.animate_in_place,
      axis: parameters.export_orientation,
    },
    { size: 4096, inPlace: false, axis: '+x' },
  );
  assert.equal(parameters.texture_format, undefined);
  assert.equal(parameters.with_animation, raw.with_animation);
  assert.deepEqual(native(), raw);
  assert.equal(raw.texture_size, 2048);
  assert.equal(raw.export_orientation, '-y');
  assert.deepEqual(normalize('export', parameters), parameters);
});
test('explicit values and the strict static bake=false requirement override new compatible defaults', () => {
  const explicit = {
    ...native(),
    texture_size: 1024,
    animate_in_place: true,
    export_orientation: '+y',
    texture_format: 'PNG',
  };
  const snapshot = structuredClone(explicit);
  applyExportDefaultValues(explicit, ['with_animation']);
  assert.deepEqual(explicit, snapshot);
  const unbaked = normalize('export', {
    project_id: 'project',
    expected_operator_id: 'source',
    bake: false,
    with_animation: false,
  });
  const before = fingerprint(unbaked);
  applyExportDefaultValues(unbaked, fields);
  assert.equal(fingerprint(unbaked), before);
});
test('old same-project task inputs restore original missing-field intent while explicit changes remain visible', () => {
  const original = native(),
    parameters = { ...native() };
  applyExportDefaultValues(parameters, fields, { operation: 'export', input: original });
  assert.equal(fingerprint(parameters), fingerprint(original));
  const changed = { ...native(), texture_size: 4096 };
  applyExportDefaultValues(
    changed,
    fields.filter((key) => key !== 'texture_size'),
    { operation: 'export', input: original },
  );
  assert.notEqual(fingerprint(changed), fingerprint(original));
  assert.equal(changed.texture_size, 4096);
  const another: Record<string, unknown> = { ...native(), project_id: 'different' };
  applyExportDefaultValues(another, fields, { operation: 'export', input: original });
  assert.equal(another.texture_size, 4096);
});
