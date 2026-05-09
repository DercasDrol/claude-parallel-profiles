import * as vscode from 'vscode';
import * as fs from 'fs';
import { ProfileManager } from './profileManager';
import { AccountManager, AccountInfo } from './accountManager';

export class SetupWizard {
  constructor(
    private readonly profileManager: ProfileManager,
    private readonly accountManager: AccountManager
  ) {}

  // ─── Full profile setup ───────────────────────────────────────────────────

  async runSetup(): Promise<void> {
    const info = await this.profileManager.getProfileInfo();

    const currentName = info.isConfigured ? info.name : undefined;

    const name = await vscode.window.showInputBox({
      title: 'Claude Profiles: Setup — Step 1 of 2',
      prompt:
        'Enter a short name for this VSCode profile (used to name the data directory).',
      value: currentName,
      placeHolder: 'work',
      validateInput: (val) => {
        if (!val || !/^[a-z0-9][a-z0-9-]*$/i.test(val)) {
          return 'Use letters, numbers, and hyphens only (no spaces). Must start with a letter or number.';
        }
        return null;
      },
    });
    if (!name) return;

    const configDir = await this.profileManager.setupConfigDir(name);

    const action = await vscode.window.showInformationMessage(
      `Profile "${name}" configured.\n\nData directory: ${configDir}\n\nYou can now log in to Claude for this profile.`,
      'Login to Claude now',
      'Later'
    );
    if (action === 'Login to Claude now') {
      await this.runLogin(configDir, name);
    }
  }

  // ─── Login flow ───────────────────────────────────────────────────────────

  async runLoginForCurrentProfile(): Promise<void> {
    const info = await this.profileManager.getProfileInfo();
    if (!info.isConfigured || !info.configDir) {
      const answer = await vscode.window.showWarningMessage(
        'No CLAUDE_CONFIG_DIR configured for this VSCode profile.',
        'Setup Now',
        'Cancel'
      );
      if (answer === 'Setup Now') await this.runSetup();
      return;
    }
    await this.runLogin(info.configDir, info.name);
  }

  private async runLogin(configDir: string, profileName: string): Promise<void> {
    // Open a terminal pre-loaded with CLAUDE_CONFIG_DIR so `claude login`
    // writes tokens to the profile-specific Keychain entry and account data
    // to ~/.claude.json (which we then capture into configDir).
    const terminal = vscode.window.createTerminal({
      name: `Claude Login — ${profileName}`,
      env: { CLAUDE_CONFIG_DIR: configDir },
      // macOS: inherit the user's shell so PATH is correct
      shellPath: process.env.SHELL,
    });
    terminal.show();
    terminal.sendText('claude login', false);

    // Start watching ~/.claude.json for the change that signals login success.
    // The watcher auto-captures auth data into configDir when detected.
    const watcherDisposable = this.accountManager.watchForLogin(configDir, (account) => {
      watcherDisposable.dispose();
      vscode.window.showInformationMessage(
        `Claude Profiles: Logged in as ${account.displayName} (${account.email}) for profile "${profileName}". Account data saved to ${configDir}.`
      );
    });

    // Show a manual fallback in case the watcher misses the event (e.g. file
    // was written before the watcher started).
    const fallback = await vscode.window.showInformationMessage(
      `Terminal opened with CLAUDE_CONFIG_DIR=${configDir}.\n\nPress Enter in the terminal to start the Claude OAuth flow. After completing login, click "Done" if the status bar hasn't updated automatically.`,
      'Done — Capture Now',
      'Cancel'
    );

    if (fallback === 'Done — Capture Now') {
      watcherDisposable.dispose();
      this.accountManager.stopLoginWatch();
      await this.runCapture(configDir, profileName);
    } else {
      // User cancelled — stop the watcher
      watcherDisposable.dispose();
      this.accountManager.stopLoginWatch();
    }
  }

  // ─── Capture ─────────────────────────────────────────────────────────────

  /**
   * Reads the current ~/.claude.json and saves a snapshot into configDir.
   * Call this right after a successful `claude login`.
   */
  async runCapture(configDir: string, profileName: string): Promise<void> {
    const account = this.accountManager.captureToProfileDir(configDir);
    if (account) {
      vscode.window.showInformationMessage(
        `Captured account ${account.email} into "${profileName}" data directory.`
      );
    } else {
      const manual = await vscode.window.showWarningMessage(
        'Could not read account from ~/.claude.json. Are you logged in?\n\nTry running "claude whoami" in a terminal first, then come back.',
        'Enter Email Manually',
        'Retry'
      );
      if (manual === 'Enter Email Manually') {
        await this.enterAccountManually(configDir, profileName);
      } else if (manual === 'Retry') {
        await this.runCapture(configDir, profileName);
      }
    }
  }

  async runCaptureForCurrentProfile(): Promise<void> {
    const info = await this.profileManager.getProfileInfo();
    if (!info.isConfigured || !info.configDir) {
      vscode.window.showWarningMessage('No CLAUDE_CONFIG_DIR configured for this profile.');
      return;
    }
    await this.runCapture(info.configDir, info.name);
  }

  // ─── Restore ─────────────────────────────────────────────────────────────

