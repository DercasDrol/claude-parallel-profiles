import * as vscode from 'vscode';
import { AccountRegistry } from './accounts';
import { WindowBinding } from './binding';
import { StatusBarManager } from './statusBar';
import { SetupWizard } from './setupWizard';
import { ensureSharedHistory, unshareHistory, sharedStoreDir } from './sharedHistory';
import { defaultSourceDir } from './capture';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const registry = new AccountRegistry(context);
  const binding = new WindowBinding(context);
  const wizard = new SetupWizard(registry, binding);
  const statusBar = new StatusBarManager(registry, binding);

  // Bind this window to its remembered account FIRST and synchronously, so
  // process.env.CLAUDE_CONFIG_DIR is set before Claude Code spawns `claude`
  // (both extensions activate on startup — minimise the race window).
  let bound = binding.applyStored((name) => registry.get(name));

  // ── The critical fix ───────────────────────────────────────────────────────
  // The machine-scoped `claudeCode.environmentVariables` setting is shared by
  // every window on this host; if it defines CLAUDE_CONFIG_DIR it overrides our
  // per-window process.env and forces all windows onto one account. Clear it so
  // isolation flows through process.env instead.
  const cleared = await binding.clearMachineOverride();

  // Pick up any accounts already logged in on disk, then retry binding in case
  // the remembered account was only discovered just now.
  await registry.discoverAndMerge();
  if (!bound) bound = binding.applyStored((name) => registry.get(name));

  // Shared history: symlink every account's projects/sessions/… to one store so
  // a conversation survives an account switch. Do this BEFORE Claude Code reads
  // the dir, otherwise the first paint of the panel would show empty history.
  // With the setting off, the same pass reverts any leftover links to real
  // copies, so toggling the setting (in either direction) is always honoured.
  // Forgotten accounts' dirs are included: they stay on disk, so they must
  // follow the shared-history mode too (especially the un-share pass —
  // otherwise they'd keep dangling symlinks into the store).
  const allDirs = (): string[] => [
    defaultSourceDir(),
    ...registry.list().map((a) => a.dir),
    ...registry.listForgotten().map((a) => a.dir),
  ];
  const applySharedHistory = (announce: boolean): void => {
    const on = vscode.workspace
      .getConfiguration('claudeProfiles')
      .get<boolean>('sharedHistory', true);
    const warnings = on ? ensureSharedHistory(allDirs()) : unshareHistory(allDirs());
    if (warnings.length > 0) {
      vscode.window.showWarningMessage(
        `Claude Accounts: shared history ${on ? 'migration' : 'restore'} hit ${warnings.length} issue(s); ` +
          `will retry on next reload. First: ${warnings[0]}`
      );
    } else if (announce) {
      vscode.window.showInformationMessage(
        on
          ? 'Claude Accounts: conversation history is now shared across accounts.'
          : `Claude Accounts: history un-shared — each account got its own full copy. ` +
            `The shared store (${sharedStoreDir()}) is kept as a backup; delete it manually if unwanted.`
      );
    }
  };
  applySharedHistory(false);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProfiles.switchAccount', () =>
      wizard.switchAccountInteractive()
    ),
    vscode.commands.registerCommand('claudeProfiles.switchAccountReload', () =>
      wizard.switchAccountInteractive(true)
    ),
    vscode.commands.registerCommand('claudeProfiles.captureAccount', () =>
      wizard.captureCurrentAccount()
    ),
    vscode.commands.registerCommand('claudeProfiles.showConversations', () =>
      wizard.showLiveConversations()
    ),
    vscode.commands.registerCommand('claudeProfiles.removeProfile', () =>
      wizard.removeAccountInteractive()
    ),
    vscode.commands.registerCommand('claudeProfiles.showStatus', () =>
      statusBar.showQuickPick()
    ),
    // React to the user flipping claudeProfiles.sharedHistory at runtime.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeProfiles.sharedHistory')) applySharedHistory(true);
    }),
    statusBar
  );

  statusBar.initialize();

  if (cleared) {
    vscode.window.showInformationMessage(
      'Claude Accounts: removed CLAUDE_CONFIG_DIR from the shared machine setting. ' +
        'Isolation now works per-window. Pick this window\'s account from the status bar.'
    );
  }

  // First-run: no account bound to this window yet.
  if (!bound) {
    const key = 'claudeProfiles.introShown';
    if (!context.globalState.get<boolean>(key, false)) {
      await context.globalState.update(key, true);
      const accounts = registry.list();
      const msg = accounts.length
        ? 'Claude Accounts: pick which account this window should use.'
        : 'Claude Accounts: no saved accounts yet. Sign in with Claude Code, then save the current account.';
      const pick = await vscode.window.showInformationMessage(
        msg,
        accounts.length ? 'Choose account' : 'Save current account'
      );
      if (pick === 'Choose account') await wizard.switchAccountInteractive();
      else if (pick === 'Save current account') await wizard.captureCurrentAccount();
    }
  }
}

export function deactivate(): void {
  /* nothing to clean up */
}
