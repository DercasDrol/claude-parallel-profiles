import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Subset of ~/.claude.json that we care about */
interface DotClaudeJson {
  oauthAccount?: {
    emailAddress?: string;
    displayName?: string;
    organizationName?: string;
    organizationUuid?: string;
    accountUuid?: string;
  };
  userID?: string;
  [key: string]: unknown;
}

export interface AccountInfo {
  email: string;
  displayName: string;
  organizationName?: string;
  savedAt: string;
}

/** File stored inside CLAUDE_CONFIG_DIR to hold account display info + full auth state */
const PROFILE_STATE_FILE = '.vscode-claude-profile.json';

/** The global Claude auth/config file (fallback when no CLAUDE_CONFIG_DIR) */
const GLOBAL_DOT_CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

/** Returns the .claude.json path for a given configDir (profile-specific auth file) */
function profileDotClaudeJson(configDir: string): string {
  return path.join(configDir, '.claude.json');
}

interface ProfileStateFile {
  account: AccountInfo;
  /** Full snapshot of ~/.claude.json captured after login */
  dotClaudeJsonSnapshot: Record<string, unknown>;
}

export class AccountManager {
  private loginInProgress = false;

  /** Emitted after account info changes so the status bar can update */
  readonly onAccountChanged = new vscode.EventEmitter<void>();

  // ─── Read ────────────────────────────────────────────────────────────────

  /**
   * For display purposes: tries live configDir/.claude.json first (most accurate),
   * then falls back to the stored .vscode-claude-profile.json state.
   * Use this for the status bar and quick pick — it always reflects the actual login.
   */
  getAccountInfoForDisplay(configDir: string): AccountInfo | null {
    const live = this.readDotClaudeJson(profileDotClaudeJson(configDir));
    if (live?.account) return live.account;
    return this.getStoredAccountInfo(configDir);
  }

  /** Returns stored account info for the given CLAUDE_CONFIG_DIR, or null if not set up. */
  getStoredAccountInfo(configDir: string): AccountInfo | null {
    const stateFile = path.join(configDir, PROFILE_STATE_FILE);
    if (!fs.existsSync(stateFile)) return null;
    try {
      const parsed: ProfileStateFile = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      return parsed.account ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Reads a .claude.json file at the given path and extracts account info.
   * Returns null if the file doesn't exist or has no account.
   */
  readDotClaudeJson(filePath: string): { account: AccountInfo | null; raw: DotClaudeJson } | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw: DotClaudeJson = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const oauth = raw.oauthAccount;
      if (!oauth?.emailAddress) return { account: null, raw };
      return {
        account: {
          email: oauth.emailAddress,
          displayName: oauth.displayName ?? oauth.emailAddress,
          organizationName: oauth.organizationName,
          savedAt: new Date().toISOString(),
        },
        raw,
      };
    } catch {
      return null;
    }
  }

  // ─── Capture (after login) ────────────────────────────────────────────────

  /**
   * Reads current $CLAUDE_CONFIG_DIR/.claude.json and saves account info into
   * the profile's state file. Falls back to ~/.claude.json if the profile file
   * has no account yet.
   * Returns the captured AccountInfo or null if capture failed.
   */
  captureToProfileDir(configDir: string): AccountInfo | null {
    // Prefer the profile-specific auth file; fall back to global
    const profileFile = profileDotClaudeJson(configDir);
    const result = this.readDotClaudeJson(profileFile) ?? this.readDotClaudeJson(GLOBAL_DOT_CLAUDE_JSON);
    if (!result) return null;
    const { account, raw } = result;
    if (!account) return null;

    const state: ProfileStateFile = {
      account,
      dotClaudeJsonSnapshot: raw as Record<string, unknown>,
    };

    const stateFile = path.join(configDir, PROFILE_STATE_FILE);
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    this.onAccountChanged.fire();
    return account;
  }

  /** Allows manually saving account info without reading ~/.claude.json. */
  saveManualAccountInfo(configDir: string, account: AccountInfo): void {
    const stateFile = path.join(configDir, PROFILE_STATE_FILE);
    let existing: Partial<ProfileStateFile> = {};
    if (fs.existsSync(stateFile)) {
      try { existing = JSON.parse(fs.readFileSync(stateFile, 'utf-8')); } catch { /* ignore */ }
    }
    const state: ProfileStateFile = {
      account,
      dotClaudeJsonSnapshot: existing.dotClaudeJsonSnapshot ?? {},
    };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    this.onAccountChanged.fire();
  }

  // ─── Restore (on profile switch) ─────────────────────────────────────────

  /**
   * Restores the saved ~/.claude.json snapshot for configDir back to the global
   * ~/.claude.json. This lets Claude Code pick up the right account on next start.
   *
   * Returns 'restored' | 'no-snapshot' | 'error'.
   */
  restoreToGlobal(configDir: string): 'restored' | 'no-snapshot' | 'error' {
    const stateFile = path.join(configDir, PROFILE_STATE_FILE);
    if (!fs.existsSync(stateFile)) return 'no-snapshot';
    try {
      const state: ProfileStateFile = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      if (!state.dotClaudeJsonSnapshot || Object.keys(state.dotClaudeJsonSnapshot).length === 0) {
        return 'no-snapshot';
      }
      // Back up current global file before overwriting
      if (fs.existsSync(GLOBAL_DOT_CLAUDE_JSON)) {
        fs.copyFileSync(
          GLOBAL_DOT_CLAUDE_JSON,
          `${GLOBAL_DOT_CLAUDE_JSON}.bak`
        );
      }
      fs.writeFileSync(
        GLOBAL_DOT_CLAUDE_JSON,
        JSON.stringify(state.dotClaudeJsonSnapshot, null, 2),
        { mode: 0o600 }
      );
      this.onAccountChanged.fire();
      return 'restored';
    } catch {
      return 'error';
    }
  }

  // ─── Remove ───────────────────────────────────────────────────────────────

  removeProfileState(configDir: string): void {
    const stateFile = path.join(configDir, PROFILE_STATE_FILE);
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    this.onAccountChanged.fire();
  }

  // ─── Login-flow watcher ───────────────────────────────────────────────────

  /**
   * Watches $CLAUDE_CONFIG_DIR/.claude.json (and ~/.claude.json as fallback) for
   * changes. When a change is detected while a login is in progress, auto-captures
   * to configDir. Returns a disposable to stop watching.
   */
  watchForLogin(
    configDir: string,
    onCaptured: (account: AccountInfo) => void
  ): vscode.Disposable {
    this.loginInProgress = true;

    // Watch the profile-specific .claude.json (where Claude Code writes auth
    // when CLAUDE_CONFIG_DIR is set), plus the global fallback.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(configDir, '.claude.json'),
      false, // create
      false, // change
      true   // delete — ignore
    );
    const globalWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(os.homedir(), '.claude.json'),
      false,
      false,
      true
    );

    const handleChange = () => {
      if (!this.loginInProgress) return;
      // Small delay so Claude Code finishes writing the file
      setTimeout(() => {
        const account = this.captureToProfileDir(configDir);
        if (account) {
          this.loginInProgress = false;
          onCaptured(account);
        }
      }, 500);
    };

    watcher.onDidCreate(handleChange);
    watcher.onDidChange(handleChange);
    globalWatcher.onDidCreate(handleChange);
    globalWatcher.onDidChange(handleChange);

    return {
      dispose: () => {
        watcher.dispose();
        globalWatcher.dispose();
      },
    };
  }

  stopLoginWatch(): void {
    this.loginInProgress = false;
  }
}
