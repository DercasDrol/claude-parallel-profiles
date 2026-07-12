# Claude Parallel Accounts

[![CI](https://img.shields.io/github/actions/workflow/status/DercasDrol/claude-parallel-profiles/ci.yml?label=CI)](https://github.com/DercasDrol/claude-parallel-profiles/actions)
[![Platform: Linux](https://img.shields.io/badge/platform-Linux%20%7C%20WSL%20%7C%20SSH-orange.svg)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A companion for the [Claude Code extension for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code): run a different Claude account in each VSCode window, at the same time — with one shared conversation history.**

**[⬇️ Install from the Marketplace](https://marketplace.visualstudio.com/items?itemName=DercasDrol.claude-parallel-accounts)** · **[🐙 Source](https://github.com/DercasDrol/claude-parallel-profiles)** · **[🐛 Report an issue](https://github.com/DercasDrol/claude-parallel-profiles/issues)**

Claude Code signs you into **one** account, shared by every VSCode window. If you juggle several — personal, work, a second Pro for when the first hits its limits — this extension gives **each window its own account**: pick it once per window, and your conversations follow you across accounts instead of disappearing.

ℹ️ It's a **companion**, not a replacement: the official Claude Code extension must be installed; this one only controls which account each window uses.

> 🐧 **Linux only (for now).** Built and tested on Linux: desktop VSCode on Linux, **WSL**, **Remote-SSH** to a Linux host, and dev containers. The check happens where the extension actually runs — in a WSL/SSH window that's the *remote* side — so a Windows desktop driving a Linux remote is fully supported. On macOS and native Windows the Marketplace doesn't offer the extension at all, and a side-loaded VSIX stays completely **inert**: no files read or written, no accounts touched — the status bar says why. (Reason: Claude Code stores credentials differently there, e.g. the macOS Keychain, and guessing would be worse than declining.)

---

## The idea in 30 seconds

- **Sign in as usual** — through Claude Code's own UI (its account menu; `/login` in the chat works too). The extension notices and saves the account by itself — nothing extra to click, no names to invent: the account *is* its email.
- **Each window picks its account** from the status bar. Two windows run two accounts simultaneously — no logout/login dance, no cross-contamination. The window's integrated terminals get the same account.
- **Switching reloads the window** — required, not cosmetic: Claude Code reads its account once at start-up, so only a reload makes it both *show* and *bill* the account you picked.
- **History is one whole.** Normally chats live inside the account's data directory and vanish when you switch. Here they live in one shared store: hit a usage limit, switch account, *continue the same conversation*.
- **Forget really signs out.** Forgetting an account deletes its OAuth token from every copy on this machine and stops sessions running on it. The data directories stay — signing in again restores everything.

> ⭐ **Enjoying it?** [Rate it on the Marketplace](https://marketplace.visualstudio.com/items?itemName=DercasDrol.claude-parallel-accounts&ssr=false#review-details) — it helps other developers discover it.

---

## Requirements

| Requirement | Notes |
| --- | --- |
| Linux environment | desktop Linux, WSL, Remote-SSH (Linux host), or a dev container |
| VSCode ≥ 1.85 | the extension installs into the (remote) Linux side |
| [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) | the thing being multiplied |
| `claude` CLI on `$PATH` | asked read-only whether a directory is signed in |

---

## Quick start

1. **Install** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=DercasDrol.claude-parallel-accounts) (search "Claude Parallel Accounts").
2. **You're probably already signed in** — the status bar shows your email, and the account is saved automatically.
3. **Add the second account**: in Claude Code, sign in as the other account (its account menu — or `/login` in the chat). The extension saves it and reloads the window onto it — the previous account stays in the list.
4. **Assign accounts to windows**: status bar → **Switch account**. Open another window for another project, give it the other account — both run in parallel.

---

## Daily use

**The status bar item** — `👤 you@example.com` is the account **this window** runs as, confirmed against the real token (`claude auth status`), not just a label. **Click** it and the one action that makes sense right now happens directly: switch when there are other accounts, pick a saved account when the window is signed out, save when the account is new. **Hover** it for the full card — account details, switch/forget actions, and quick links to the extension page, its settings and its log.

**Switching** reloads the window; after the reload both the identity Claude Code shows and the token it bills are the ones you picked.

**Signing in as another account inside a window** (Claude Code's account menu, or `/login`) replaces only *that window's* account. The extension saves the new account, keeps the old one in the list, and reloads the window so Claude Code actually switches to it — other windows are untouched.

**Reopening a project** — the extension remembers which account each repository used last and restores it automatically (the tooltip says so).

**One account, one entry** — saving the same email twice reuses the existing entry; lists are collapsed by email, so you always see one row per account.

**Forgetting** (status bar hover → *Forget…*) asks for confirmation, then removes the account from the list, **deletes its OAuth token from every copy on this machine**, interrupts Claude sessions running on it, and reloads any window that was using it (that window then offers to switch to another saved account). History, settings and the data folders stay on disk; signing in again brings the account back.

**Signing out** (Claude Code's account menu, or `/logout`) revokes the token on Anthropic's side — for every copy of it. The extension notices and removes the account from the list everywhere, since switching to it could only fail.

---

## Shared conversation history

Claude Code keeps conversations *inside* the account's data directory — switch account, and your chats vanish from the panel. With `claudeProfiles.sharedHistory` (**on by default**) history lives in one shared store, `~/.claude-shared`, symlinked from every account directory:

```text
~/.claude-work/projects      ──┐
~/.claude-personal/projects  ──┼──▶  ~/.claude-shared/projects/<per-repo>/…
~/.claude/projects           ──┘
```

- Conversations, session state, plans and todos are shared. **Credentials and identity are never shared** — they stay strictly per-account.
- Transcripts remain keyed by workspace folder inside the store, so nothing leaks between repositories.
- During the initial merge, collisions resolve newer-wins; the older file is kept under `~/.claude-shared/.merge-backup`, never deleted.

**Turning it off** gives every account its own full copy of the history, diverging from there. **Uninstalling** reverts all symlinks to real directories automatically — Claude Code works as if the extension never existed.

---

## How it works

Claude Code resolves its data directory from the `CLAUDE_CONFIG_DIR` environment variable. Every VSCode window runs its own extension-host process, so `process.env` is per-window — that's the isolation mechanism. Each **account** is a store (`~/.claude-<name>`); each **window** runs on a private working copy of the account it picked:

```text
account stores                    per-window working copies
~/.claude-work      ──copy──▶    ~/.claude-windows/a1b2… ◀── window A (CLAUDE_CONFIG_DIR)
~/.claude-personal  ──copy──▶    ~/.claude-windows/c3d4… ◀── window B (CLAUDE_CONFIG_DIR)
```

The details that make it reliable — each one a bug found and fixed:

- **Activation order.** Claude Code reads `CLAUDE_CONFIG_DIR` the moment it activates and caches it — so this extension must get there *first*. It uses the `*` activation event, which VSCode's docs discourage because it loads the extension at every start-up: a deliberate, load-bearing trade-off — with any lazier activation the variable would be set after Claude Code has already read it, and per-window accounts simply wouldn't work. The cost is kept negligible: a ~25 KB bundle with zero dependencies, and the activation path itself only sets the variable and does a handful of file checks — everything heavier is deferred. (The same start-up read is why switching needs a window reload.)
- **A working copy per window.** A `/login` writes into the window's own directory, so it can only ever affect that window — "which window signed in?" is answered by construction, and no other window's account can be overwritten. Copies of an OAuth token authenticate independently, so the duplicates are safe.
- **No competing source of truth.** A machine-wide `CLAUDE_CONFIG_DIR` in `claudeCode.environmentVariables` or `terminal.integrated.env` would force all windows onto one account — the extension strips it and keeps isolation in `process.env` only.
- **Terminals follow the window.** Integrated terminals get the window's account via VSCode's environment-variable API. External terminals (outside VSCode) keep using the default `~/.claude`.
- **Reload safety.** Automatic reloads (after a forget or an in-window sign-in) go through a circuit breaker: state is corrected *before* reloading, and at most one automatic reload per minute — a misbehaving edge case degrades to a message with a button, never a reload loop.

---

## Settings

There is exactly one setting:

- **`claudeProfiles.sharedHistory`** (default: `true`) — one conversation history shared by all accounts. Turn it off to keep each account's history isolated; every account gets its own full copy from that moment on.

---

## Privacy & your data

This extension is built to manage credentials, so it holds itself to a strict policy — each point verifiable in the [source](https://github.com/DercasDrol/claude-parallel-profiles):

- **No telemetry, no analytics, no network code at all.** The source contains zero network calls and **zero runtime dependencies** — it is your files, the `vscode` API, and Node's standard library. Nothing is ever sent anywhere.
- **Everything stays in your home directory.** Accounts, working copies and the history store live under `~/.claude*`, created with owner-only permissions (`600`/`700`). Credentials are only ever *copied between* Claude Code's own data directories on this machine — never parsed beyond checking they exist, never displayed, never transmitted.
- **Conversations are moved, not read.** Shared history relinks the files; the extension does not inspect their contents.
- **Minimal footprint elsewhere:** the workspace folder path is hashed to tell windows apart; `claude auth status` is asked (locally, read-only) to confirm a directory is signed in; on Linux/WSL the process list is scanned only during *Forget*, to stop `claude` processes running on the token being deleted.
- **Self-restricted in the VSCode manifest:** disabled in virtual workspaces, and in Restricted Mode (untrusted folders) it never reads workspace content and workspace settings cannot override its configuration ([`capabilities`](package.json)).
- **Inert off Linux.** On unsupported platforms it performs no operations at all — no file reads, no writes, no account changes; the uninstall hook is guarded the same way.
- **Uninstalling cleans up:** its working copies lose their credentials, and all history symlinks revert to real directories — Claude Code behaves as if the extension never existed.

---

## Limitations

- **Linux only for now.** On macOS Claude Code keeps credentials in the Keychain (not files) and native Windows is untested — on both, the extension refuses to run rather than guess (see the note at the top). Support may come later.
- **Loads at every VSCode start-up** (`*` activation). Required to win the activation race against Claude Code — see [How it works](#how-it-works). The extension is deliberately tiny, so the impact is milliseconds.
- **API-key users**: this is for OAuth (claude.ai) logins. With `ANTHROPIC_API_KEY` you don't need it — set the key per window yourself.
- **Switching reloads the window** — a consequence of Claude Code reading its account once at start-up; surfaced honestly rather than pretended around.
- The account email is read from the account's config file because recent Claude Code versions don't expose it via `claude auth status`.

---

## Development & releases

```bash
npm ci            # install
npm run watch     # dev build with watch
npm run compile   # typecheck + build
npm run package   # build .vsix
```

- **CI** ([ci.yml](.github/workflows/ci.yml)): every push/PR to `main` builds and uploads the `.vsix` artifact.
- **Release** ([release.yml](.github/workflows/release.yml)): pushing a `v*` tag builds, creates a GitHub Release with the `.vsix`, and publishes to the VS Code Marketplace (`VSCE_PAT` secret) and Open VSX (`OVSX_PAT` secret).

```bash
# release flow: make sure package.json version matches the tag, then
git tag v<version>
git push origin main --tags     # CI does the rest
```

---

## License

MIT License — see [LICENSE](LICENSE) for details.
