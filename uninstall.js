// vscode:uninstall hook — runs via plain `node` when the extension is
// uninstalled (no vscode API available).
//
// The contract: leave the machine as if the extension had never been installed,
// and leave Claude Code WORKING.
//
//   1. All conversation history is consolidated into the default ~/.claude.
//   2. The last-used account is handed back to vanilla Claude Code, so the user
//      is still signed in after the uninstall.
//   3. Everything this extension created is deleted — no stray OAuth tokens, no
//      duplicated history, no leftover directories.
//
// Vanilla Claude Code (with CLAUDE_CONFIG_DIR unset) reads its token from
// ~/.claude/.credentials.json and its identity/config from ~/.claude.json at the
// HOME ROOT — verified empirically, and NOT the same layout as a CLAUDE_CONFIG_DIR
// account, where both live inside the dir. Restoring to the wrong one would leave
// Claude Code silently signed out, which is the bug this hook exists to prevent.
//
// Nothing here may throw: a failed uninstall hook leaves the user with a
// half-cleaned home directory and no way to re-run it.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Kept in sync with SHARED_DIRS + SHARED_FILES in src/sharedHistory.ts. */
const SHARED_DIRS = [
  'projects',
  'sessions',
  'session-env',
  'shell-snapshots',
  'file-history',
  'plans',
  'todos',
];
const SHARED_FILES = ['history.jsonl'];
const SHARED_ENTRIES = [...SHARED_DIRS, ...SHARED_FILES];

