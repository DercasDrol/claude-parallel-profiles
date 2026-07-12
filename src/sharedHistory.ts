import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Shared conversation history across accounts.
 *
 * Claude Code keeps conversations INSIDE the account's data dir:
 *   <dir>/projects/<workspace-path>/<session>.jsonl  → transcripts
 *   <dir>/sessions, session-env, shell-snapshots, …  → session state
 * so switching CLAUDE_CONFIG_DIR resets the visible history. To let a chat
 * continue across an account switch we move these entries to one shared store
 * (~/.claude-shared) and symlink them from every account dir. Only history is
 * shared — .credentials.json / .claude.json (identity + billing) stay
 * per-account, and transcripts remain keyed by workspace path inside
 * projects/, so nothing leaks between repos.
 */

/** Directory entries moved to the shared store and symlinked back. */
const SHARED_DIRS = [
  'projects',
  'sessions',
  'session-env',
  'shell-snapshots',
  'file-history',
  'plans',
  'todos',
];
/** File entries: contents are appended into the shared file, then symlinked. */
const SHARED_FILES = ['history.jsonl'];

export function sharedStoreDir(): string {
  return path.join(os.homedir(), '.claude-shared');
}

/**
 * Ensures every given account dir sees the shared history store. Idempotent
 * and best-effort: each entry is migrated independently and a failure is
 * reported as a warning instead of aborting the rest (a partial migration
 * simply converges on the next activation). Returns human-readable warnings.
 */
export function ensureSharedHistory(accountDirs: string[]): string[] {
  const warnings: string[] = [];
  const store = sharedStoreDir();
  try {
    fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  } catch (err) {
    return [`Could not create ${store}: ${(err as Error).message}`];
  }

  const seen = new Set<string>();
  for (const rawDir of accountDirs) {
    const dir = path.normalize(rawDir);
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (dir === path.normalize(store)) continue;
    if (!fs.existsSync(dir)) continue;

    for (const name of SHARED_DIRS) {
      try {
        linkDirEntry(dir, store, name);
      } catch (err) {
        warnings.push(`${path.join(dir, name)}: ${(err as Error).message}`);
      }
    }
    for (const name of SHARED_FILES) {
      try {
        linkFileEntry(dir, store, name);
      } catch (err) {
        warnings.push(`${path.join(dir, name)}: ${(err as Error).message}`);
      }
    }
  }
  return warnings;
}

/** Migrates one directory entry of an account dir into the store + symlinks it. */
function linkDirEntry(accountDir: string, store: string, name: string): void {
  const src = path.join(accountDir, name);
  const dst = path.join(store, name);

  const st = fs.lstatSync(src, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) {
    if (path.normalize(fs.readlinkSync(src)) === path.normalize(dst)) return; // already ours
    fs.unlinkSync(src); // foreign/stale link — replace
  } else if (st?.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
    mergeDirInto(src, dst, store);
    fs.rmSync(src, { recursive: true, force: true });
  } else if (st) {
    return; // unexpected non-dir entry — leave it alone
  }

  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  fs.symlinkSync(dst, src);
}

/**
 * Moves everything from src into dst. On a name collision the newer file wins
 * and the older one is preserved under <store>/.merge-backup rather than
 * deleted (transcripts are user data — never destroy them).
 */
function mergeDirInto(src: string, dst: string, store: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    const dstStat = fs.lstatSync(d, { throwIfNoEntry: false });

    if (!dstStat) {
      fs.renameSync(s, d);
      continue;
    }
    if (entry.isDirectory() && dstStat.isDirectory()) {
      mergeDirInto(s, d, store);
      continue;
    }
    // Collision between files: keep the newer, back up the older.
    const srcStat = fs.statSync(s);
    const loser = srcStat.mtimeMs > dstStat.mtimeMs ? d : s;
    const backup = path.join(store, '.merge-backup', path.relative(store, dst), `${entry.name}.${Date.now()}`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.renameSync(loser, backup);
    if (loser === d) fs.renameSync(s, d);
  }
}

/**
 * Reverses ensureSharedHistory: every symlink into the shared store is
 * replaced by a REAL copy of the store's current content, so each account
 * keeps the full history it could see while sharing was on, and further
 * conversations diverge per-account again. The store itself is left on disk
 * (it holds the only merge backups); the caller tells the user it can be
 * deleted. Idempotent and best-effort like its counterpart.
 */
export function unshareHistory(accountDirs: string[]): string[] {
  const warnings: string[] = [];
  const store = sharedStoreDir();
  const seen = new Set<string>();
  for (const rawDir of accountDirs) {
    const dir = path.normalize(rawDir);
    if (seen.has(dir) || dir === path.normalize(store) || !fs.existsSync(dir)) continue;
    seen.add(dir);
    for (const name of [...SHARED_DIRS, ...SHARED_FILES]) {
      try {
        materializeEntry(dir, store, name);
      } catch (err) {
        warnings.push(`${path.join(dir, name)}: ${(err as Error).message}`);
      }
    }
  }
  return warnings;
}

/** Replaces one symlink-into-store with a real copy of the store content. */
function materializeEntry(accountDir: string, store: string, name: string): void {
  const src = path.join(accountDir, name);
  const dst = path.join(store, name);
  const st = fs.lstatSync(src, { throwIfNoEntry: false });
  if (!st?.isSymbolicLink()) return; // real dir/file or absent — not ours
  if (path.normalize(fs.readlinkSync(src)) !== path.normalize(dst)) return; // foreign link
  fs.unlinkSync(src);
  if (!fs.existsSync(dst)) return;
  fs.cpSync(dst, src, { recursive: true });
}

/** Appends an account's file (e.g. history.jsonl) into the store + symlinks it. */
function linkFileEntry(accountDir: string, store: string, name: string): void {
  const src = path.join(accountDir, name);
  const dst = path.join(store, name);

  const st = fs.lstatSync(src, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) {
    if (path.normalize(fs.readlinkSync(src)) === path.normalize(dst)) return;
    fs.unlinkSync(src);
  } else if (st?.isFile()) {
    let content = fs.readFileSync(src, 'utf-8');
    if (content && !content.endsWith('\n')) content += '\n';
    fs.appendFileSync(dst, content, { mode: 0o600 });
    fs.unlinkSync(src);
  } else if (st) {
    return; // unexpected entry type
  }

  if (!fs.existsSync(dst)) fs.writeFileSync(dst, '', { mode: 0o600 });
  fs.symlinkSync(dst, src);
}
