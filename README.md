# Claude Usage Widget

A tiny always-on-top desktop widget that shows your Claude usage at a glance: the **5-hour window**, the **weekly window**, your **extra-usage spend**, and your **prepaid balance**. Auto-refreshes every 5 minutes (plus manual refresh any time).

Built with Electron. Available for **Windows** and **macOS**.

---

## Download

Grab the latest installer for your OS from the **[Releases page](https://github.com/AfterRealm/claude-usage-widget/releases/latest)**.

| OS | File |
|----|------|
| Windows (x64) | `ClaudeUsage-Setup-x.y.z.exe` |
| macOS (Apple Silicon) | `ClaudeUsage-x.y.z-arm64.dmg` |
| macOS (Intel) | `ClaudeUsage-x.y.z-x64.dmg` |

> Almost every Mac sold since 2021 is Apple Silicon — grab the **`arm64`** build unless you know you're on an older Intel Mac. (Apple has ended Intel support, so the `x64` build is legacy-only.)

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
> If you see **"Claude Usage is damaged and can't be opened"** — that's the same unsigned/quarantine block, not actual corruption. The `xattr` command above clears it.

---

## First-run

1. Install and launch.
2. A Claude sign-in window pops up. Sign in with the account whose usage you want to see.
3. The window closes and the small widget appears. That's it — sign-in is remembered.

The widget stores its own cookies in an isolated Electron partition. It does **not** touch the official Claude Desktop app or your browser.

---

## What it shows

- **5-hour bar** — % of current session used + countdown to reset
- **Weekly bar** — % of weekly limit used (All models) + reset day/time
- **Extra spent** — dollars spent on extra usage / your monthly spend cap
- **Balance** — prepaid balance remaining

---

## Controls

- Drag by the title bar to move it.
- **↻** — refresh now (it auto-refreshes every 5 min anyway).
- **×** — quit.
- Right-click the tray icon for **Refresh now** / **Sign out / switch account** / **Quit**.

---

## How it works

The widget loads `claude.ai/settings/usage` in a hidden BrowserWindow using your saved session cookies, reads the rendered values out of the DOM, and pushes them to the visible widget UI. No API keys, no third-party servers, nothing leaves your machine.

If Claude changes the settings page markup, the scraper will need updating — open an issue.

---

## Build from source

```bash
git clone https://github.com/AfterRealm/claude-usage-widget.git
cd claude-usage-widget
npm install
npm start              # dev run
npm run dist:win       # build Windows installer  (run on Windows)
npm run dist:mac       # build macOS DMG          (run on macOS)
```

---

## Troubleshooting

Widget says "Could not read usage page":
1. Click the **↻** refresh button.
2. If it persists, sign out and back in: tray icon → **Sign out / switch account**.
3. If it still fails, claude.ai may have changed its usage page markup. Open an [issue](https://github.com/AfterRealm/claude-usage-widget/issues) with the log file at:
   - Windows: `%APPDATA%\claude-usage-widget\startup.log`
   - macOS: `~/Library/Application Support/claude-usage-widget/startup.log`

---

## License

MIT — see [LICENSE](LICENSE).

Built by [AfterRealm](https://github.com/AfterRealm).
