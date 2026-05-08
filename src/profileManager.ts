import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export interface ProfileInfo {
  /** Hash segment from VSCode's internal profile path, null = default profile */
  vsCodeProfileHash: string | null;
  /** Human-readable name derived from CLAUDE_CONFIG_DIR (e.g. "work", "personal") */
  name: string;
  /** The CLAUDE_CONFIG_DIR value for this profile, null if not configured */
  configDir: string | null;
  /** Whether CLAUDE_CONFIG_DIR is configured for this profile */
  isConfigured: boolean;
}

export class ProfileManager {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Returns the VSCode internal profile hash by parsing globalStorageUri.
   * e.g. .../profiles/5a9e357/globalStorage/<ext-id>/ → "5a9e357"
   * Default profile has no /profiles/ segment → returns null.
   */
  getVSCodeProfileHash(): string | null {
    const storagePath = this.context.globalStorageUri.fsPath;
    const match = storagePath.match(/[/\\]profiles[/\\]([^/\\]+)[/\\]globalStorage/);
    return match ? match[1] : null;
  }

  /**
   * Reads CLAUDE_CONFIG_DIR from the current profile's claudeCode.environmentVariables setting.
   */
  getConfigDir(): string | null {
    const envVars =
      vscode.workspace
        .getConfiguration('claudeCode')
        .get<Array<{ name: string; value: string }>>('environmentVariables') ?? [];
    const entry = envVars.find((e) => e.name === 'CLAUDE_CONFIG_DIR');
    if (!entry?.value) return null;
    // Resolve ~ if present
    return entry.value.replace(/^~/, os.homedir());
  }

  /** Derives a short display name from a CLAUDE_CONFIG_DIR path. */
  nameFromConfigDir(configDir: string): string {
    const base = path.basename(configDir);
    // .claude-work → "work", .claude → "default", anything else → as-is
    return base.replace(/^\.?claude[-_]?/, '') || base || 'default';
  }

  async getProfileInfo(): Promise<ProfileInfo> {
    const configDir = this.getConfigDir();
    const hash = this.getVSCodeProfileHash();
    const name = configDir
      ? this.nameFromConfigDir(configDir)
      : hash ?? 'default';
    return { vsCodeProfileHash: hash, name, configDir, isConfigured: !!configDir };
  }

  /**
   * Creates a CLAUDE_CONFIG_DIR for the given profile name and writes the
   * necessary settings into the current VSCode profile.
   *
   * Sets:
   *  - claudeCode.environmentVariables → CLAUDE_CONFIG_DIR
   *  - terminal.integrated.env.<platform> → CLAUDE_CONFIG_DIR
   */
  async setupConfigDir(profileName: string): Promise<string> {
    const configDir = path.join(os.homedir(), `.claude-${profileName}`);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Update claudeCode.environmentVariables (for the Claude Code VSCode extension)
    const claudeConfig = vscode.workspace.getConfiguration('claudeCode');
    const envVars: Array<{ name: string; value: string }> =
      claudeConfig.get('environmentVariables') ?? [];
    const updatedEnvVars = [
      ...envVars.filter((e) => e.name !== 'CLAUDE_CONFIG_DIR'),
      { name: 'CLAUDE_CONFIG_DIR', value: configDir },
    ];
    await claudeConfig.update(
      'environmentVariables',
      updatedEnvVars,
      vscode.ConfigurationTarget.Global
    );

    // Update terminal.integrated.env.<platform> so terminals in this profile
    // also inherit CLAUDE_CONFIG_DIR for manual `claude` usage.
    const platformKey =
      process.platform === 'win32'
        ? 'windows'
        : process.platform === 'darwin'
          ? 'osx'
          : 'linux';
    const termConfig = vscode.workspace.getConfiguration('terminal.integrated.env');
    const termEnv: Record<string, string> = termConfig.get(platformKey) ?? {};
    termEnv['CLAUDE_CONFIG_DIR'] = configDir;
    await termConfig.update(platformKey, termEnv, vscode.ConfigurationTarget.Global);

    return configDir;
  }

  /** Returns true if the given directory path is a valid CLAUDE_CONFIG_DIR (exists). */
  configDirExists(configDir: string): boolean {
    return fs.existsSync(configDir);
  }
}
