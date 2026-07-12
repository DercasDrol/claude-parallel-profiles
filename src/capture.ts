import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AuthStatus } from './cli';

/**
 * Snapshots the account currently signed in inside `sourceDir` into a dedicated
 * account directory `targetDir`, copying auth token and identity TOGETHER from
 * the same source so they can never drift apart (the drift between
 * .credentials.json and .claude.json's oauthAccount is exactly what made the
 * old version show one account while billing another).
 *
 * Returns the paths written. Throws if the source has no credentials.
 */
export function snapshotAccount(
  sourceDir: string,
  targetDir: string,
  status: AuthStatus
): void {
  const srcCreds = path.join(sourceDir, '.credentials.json');
  if (!fs.existsSync(srcCreds)) {
    throw new Error(`No credentials found in ${sourceDir} — sign in first.`);
  }

  if (path.normalize(sourceDir) === path.normalize(targetDir)) {
    // Already the account's own directory; nothing to copy.
    ensureIdentity(targetDir, status);
    return;
  }

  // 0700: the dir holds an OAuth token. The token file itself is 0600, but a
  // world-listable directory still leaks which accounts exist on the machine.
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });

  // 1) Credentials — copy atomically (temp + rename).
  const dstCreds = path.join(targetDir, '.credentials.json');
  const tmpCreds = `${dstCreds}.tmp`;
  fs.copyFileSync(srcCreds, tmpCreds);
  fs.chmodSync(tmpCreds, 0o600);
  fs.renameSync(tmpCreds, dstCreds);

  // 2) Identity (.claude.json). Prefer the real source file; the default
  //    ~/.claude keeps its identity in ~/.claude.json (home) instead.
  const srcIdentity = firstExisting([
    path.join(sourceDir, '.claude.json'),
    isDefaultDir(sourceDir) ? path.join(os.homedir(), '.claude.json') : '',
  ]);
  const dstIdentity = path.join(targetDir, '.claude.json');
  if (srcIdentity) {
    const tmp = `${dstIdentity}.tmp`;
    fs.copyFileSync(srcIdentity, tmp);
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, dstIdentity);
  } else {
    writeMinimalIdentity(dstIdentity, status);
  }
  ensureIdentity(targetDir, status);
}

/** Makes sure oauthAccount in the target reflects `status` (best effort). */
function ensureIdentity(dir: string, status: AuthStatus): void {
  if (!status.email) return;
  const file = path.join(dir, '.claude.json');
  let obj: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      obj = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      obj = {};
    }
  }
  const existing = (obj.oauthAccount as Record<string, unknown>) ?? {};
  if (existing.emailAddress === status.email) return; // already consistent
  obj.oauthAccount = {
    ...existing,
    emailAddress: status.email,
    organizationName: status.orgName ?? existing.organizationName,
  };
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function writeMinimalIdentity(file: string, status: AuthStatus): void {
  const obj = {
    oauthAccount: {
      emailAddress: status.email,
      displayName: status.email,
      organizationName: status.orgName,
    },
  };
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (p && fs.existsSync(p)) return p;
  return null;
}

function isDefaultDir(dir: string): boolean {
  return path.normalize(dir) === path.normalize(path.join(os.homedir(), '.claude'));
}

/** Default source dir when a window isn't bound to a named account yet. */
export function defaultSourceDir(): string {
  return path.join(os.homedir(), '.claude');
}
