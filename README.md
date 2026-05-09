# Claude Code Profile Manager

**Use a different Claude account for every VSCode profile — automatically.**

Claude Code Profile Manager gives each [VSCode Profile](https://code.visualstudio.com/docs/editor/profiles) its own isolated Claude Code account and data directory. Switch profiles and the right Claude account is already active — no re-login, no manual token swapping.

---

## Why you need this

If you use Claude Code across multiple contexts — personal projects, work, freelance clients — you know the pain: every time you switch contexts you have to `claude logout`, `claude login`, and wait through the OAuth flow again. Claude Profiles eliminates that entirely.

| Without Claude Profiles | With Claude Profiles |
|---|---|
| One account shared across all contexts | Each VSCode profile has its own account |
| Manual `claude login` every time you switch | Auto-restore on profile activation |
| Risk of committing under the wrong account | Guaranteed correct identity per workspace |

---

## Features

- **Automatic account switching** — activating a VSCode profile instantly restores the correct Claude account
- **Isolated data directories** — each profile gets its own `CLAUDE_CONFIG_DIR` (`~/.claude-work`, `~/.claude-personal`, etc.)
- **Cross-platform** — works on macOS, Linux, and Windows
- **Status bar indicator** — always shows which Claude account is active
- **One-time setup** — configure once per profile, then forget about it
- **Safe credential storage** — OAuth tokens remain in the OS credential store (Keychain / libsecret / Windows Credential Manager); only metadata is stored in the profile directory

---

## Requirements

| Requirement | Version |
|---|---|
| VSCode | ≥ 1.85 |
| [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) | latest |
| Claude CLI (`claude`) | latest — must be on `$PATH` |

Install the Claude CLI if you haven't already:

```bash
npm install -g @anthropic-ai/claude-code
```

---

## Quick Start

### 1. Install the extension

Search for **Claude Code Profile Manager** in the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`) and click **Install**.

### 2. Switch to the VSCode profile you want to configure

Use the profile picker in the bottom-left corner of VSCode (or `Ctrl+Shift+P` → **Profiles: Switch Profile**).

### 3. Run the setup wizard

`Ctrl+Shift+P` → **Claude Profiles: Setup Profile**

- Enter a short name (e.g. `work`, `personal`, `client-a`)
- The extension creates `~/.claude-<name>/` and configures `CLAUDE_CONFIG_DIR` for both the Claude Code extension and integrated terminals

### 4. Log in

Click **Login to Claude now** in the prompt (or run **Claude Profiles: Login to Current Profile**).

- A terminal opens pre-loaded with the correct `CLAUDE_CONFIG_DIR`
- Press **Enter** to start the OAuth flow and authenticate in your browser
- The extension detects the successful login and saves your account automatically
- The status bar updates to show your email

### 5. Repeat for each profile

Switch to your next VSCode profile and repeat steps 3–4 with a different Claude account.

---

## Daily Use

Nothing changes about how you work. When you open a VSCode window in a configured profile:

1. The extension activates automatically
2. Your Claude account is restored from the saved snapshot
3. Claude Code starts authenticated as the correct account
4. The status bar shows `$(account) <profile>: you@example.com`

### Status bar quick menu

Click the status bar item at any time to access:

| Action | Description |
|---|---|
| **Login / Switch Account** | Re-run `claude login` for the current profile |
| **Capture account** | Manually save the current `~/.claude.json` to this profile |
| **Restore this profile's account** | Write the saved snapshot back to `~/.claude.json` |
| **Reconfigure profile** | Change the profile name or `CLAUDE_CONFIG_DIR` path |
| **Remove saved account** | Clear cached account info for this profile |

---

## How It Works

Claude Code reads authentication state from `~/.claude.json` and stores OAuth tokens in the OS credential store under a key derived from `CLAUDE_CONFIG_DIR`. Claude Profiles takes advantage of this:

1. Assigns each VSCode profile a unique `CLAUDE_CONFIG_DIR` (e.g. `~/.claude-work`)
2. After login, captures a snapshot of `~/.claude.json` into that directory
3. On profile activation, restores the snapshot to `~/.claude.json` so Claude Code picks up the right account

```
VSCode Profile "work"              VSCode Profile "personal"
  CLAUDE_CONFIG_DIR                  CLAUDE_CONFIG_DIR
  = ~/.claude-work/                  = ~/.claude-personal/
    └── .vscode-claude-profile.json    └── .vscode-claude-profile.json
         (account snapshot)                 (account snapshot)

OS Credential Store:
  Claude Code-credentials-<work-hash>
  Claude Code-credentials-<personal-hash>
```

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeProfiles.autoRestore` | `true` | Automatically restore the saved account on profile activation |
| `claudeProfiles.autoCapture` | `true` | Automatically capture account data after a successful login |

---

## Known Limitations

- **Multiple windows open simultaneously**: If you have two VSCode windows open in different profiles at the same time, `~/.claude.json` reflects whichever profile activated last. Functional auth (OS credential store) is not affected — only the account metadata shown in Claude Code may be from the wrong profile. **Workaround:** click **Restore this profile's account** after switching focus.

- **API key users**: This extension is designed for OAuth (Claude.ai) login. If you authenticate via `ANTHROPIC_API_KEY`, set the key directly in `claudeCode.environmentVariables` per profile in VSCode settings — no extension needed.

---

## Privacy & Security

- OAuth tokens are **never** moved out of the OS credential store (macOS Keychain, Linux libsecret, Windows Credential Manager)
- The only file written by this extension is `.vscode-claude-profile.json` inside each `CLAUDE_CONFIG_DIR`, stored with mode `600` (owner-read-only on Unix)
- No data is sent to any server by this extension

---

## Contributing

Issues and pull requests are welcome. See the [GitHub repository](https://github.com/claude-profiles/vscode-claude-profiles) for source code, build instructions, and contribution guidelines.

---

## License

[MIT](LICENSE) © Sohan Yadav
