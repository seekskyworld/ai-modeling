/** Pure path contracts complement, but do not replace, native operating-system tests. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { configFromEnv } from '../cli/core/config.ts';

const windows = { home: 'C:\\Users\\synthetic user', platform: 'win32' as const };

test('Windows data paths use LocalAppData and ignore Unix XDG settings', () => {
  assert.equal(
    configFromEnv({ LOCALAPPDATA: 'D:\\Local Data', XDG_DATA_HOME: '/unix/data' }, windows).dataDir,
    'D:\\Local Data\\ai-modeling',
  );
  assert.equal(
    configFromEnv({ XDG_DATA_HOME: '/unix/data' }, windows).dataDir,
    'C:\\Users\\synthetic user\\AppData\\Local\\ai-modeling',
  );
});

test('Windows explicit drive and UNC paths keep their identity and semicolon input boundaries', () => {
  const config = configFromEnv(
    {
      AI_MODELING_DATA_DIR: 'D:\\State Dir',
      AI_MODELING_OUTPUT_DIR: '\\\\server\\share\\output',
      AI_MODELING_INPUT_ROOTS: 'C:\\Images;D:\\Model Inputs;;\\\\server\\share\\assets',
      AI_MODELING_PROFILE: 'selected-profile',
    },
    windows,
  );
  assert.deepEqual(config, {
    dataDir: 'D:\\State Dir',
    outputDir: '\\\\server\\share\\output',
    inputRoots: ['C:\\Images', 'D:\\Model Inputs', '\\\\server\\share\\assets'],
    credentialProfile: 'selected-profile',
  });
});

test('Linux XDG and macOS data paths remain independent from the shared credential profile', () => {
  const linux = configFromEnv(
    { XDG_DATA_HOME: '/synthetic/xdg', AI_MODELING_PROFILE: 'shared' },
    { home: '/synthetic/user', platform: 'linux' },
  );
  const mac = configFromEnv(
    { XDG_DATA_HOME: '/ignored/xdg', AI_MODELING_PROFILE: 'shared' },
    { home: '/synthetic/user', platform: 'darwin' },
  );
  assert.equal(linux.dataDir, '/synthetic/xdg/ai-modeling');
  assert.equal(mac.dataDir, '/synthetic/user/Library/Application Support/ai-modeling');
  assert.equal(linux.credentialProfile, mac.credentialProfile);
});
