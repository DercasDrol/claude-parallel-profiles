import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Account, AccountRegistry, readIdentity } from './accounts';
import { WindowBinding } from './binding';
import { getAuthStatus } from './cli';
import { snapshotAccount, defaultSourceDir } from './capture';
import { ensureSharedHistory } from './sharedHistory';
import { listLiveConversations } from './diagnostics';

/**
 * User-facing flows, all driven from the extension — no terminal/CLI login.
 * You sign in / switch accounts using Claude Code's own UI; this extension
 * captures whatever account is currently active into a named account, and lets
 * you bind each window to one.
 */
export class SetupWizard {
  constructor(
    private readonly registry: AccountRegistry,
    private readonly binding: WindowBinding
  ) {}

  // ─── Capture the currently-signed-in account ────────────────────────────────

  /**
   * Reads the account Claude Code is currently signed in as (in this window's
   * data dir) and saves it. The email IS the account's identity — no name to
   * type: the directory slug is derived from it, and duplicates are detected
   * by email (a second snapshot of the same account would fork its OAuth
   * token, and a later refresh in one copy can invalidate the other).
   *
   * Returns the saved (or reused) account, or undefined if nothing was saved.
   * With `quiet`, success toasts are suppressed (for composite flows like
   * save-then-switch); warnings are always shown.
   */
  async captureCurrentAccount(opts: { quiet?: boolean } = {}): Promise<Account | undefined> {
    const sourceDir = this.binding.getEnvDir() ?? defaultSourceDir();

    const status = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Reading current Claude account…' },
      () => getAuthStatus(sourceDir)
    );

    if (!status?.loggedIn || !status.email) {
      vscode.window.showWarningMessage(
        'No signed-in Claude account detected in this window. Sign in with Claude Code first ' +
          '(Account menu → Login, or /login in a chat), then run "Save current account".'
      );
      return undefined;
    }

    // Already registered as this exact dir? Refresh its email and make sure
    // this window is actually bound to it (saving must never leave the window
    // in the "unsaved/unbound" state).
    const existingByDir = this.registry.getByDir(sourceDir);
    if (existingByDir) {
      existingByDir.email = status.email;
      await this.registry.add(existingByDir);
      await this.binding.bind(existingByDir);
      if (!opts.quiet) {
        vscode.window.showInformationMessage(
          `${status.email} is already saved — this window is bound to it.`
        );
      }
      return existingByDir;
    }

    // Same email already saved under another dir? Reuse it instead of taking a
    // second snapshot: two copies of one OAuth token invalidate each other on
    // refresh, which surfaces to the user as a random sign-out.
    const existingByEmail = this.registry
      .list()
      .find((a) => (a.email ?? readIdentity(a.dir)?.email) === status.email);
    if (existingByEmail) {
      // Refresh the saved copy's credentials from the live source before
      // rebinding, so we never land the window on a stale token.
      try {
        snapshotAccount(sourceDir, existingByEmail.dir, status);
      } catch {
        /* keep the existing copy as-is */
      }
      await this.binding.bind(existingByEmail);
      if (!opts.quiet) {
        vscode.window.showInformationMessage(
          `${status.email} is already saved — this window now uses that copy.`
        );
      }
      return existingByEmail;
    }

    // A previously forgotten copy of this account? Restore it — its dir is
    // still on disk (forget deletes nothing), and a fresh snapshot would fork
    // the OAuth token.
    const restored = await this.registry.restoreForgotten(status.email);
    if (restored) {
      try {
        snapshotAccount(sourceDir, restored.dir, status); // refresh credentials
      } catch {
        /* keep the existing copy as-is */
      }
      if (vscode.workspace.getConfiguration('claudeProfiles').get<boolean>('sharedHistory', true)) {
        ensureSharedHistory([restored.dir]);
      }
      await this.binding.bind(restored);
      if (!opts.quiet) {
        vscode.window.showInformationMessage(
          `${status.email} was restored from the forgotten list — this window is bound to it.`
        );
      }
      return restored;
    }

    // No name prompt: the email is the identity, the dir slug derives from it.
    // A slug is free only if no registry entry uses it AND its dir doesn't
    // already exist on disk (an unregistered leftover must not be overwritten).
    const name = suggestName(
      status.email,
      (n) => !this.registry.get(n) && !fs.existsSync(path.join(os.homedir(), `.claude-${n}`))
    );
    const targetDir = path.join(os.homedir(), `.claude-${name}`);
    try {
      snapshotAccount(sourceDir, targetDir, status);
    } catch (err) {
      vscode.window.showErrorMessage(`Could not save account: ${(err as Error).message}`);
      return undefined;
    }

