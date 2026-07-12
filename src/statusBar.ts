import * as vscode from 'vscode';
import { AccountRegistry, readIdentity } from './accounts';
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
      const isSaved = Boolean(savedName || active);
      this.item.text = `$(account) ${email}${isSaved ? '' : ' $(circle-outline)'}`;
      // The tooltip doubles as the action menu: VSCode cannot anchor a real
      // menu to a status bar item, but a trusted-markdown hover CAN hold
      // command links — so the actions appear right above the button.
      const hasOthers = this.registry.list().some((a) => a.name !== (savedName ?? active));
      const actions = [
        !isSaved ? '[$(save) Save this account](command:claudeProfiles.captureAccount "Save it so you can switch back to it later")' : '',
        hasOthers ? '[$(arrow-swap) Switch account](command:claudeProfiles.switchAccount "Pick another account for this window")' : '',
        '[$(comment-discussion) Live conversations](command:claudeProfiles.showConversations "Which account each running chat uses")',
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
   * Context-aware action menu. Identity lives in the title (not a selectable
   * row), and only actions that make sense right now are offered: no switch
   * when there is nothing to switch to, no "forget" when nothing is saved.
   */
  async showQuickPick(): Promise<void> {
    type Item = vscode.QuickPickItem & { action: string };
    const dir = this.effectiveDir();
    const status = this.cachedStatus(dir);
    const email = status?.email ?? readIdentity(dir)?.email;
    const savedHere = this.registry.getByDir(dir);
    const accounts = this.registry.list();
    const others = accounts.filter((a) => a.name !== savedHere?.name);

    const items: Item[] = [];
    if (!email) {
      // Don't claim "not signed in" while the very first CLI confirmation is
      // still running — that's a false alarm during the initial seconds.
      items.push(
        this.statusCache.has(dir)
          ? {
              label: '$(info) Not signed in',
              description: 'Open the Claude Code panel and run /login, then save the account here',
              action: 'noop',
            }
          : {
              label: '$(sync~spin) Reading current Claude account…',
              description: 'Try again in a moment',
              action: 'noop',
            }
      );
    }
    if (email && !savedHere) {
      items.push({
        label: '$(save) Save this account',
        description: `Remember ${email} so you can switch back to it later`,
        action: 'capture',
      });
    }
    if (others.length > 0) {
      // Single switch entry: the switch toast offers a window reload right
      // when that nuance becomes relevant.
      items.push({
        label: '$(arrow-swap) Switch account for this window',
        description: 'New conversations switch immediately; a running chat keeps its account',
        action: 'switch',
      });
    }
    items.push({
      label: '$(comment-discussion) Show live conversations & accounts',
      description: 'Which account each running chat is pinned to',
      action: 'conversations',
    });
    if (accounts.length > 0) {
      items.push({
        label: '$(trash) Forget a saved account…',
        description: 'Hides it from this list — nothing is deleted; save it again later to restore',
        action: 'remove',
      });
    }

    const title = email
      ? `Claude: ${email}${status?.subscriptionType ? ` · ${status.subscriptionType}` : ''}${savedHere ? ' (saved)' : ' (not saved)'}`
      : 'Claude Account (this window)';
    const picked = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: 'Select an action',
    });
    if (!picked || picked.action === 'noop') return;

    const map: Record<string, string> = {
      switch: 'claudeProfiles.switchAccount',
      capture: 'claudeProfiles.captureAccount',
      conversations: 'claudeProfiles.showConversations',
      remove: 'claudeProfiles.removeProfile',
    };
    if (map[picked.action]) await vscode.commands.executeCommand(map[picked.action]);
  }

  dispose(): void {
    this.item.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
