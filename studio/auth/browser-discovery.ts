/** Detect supported executables without reading browser profiles or opening a window. */
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { TripoError } from '../contracts/errors.ts';

export function installedBrowser(
  explicit?: string,
  location = { platform: process.platform, home: homedir(), env: process.env },
): string {
  const candidates = explicit
    ? [explicit]
    : location.platform === 'darwin'
      ? ['/Applications', path.join(location.home, 'Applications')].flatMap((root) => [
          path.join(root, 'Google Chrome.app/Contents/MacOS/Google Chrome'),
          path.join(root, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
        ])
      : location.platform === 'win32'
        ? [location.env.PROGRAMFILES, location.env['PROGRAMFILES(X86)'], location.env.LOCALAPPDATA]
            .filter((root): root is string => Boolean(root))
            .flatMap((root) => [
              path.join(root, 'Google/Chrome/Application/chrome.exe'),
              path.join(root, 'Microsoft/Edge/Application/msedge.exe'),
            ])
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/microsoft-edge',
            '/usr/bin/microsoft-edge-stable',
          ];
  for (const candidate of candidates) {
    try {
      if (!path.isAbsolute(candidate) || !statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Continue through known executables; never inspect browser user data. */
    }
  }
  throw new TripoError(
    'BROWSER_NOT_FOUND',
    'No supported Chrome or Edge executable was found.',
    'not_submitted',
  );
}