    // Give the new account dir the shared history links right away, so
    // switching to it continues the current conversation instead of resetting.
    if (vscode.workspace.getConfiguration('claudeProfiles').get<boolean>('sharedHistory', true)) {
      ensureSharedHistory([targetDir]);
    }

    // Verify the snapshot authenticates as the same account.
    const check = await getAuthStatus(targetDir, 8000);
    if (check && check.email && check.email !== status.email) {
      vscode.window.showWarningMessage(
        `Saved, but the copy reports ${check.email} instead of ${status.email}. ` +
          'The source credentials may have changed mid-capture.'
      );
    }

    const account: Account = { name, dir: targetDir, email: status.email };
    await this.registry.add(account);
    // Bind immediately: the user saved the account this window is running on,
    // so the window should end up attached to the saved copy — same account,
    // same conversations (shared history), but now possible to return to.
    await this.binding.bind(account);
    if (!opts.quiet) {
      vscode.window.showInformationMessage(
        `Saved ${status.email} — this window is now bound to it.`
      );
    }
    return account;
  }

  // ─── Switch the current window's account ────────────────────────────────────

  async switchAccountInteractive(forceReload = false): Promise<void> {
    const accounts = this.registry.list();
    if (accounts.length === 0) {
      const pick = await vscode.window.showInformationMessage(
        'No saved accounts yet. Sign in with Claude Code, then save the current account.',
        'Save current account'
      );
      if (pick === 'Save current account') await this.captureCurrentAccount();
      return;
    }

    const activeName = this.binding.getActiveName();
    const currentDir = this.binding.getEnvDir() ?? defaultSourceDir();
    type Item = vscode.QuickPickItem & { account?: Account; capture?: boolean };
    // The email is the account's identity — lead with it; the dir is detail.
    const items: Item[] = accounts.map((a) => ({
      label: `${a.name === activeName ? '$(check) ' : '$(account) '}${a.email ?? readIdentity(a.dir)?.email ?? a.name}`,
      description: a.name === activeName ? 'current' : '',
      detail: a.dir,
      account: a,
    }));
    // Offer saving only when the current account actually isn't saved yet.
    if (!this.registry.getByDir(currentDir)) {
      items.push({ label: '$(save) Save current account…', capture: true });
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: forceReload
        ? 'Switch account for this window (will reload)'
        : 'Switch Claude account for this window',
      placeHolder: 'Pick the account this window should use',
    });
    if (!picked) return;
    if (picked.capture) {
      await this.captureCurrentAccount();
      return;
    }
    if (picked.account) {
      if (!(await this.maybeSaveCurrentBeforeSwitch(picked.account))) return; // cancelled
      await this.switchTo(picked.account, forceReload);
    }
  }

  /**
   * If the account this window is currently using isn't saved, switching away
   * would leave the user no way back to it from this extension. Offer to save
   * it first. Returns false if the user cancelled the switch entirely.
   */
  private async maybeSaveCurrentBeforeSwitch(target: Account): Promise<boolean> {
    const dir = this.binding.getEnvDir() ?? defaultSourceDir();
    if (this.registry.getByDir(dir)) return true; // already saved — nothing to lose
    if (path.normalize(dir) === path.normalize(target.dir)) return true;
    const email = readIdentity(dir)?.email;
    if (!email) return true; // not signed in — nothing to save
    const pick = await vscode.window.showWarningMessage(
      `The account this window uses now (${email}) is not saved. ` +
        `If you switch without saving, this extension won't be able to switch back to it.`,
      { modal: true },
      'Save it, then switch',
      'Switch without saving'
    );
    if (!pick) return false;
    if (pick === 'Save it, then switch') {
      // If saving failed or was aborted, do NOT proceed: the user explicitly
      // chose to keep a way back to this account.
      const saved = await this.captureCurrentAccount({ quiet: true });
      return Boolean(saved);
    }
    return true;
  }

  /**
   * Binds the window to the account by mutating this host's process.env. Claude
   * Code reads CLAUDE_CONFIG_DIR fresh per request, so the Usage panel and any
   * NEW conversation immediately use the new account. A conversation already in
   * progress keeps the account it was started with until you start a new one
   * (or enable reloadOnSwitch). Other windows are unaffected.
   */
  async switchTo(account: Account, forceReload = false): Promise<void> {
    await this.binding.bind(account);

    const cfg = vscode.workspace.getConfiguration('claudeProfiles');
    if (forceReload || cfg.get<boolean>('reloadOnSwitch', false)) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return;
    }

    // One toast, with the reload nuance explained exactly when it matters —
    // this replaces the separate "Switch + reload" menu item.
    const email = account.email ?? readIdentity(account.dir)?.email;
    const pick = await vscode.window.showInformationMessage(
      `This window now uses ${email ?? account.name}. New conversations switch immediately; ` +
        `a chat already in progress stays on the previous account until you start a new one.`,
      'Reload window'
    );
    if (pick === 'Reload window') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  // ─── Diagnostics: live conversations ────────────────────────────────────────

  /**
   * Shows every running Claude conversation subprocess and the account its
   * environment is pinned to (ground truth — a running chat can't change it).
   */
  async showLiveConversations(): Promise<void> {
    const convs = listLiveConversations();
    if (convs.length === 0) {
      vscode.window.showInformationMessage(
        'No live Claude conversations found (or /proc is unavailable on this platform).'
      );
      return;
    }

    // Resolve each unique dir to an email once.
    const dirs = [...new Set(convs.map((c) => c.dir))];
    const emails = new Map<string, string | undefined>();
    await Promise.all(
      dirs.map(async (d) => {
        const s = await getAuthStatus(d, 8000);
        emails.set(d, s?.email ?? this.registry.getByDir(d)?.email ?? undefined);
      })
    );

    const items = convs.map((c) => {
      const name = this.registry.getByDir(c.dir)?.name;
      const email = emails.get(c.dir);
      return {
        label: `$(comment-discussion) ${email ?? name ?? path.basename(c.dir)}`,
        description: `pid ${c.pid}${name ? ` · ${name}` : ''}`,
        detail: `${c.dir}${c.cwd ? `  ·  cwd: ${c.cwd}` : ''}`,
      } satisfies vscode.QuickPickItem;
    });

    await vscode.window.showQuickPick(items, {
      title: `Live Claude conversations (${convs.length})`,
      placeHolder: 'Each row = one running chat and the account it is pinned to',
    });
  }

  // ─── Remove an account ──────────────────────────────────────────────────────

  async removeAccountInteractive(): Promise<void> {
    const accounts = this.registry.list();
    if (accounts.length === 0) {
      vscode.window.showInformationMessage('No accounts to remove.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      accounts.map((a) => ({
        label: a.email ?? readIdentity(a.dir)?.email ?? a.name,
        description: a.dir,
        account: a,
      })),
      { title: 'Forget a saved account', placeHolder: 'Pick a saved account to forget (your Claude account itself is untouched)' }
    );
    if (!picked) return;

    // Forgetting is deliberately non-destructive: the extension's list and the
    // Claude Code data are separate worlds. The dir (credentials, settings,
    // any unshared history) stays on disk, running conversations keep working,
    // and re-saving the same email later restores the entry.
    const email = picked.account.email ?? picked.account.name;
    const usedHere = this.binding.getActiveName() === picked.account.name;
    const choice = await vscode.window.showWarningMessage(
      `Forget ${email}? It only disappears from this extension's list — the Claude account stays ` +
        `signed in, running conversations keep working, and its data directory remains on disk ` +
        `(${picked.account.dir}). Saving the same account later restores it.` +
        (usedHere ? '\n\nThis window is currently using it and will fall back to the default account.' : ''),
      { modal: true },
      'Forget'
    );
    if (choice !== 'Forget') return;

    await this.registry.forget(picked.account);
    // Release every reference: this window's env (so it really falls back to
    // the default) and the repo→account memory of every folder pointing at it.
    await this.binding.forget(picked.account);
    vscode.window.showInformationMessage(
      `Forgot ${email}. Its data directory is untouched — save the account again to restore it.`
    );
  }
}

/**
 * Derives a directory slug from an email. Tries the local part first; if that
 * is taken (same local part, different domain — daniil@gmail.com vs
 * daniil@work.dev), disambiguates with the domain instead of an opaque
 * counter: `daniil`, then `daniil-work-dev`. A numeric suffix is the last
 * resort only.
 */
function suggestName(email: string, available: (n: string) => boolean): string {
  const slug = (s: string) =>
    s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'account';
  const [local = 'account', domain = ''] = email.split('@');
  const candidates = [slug(local), domain ? slug(`${local}-${domain}`) : ''].filter(Boolean);
  for (const c of candidates) if (available(c)) return c;
  for (let i = 2; i < 100; i++) if (available(`${candidates[0]}${i}`)) return `${candidates[0]}${i}`;
  return candidates[0];
}
