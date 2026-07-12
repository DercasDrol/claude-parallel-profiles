import * as vscode from 'vscode';
import * as path from 'path';
import { Account } from './accounts';
import { log } from './log';

/**
 * Per-window binding of a Claude account.
 *
 * How isolation actually works
 * ────────────────────────────
 * Claude Code resolves its data directory from `process.env.CLAUDE_CONFIG_DIR`
 * (verified against the extension bundle: it builds the child env as
 * `{ ...process.env, ...claudeCode.environmentVariables }`). Each VSCode window
 * runs in its OWN remote extension host process, so `process.env` is
 * independent per window. By setting `process.env.CLAUDE_CONFIG_DIR` here, and
 * making sure the machine-scoped `claudeCode.environmentVariables` setting does
 * NOT also define it (that setting would override us), each window can point at
 * a different account simultaneously on a single WSL host.
 *
 * The active account for a window is remembered in workspaceState so it sticks
 * across reloads of the same workspace.
 */

const ACTIVE_KEY = 'claudeProfiles.activeAccount';
/** Global map: repo/workspace folder path → last account name used there. */
const REPO_MAP_KEY = 'claudeProfiles.repoAccounts';
const ENV_VAR = 'CLAUDE_CONFIG_DIR';

export class WindowBinding {
  /** Fires whenever the active account for this window changes. */
  readonly onDidChange = new vscode.EventEmitter<void>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Absolute path of this window's first workspace folder, if any. */
  private getRepoKey(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private getRepoMap(): Record<string, string> {
    return this.context.globalState.get<Record<string, string>>(REPO_MAP_KEY, {});
  }

  /**
   * The account name remembered for this window: the per-workspace value first,
   * then the global repo→account map (so reopening a repo restores its account
   * even on a fresh window). Undefined if never chosen.
   */
  getActiveName(): string | undefined {
    const fromWorkspace = this.context.workspaceState.get<string>(ACTIVE_KEY);
    if (fromWorkspace) return fromWorkspace;
    const repo = this.getRepoKey();
    return repo ? this.getRepoMap()[repo] : undefined;
  }

  /**
   * Forgets an account everywhere this binding could restore it from —
   * workspaceState, the repo→account map (all repos), and process.env if this
   * window currently points at it. Without the env release, a forgotten (and
   * possibly deleted-from-disk) dir would silently stay in use until reload.
   */
  async forget(account: Account): Promise<void> {
    if (this.context.workspaceState.get<string>(ACTIVE_KEY) === account.name) {
      await this.context.workspaceState.update(ACTIVE_KEY, undefined);
    }
    const map = this.getRepoMap();
    const filtered = Object.fromEntries(
      Object.entries(map).filter(([, v]) => v !== account.name)
    );
    if (Object.keys(filtered).length !== Object.keys(map).length) {
      await this.context.globalState.update(REPO_MAP_KEY, filtered);
    }
    const env = process.env[ENV_VAR];
    if (env && path.normalize(env) === path.normalize(account.dir)) {
      delete process.env[ENV_VAR];
    }
    this.onDidChange.fire();
  }

  /**
   * True when the active account came from the repo→account memory rather
   * than an explicit choice in this window — surfaced in the status bar so an
   * auto-selected account doesn't look like a mystery.
   */
  rememberedForFolder(): boolean {
    if (this.context.workspaceState.get<string>(ACTIVE_KEY)) return false;
    const repo = this.getRepoKey();
    return Boolean(repo && this.getRepoMap()[repo]);
  }

  /** The CLAUDE_CONFIG_DIR currently in this host's process env, if any. */
  getEnvDir(): string | undefined {
    return process.env[ENV_VAR];
  }

  /**
   * Binds this window to the given account: sets process.env so any `claude`
   * process spawned afterwards (e.g. a new conversation) uses this account's
   * data dir, and remembers the choice in workspaceState.
   *
   * Does NOT affect an already-running Claude session — the caller decides
   * whether to start a new conversation or reload the window.
   */
  async bind(account: Account): Promise<void> {
    log(`bind: ${account.name} → ${account.dir} (was ${process.env[ENV_VAR] ?? '(default)'})`);
    process.env[ENV_VAR] = account.dir;
    await this.context.workspaceState.update(ACTIVE_KEY, account.name);
    const repo = this.getRepoKey();
    if (repo) {
      const map = { ...this.getRepoMap(), [repo]: account.name };
      await this.context.globalState.update(REPO_MAP_KEY, map);
    }
    this.onDidChange.fire();
  }

  /** Applies the remembered account to process.env at activation time. */
  applyStored(resolve: (name: string) => Account | undefined): Account | undefined {
    const name = this.getActiveName();
    if (!name) return undefined;
    const account = resolve(name);
    if (!account) return undefined;
    process.env[ENV_VAR] = account.dir;
    return account;
  }

  /**
   * Ensures NO settings define CLAUDE_CONFIG_DIR, in ANY scope. Two sources
   * override our per-window process.env and make binding look like a no-op:
   *  - `claudeCode.environmentVariables` (Claude Code merges it OVER the
   *    process env when spawning `claude`) — must be purged from global,
   *    workspace and folder scopes, not just global;
   *  - `terminal.integrated.env.*` — v1.0.0 of this extension wrote
   *    CLAUDE_CONFIG_DIR there; it hijacks any `claude` run in a terminal.
   *
   * Returns true if anything was removed.
   */
  async clearMachineOverride(): Promise<boolean> {
    let cleared = false;
    const tryUpdate = async (
      cfg: vscode.WorkspaceConfiguration,
      key: string,
      value: unknown,
      target: vscode.ConfigurationTarget
    ) => {
      try {
        await cfg.update(key, value, target);
        cleared = true;
      } catch {
        /* scope unavailable (e.g. no workspace open) — nothing to clear there */
      }
    };

    const cfg = vscode.workspace.getConfiguration('claudeCode');
    const info = cfg.inspect<Array<{ name: string; value: string }>>('environmentVariables');
    const envScopes: Array<
      [Array<{ name: string; value: string }> | undefined, vscode.ConfigurationTarget]
    > = [
      [info?.globalValue, vscode.ConfigurationTarget.Global],
      [info?.workspaceValue, vscode.ConfigurationTarget.Workspace],
      [info?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
    ];
    for (const [value, target] of envScopes) {
      if (!value) continue;
      const filtered = value.filter((e) => e.name !== ENV_VAR);
      if (filtered.length === value.length) continue;
      await tryUpdate(cfg, 'environmentVariables', filtered.length ? filtered : undefined, target);
    }

    const term = vscode.workspace.getConfiguration('terminal.integrated');
    for (const key of ['env.linux', 'env.osx', 'env.windows']) {
      const tinfo = term.inspect<Record<string, string>>(key);
      const termScopes: Array<[Record<string, string> | undefined, vscode.ConfigurationTarget]> = [
        [tinfo?.globalValue, vscode.ConfigurationTarget.Global],
        [tinfo?.workspaceValue, vscode.ConfigurationTarget.Workspace],
        [tinfo?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
      ];
      for (const [value, target] of termScopes) {
        if (!value || !(ENV_VAR in value)) continue;
        const rest = { ...value };
        delete rest[ENV_VAR];
        await tryUpdate(term, key, Object.keys(rest).length ? rest : undefined, target);
      }
    }
    return cleared;
  }
}
