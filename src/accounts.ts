import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * An account = a Claude Code data directory (CLAUDE_CONFIG_DIR) that has been
 * logged in. Everything Claude Code needs lives inside it:
 *   <dir>/.claude.json        → config + oauthAccount identity
 *   <dir>/.credentials.json   → OAuth tokens (file-based on Linux/WSL)
 *
 * We NEVER touch ~/.claude.json (the global default) — isolation is achieved
 * purely by pointing each window's process.env.CLAUDE_CONFIG_DIR at a dir.
 */
export interface Account {
  /** Short, user-facing name (e.g. "work", "personal"). */
  name: string;
  /** Absolute CLAUDE_CONFIG_DIR path. */
  dir: string;
  /** Last known account email (cached for display; source of truth is the CLI). */
  email?: string;
}

/** Identity read live from <dir>/.claude.json. */
export interface AccountIdentity {
  email: string;
  displayName: string;
  organizationName?: string;
}

const REGISTRY_KEY = 'claudeProfiles.accounts';
/**
 * Accounts the user explicitly forgot. Their dirs stay on disk untouched (this
 * extension performs no destructive operations), so discovery must remember
 * NOT to re-add them — and a later save of the same email restores the entry
 * instead of snapshotting a duplicate of the same OAuth token.
 */
const FORGOTTEN_KEY = 'claudeProfiles.forgottenAccounts';

/** Parses oauthAccount identity out of a single .claude.json file. */
function readIdentityFile(file: string): AccountIdentity | null {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      oauthAccount?: {
        emailAddress?: string;
        displayName?: string;
        organizationName?: string;
      };
    };
    const o = raw.oauthAccount;
    if (!o?.emailAddress) return null;
    return {
      email: o.emailAddress,
      displayName: o.displayName ?? o.emailAddress,
      organizationName: o.organizationName,
    };
  } catch {
    return null;
  }
}

/**
 * Reads oauthAccount identity for a config dir. Named accounts keep it in
 * <dir>/.claude.json. The default ~/.claude is special: its config dir's
 * .claude.json has no oauthAccount — that identity lives in ~/.claude.json at
 * the home root — so we fall back to it. Without this fallback an unbound
 * window has no identity to paint and the status bar hangs on its spinner.
 */
export function readIdentity(dir: string): AccountIdentity | null {
  const own = readIdentityFile(path.join(dir, '.claude.json'));
  if (own) return own;
  if (path.normalize(dir) === path.normalize(path.join(os.homedir(), '.claude'))) {
    return readIdentityFile(path.join(os.homedir(), '.claude.json'));
  }
  return null;
}

/** True if the dir looks like a logged-in Claude Code config dir. */
export function hasCredentials(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.credentials.json'));
}

/** Expands a leading ~ to the home directory. */
export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * The account registry is stored in globalState so every window (and every
 * VSCode profile) on this machine sees the same set of accounts.
 */
export class AccountRegistry {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): Account[] {
    return this.context.globalState.get<Account[]>(REGISTRY_KEY, []);
  }

  get(name: string): Account | undefined {
    return this.list().find((a) => a.name === name);
  }

  getByDir(dir: string): Account | undefined {
    const norm = path.normalize(dir);
    return this.list().find((a) => path.normalize(a.dir) === norm);
  }

  async add(account: Account): Promise<void> {
    const list = this.list().filter((a) => a.name !== account.name);
    list.push(account);
    list.sort((a, b) => a.name.localeCompare(b.name));
    await this.context.globalState.update(REGISTRY_KEY, list);
  }

  async remove(name: string): Promise<void> {
    const list = this.list().filter((a) => a.name !== name);
    await this.context.globalState.update(REGISTRY_KEY, list);
  }

  listForgotten(): Account[] {
    return this.context.globalState.get<Account[]>(FORGOTTEN_KEY, []);
  }

  /** Moves an account from the registry to the forgotten list. Dir stays on disk. */
  async forget(account: Account): Promise<void> {
    await this.remove(account.name);
    const norm = path.normalize(account.dir);
    const rest = this.listForgotten().filter((a) => path.normalize(a.dir) !== norm);
    rest.push(account);
    await this.context.globalState.update(FORGOTTEN_KEY, rest);
  }

  /** Restores a previously forgotten account matching this email, if any. */
  async restoreForgotten(email: string): Promise<Account | undefined> {
    const list = this.listForgotten();
    const found = list.find((a) => (a.email ?? readIdentity(a.dir)?.email) === email);
    if (!found) return undefined;
    await this.context.globalState.update(
      FORGOTTEN_KEY,
      list.filter((a) => a !== found)
    );
    found.email = email;
    await this.add(found);
    return found;
  }

  /**
   * Discovers logged-in config dirs on disk (~/.claude-* and ~/.claude) and
   * merges any that aren't in the registry yet. Non-destructive.
   */
  async discoverAndMerge(): Promise<Account[]> {
    const home = os.homedir();
    const found: Account[] = [];
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(home, { withFileTypes: true });
    } catch {
      return this.list();
    }
    const forgotten = new Set(this.listForgotten().map((a) => path.normalize(a.dir)));
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // Only manage explicit .claude-<name> dirs. The bare ~/.claude default is
      // skipped: its identity lives in ~/.claude.json (home), not in the dir,
      // so it isn't a self-contained account.
      const m = /^\.claude[-_](.+)$/.exec(e.name);
      if (!m) continue;
      const dir = path.join(home, e.name);
      if (!hasCredentials(dir)) continue;
      // Explicitly forgotten dirs stay on disk — do not resurrect them.
      if (forgotten.has(path.normalize(dir))) continue;
      const name = m[1];
      if (this.getByDir(dir)) continue;
      found.push({ name, dir });
    }
    for (const acc of found) {
      // Avoid name collisions with existing registry entries.
      if (this.get(acc.name)) continue;
      await this.add(acc);
    }
    return this.list();
  }
}
