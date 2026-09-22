# Claude Usage Widget

A tiny always-on-top desktop widget that shows your Claude usage at a glance: your **5-hour window**, your **weekly window**, your **monthly spend**, and your **prepaid balance**. It refreshes every minute, and you can refresh by hand any time.

It can also pick your work back up for you: with **Auto Continue** on, when a usage limit resets it tells the stalled Claude Code session to continue where it left off.

Built with Electron. Available for **Windows** and **macOS**.

---

## Download

Grab the latest installer for your OS from the **[Releases page](https://github.com/J-M-Pineapple-Express/claude-usage-widget/releases/latest)**.

| OS | File |
|----|------|
| Windows (x64) | `ClaudeUsage-Setup-x.y.z.exe` |
| macOS (Apple Silicon) | `ClaudeUsage-x.y.z-arm64.dmg` |
| macOS (Intel) | `ClaudeUsage-x.y.z-x64.dmg` |

> Almost every Mac sold since 2021 is Apple Silicon, so grab the **`arm64`** build unless you know you're on an older Intel Mac. (Apple has ended Intel support, so the `x64` build is legacy-only.)

> The app is **not code-signed or notarized**, so the OS will warn on first launch.
>
> **Windows:** click **More info → Run anyway**.
>
> **macOS:** the right-click → Open trick was removed in macOS 15 (Sequoia) and no longer works. Instead:
> 1. Drag **Claude Usage** into `/Applications`.
> 2. Open **Terminal** and run:
>    ```bash
>    xattr -dr com.apple.quarantine "/Applications/Claude Usage.app"
>    ```
> 3. Launch it normally.
>
> If you see **"Claude Usage is damaged and can't be opened"**, that's the same unsigned/quarantine block, not actual corruption. The `xattr` command above clears it.

---

## First run

1. Install and launch.
2. A Claude sign-in window pops up. Sign in with the account whose usage you want to see.
3. The window closes and the small widget appears. Sign-in is remembered.

The widget stores its own cookies in an isolated Electron partition. It does **not** touch the official Claude Desktop app or your browser.

---

## What it shows

- **Context**: how full your active Claude Code context window is, so you get a heads-up before it auto-compacts. Reads the most recently active transcript under `~/.claude/projects/` and updates every 15 s. Click the line under the bar to set your window size (200K / 500K / 1M); it measures against about 80% of that, where compaction kicks in. Green → yellow → red as you fill up. The line under the bar also shows the transcript's size (`jsonl 4.7MB`, green under 12MB, yellow under 15MB, red above), and the line below that shows which project and session it's measuring, for example `Claude Command Center · Projects`.
- **5-hour**: % of your current session window used, and when it resets.
- **Weekly**: % of your weekly limit used, and the reset day and time.
- **Spend**: usage credits spent this month against your monthly cap, or "off" if usage credits aren't enabled.
- **Balance**: prepaid balance remaining.
- **Auto Continue** switches (see below).
- **This week by product**: how much of the weekly allowance went to Claude Code, Chats, Cowork, and Other.

---

## Auto Continue

Hit your usage limit mid-task and walk away. When the limit resets, the widget brings the stalled Claude Code window forward and sends:

> I had hit my token limit previously, please continue where we left off.

It works with Claude Code in a terminal, in VS Code, or in the Claude Code Desktop app.

**Turn it on** with the **Auto Continue** switch on the widget (or tray icon → **Auto Continue**). That registers a small hook in `~/.claude/settings.json` so Claude Code tells the widget when a session stops on a rate limit. Turning it off removes the hook. Your settings file is backed up to `settings.json.auto-continue-backup` before each change, and the widget won't touch a settings file that isn't valid JSON.

**Resume agents** (off by default): if the limit also stopped subagents or teammates, the message names them. On, it asks Claude to resume them. Off, it lists them and waits for you. Resuming a batch of agents can use up a good chunk of a fresh window, so only turn this on if that's what you want while you're away.

Good to know:
- It only sends once both the 5-hour and weekly bars are under 100%.
- Your OS won't let apps send keystrokes while the screen is locked, so a reset that lands while you're locked gets sent right after you unlock.
- The widget has to be running for it to work.
- The message is pasted in, and your clipboard is put back afterward.
- **macOS support is new and hasn't been tested on a Mac yet.** You'll need to allow Claude Usage under **System Settings > Privacy & Security > Accessibility** (the widget asks when you turn the switch on), and you may get a one-time prompt to let it control System Events, Terminal, or iTerm.

---

## Controls

- Drag by the title bar to move it.
- **↻**: refresh now.
- **–**: hide the widget. Bring it back from the tray / menu-bar icon → **Show widget**.
- **×**: quit.
- Right-click the tray icon for **Show widget**, **Refresh now**, **Auto Continue**, **Sign out / switch account**, and **Quit**.

---

## How it works

The widget calls the same JSON endpoint the claude.ai usage page uses (`/api/organizations/{org}/usage`), signed in with the session cookies from your first-run login. No API keys, no third-party servers, nothing leaves your machine.

Auto Continue adds two local pieces: a Claude Code `StopFailure` hook that writes a small queue file (`~/.claude/auto-continue-queue.json`) when a session hits a rate limit, and the widget itself, which checks that queue on every refresh and sends the continue message once your limits have reset.

---

## Build from source

```bash
git clone https://github.com/J-M-Pineapple-Express/claude-usage-widget.git
cd claude-usage-widget
npm install
npm start              # dev run
npm run dist:win       # build Windows installer  (run on Windows)
npm run dist:mac       # build macOS DMG          (run on macOS)
```

---

## Troubleshooting

**"Session expired — signing in…"**: your claude.ai login lapsed. The sign-in window reopens on its own; sign in again and the numbers come back.

**"Offline — retrying"**: the widget couldn't reach claude.ai (network blip, laptop waking up). It keeps the last numbers on screen and recovers on the next refresh.

**Auto Continue didn't send anything:**
1. Make sure the widget was running when the limit reset, and the Auto Continue switch is on.
2. Check that `~/.claude/settings.json` has a `StopFailure` entry mentioning `rate_limit_hook`. Toggling the switch off and on re-adds it.
3. On macOS, confirm Claude Usage is allowed under **Privacy & Security > Accessibility**.

Anything else: open an [issue](https://github.com/J-M-Pineapple-Express/claude-usage-widget/issues) with the log file at:
- Windows: `%APPDATA%\claude-usage-widget\startup.log`
- macOS: `~/Library/Application Support/claude-usage-widget/startup.log`

---

## License

MIT, see [LICENSE](LICENSE).

Built by [AfterRealm](https://github.com/AfterRealm).