/** The per-window working dirs this extension creates (~/.claude-windows/<id>). */
function workingDirs(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

/**
 * The account stores the extension manages, as recorded by the registry.
 *
 * Only these are ever deleted. A `~/.claude-<name>` dir NOT in the manifest was
 * made by the user (or another tool) and is none of our business — guessing from
 * the name alone is how an uninstall destroys someone's data.
 */
function managedStores(home, manifestFile) {
  let stores;
  try {
    stores = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')).stores;
  } catch {
    return []; // no manifest → delete no stores (fail safe)
  }
  if (!Array.isArray(stores)) return [];
  const home_ = path.normalize(home);
  return stores.filter((dir) => {
    if (typeof dir !== 'string') return false;
    const norm = path.normalize(dir);
    // Must be a `~/.claude-<name>` dir directly under home. Never the default
    // account, never the store or the working root (handled separately).
    if (path.dirname(norm) !== home_) return false;
    const base = path.basename(norm);
    if (!/^\.claude[-_].+$/.test(base)) return false;
    return base !== '.claude-shared' && base !== '.claude-windows';
  });
}

/** Byte equality, size-gated so the common "differs" case never reads a file. */
function sameContent(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * Folds `src` into `dst`, keeping the newer file on a collision and dropping
 * byte-identical duplicates outright. Same rules as the extension's own merge,
 * minus the backup: by the time this runs, the copies being folded in are the
 * ones we are about to delete, and their content ends up in `dst` either way.
 */
function mergeDirInto(src, dst) {
  let entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    try {
      const dstStat = fs.lstatSync(d, { throwIfNoEntry: false });
      if (!dstStat) {
        fs.renameSync(s, d);
      } else if (entry.isDirectory() && dstStat.isDirectory()) {
        mergeDirInto(s, d);
      } else if (sameContent(s, d)) {
        fs.rmSync(s, { force: true });
      } else if (fs.statSync(s).mtimeMs > dstStat.mtimeMs) {
        fs.rmSync(d, { recursive: true, force: true });
        fs.renameSync(s, d);
      }
    } catch {
      // Best-effort per entry: one unreadable file must not abandon the rest.
    }
  }
}

/** Folds a line-based file (history.jsonl) into `dst`, skipping lines it has. */
function mergeFileInto(src, dst) {
  try {
    const existing = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf-8') : '';
    const known = new Set(existing.split('\n').filter(Boolean));
    const incoming = fs
      .readFileSync(src, 'utf-8')
      .split('\n')
      .filter((line) => line && !known.has(line));
    if (incoming.length > 0) {
      const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(dst, `${prefix}${incoming.join('\n')}\n`, { mode: 0o600 });
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Brings every trace of the history into the default dir.
 *
 * The shared store is MOVED, not copied — a rename within the same filesystem is
 * instant and needs no free space, where a copy of a multi-gigabyte transcript
 * archive is neither. Where a rename cannot work (the store and the home dir on
 * different filesystems, a permission quirk), it falls back to a copy.
 *
 * Returns true only if EVERY entry made it across. The caller must not delete the
 * store otherwise: by then the symlinks that pointed at it are already gone, so a
 * silently-swallowed failure plus a confident `rm -rf` is how an uninstall eats
 * years of transcripts.
 */
function consolidateHistory(defaultDir, store, otherDirs) {
  let complete = true;
  fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });

  // Every dir's entries are symlinks into the store while sharing is on. Drop
  // them all first: they are about to dangle, and the default dir must be free
  // for the store's real content to take its place.
  for (const dir of [defaultDir, ...otherDirs]) {
    for (const name of SHARED_ENTRIES) {
      const p = path.join(dir, name);
      try {
        const st = fs.lstatSync(p, { throwIfNoEntry: false });
        if (st && st.isSymbolicLink()) fs.unlinkSync(p);
      } catch {
        /* best-effort */
      }
    }
  }

  // The store holds the union of every account's history — move it into place.
  for (const name of SHARED_ENTRIES) {
    const src = path.join(store, name);
    const dst = path.join(defaultDir, name);
    try {
      if (!fs.existsSync(src)) continue;
      if (!fs.existsSync(dst)) {
        try {
          fs.renameSync(src, dst);
        } catch {
          // Cross-device or permission: copy instead. Slower, but the alternative
          // is losing the entry when the store is deleted below.
          fs.cpSync(src, dst, { recursive: true });
        }
      } else if (SHARED_FILES.includes(name)) {
        mergeFileInto(src, dst);
      } else {
        mergeDirInto(src, dst);
      }
    } catch {
      complete = false;
    }
  }

  // Versions up to 1.2.7 had a setting that turned sharing off, leaving real
  // history inside the dirs which the store never saw. Fold it in too, or
  // uninstalling one of those installs would delete it.
  for (const dir of otherDirs) {
    for (const name of SHARED_ENTRIES) {
      const src = path.join(dir, name);
      const dst = path.join(defaultDir, name);
      try {
        const st = fs.lstatSync(src, { throwIfNoEntry: false });
        if (!st) continue;
        if (st.isDirectory()) mergeDirInto(src, dst);
        else if (st.isFile()) {
          if (fs.existsSync(dst)) mergeFileInto(src, dst);
          else fs.renameSync(src, dst);
        }
      } catch {
        complete = false;
      }
    }
  }
  return complete;
}

/**
 * The dir holding the account to hand back: the freshest OAuth token on disk.
 *
 * Working dirs come first because they are where Claude Code actually ran — their
 * token may have been refreshed since the store was written, and their config is
 * the live one. Ties go to whichever was touched last, which is the account the
 * user was using when they uninstalled.
 */
function lastUsedDir(working, stores) {
  const freshest = (dirs) => {
    let best;
    let bestTime = -1;
    for (const dir of dirs) {
      try {
        const t = fs.statSync(path.join(dir, '.credentials.json')).mtimeMs;
        if (t > bestTime) {
          bestTime = t;
          best = dir;
        }
      } catch {
        // no token here — not a candidate
      }
    }
    return best;
  };
  // Working dirs are strictly better sources when they exist: their token is the
  // one Claude Code actually refreshed, and their config is the live one (the
  // store's config is only ever a snapshot from when the account was saved).
  return freshest(working) ?? freshest(stores);
}

/**
 * Hands the account back to vanilla Claude Code: token into ~/.claude, identity
 * into ~/.claude.json. Both come from the SAME dir — an identity paired with
 * another account's token is the exact desync this extension was built to fix.
 *
 * The config is merged over whatever ~/.claude.json already had rather than
 * replacing it, so per-project settings that predate the extension survive.
 */
function restoreDefaultAccount(source, defaultDir, defaultConfig) {
  try {
    const token = path.join(source, '.credentials.json');
    if (!fs.existsSync(token)) return;
    fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
    const dstToken = path.join(defaultDir, '.credentials.json');
    fs.copyFileSync(token, dstToken);
    fs.chmodSync(dstToken, 0o600);

    const cfgFile = path.join(source, '.claude.json');
    if (!fs.existsSync(cfgFile)) return;
    const incoming = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(defaultConfig, 'utf-8'));
    } catch {
      // no default config yet, or unreadable — the account's is all we need
    }
    const merged = {
      ...existing,
      ...incoming,
      projects: { ...(existing.projects || {}), ...(incoming.projects || {}) },
    };
    const tmp = `${defaultConfig}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, defaultConfig); // atomic: a half-written config bricks Claude Code
  } catch {
    /* best-effort */
  }
}

function main() {
  // On unsupported platforms the extension never created anything (it activates
  // into an inert mode there), so there is nothing to revert — and guessing at
  // other OSes' file layouts on uninstall is exactly the kind of manipulation
  // the inert mode promises not to do.
  if (os.platform() !== 'linux') return;

  const home = os.homedir();
  const defaultDir = path.join(home, '.claude');
  const defaultConfig = path.join(home, '.claude.json');
  const store = path.join(home, '.claude-shared');
  const workRoot = path.join(home, '.claude-windows');

  const working = workingDirs(workRoot);
  const stores = managedStores(home, path.join(workRoot, '.manifest.json'));
  const ours = [...working, ...stores];

  // Order matters: the account must be captured before its dir is emptied, and
  // the history moved out before anything is deleted.
  const source = lastUsedDir(working, stores);
  const consolidated = consolidateHistory(defaultDir, store, ours);
  if (source) restoreDefaultAccount(source, defaultDir, defaultConfig);

  // Our dirs now hold nothing but duplicated credentials and config, so they go
  // regardless — leaving a stray OAuth token behind is the one outcome worse than
  // leaving an empty folder. A short-lived earlier version also kept token copies
  // in ~/.claude-vault.
  const doomed = [...ours, workRoot, path.join(home, '.claude-vault')];
  // The store only goes if EVERY entry of it reached ~/.claude. If anything was
  // left behind, it is now the only copy of that history — keep it.
  if (consolidated) doomed.push(store);
  for (const dir of doomed) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

main();
