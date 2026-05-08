import * as vscode from 'vscode';
import { ProfileManager } from './profileManager';
import { AccountManager } from './accountManager';
import { StatusBarManager } from './statusBar';
import { SetupWizard } from './setupWizard';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const profileManager = new ProfileManager(context);
  const accountManager = new AccountManager();
  const statusBar = new StatusBarManager(profileManager, accountManager);
  const wizard = new SetupWizard(profileManager, accountManager);

  // ── Register commands ──────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProfiles.setupProfile', () =>
      wizard.runSetup()
    ),
    vscode.commands.registerCommand('claudeProfiles.loginCurrentProfile', () =>
      wizard.runLoginForCurrentProfile()
    ),
    vscode.commands.registerCommand('claudeProfiles.captureAccount', () =>
      wizard.runCaptureForCurrentProfile()
    ),
    vscode.commands.registerCommand('claudeProfiles.restoreAccount', () =>
      wizard.runRestoreForCurrentProfile()
    ),
    vscode.commands.registerCommand('claudeProfiles.showStatus', () =>
      statusBar.showQuickPick()
    ),
    vscode.commands.registerCommand('claudeProfiles.removeProfile', () =>
      wizard.runRemoveForCurrentProfile()
    ),

    statusBar
  );

  // ── Initialize status bar ──────────────────────────────────────────────
  await statusBar.initialize();

  // ── On-activation: auto-restore and first-run hints ───────────────────
  const info = await profileManager.getProfileInfo();

  if (!info.isConfigured) {
    // Brand new profile or not yet set up → prompt once
    const firstRunKey = `claudeProfiles.firstRunShown.${info.vsCodeProfileHash ?? 'default'}`;
    const alreadyShown = context.globalState.get<boolean>(firstRunKey, false);
    if (!alreadyShown) {
      context.globalState.update(firstRunKey, true);
      const action = await vscode.window.showInformationMessage(
        'Claude Profiles: This VSCode profile does not have a Claude account configured. Set one up now?',
        'Setup Now',
        'Later'
      );
      if (action === 'Setup Now') {
        await wizard.runSetup();
      }
    }
  } else if (info.configDir) {
    // Profile IS configured — auto-restore if the setting is on
    const autoRestore = vscode.workspace
      .getConfiguration('claudeProfiles')
      .get<boolean>('autoRestore', true);

    if (autoRestore) {
      const result = accountManager.restoreToGlobal(info.configDir);
      if (result === 'restored') {
        // Silently restored — just refresh the status bar
        await statusBar.render();
      }
      // 'no-snapshot' means never logged in yet → leave alone
    }

    // If no account info captured yet, nudge the user
    const account = accountManager.getStoredAccountInfo(info.configDir);
    if (!account) {
      const firstLoginKey = `claudeProfiles.loginNudge.${info.vsCodeProfileHash ?? 'default'}`;
      const nudgeSeen = context.globalState.get<boolean>(firstLoginKey, false);
      if (!nudgeSeen) {
        context.globalState.update(firstLoginKey, true);
        const action = await vscode.window.showInformationMessage(
          `Claude Profiles: Profile "${info.name}" is configured but no account has been captured yet.`,
          'Login Now',
          'Later'
        );
        if (action === 'Login Now') {
          await wizard.runLoginForCurrentProfile();
        }
      }
    }
  }
}

export function deactivate(): void {
  // Nothing to clean up — subscriptions handle disposal automatically.
}
