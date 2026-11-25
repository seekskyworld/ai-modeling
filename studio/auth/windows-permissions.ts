/** Windows uses a protected DACL; POSIX mode bits do not restrict Windows file access. */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import path from 'node:path';
import { TripoError } from '../contracts/errors.ts';

export type PrivateWindowsPath = { path: string; kind: 'file' | 'directory' };
type PermissionRequest = PrivateWindowsPath & { protect?: boolean; repair?: boolean };
type PermissionRunner = (
  executable: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => Pick<ReturnType<typeof spawnSync>, 'status' | 'signal' | 'error' | 'stdout'>;
export const windowsPermissionTimeoutMs = 10000;

// Only paths cross stdin. No credential contents, account values, or PowerShell profiles are used.
const permissionScript = (replace = false) => `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  # Module discovery can block without a user environment. Load only the system JSON cmdlet.
  $utilityModule = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')
  Import-Module -Name $utilityModule -ErrorAction Stop
  $requests = @(([Console]::In.ReadToEnd() | Microsoft.PowerShell.Utility\\ConvertFrom-Json))
  if ($requests.Count -lt 1 -or $requests.Count -gt 32) { throw 'Invalid request' }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $current = $identity.User
  $elevated = [System.Security.Principal.WindowsPrincipal]::new($identity).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
  $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $full = [System.Security.AccessControl.FileSystemRights]::FullControl
  $both = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  function Test-PrivateAcl($acl, $current, $system, $directory, $full, $both) {
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $current.Value) { return $false }
    $userFullControl = $false
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { return $false }
      if ($rule.IdentityReference.Value -ne $current.Value -and $rule.IdentityReference.Value -ne $system.Value) { return $false }
      if ($rule.IdentityReference.Value -eq $current.Value -and ($rule.FileSystemRights -band $full) -eq $full -and $rule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None) {
        if (-not $directory -or ($rule.InheritanceFlags -band $both) -eq $both) { $userFullControl = $true }
      }
    }
    return $userFullControl
  }
  foreach ($request in $requests) {
    $location = [string]$request.path
    if (-not [IO.Path]::IsPathRooted($location)) { throw 'Invalid path' }
    $directory = $request.kind -eq 'directory'
    if (-not $directory -and $request.kind -ne 'file') { throw 'Invalid kind' }
    $attributes = [IO.File]::GetAttributes($location)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
    if ((($attributes -band [IO.FileAttributes]::Directory) -ne 0) -ne $directory) { throw 'Wrong kind' }
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
    if ($directory) { $acl = [IO.Directory]::GetAccessControl($location, $sections) }
    else { $acl = [IO.File]::GetAccessControl($location, $sections) }
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($request.repair -eq $true -and -not $directory) { throw 'File repair is not implicit' }
    if ($owner -ne $current.Value -and -not (($request.protect -eq $true -or $request.repair -eq $true) -and $owner -eq 'S-1-5-32-544' -and $elevated)) { throw 'Wrong owner' }
    $private = Test-PrivateAcl $acl $current $system $directory $full $both
    if (($request.protect -eq $true -or $request.repair -eq $true) -and -not $private) {
      if ($directory) { $acl = [Security.AccessControl.DirectorySecurity]::new(); $inherit = $both }
      else { $acl = [Security.AccessControl.FileSecurity]::new(); $inherit = [Security.AccessControl.InheritanceFlags]::None }
      $acl.SetOwner($current)
      $acl.SetAccessRuleProtection($true, $false)
      foreach ($identity in @($current, $system)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, $full, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        [void]$acl.AddAccessRule($rule)
      }
      if ($directory) { [IO.Directory]::SetAccessControl($location, $acl) }
      else { [IO.File]::SetAccessControl($location, $acl) }
    }
    if (([IO.File]::GetAttributes($location) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Changed path' }
    if ($directory) { $acl = [IO.Directory]::GetAccessControl($location, $sections) }
    else { $acl = [IO.File]::GetAccessControl($location, $sections) }
    if (-not (Test-PrivateAcl $acl $current $system $directory $full $both)) { throw 'Unprotected ACL' }
  }
  ${
    replace
      ? `# ReplaceFile preserves the destination DACL and permits readers of the old file to finish.
  # Never delete first, ignore metadata failures, create a backup or retry a partial replacement.
  # PowerShell coerces $null to an empty string for string parameters; the backup must be actual null.
  [IO.File]::Replace([string]$requests[1].path, [string]$requests[2].path, [NullString]::Value)
  $location = [string]$requests[2].path
  $attributes = [IO.File]::GetAttributes($location)
  if (($attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory)) -ne 0) { throw 'Changed replacement' }
  $acl = [IO.File]::GetAccessControl($location, $sections)
  if (-not (Test-PrivateAcl $acl $current $system $false $full $both)) { throw 'Unprotected replacement' }`
      : ''
  }
  [Console]::Out.Write('{"ok":true}')
} catch {
  [Console]::Out.Write('{"ok":false}')
  exit 1
}
`;

