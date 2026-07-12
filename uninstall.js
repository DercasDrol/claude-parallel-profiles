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

function main() {
  const home = os.homedir();
  const store = path.join(home, '.claude-shared');
  if (!fs.existsSync(store)) return; // sharing was never enabled

  let dirs = [];
  try {
    dirs = fs
      .readdirSync(home, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\.claude([-_].+)?$/.test(e.name) && e.name !== '.claude-shared')
      .map((e) => path.join(home, e.name));
  } catch {
    return;
  }

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
}

main();
