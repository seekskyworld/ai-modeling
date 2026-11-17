import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  channelPlan,
  compareVersions,
  semanticVersion,
  type CurrentChannels,
} from '../scripts/release-channel-plan.ts';
import {
  promoteVerifiedReleases,
  type PromotionBackend,
  type PromotionCandidate,
} from '../scripts/release-promotion.ts';

function candidate(version: string, draft = true): PromotionCandidate {
  return { version, tag: `v${version}`, draft } as PromotionCandidate;
}

class MemoryPromotion implements PromotionBackend {
  releases: PromotionCandidate[];
  current: CurrentChannels;
  calls: string[] = [];
  failVerification?: string;
  npmFailure?: 'before' | 'after';
  githubFailure?: 'before' | 'after';
  advanceBeforeWrite?: CurrentChannels;
  reads = 0;
  constructor(releases: PromotionCandidate[], channels: CurrentChannels = {}) {
    this.releases = releases;
    this.current = { ...channels };
  }
  async candidates() {
    return this.releases;
  }
  async channels() {
    this.reads++;
    if (this.reads === 2 && this.advanceBeforeWrite) Object.assign(this.current, this.advanceBeforeWrite);
    return { ...this.current };
  }
  async verify(value: PromotionCandidate) {
    this.calls.push(`verify:${value.version}`);
    if (value.version === this.failVerification) throw new Error('Public npm archive did not match');
    return { verified: value.version };
  }
  async publish(value: PromotionCandidate, proof: unknown) {
    assert.deepEqual(proof, { verified: value.version });
    this.calls.push(`publish:${value.version}:not-latest`);
    value.draft = false;
  }
  async npmTag(channel: 'latest' | 'next', version: string) {
    this.calls.push(`npm:${channel}:${version}`);
    if (this.npmFailure === 'before') throw new Error('Request failed before delivery');
    this.current[channel] = version;
    if (this.npmFailure === 'after') throw new Error('Response lost after mutation');
  }
  async githubLatest(value: PromotionCandidate) {
    this.calls.push(`github:latest:${value.version}`);
    if (this.githubFailure === 'before') throw new Error('Request failed before delivery');
    this.current.githubLatest = value.version;
    if (this.githubFailure === 'after') throw new Error('Response lost after mutation');
  }
}

test('semantic version precedence follows numeric prerelease identifiers and stable releases', () => {
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.10.0',
    '2.0.0',
  ];
  for (let index = 1; index < ordered.length; index++) {
    assert.equal(compareVersions(ordered[index - 1]!, ordered[index]!), -1);
    assert.equal(compareVersions(ordered[index]!, ordered[index - 1]!), 1);
  }
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('9007199254740993.0.0', '9007199254740992.0.0'), 1);
});

test('channel versions reject ambiguity and malformed numeric identifiers', () => {
  for (const value of ['v1.0.0', '01.0.0', '1.0', '1.0.0-01', '1.0.0-a..b', '1.0.0+a', '1.0.0\n'])
    assert.throws(() => semanticVersion(value), /version|identifier/);
});

test('older first upload cannot displace a newer default npm or GitHub version', async () => {
  const backend = new MemoryPromotion([candidate('0.1.4')], { latest: '0.1.5', githubLatest: '0.1.5' });
  const report = await promoteVerifiedReleases(backend);
  assert.deepEqual(backend.calls, ['verify:0.1.4', 'publish:0.1.4:not-latest']);
  assert.deepEqual(report.after, { latest: '0.1.5', githubLatest: '0.1.5' });
  assert.equal(report.npm_upload_performed, false);
});

test('delayed GitHub visibility for an older version never moves GitHub Latest backwards', async () => {
  const backend = new MemoryPromotion([candidate('0.1.4')], { latest: '0.1.5', githubLatest: '0.1.5' });
  await promoteVerifiedReleases(backend);
  assert.equal(backend.current.githubLatest, '0.1.5');
  assert.equal(
    backend.calls.some((call) => call.startsWith('github:')),
    false,
  );
});

test('a surviving queued run drains every pending verified release, including coalesced jobs', async () => {
  const backend = new MemoryPromotion([candidate('0.1.6'), candidate('0.1.4'), candidate('0.1.5')], {
    latest: '0.1.3',
    githubLatest: '0.1.3',
  });
  const report = await promoteVerifiedReleases(backend);
  assert.deepEqual(report.published, ['0.1.4', '0.1.5', '0.1.6']);
  assert.deepEqual(
    backend.calls.filter((call) => call.startsWith('npm:')),
    ['npm:latest:0.1.6'],
  );
  assert.deepEqual(
    backend.calls.filter((call) => call.startsWith('github:')),
    ['github:latest:0.1.6'],
  );
  assert.deepEqual(report.after, { latest: '0.1.6', githubLatest: '0.1.6' });
});

