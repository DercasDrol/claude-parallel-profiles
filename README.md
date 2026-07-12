# Claude Parallel Accounts

[![VS Code](https://img.shields.io/badge/VS%20Code-Extension-blue.svg)](https://marketplace.visualstudio.com/items?itemName=DercasDrol.claude-parallel-accounts)
[![Version](https://img.shields.io/visual-studio-marketplace/v/DercasDrol.claude-parallel-accounts?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=DercasDrol.claude-parallel-accounts)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/DercasDrol.claude-parallel-accounts)](https://marketplace.visualstudio.com/items?itemName=DercasDrol.claude-parallel-accounts)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A companion for the [Claude Code extension for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) — run a different Claude account in each VSCode window, at the same time, with one shared conversation history.**

**[⬇️ Install](https://marketplace.visualstudio.com/items?itemName=DercasDrol.claude-parallel-accounts)** · **[🛒 Marketplace](https://marketplace.visualstudio.com/items?itemName=DercasDrol.claude-parallel-accounts)** · **[🐙 Source](https://github.com/DercasDrol/claude-parallel-profiles)** · **[🐛 Report an issue](https://github.com/DercasDrol/claude-parallel-profiles/issues)**

The official **Claude Code extension for VS Code** (the one that puts Claude in your editor) signs you into a single Claude account, shared by every window. If you juggle several accounts on one machine — personal, work, a second Pro subscription for when the first hits its limits — this extension gives **each VSCode window its own account**. Pick it once, and your conversations follow you across accounts instead of disappearing.

ℹ️ This is a **companion** extension — it doesn't replace Claude Code; it sits alongside it and controls which account each window uses. You still need the official Claude Code extension installed.

> ⭐ **Enjoying it?** [Rate it on the Marketplace](https://marketplace.visualstudio.com/items?itemName=DercasDrol.claude-parallel-accounts&ssr=false#review-details) — your feedback helps other developers discover it.

---

## The idea in 30 seconds

- **Sign in once per account** — inside Claude Code, the normal way (`/login`). The extension snapshots the account you're signed in as. No names to invent: the account *is* its email.
- **Each window picks its account** from the status bar. Two windows can run two accounts simultaneously — no logout/login dance, no cross-contamination.
- **Switching reloads the window.** Claude Code reads which account to use only when it starts up, so the extension re-points the window and reloads it — after which Claude Code shows *and* bills the account you picked. (See [How it works](#how-it-works) for why the reload is required, not optional.)
- **Your chat history is one whole.** Normally Claude Code stores conversations inside the account's data directory, so switching accounts "loses" your chats. Here, history lives in one shared store and every account sees it: hit a usage limit, switch to the other account, and *continue the same conversation*.
- **Nothing is ever destroyed.** Forgetting an account only hides it from the list; uninstalling the extension puts every file back the way Claude Code expects.

---

## Requirements

| Requirement | Notes |
|---|---|
| VSCode ≥ 1.85 | desktop or WSL remote |
| [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) | the thing being multiplied |
| `claude` CLI on `$PATH` | used read-only to confirm a directory is logged in (`claude auth status`) |

Best experience on Linux / WSL. On Windows, shared history needs Developer Mode (it uses symlinks); the per-window account isolation works everywhere.

---

## Quick start

1. **Install** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=DercasDrol.claude-parallel-accounts) (search "Claude Parallel Accounts").
2. **Save your first account.** You're probably already signed in — click the status bar item (your email with a `○` = "not saved yet") → **Save this account**. The window is now bound to it.
3. **Add the second account.** In Claude Code run `/login`, sign in as the other account, then **Save this account** again.
4. **Assign accounts to windows.** Status bar → **Switch account**. The window reloads onto the chosen account. Open another window for another project, give it the other account — both run in parallel.

---

## Daily use

### The status bar item

`👤 you@example.com` — the account **this window** runs as. The email comes from the account's own config; the extension also asks `claude auth status` to confirm the directory is still logged in (re-checked when the window regains focus, and live-updated if the identity file changes). A `○` after the email means this account isn't saved anywhere yet.

**Click** it and the one action that makes sense right now happens directly — no intermediate menus: switch when there are other accounts, save when the current account isn't saved yet, a hint about the next step otherwise. **Hover** it for the full action card (save / switch / forget) right above the button.

### Switching

Pick **Switch account** and the window **reloads** onto the chosen account. The reload isn't a nicety — Claude Code reads its account at start-up and keeps a long-lived process, so a live swap would be invisible to it. After the reload, both the identity Claude Code shows and the account it bills are the one you picked.

If the account you're switching *away from* isn't saved, the extension asks first — otherwise you'd have no way back to it.

### Reopening a project

The extension remembers which account each repository used last (globally, across windows). Open a familiar repo in a fresh window and it gets its usual account automatically — the tooltip says so ("Auto-selected: this folder used this account last time").

### One account, one entry

The account *is* its email. Saving the same account twice never makes a duplicate — the existing copy is reused (two copies of one OAuth token would invalidate each other on refresh). Account lists are collapsed by email, so you always see one row per account even if an older version of the extension left extra copies on disk.

### Forgetting an account

**Forget a saved account…** hides it from the extension's list — every copy of that email at once. That's all it does: the Claude account stays signed in wherever it's used, running conversations keep working, and the data directories stay on disk. Saving the same email later restores it. The extension performs no destructive operations — if you want a directory gone, delete it yourself.

---

## Shared conversation history

Claude Code keeps conversations *inside* the account's data directory. Out of the box that means: switch account → your chats vanish from the panel. With `claudeProfiles.sharedHistory` (**on by default**) the extension merges history into one shared store, `~/.claude-shared`, and symlinks it from every account directory:

```text
~/.claude-work/projects      ──┐
~/.claude-personal/projects  ──┼──▶  ~/.claude-shared/projects/<per-repo>/…
~/.claude/projects           ──┘
```

- Conversations, session state, plans and todos are shared. **Credentials and identity are never shared** — they stay strictly per-account.
- Transcripts remain keyed by workspace folder inside the store, so nothing leaks between repositories.
- During the initial merge, name collisions resolve newer-wins; the older file is kept under `~/.claude-shared/.merge-backup`, never deleted.

**Turning it off** gives every account its own full copy of the history and they diverge from there. **Uninstalling the extension** reverts all symlinks to real directories automatically — Claude Code works as if the extension never existed. The store stays on disk as a backup you can delete manually.

---

## How it works

Claude Code resolves its data directory from the `CLAUDE_CONFIG_DIR` environment variable. Every VSCode window runs its own extension-host process, so `process.env` is per-window — the extension sets it there:

```text
Window A                          Window B
process.env.CLAUDE_CONFIG_DIR     process.env.CLAUDE_CONFIG_DIR
  = ~/.claude-work                  = ~/.claude-personal
    ├── .credentials.json (own)       ├── .credentials.json (own)
    ├── .claude.json      (own)       ├── .claude.json      (own)
    └── projects → shared store       └── projects → shared store
```

Three details make this actually reliable — each of them a bug we hit and fixed:

- **Timing beats Claude Code to the punch.** Claude Code reads `CLAUDE_CONFIG_DIR` (for the identity it shows) the moment its extension host activates, and caches it. So this extension activates *earlier* (activation event `*`, which fires before `onStartupFinished`) and sets `process.env` first — otherwise Claude Code would read the default account while only the billed token followed the window, and the two would disagree.
- **Switching reloads the window.** Because that account read happens at start-up and Claude Code keeps a long-lived process, the only way to move a window to another account cleanly is to re-point `process.env` and reload — then everything (shown identity *and* token) lands on the new account together.
- **No competing source of truth.** The machine-scoped `claudeCode.environmentVariables` setting is shared by *all* windows; if it defined `CLAUDE_CONFIG_DIR` it would force every window onto one account. The extension strips that entry (and any stale `terminal.integrated.env` one) and keeps isolation purely in `process.env`.

Identity vs. token: the email you see comes from the account's `.claude.json` (`oauthAccount`); the actual OAuth token that gets billed lives in `.credentials.json`. The extension snapshots both together so they can never drift apart.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeProfiles.sharedHistory` | `true` | One conversation history shared by all accounts. Turn off to keep each account's history isolated (each gets a full copy at that moment). |

---

## Limitations

- **Shared history on native Windows** requires Developer Mode for symlink creation. Per-window account isolation works everywhere.
- **API-key users**: this extension is for OAuth (claude.ai) logins. With `ANTHROPIC_API_KEY` you don't need it — set the key per window/profile yourself.
- **Switching reloads the window.** This is a consequence of Claude Code reading its account once at start-up and holding a long-lived process — surfaced honestly rather than pretended around.
- The account email is read from the config file because recent Claude Code versions don't expose it through `claude auth status`; the CLI is still used to confirm a directory is logged in.

---

## Privacy & security

- Credentials are copied only between Claude Code data directories on your own machine, mode `600`.
- The extension never reads or transmits the contents of your credentials or conversations; it moves/links files and asks the local `claude` CLI whether a directory is signed in.
- Nothing is sent to any server.

---

## Development & releases

```bash
npm ci            # install
npm run watch     # dev build with watch
npm run compile   # typecheck + build
npm run package   # build .vsix
```

Releases are automated with GitHub Actions:

- **CI** ([ci.yml](.github/workflows/ci.yml)): every push/PR to `main` builds and uploads the `.vsix` artifact.
- **Release** ([release.yml](.github/workflows/release.yml)): pushing a `v*` tag (or manual dispatch) builds, creates a GitHub Release with the `.vsix`, and publishes to the VS Code Marketplace (`VSCE_PAT` secret) and Open VSX (`OVSX_PAT` secret).

```bash
# release flow
npm version patch          # bumps package.json + git tag
git push --follow-tags     # CI does the rest
```

---

## License

MIT License — see [LICENSE](LICENSE) for details.
