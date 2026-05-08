# Claude Profiles

A VSCode extension that gives each **VSCode Profile** its own isolated Claude account and data directory. When you switch profiles, the right Claude account is automatically restored — no manual re-login needed.

---

## How it works

Claude Code stores OAuth tokens in the macOS Keychain under a key derived from `CLAUDE_CONFIG_DIR`. This extension:

1. Assigns each VSCode profile a unique `CLAUDE_CONFIG_DIR` (e.g. `~/.claude-work`)
2. After login, captures a full snapshot of `~/.claude.json` into that directory
3. On every profile activation, restores the snapshot back to `~/.claude.json` so Claude Code starts with the correct account

```
VSCode Profile "work"           VSCode Profile "personal"
  CLAUDE_CONFIG_DIR               CLAUDE_CONFIG_DIR
  = ~/.claude-work/               = ~/.claude-personal/
    ├── sessions/                   ├── sessions/
    ├── settings.json               ├── settings.json
    └── .vscode-claude-profile.json └── .vscode-claude-profile.json
         └─ account snapshot              └─ account snapshot

Keychain: Claude Code-credentials-<work-hash>
Keychain: Claude Code-credentials-<personal-hash>
```

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **VSCode** | ≥ 1.85 | Profiles feature required |
| **Claude Code VSCode extension** | latest | Provides `claudeCode.environmentVariables` setting |
| **Claude CLI** (`claude`) | latest | Must be on `$PATH` in your shell |
| **macOS** | any | Linux/Windows supported; Keychain isolation is macOS-only |

Install the Claude CLI:
```bash
npm install -g @anthropic-ai/claude-code
# or via Homebrew
brew install claude
```

---

## Installation

### Option A — Load unpacked (development)

```bash
git clone <this-repo>
cd extension
npm install
npm run build
```

Then in VSCode:
1. `Cmd+Shift+P` → **Developer: Install Extension from Location…**
2. Select the `extension/` folder

### Option B — Package and install

```bash
npm install -g @vscode/vsce
vsce package          # produces claude-profiles-0.1.0.vsix
```

Then in VSCode:
- `Cmd+Shift+P` → **Extensions: Install from VSIX…** → select the `.vsix` file

### Option C — F5 (Extension Development Host)

Open the `extension/` folder in VSCode and press **F5**. A new VSCode window opens with the extension loaded.

---

## Setup (per profile)

Do this once for each VSCode profile that should have its own Claude account.

### Step 1 — Run the setup wizard

`Cmd+Shift+P` → **Claude Profiles: Setup Profile**

- Enter a short name for the profile (e.g. `work`, `personal`, `client-a`)
- The extension creates `~/.claude-<name>/` and writes `CLAUDE_CONFIG_DIR` into:
  - `claudeCode.environmentVariables` (for the Claude Code extension)
  - `terminal.integrated.env.osx` / `.linux` / `.windows` (for terminals)

### Step 2 — Log in to Claude

Click **Login to Claude now** in the prompt (or run **Claude Profiles: Login to Claude for Current Profile**).

- A terminal opens pre-loaded with the correct `CLAUDE_CONFIG_DIR`
- Press **Enter** to start the OAuth flow and authenticate in your browser
- The extension watches `~/.claude.json` for the change that signals success
- Account data is **automatically saved** to `~/.claude-<name>/.vscode-claude-profile.json`
- The status bar updates to show your email

### Step 3 — Repeat for each profile

Switch to your next VSCode profile and repeat steps 1–2 with a different account.

---

## Daily use

Nothing special is required. When you open a VSCode window in a configured profile:

- The extension activates and **restores** `~/.claude.json` from the profile's saved snapshot
- Claude Code starts authenticated as the correct account
- The status bar shows `$(account) <profile-name>: you@example.com`

Click the status bar item at any time to:

| Action | Description |
|--------|-------------|
| **Login / Switch Account** | Re-run `claude login` for the current profile |
| **Capture account** | Manually save `~/.claude.json` to this profile's dir |
| **Restore this profile's account** | Write the saved snapshot back to `~/.claude.json` |
| **Reconfigure profile** | Change the profile name / `CLAUDE_CONFIG_DIR` |
| **Remove saved account** | Clear cached account info (Keychain is untouched) |

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeProfiles.autoRestore` | `true` | Restore saved `~/.claude.json` snapshot on profile activation |
| `claudeProfiles.autoCapture` | `true` | Auto-capture account data after a detected `~/.claude.json` change during login |

---

## Account data stored per profile

Each `CLAUDE_CONFIG_DIR` contains a `.vscode-claude-profile.json` file (mode `600`) with:

```json
{
  "account": {
    "email": "you@example.com",
    "displayName": "Your Name",
    "organizationName": "Acme Corp",
    "savedAt": "2026-05-08T07:20:00.000Z"
  },
  "dotClaudeJsonSnapshot": { ... }
}
```

The `dotClaudeJsonSnapshot` is the full `~/.claude.json` captured after login — this is what gets restored on profile switch.

---

## Caveats

- **Simultaneous multi-profile windows**: If you have two VSCode windows open in different profiles at the same time, `~/.claude.json` reflects whichever profile last activated. Functional auth (Keychain) is unaffected — only the metadata display in Claude Code may be from the wrong account. The workaround is to click **Restore this profile's account** after switching focus.
- **Linux / Windows**: OAuth tokens are stored in the system credential store (libsecret / Windows Credential Manager) rather than macOS Keychain. The per-`CLAUDE_CONFIG_DIR` isolation behaviour is the same.
- **API key users**: This extension is designed for OAuth (Claude.ai) login. If you use `ANTHROPIC_API_KEY`, simply set the key via `claudeCode.environmentVariables` directly in each profile's VSCode settings — no extension needed.

---

## Project structure

```
extension/
├── src/
│   ├── extension.ts        # Activation, command registration, auto-restore
│   ├── profileManager.ts   # Profile detection, CLAUDE_CONFIG_DIR setup
│   ├── accountManager.ts   # Snapshot capture/restore, file watcher
│   ├── statusBar.ts        # Status bar item + quick-pick menu
│   └── setupWizard.ts      # Setup wizard + login flow
├── esbuild.js              # Bundle script
├── package.json
└── tsconfig.json
```
