import * as vscode from 'vscode';
import { ProfileManager } from './profileManager';
import { AccountManager } from './accountManager';

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly profileManager: ProfileManager,
    private readonly accountManager: AccountManager
  ) {
    this.item = vscode.window.createStatusBarItem(
      'claudeProfiles.status',
      vscode.StatusBarAlignment.Right,
      90
    );
    this.item.command = 'claudeProfiles.showStatus';
    this.item.name = 'Claude Profiles';

    // Re-render whenever account info changes
    this.disposables.push(
      this.accountManager.onAccountChanged.event(() => this.render())
    );

    // Re-render when CLAUDE_CONFIG_DIR changes (e.g. profile switch)
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeCode.environmentVariables')) {
          this.render();
        }
      })
    );
  }

  async initialize(): Promise<void> {
    await this.render();
    this.item.show();
  }

  async render(): Promise<void> {
    const info = await this.profileManager.getProfileInfo();

    if (!info.isConfigured) {
      this.item.text = '$(account) Claude: setup needed';
      this.item.tooltip = new vscode.MarkdownString(
        'No Claude profile configured for this VSCode profile.\nClick to set up.'
      );
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      return;
    }

    const account = this.accountManager.getStoredAccountInfo(info.configDir!);

    if (!account) {
      this.item.text = `$(account) Claude [${info.name}]: login needed`;
      this.item.tooltip = new vscode.MarkdownString(
        `Profile **${info.name}**\n\`${info.configDir}\`\n\nNo account captured yet. Click → Login.`
      );
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    } else {
      this.item.text = `$(account) ${info.name}: ${account.email}`;
      this.item.tooltip = new vscode.MarkdownString(
        [
          `**Claude Profile: ${info.name}**`,
          `Account: ${account.displayName} (${account.email})`,
          account.organizationName ? `Org: ${account.organizationName}` : '',
          `Data dir: \`${info.configDir}\``,
          `Saved: ${new Date(account.savedAt).toLocaleString()}`,
        ]
          .filter(Boolean)
          .join('\n\n')
      );
      this.item.backgroundColor = undefined;
      this.item.color = undefined;
    }
  }

  /**
   * Shows a quick-pick menu for the current profile.
   */
  async showQuickPick(): Promise<void> {
    const info = await this.profileManager.getProfileInfo();
    const account = info.configDir
      ? this.accountManager.getStoredAccountInfo(info.configDir)
      : null;

    type Item = vscode.QuickPickItem & { action: string };

    const items: Item[] = [];

    // Current state header
    if (account) {
      items.push({
        label: `$(account) ${account.displayName}`,
        description: account.email,
        detail: account.organizationName
          ? `Organization: ${account.organizationName}  •  Data: ${info.configDir}`
          : `Data: ${info.configDir}`,
        action: 'noop',
        alwaysShow: true,
      });
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: 'noop' });
    }

    if (!info.isConfigured) {
      items.push({
        label: '$(gear) Setup this VSCode profile',
        description: 'Create a CLAUDE_CONFIG_DIR and configure account',
        action: 'setup',
      });
    } else {
      items.push({
        label: '$(sign-in) Login / Switch Account',
        description: 'Open terminal and run `claude login` for this profile',
        action: 'login',
      });
      items.push({
        label: '$(cloud-download) Capture account from ~/.claude.json',
        description: 'Save current global account to this profile\'s data dir',
        action: 'capture',
      });
      items.push({
        label: '$(cloud-upload) Restore this profile\'s account',
        description: 'Write this profile\'s saved account back to ~/.claude.json',
        action: 'restore',
      });
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: 'noop' });
      items.push({
        label: '$(gear) Reconfigure profile',
        description: 'Change profile name / CLAUDE_CONFIG_DIR',
        action: 'setup',
      });
      if (account) {
        items.push({
          label: '$(trash) Remove saved account',
          description: 'Clear stored account info for this profile',
          action: 'remove',
        });
      }
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: `Claude Profile: ${info.name}`,
      placeHolder: 'Select an action',
      matchOnDescription: false,
    });

    if (!picked || picked.action === 'noop') return;

    const commandMap: Record<string, string> = {
      setup: 'claudeProfiles.setupProfile',
      login: 'claudeProfiles.loginCurrentProfile',
      capture: 'claudeProfiles.captureAccount',
      restore: 'claudeProfiles.restoreAccount',
      remove: 'claudeProfiles.removeProfile',
    };
    if (commandMap[picked.action]) {
      await vscode.commands.executeCommand(commandMap[picked.action]);
    }
  }

  dispose(): void {
    this.item.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
