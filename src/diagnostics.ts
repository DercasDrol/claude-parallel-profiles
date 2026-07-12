import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * A live Claude Code conversation subprocess and the account directory its
 * environment is pinned to. Because a conversation runs as a persistent
 * `claude --input-format stream-json` process, its CLAUDE_CONFIG_DIR is frozen
 * at spawn — this is the ground truth for "which account is this chat using".
 */
export interface LiveConversation {
  pid: number;
  /** CLAUDE_CONFIG_DIR from the process env (defaults to ~/.claude if unset). */
  dir: string;
  /** Working directory (workspace/repo) of the process, if readable. */
  cwd?: string;
  /** --resume <session-id> if present. */
  sessionId?: string;
}

function readProcFile(pid: string, name: string): string | null {
  try {
    return fs.readFileSync(path.join('/proc', pid, name), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Enumerates live Claude conversation subprocesses by scanning /proc. Linux
 * (incl. WSL) only; returns [] where /proc is unavailable.
 */
export function listLiveConversations(): LiveConversation[] {
  if (!fs.existsSync('/proc')) return [];
  const out: LiveConversation[] = [];
  let pids: string[] = [];
  try {
    pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }
  for (const pid of pids) {
    const cmdline = readProcFile(pid, 'cmdline');
    if (!cmdline) continue;
    const args = cmdline.split('\0').filter(Boolean);
    const joined = args.join(' ');
    if (!/claude/i.test(joined) || !joined.includes('input-format stream-json')) continue;

    const environ = readProcFile(pid, 'environ');
    let dir = os.homedir() + '/.claude';
    if (environ) {
      const entry = environ.split('\0').find((e) => e.startsWith('CLAUDE_CONFIG_DIR='));
      if (entry) dir = entry.slice('CLAUDE_CONFIG_DIR='.length);
    }

    let cwd: string | undefined;
    try {
      cwd = fs.readlinkSync(path.join('/proc', pid, 'cwd'));
    } catch {
      /* not readable */
    }

    const resumeIdx = args.indexOf('--resume');
    const sessionId = resumeIdx >= 0 ? args[resumeIdx + 1] : undefined;

    out.push({ pid: Number(pid), dir, cwd, sessionId });
  }
  return out;
}
