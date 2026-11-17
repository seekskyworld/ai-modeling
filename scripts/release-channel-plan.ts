/** Pure release ordering; default channels may advance but never move backwards. */
export interface SemanticVersion {
  value: string;
  core: bigint[];
  prerelease: string[];
}

export function semanticVersion(value: string): SemanticVersion {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) throw new Error('Release channels require canonical semantic versions without build metadata.');
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((part) => !part || (/^\d+$/.test(part) && !/^(?:0|[1-9]\d*)$/.test(part))))
    throw new Error('Invalid semantic-version prerelease identifier.');
  return { value, core: match.slice(1, 4).map((part) => BigInt(part!)), prerelease };
}

export function compareVersions(left: string, right: string): number {
  const a = semanticVersion(left);
  const b = semanticVersion(right);
  for (let index = 0; index < 3; index++)
    if (a.core[index] !== b.core[index]) return a.core[index]! > b.core[index]! ? 1 : -1;
  if (!a.prerelease.length || !b.prerelease.length)
    return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const first = a.prerelease[index];
    const second = b.prerelease[index];
    if (first === second) continue;
    if (first === undefined || second === undefined) return first === undefined ? -1 : 1;
    const firstNumeric = /^\d+$/.test(first);
    const secondNumeric = /^\d+$/.test(second);
    if (firstNumeric && secondNumeric) return BigInt(first) > BigInt(second) ? 1 : -1;
    if (firstNumeric !== secondNumeric) return firstNumeric ? -1 : 1;
    return first > second ? 1 : -1;
  }
  return 0;
}

export function versionFromTag(tag: string): string {
  if (!tag.startsWith('v')) throw new Error('Expected an exact version tag.');
  return semanticVersion(tag.slice(1)).value;
}

export interface ChannelCandidate {
  version: string;
  tag: string;
  draft: boolean;
}
export interface CurrentChannels {
  latest?: string;
  next?: string;
  githubLatest?: string;
}

export function channelPlan<T extends ChannelCandidate>(candidates: T[], current: CurrentChannels) {
  for (const version of Object.values(current)) if (version !== undefined) semanticVersion(version);
  const ordered = [...candidates].sort((a, b) => compareVersions(a.version, b.version));
  const stable = ordered.filter((candidate) => !semanticVersion(candidate.version).prerelease.length).at(-1);
  const next = ordered.filter((candidate) => semanticVersion(candidate.version).prerelease.length).at(-1);
  const newer = (candidate: T | undefined, previous: string | undefined) =>
    candidate && (previous === undefined || compareVersions(candidate.version, previous) > 0)
      ? candidate
      : undefined;
  const latest = newer(stable, current.latest);
  const prerelease = newer(next, current.next);
  const githubLatest = newer(stable, current.githubLatest);
  const publish = ordered.filter((candidate) => candidate.draft);
  const verify = [
    ...new Set([...publish, latest, prerelease, githubLatest].filter((item) => item !== undefined)),
  ];
  return { publish, latest, next: prerelease, githubLatest, verify };
}
