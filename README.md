# Claude Parallel Accounts

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Different Claude Code accounts in different VSCode windows — at the same time, with one shared conversation history.**

One machine, several Claude accounts (personal, work, a second Pro subscription for when the first hits its limits). Claude Code itself only knows about one login at a time. This extension gives every VSCode window its own account — switch with one click, keep working, and your conversations follow you across accounts instead of disappearing.

---

## The idea in 30 seconds

- **Sign in once per account** — inside Claude Code, the normal way (`/login`). The extension snapshots the account you're signed in as. No names to invent: the account *is* its email.
- **Each window picks its account** from the status bar. Two windows can run two accounts simultaneously — no logout/login dance, no cross-contamination.
- **Your chat history is one whole.** Normally Claude Code stores conversations inside the account's data directory, so switching accounts "loses" your chats. Here, history lives in one shared store and every account sees it: hit a usage limit, switch to the other account, and *continue the same conversation*.
- **Nothing is ever destroyed.** Forgetting an account only hides it from the list; uninstalling the extension puts every file back the way Claude Code expects.

---

## Requirements

| Requirement | Notes |
|---|---|
| VSCode ≥ 1.85 | desktop or WSL remote |
| [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) | the thing being multiplied |
| `claude` CLI on `$PATH` | used read-only to confirm identities (`claude auth status`) |

Best experience on Linux / WSL. On Windows, shared history needs Developer Mode (it uses symlinks); the per-window account isolation works everywhere.

---

## Quick start

1. **Install** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=DercasDrol.claude-parallel-accounts) (search "Claude Parallel Accounts").
2. **Save your first account.** You're probably already signed in — click the status bar item (your email with a `○` = "not saved") → **Save this account**. Done: the window is bound to it.
3. **Add the second account.** In Claude Code run `/login`, sign in as the other account, then **Save this account** again.
4. **Assign accounts to windows.** Status bar → **Switch account for this window**. Open another window for another project, give it the other account — both run in parallel.

---

## Daily use

### The status bar item

`👤 you@example.com` — the account **this window** runs as, confirmed against the real OAuth token via `claude auth status` (re-checked when the window regains focus, so a `/login` behind the extension's back is noticed). A `○` after the email means the account isn't saved yet.

**Hover** it for instant actions (save / switch / live conversations) — no menu digging. **Click** it for the full menu; only actions that currently make sense are shown.

### Switching

Switching applies to **new conversations immediately**. A chat that is already running is a live `claude` process pinned to the account it started with — it keeps that account until you start a new chat. The toast after switching offers **Reload window** for an all-at-once switch when you want that instead.

If the account you're switching *away from* isn't saved, the extension asks first — otherwise you'd have no way back to it.

### Reopening a project

The extension remembers which account each repository used last (globally, across windows). Open a familiar repo in a fresh window and it gets its usual account automatically — the tooltip says so ("Auto-selected: this folder used this account last time").

### Which chat runs on which account?

**Show live conversations & accounts** lists every running Claude conversation process and the account its environment is pinned to — ground truth read from `/proc` (Linux/WSL).

### Forgetting an account

**Forget a saved account…** hides it from the extension's list. That's all it does: the Claude account stays signed in wherever it's used, running conversations keep working, and the data directory stays on disk. Saving the same email later restores it. The extension performs no destructive operations — if you want the directory gone, delete it yourself.

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

Claude Code resolves its data directory from the `CLAUDE_CONFIG_DIR` environment variable. Every VSCode window runs its own extension-host process, so `process.env` is per-window — the extension sets it at activation, before Claude Code spawns anything:

```text
Window A                          Window B
process.env.CLAUDE_CONFIG_DIR     process.env.CLAUDE_CONFIG_DIR
  = ~/.claude-work                  = ~/.claude-personal
    ├── .credentials.json (own)       ├── .credentials.json (own)
    ├── .claude.json      (own)       ├── .claude.json      (own)
    └── projects → shared store       └── projects → shared store
```

Two details make this reliable:

- The machine-scoped `claudeCode.environmentVariables` setting is shared by *all* windows, so if it defined `CLAUDE_CONFIG_DIR` it would force every window onto one account. The extension removes that entry and keeps isolation in `process.env`.
- Saving the same email twice never creates a second snapshot: two copies of one OAuth token invalidate each other on refresh. The existing copy is reused and its credentials refreshed instead.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeProfiles.sharedHistory` | `true` | One conversation history shared by all accounts. Turn off to keep each account's history isolated (each gets a full copy at that moment) |
| `claudeProfiles.reloadOnSwitch` | `false` | Always reload the window after switching accounts, instead of switching live |

---

## Limitations

- **Live conversation listing** reads `/proc` — Linux and WSL only (the rest of the extension works without it).
- **Shared history on native Windows** requires Developer Mode for symlink creation.
- **API-key users**: this extension is for OAuth (claude.ai) logins. With `ANTHROPIC_API_KEY` you don't need it — set the key per window/profile yourself.
- A conversation that is already running when you switch keeps its original account until you start a new conversation (or reload the window). That's a property of Claude Code's long-lived processes, surfaced honestly in the UI.

---

## Privacy & security

- Credentials are copied only between Claude Code data directories on your own machine, mode `600`.
- The extension never reads or transmits the contents of your credentials or conversations; it moves/links files and asks the local `claude` CLI who is signed in.
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

[MIT](LICENSE) © dercasdrol