function assertSiblingReplacement(entries: PermissionRequest[]): void {
  if (
    entries.length !== 3 ||
    entries[0]!.kind !== 'directory' ||
    entries[1]!.kind !== 'file' ||
    entries[2]!.kind !== 'file' ||
    entries.some((entry) => entry.protect || entry.repair) ||
    path.win32.resolve(entries[1]!.path).toLowerCase() ===
      path.win32.resolve(entries[2]!.path).toLowerCase() ||
    entries
      .slice(1)
      .some(
        (entry) =>
          path.win32.dirname(path.win32.resolve(entry.path)).toLowerCase() !==
          path.win32.resolve(entries[0]!.path).toLowerCase(),
      )
  )
    throw new Error('Replacement requires two private files in the same directory.');
}

/** Injectable process boundary lets offline tests exercise failures without changing the host ACL. */
function checkWindowsPaths(entries: PermissionRequest[], runner: PermissionRunner, replace = false): void {
  try {
    if (
      !entries.length ||
      entries.length > 32 ||
      entries.some((entry) => !path.win32.isAbsolute(entry.path) || /[\0\r\n]/.test(entry.path))
    )
      throw new Error('Invalid permission request.');
    if (replace) assertSiblingReplacement(entries);
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    if (!path.win32.isAbsolute(systemRoot)) throw new Error('Invalid Windows directory.');
    const powerShellDirectory = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
    const executable = path.win32.join(powerShellDirectory, 'powershell.exe');
    const result = runner(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(permissionScript(replace), 'utf16le').toString('base64'),
      ],
      {
        input: JSON.stringify(entries),
        encoding: 'utf8',
        timeout: windowsPermissionTimeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        maxBuffer: 4096,
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          PSModulePath: path.win32.join(powerShellDirectory, 'Modules'),
        },
      },
    );
    if (result.error || result.signal || result.status !== 0 || result.stdout !== '{"ok":true}')
      throw new Error('Private ACL could not be verified.');
  } catch {
    throw new TripoError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      replace
        ? 'The private Windows JSON record could not be replaced safely. A protected temporary record may remain; inspect the stored state before retrying the original action.'
        : 'Private local JSON storage requires a Windows ACL owned by the current user and restricted to that user and SYSTEM. Check the directory permissions and retry the original action.',
      replace ? 'unknown' : 'not_submitted',
    );
  }
}

export function checkWindowsPermissions(
  entries: PermissionRequest[],
  runner: PermissionRunner = spawnSync,
): void {
  checkWindowsPaths(entries, runner);
}

/** One same-directory ReplaceFile operation; a failure may have changed either path, so never retry it. */
export function replacePrivateWindowsFile(
  source: string,
  target: string,
  runner: PermissionRunner = spawnSync,
): void {
  checkWindowsPaths(
    [
      { path: path.win32.dirname(target), kind: 'directory' },
      { path: source, kind: 'file' },
      { path: target, kind: 'file' },
    ],
    runner,
    true,
  );
}

export function applyPrivateWindowsPaths(entries: PermissionRequest[]): void {
  if (process.platform === 'win32') checkWindowsPermissions(entries);
}
export function verifyPrivateWindowsPaths(entries: PrivateWindowsPath[]): void {
  applyPrivateWindowsPaths(entries);
}
export function verifyPrivateWindowsPath(location: string, kind: PrivateWindowsPath['kind']): void {
  verifyPrivateWindowsPaths([{ path: location, kind }]);
}
export function protectPrivateWindowsPath(location: string, kind: PrivateWindowsPath['kind']): void {
  applyPrivateWindowsPaths([{ path: location, kind, protect: true }]);
}
