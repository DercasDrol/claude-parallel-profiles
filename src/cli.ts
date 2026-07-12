import { execFile } from 'child_process';

/**
 * Thin wrapper around the `claude` CLI's auth commands, scoped to a specific
 * CLAUDE_CONFIG_DIR. This is the AUTHORITATIVE source of an account's identity:
 * `claude auth status` reflects the real OAuth token, so it can never disagree
 * with what Claude Code actually bills to (unlike reading .claude.json, whose
 * oauthAccount field can drift out of sync with the token).
 */

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

/** Runs a claude CLI command through a login shell so nvm/PATH resolve. */
function runClaude(args: string, dir: string, timeoutMs: number): Promise<string> {
  const shell = process.env.SHELL || '/bin/bash';
  return new Promise((resolve, reject) => {
    // execFile's own `timeout` sends SIGTERM, which a login shell can trap and
    // ignore — leaving the callback pending forever. Escalate to SIGKILL and
    // back it with our own hard timer so this promise ALWAYS settles.
    const child = execFile(
      shell,
      ['-lc', `claude ${args}`],
      { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        clearTimeout(hardTimer);
        if (err) reject(new Error(stderr?.toString() || err.message));
        else resolve(stdout.toString());
      }
    );
    const hardTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      reject(new Error(`claude ${args} timed out after ${timeoutMs}ms`));
    }, timeoutMs + 1000);
    if (typeof hardTimer.unref === 'function') hardTimer.unref();
  });
}

/**
 * Returns the authenticated account for a config dir, or null if the CLI call
 * fails or the dir isn't logged in. Never throws.
 */
export async function getAuthStatus(
  dir: string,
  timeoutMs = 15000
): Promise<AuthStatus | null> {
  try {
    const out = await runClaude('auth status --json', dir, timeoutMs);
    const parsed = JSON.parse(out) as AuthStatus;
    return parsed;
  } catch {
    return null;
  }
}
