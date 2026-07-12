// vscode:uninstall hook — runs via plain `node` when the extension is
// uninstalled (no vscode API available). Reverts what the sharedHistory
// feature did to the user's Claude data dirs: every symlink pointing into
// ~/.claude-shared is replaced with a real copy of the store's content, so
// after the extension is gone each account owns a normal, self-contained
// history again. The store itself is left in place as a backup.
//
// Must stay dependency-free and in sync with the entry list in
// src/sharedHistory.ts.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SHARED_ENTRIES = [
  'projects',
  'sessions',
  'session-env',
  'shell-snapshots',
  'file-history',
  'plans',
  'todos',
  'history.jsonl',
];

/** The per-window working dirs this extension creates (~/.claude-windows/<id>). */
function workingDirs(home) {
  try {
    const root = path.join(home, '.claude-windows');
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

/**
 * Working dirs are ours, not the user's: each is a COPY of an account, made only
 * so that two windows never share one directory. Once the extension is gone
 * nothing points at them, and each holds a duplicate of a live OAuth token — so
 * the tokens go. The dirs themselves are left (their history has just been turned
 * back into real files, and deleting user data on uninstall is not our call).
 */
function dropWorkingCredentials(home) {
  for (const dir of workingDirs(home)) {
    try {
      fs.rmSync(path.join(dir, '.credentials.json'), { force: true });
    } catch {
      // best-effort
    }
  }
}

function main() {
  // On unsupported platforms the extension never created anything (it activates
  // into an inert mode there), so there is nothing to revert — and guessing at
  // other OSes' file layouts on uninstall is exactly the kind of manipulation
  // the inert mode promises not to do.
  if (os.platform() !== 'linux') return;

  const home = os.homedir();
  // A short-lived earlier version kept credential copies here. Never leave tokens.
  try {
    fs.rmSync(path.join(home, '.claude-vault'), { recursive: true, force: true });
  } catch {
    // best-effort
  }

  const store = path.join(home, '.claude-shared');
  if (!fs.existsSync(store)) {
    dropWorkingCredentials(home); // still ours to clean up, sharing or not
    return;
  }

  let dirs = [];
  try {
    dirs = fs
      .readdirSync(home, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          /^\.claude([-_].+)?$/.test(e.name) &&
          e.name !== '.claude-shared' &&
          e.name !== '.claude-windows'
      )
      .map((e) => path.join(home, e.name));
  } catch {
    return;
  }
  // Working dirs are nested one level deeper, so the scan above misses them — and
  // they are exactly the dirs a window's conversations actually live in.
  dirs = dirs.concat(workingDirs(home));

  for (const dir of dirs) {
    for (const name of SHARED_ENTRIES) {
      const src = path.join(dir, name);
      const dst = path.join(store, name);
      try {
        const st = fs.lstatSync(src, { throwIfNoEntry: false });
        if (!st || !st.isSymbolicLink()) continue;
        if (path.normalize(fs.readlinkSync(src)) !== path.normalize(dst)) continue;
        fs.unlinkSync(src);
        if (fs.existsSync(dst)) fs.cpSync(dst, src, { recursive: true });
      } catch {
        // Best-effort: a failed entry just stays a symlink; Claude Code still
        // follows it, so nothing breaks — it only remains shared.
      }
    }
  }

  // Only after the history is real files again — otherwise a working dir would be
  // stripped of its token while its conversations were still dangling symlinks.
  dropWorkingCredentials(home);
}

main();
