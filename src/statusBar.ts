import * as vscode from 'vscode';
import { AccountRegistry, readIdentity } from './accounts';
import { log } from './log';
import { WindowBinding } from './binding';
import { getAuthStatus, AuthStatus } from './cli';
import { defaultSourceDir } from './capture';

/**
 * Status bar item showing the account bound to THIS window. The displayed
 * identity is confirmed asynchronously via `claude auth status` (the real
 * token), so it never shows a stale identity when another window switches
 * accounts or when a config file drifts out of sync with the token.
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  /** Authoritative status per dir, filled in asynchronously. */
  private readonly statusCache = new Map<string, { status: AuthStatus | null; at: number }>();
  /**
   * How long a CLI confirmation stays trusted. The user can re-login inside
   * Claude Code itself at any moment (/login), which this extension can't
   * observe — so a cached identity must expire, or the status bar would show
   * the old account until the next reload.
   */
  private static readonly STATUS_TTL_MS = 60_000;

  constructor(
    private readonly registry: AccountRegistry,
    private readonly binding: WindowBinding
  ) {
    this.item = vscode.window.createStatusBarItem(
      'claudeProfiles.status',
      vscode.StatusBarAlignment.Right,
      90
    );
    this.item.command = 'claudeProfiles.showStatus';
    this.item.name = 'Claude Account';
    this.disposables.push(
      this.binding.onDidChange.event(() => {
        const dir = this.binding.getEnvDir();
        if (dir) this.statusCache.delete(dir); // force re-confirm after a switch
        this.refresh();
      }),
      // Coming back to the window is the natural moment the account may have
      // changed behind our back (e.g. /login in the Claude Code panel).
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) this.refresh();
      })
    );
  }

  initialize(): void {
    this.item.show();
    this.refresh();
  }

  /**
   * Force a re-confirmation of this window's account and repaint. Called by the
   * account watcher when an identity file changes, so the bar never lags behind
   * an account switch made in Claude Code.
   */
  reconfirm(): void {
    this.statusCache.delete(this.effectiveDir());
    this.refresh();
  }

  /**
   * The data dir this window's Claude Code is effectively using: the bound
   * account if any, otherwise the default ~/.claude. We always resolve to
   * something so the status bar reflects the *actual* active account, even
   * before the user has saved/bound anything.
   */
  private effectiveDir(): string {
    return this.binding.getEnvDir() ?? defaultSourceDir();
  }

  /** Dirs with a CLI confirmation currently in flight (dedupes focus events). */
  private readonly pendingDirs = new Set<string>();

  /** The CLI-confirmed status for a dir, if still fresh. */
  private cachedStatus(dir: string): AuthStatus | null | undefined {
    return this.statusCache.get(dir)?.status;
  }

  /** Renders from cache immediately, then confirms via the CLI in the background. */
  private refresh(): void {
    this.render();
    const dir = this.effectiveDir();
    const entry = this.statusCache.get(dir);
    if (entry && Date.now() - entry.at < StatusBarManager.STATUS_TTL_MS) return;
    // Each confirmation spawns a login shell + the claude CLI; window-focus
    // events can arrive in bursts, so never run two for the same dir at once.
    if (this.pendingDirs.has(dir)) return;
    this.pendingDirs.add(dir);
    void getAuthStatus(dir).then((status) => {
      this.pendingDirs.delete(dir);
      this.statusCache.set(dir, { status, at: Date.now() });
      this.render();
    });
  }

  private render(): void {
    const dir = this.effectiveDir();
    const active = this.binding.getActiveName();
    const savedName = this.registry.getByDir(dir)?.name;

    const status = this.cachedStatus(dir);
    // Prefer the CLI-confirmed email; fall back to the config file for instant
    // paint before the async confirmation lands.
    const email = status?.email ?? readIdentity(dir)?.email;
    const confirmed = status?.loggedIn === true;
    const notLoggedIn = status !== undefined && status?.loggedIn !== true && !email;

    if (email) {
      // The email IS the identity — no internal label in front of it. The only
      // extra glyph is ○ = "not saved yet"; its meaning is spelled out in the
      // tooltip. No spinner while re-confirming: a blinking icon next to a
      // perfectly fine account reads as a problem that isn't there.
      // "Saved" means this ACCOUNT (by email) is saved somewhere — not that
      // this exact dir is a registry entry. Otherwise a window sitting on the
      // default dir shows ○ even though the same account was already saved as a
      // named copy in another window.
      const savedByEmail = email ? this.registry.savedForEmail(email) : undefined;
      const isSaved = Boolean(savedName || active || savedByEmail);
      this.item.text = `$(account) ${email}${isSaved ? '' : ' $(circle-outline)'}`;
      // The tooltip doubles as the action menu: VSCode cannot anchor a real
      // menu to a status bar item, but a trusted-markdown hover CAN hold
      // command links — so the actions appear right above the button.
      // Count accounts by distinct email so a duplicated-email copy doesn't look
      // like a separate account to switch to.
      const unique = this.registry.listUniqueByEmail();
      const hasOthers = unique.some((a) => this.registry.emailOf(a) !== email);
      // The hover card is the FULL menu (incl. rare actions like Forget);
      // clicking the item fast-paths straight to the one meaningful action.
      const actions = [
        !isSaved ? '[$(save) Save this account](command:claudeProfiles.captureAccount "Save it so you can switch back to it later")' : '',
        hasOthers ? '[$(arrow-swap) Switch account](command:claudeProfiles.switchAccount "Pick another account for this window")' : '',
        unique.length > 0
          ? '[$(trash) Forget…](command:claudeProfiles.removeProfile "Hide a saved account from the list — nothing is deleted")'
          : '',
      ].filter(Boolean);
      const md = new vscode.MarkdownString(
        [
          `**${email}**${status?.subscriptionType ? ` · ${status.subscriptionType}` : ''}${status?.orgName ? ` · ${status.orgName}` : ''}`,
          `Data dir: \`${dir}\``,
          !isSaved ? '_$(circle-outline) This account is not saved yet — save it to switch back to it later._' : '',
          this.binding.rememberedForFolder()
            ? '_Auto-selected: this folder used this account last time._'
            : '',
          confirmed ? '' : '_Confirming with `claude auth status`…_',
          '',
          actions.join(' &nbsp;·&nbsp; '),
        ]
          .filter(Boolean)
          .join('\n\n')
      );
      md.isTrusted = true;
      md.supportThemeIcons = true;
      this.item.tooltip = md;
      this.item.backgroundColor = undefined;
    } else if (notLoggedIn) {
      // Reached both when genuinely logged out AND when the CLI call failed
      // (e.g. `claude` not on PATH) — we cannot tell these apart, so the
      // tooltip must not confidently claim "not signed in".
      this.item.text = '$(account) Claude: sign in';
      this.item.tooltip = new vscode.MarkdownString(
        `No signed-in Claude account detected for \`${dir}\`.\n\n` +
          `Sign in with Claude Code (Account menu → Login, or /login in a chat), then save the account here. ` +
          `If you ARE signed in, check that the \`claude\` CLI is available on PATH.`
      );
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      // Still confirming for the first time.
      this.item.text = '$(account) Claude $(sync~spin)';
      this.item.tooltip = new vscode.MarkdownString('Reading current Claude account…');
      this.item.backgroundColor = undefined;
    }
  }

  /**
   * Status bar click = the one action that makes sense right now, directly —
   * no intermediate action list (VSCode cannot anchor a popup to the status
   * bar anyway; the hover card is the full menu, including rare actions).
   */
  async onClick(): Promise<void> {
    const dir = this.effectiveDir();
    const status = this.cachedStatus(dir);
    const email = status?.email ?? readIdentity(dir)?.email;
    // Saved is by EMAIL, not by this exact dir: a window on the default dir can
    // still be an account that was saved (as a named copy) elsewhere.
    const savedByEmail = email ? this.registry.savedForEmail(email) : undefined;
    const others = this.registry
      .listUniqueByEmail()
      .filter((a) => this.registry.emailOf(a) !== email);
    log(
      `onClick: dir=${dir} email=${email ?? '(none)'} saved=${savedByEmail?.name ?? '(no)'} others=${others.length}`
    );

    // Don't claim "not signed in" while the very first CLI confirmation is
    // still running — that's a false alarm during the initial seconds.
    if (!email && !this.statusCache.has(dir)) {
      vscode.window.showInformationMessage(
        'Still reading the current Claude account — try again in a moment.'
      );
      return;
    }
    if (!email) {
      vscode.window.showWarningMessage(
        'No signed-in Claude account. Open the Claude Code panel and run /login, then click here to save it.'
      );
      return;
    }
    if (others.length > 0) {
      // There is something to switch to; the list includes "Save current…"
      // when the current account isn't saved yet.
      await vscode.commands.executeCommand('claudeProfiles.switchAccount');
      return;
    }
    if (!savedByEmail) {
      // Nothing to switch to, current account not saved → saving is the only move.
      await vscode.commands.executeCommand('claudeProfiles.captureAccount');
      return;
    }
    // Single saved account and it's the current one — teach the next step.
    vscode.window.showInformationMessage(
      `${email} is your only saved account. To add another one: sign in as it in Claude Code (/login), then click here to save it.`
    );
  }

  dispose(): void {
    this.item.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
