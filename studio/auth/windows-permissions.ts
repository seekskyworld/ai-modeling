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
const permissionScript = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $requests = @(([Console]::In.ReadToEnd() | ConvertFrom-Json))
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
  [Console]::Out.Write('{"ok":true}')
} catch {
  [Console]::Out.Write('{"ok":false}')
  exit 1
}
`;

/** Injectable process boundary lets offline tests exercise failures without changing the host ACL. */
export function checkWindowsPermissions(
  entries: PermissionRequest[],
  runner: PermissionRunner = spawnSync,
): void {
  try {
    if (
      !entries.length ||
      entries.length > 32 ||
      entries.some((entry) => !path.win32.isAbsolute(entry.path) || /[\0\r\n]/.test(entry.path))
    )
      throw new Error('Invalid permission request.');
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    if (!path.win32.isAbsolute(systemRoot)) throw new Error('Invalid Windows directory.');
    const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = runner(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(permissionScript, 'utf16le').toString('base64'),
      ],
      {
        input: JSON.stringify(entries),
        encoding: 'utf8',
        timeout: windowsPermissionTimeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        maxBuffer: 4096,
        env: { SystemRoot: systemRoot, WINDIR: systemRoot },
      },
    );
    if (result.error || result.signal || result.status !== 0 || result.stdout !== '{"ok":true}')
      throw new Error('Private ACL could not be verified.');
  } catch {
    throw new TripoError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      'Private local JSON storage requires a Windows ACL owned by the current user and restricted to that user and SYSTEM. Check the directory permissions and retry the original action.',
      'not_submitted',
    );
  }
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