  /**
   * Restores the profile's saved ~/.claude.json snapshot back to the global path.
   * This lets Claude Code pick up the right account on the next start.
   */
  async runRestoreForCurrentProfile(): Promise<void> {
    const info = await this.profileManager.getProfileInfo();
    if (!info.isConfigured || !info.configDir) {
      vscode.window.showWarningMessage('No CLAUDE_CONFIG_DIR configured for this profile.');
      return;
    }

    const account = this.accountManager.getStoredAccountInfo(info.configDir);
    if (!account) {
      vscode.window.showWarningMessage(
        `No saved account for profile "${info.name}". Log in first.`
      );
      return;
    }

    const confirm = await vscode.window.showInformationMessage(
      `Restore ${account.email} (profile "${info.name}") to ~/.claude.json?\n\nThe current global file will be backed up to ~/.claude.json.bak.`,
      'Restore',
      'Cancel'
    );
    if (confirm !== 'Restore') return;

    const result = this.accountManager.restoreToGlobal(info.configDir);
    if (result === 'restored') {
      vscode.window.showInformationMessage(
        `Restored ${account.email} to ~/.claude.json for profile "${info.name}".`
      );
    } else if (result === 'no-snapshot') {
      vscode.window.showWarningMessage(
        'No full account snapshot found. Try logging in again to capture a complete snapshot.'
      );
    } else {
      vscode.window.showErrorMessage('Failed to restore ~/.claude.json. Check file permissions.');
    }
  }

  // ─── Remove ───────────────────────────────────────────────────────────────

  async runRemoveForCurrentProfile(): Promise<void> {
    const info = await this.profileManager.getProfileInfo();
    if (!info.isConfigured || !info.configDir) {
      vscode.window.showWarningMessage('No CLAUDE_CONFIG_DIR configured for this profile.');
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Remove saved account for profile "${info.name}"?\n\nThis only removes the cached account info from the extension. Your Claude login credentials will remain in the system Keychain.`,
      { modal: true },
      'Remove'
    );
    if (confirm !== 'Remove') return;

    this.accountManager.removeProfileState(info.configDir);
    vscode.window.showInformationMessage(`Removed saved account for profile "${info.name}".`);
  }

  // ─── Full cleanup (before uninstall) ─────────────────────────────────

  /**
   * Removes all extension-written state for the current VSCode profile:
   *  - CLAUDE_CONFIG_DIR from claudeCode.environmentVariables
   *  - CLAUDE_CONFIG_DIR from terminal.integrated.env.<platform>
   *  - The .vscode-claude-profile.json state file
   *  - Optionally the entire ~/.claude-<name>/ directory
   *
   * Returns true if the user confirmed and cleanup ran, false if cancelled.
   */
  async runFullCleanupForCurrentProfile(): Promise<boolean> {
    const info = await this.profileManager.getProfileInfo();

    if (!info.isConfigured) {
      vscode.window.showInformationMessage(
        'Claude Profiles: No profile configured for this VSCode profile — nothing to clean up.'
      );
      return false;
    }

    const dirLine = info.configDir
      ? `\n\nData directory on disk: ${info.configDir}`
      : '';

    const pick = await vscode.window.showWarningMessage(
      `This will remove the Claude profile "${info.name}" from VSCode settings (CLAUDE_CONFIG_DIR, terminal env). Your Claude login credentials stay in the system Keychain.${dirLine}`,
      { modal: true },
      'Clean Up Settings',
      'Clean Up Settings + Delete Data Directory',
    );
    if (!pick) return false;

    // 1. Remove VSCode settings entries
    await this.profileManager.teardownConfigDir();

    // 2. Remove the account state file if the directory still exists
    if (info.configDir && fs.existsSync(info.configDir)) {
      this.accountManager.removeProfileState(info.configDir);
    }

    // 3. Optionally delete the data directory
    if (pick === 'Clean Up Settings + Delete Data Directory' && info.configDir) {
      try {
        fs.rmSync(info.configDir, { recursive: true, force: true });
      } catch (err) {
        vscode.window.showWarningMessage(
          `Could not delete ${info.configDir}: ${(err as Error).message}`
        );
      }
    }

    vscode.window.showInformationMessage(
      `Claude profile "${info.name}" cleaned up. You can now safely uninstall the extension.`
    );
    return true;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async enterAccountManually(configDir: string, profileName: string): Promise<void> {
    const email = await vscode.window.showInputBox({
      prompt: 'Enter your Claude account email',
      placeHolder: 'you@example.com',
      validateInput: (v) => (v && v.includes('@') ? null : 'Enter a valid email address'),
    });
    if (!email) return;

    const displayName =
      (await vscode.window.showInputBox({
        prompt: 'Display name (optional)',
        placeHolder: 'Your Name',
      })) ?? email;

    const org = await vscode.window.showInputBox({
      prompt: 'Organization name (optional, press Enter to skip)',
      placeHolder: 'Acme Corp',
    });

    const info: AccountInfo = {
      email,
      displayName,
      organizationName: org || undefined,
      savedAt: new Date().toISOString(),
    };

    this.accountManager.saveManualAccountInfo(configDir, info);
    vscode.window.showInformationMessage(
      `Saved account ${email} for profile "${profileName}".`
    );
  }
}