test('prerelease ordering advances next without modifying stable defaults', async () => {
  const backend = new MemoryPromotion([candidate('0.2.0-rc.2'), candidate('0.2.0-rc.10')], {
    latest: '0.1.5',
    next: '0.2.0-rc.3',
    githubLatest: '0.1.5',
  });
  const report = await promoteVerifiedReleases(backend);
  assert.deepEqual(report.after, { latest: '0.1.5', next: '0.2.0-rc.10', githubLatest: '0.1.5' });
  assert.deepEqual(report.advanced, [{ channel: 'next', version: '0.2.0-rc.10' }]);
});

test('published legacy 0.1.3 can restore missing channels without repackaging or uploading', async () => {
  const backend = new MemoryPromotion([candidate('0.1.3', false)]);
  const report = await promoteVerifiedReleases(backend);
  assert.deepEqual(backend.calls, ['verify:0.1.3', 'npm:latest:0.1.3', 'github:latest:0.1.3']);
  assert.equal(report.npm_upload_performed, false);
});

test('already promoted releases perform no writes and do not redownload historical archives', async () => {
  const backend = new MemoryPromotion([candidate('0.1.3', false), candidate('0.1.4', false)], {
    latest: '0.1.4',
    githubLatest: '0.1.4',
  });
  assert.deepEqual((await promoteVerifiedReleases(backend)).advanced, []);
  assert.deepEqual(backend.calls, []);
});

test('one failed public verification remains pending while other verified releases complete', async () => {
  const backend = new MemoryPromotion([candidate('0.1.4'), candidate('0.1.5')]);
  backend.failVerification = '0.1.5';
  const report = await promoteVerifiedReleases(backend);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0]?.tag, 'v0.1.5');
  assert.deepEqual(report.published, ['0.1.4']);
  assert.equal(report.after.latest, '0.1.4');
  assert.equal(backend.releases.find((item) => item.version === '0.1.5')?.draft, true);
  backend.failVerification = undefined;
  assert.equal((await promoteVerifiedReleases(backend)).after.latest, '0.1.5');
});

test('an unknown npm dist-tag result is read back without retrying an upload or the mutation', async () => {
  const backend = new MemoryPromotion([candidate('0.1.4')]);
  backend.npmFailure = 'after';
  const report = await promoteVerifiedReleases(backend);
  assert.equal(backend.calls.filter((call) => call === 'npm:latest:0.1.4').length, 1);
  assert.equal(report.after.latest, '0.1.4');
  assert.equal(report.npm_upload_performed, false);
});

test('failed channel writes remain recoverable without an npm upload', async () => {
  const backend = new MemoryPromotion([candidate('0.1.4')]);
  backend.npmFailure = 'before';
  const failed = await promoteVerifiedReleases(backend);
  assert.match(failed.failures[0]!.reason, /unknown outcome.*never upload/);
  assert.equal(
    backend.calls.some((call) => call.startsWith('github:')),
    false,
  );
  backend.npmFailure = undefined;
  const report = await promoteVerifiedReleases(backend);
  assert.equal(report.after.latest, '0.1.4');
  assert.equal(report.npm_upload_performed, false);
});

test('lost GitHub Latest response reconciles the actual public value', async () => {
  const backend = new MemoryPromotion([candidate('0.1.4')]);
  backend.githubFailure = 'after';
  const report = await promoteVerifiedReleases(backend);
  assert.equal(report.after.githubLatest, '0.1.4');
  assert.equal(backend.calls.filter((call) => call === 'github:latest:0.1.4').length, 1);
});

test('failed GitHub Latest update retries only reconciliation after npm succeeded', async () => {
  const backend = new MemoryPromotion([candidate('0.1.4')]);
  backend.githubFailure = 'before';
  const failed = await promoteVerifiedReleases(backend);
  assert.match(failed.failures[0]!.reason, /unknown outcome.*without resubmitting/);
  backend.githubFailure = undefined;
  await promoteVerifiedReleases(backend);
  assert.equal(backend.calls.filter((call) => call === 'npm:latest:0.1.4').length, 1);
  assert.equal(backend.current.githubLatest, '0.1.4');
});

test('channels are reread immediately before promotion to preserve a newer observed version', async () => {
  const backend = new MemoryPromotion([candidate('0.1.4')], { latest: '0.1.3', githubLatest: '0.1.3' });
  backend.advanceBeforeWrite = { latest: '0.1.5', githubLatest: '0.1.5' };
  const report = await promoteVerifiedReleases(backend);
  assert.deepEqual(report.advanced, []);
  assert.equal(
    backend.calls.some((call) => call.startsWith('npm:') || call.startsWith('github:')),
    false,
  );
});

test('a newer legacy version without a promotion receipt is respected as the existing default', () => {
  const plan = channelPlan([candidate('0.1.4', false)], { latest: '1.0.0', githubLatest: '1.0.0' });
  assert.equal(plan.latest, undefined);
  assert.equal(plan.githubLatest, undefined);
  assert.deepEqual(plan.verify, []);
});
