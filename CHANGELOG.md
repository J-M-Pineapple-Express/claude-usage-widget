# Changelog

## v0.7.1 — 2026-09-22

### Added
- **Bots & scripts in the Sessions window.** Bots and scripts that drive Claude
  Code with `claude -p --resume` (a Discord bot, for example) start a short
  process for every message, so they never appeared as running sessions. The
  Sessions window now lists them in their own section: any headless session
  that has handled 2 or more messages in the last day, with how many messages
  it has handled, when it last replied, whether it's replying right now,
  context % and transcript size. One-off `claude -p` calls are left out.

## v0.7.0 — 2026-09-22

**Multiple sessions.** If you run several Claude Code sessions at once (a few
terminals, VS Code, the desktop app), the widget now knows about all of them.

### Added
- **Sessions window.** Click **sessions** (or **+2 more**) at the end of the
  project/session line. It lists every running interactive session, read from
  Claude Code's own records of running sessions:
  - session name and project
  - where it's running: the terminal, VS Code workspace, or Claude Desktop
  - working or idle, and how long since it was last active
  - context % and transcript size
  - a **where I left off** link for its recap
- **Pin a session.** Click a session in that window to show it in the widget's
  context bar. The recap window follows the pin too. Click it again, or
  **Follow latest**, to unpin. While pinned, the widget's link reads **pinned**.
  If a pinned session ends, the widget goes back to following the latest one.

### Changed
- When nothing is pinned, the context bar follows the running session that was
  active most recently. Before, it followed whichever transcript on disk changed
  last, which could be a background `claude -p` run rather than a session you
  were working in.

## v0.6.0 — 2026-09-22

### Added
- **Where you left off.** Click the project/session line under the context bar to
  open a small window with Claude Code's latest "while you were away" recap for
  that session, plus the last thing you asked. Recaps are Claude Code's own and
  can be turned on or off in its `/config`; with them off, you still get the last
  prompt.
- **Auto Continue activity.** Click **activity** next to the Auto Continue switch
  to see:
  - the last check: when it ran, your 5-hour and weekly numbers, and whether it's
    waiting on a reset
  - anything waiting to send: which window, when the limit hit, any interrupted
    agents, and the exact message that will be pasted
  - recent sends, including ones that couldn't reach their window
- **Unnamed sessions get a name.** If you never used `/rename`, the widget shows
  the title Claude Code generated for the session instead of nothing.

### Fixed
- An Auto Continue entry whose window couldn't be identified was dropped quietly.
  It's now recorded in the activity history as dropped.

### Testing
- Auto Continue on macOS now has an automated test that runs on a real Mac for
  every change. It covers everything except the final paste into your window,
  which still needs a hands-on check.

## v0.5.2 — 2026-09-22

### Fixed
- **Context row showed only the last word of the project name.** A project in
  "Claude Command Center" showed up as "Center" because the name was guessed from
  Claude Code's encoded folder name, where spaces and dashes both turn into `-`.
  It now reads the folder the session was launched in straight from the
  transcript, so you get the full name.

### Added
- **Session name** next to the project (whatever you set with `/rename`), shown as
  `Project · Session` on its own line under the context bar. Long names are cut
  off with "…"; hover to see the whole thing.
- **Transcript size** on the context line (`jsonl 4.7MB`), colored like the Claude
  Code status line: green under 12MB, yellow under 15MB, red above.

## v0.5.1 — 2026-09-22

**Auto Continue for macOS.** The Auto Continue and Resume agents switches now
appear on macOS too. An automated test on a real Mac covers the hook (finding
the host app and terminal tab, merging agents, the settings.json entry) and
checks the nudge script compiles. The last step, bringing the window forward
and pasting, hasn't been tried by hand on a Mac yet. Please report anything
that doesn't work.

### Added
- **macOS hook.** Runs under the widget's own app binary in Node mode, so it
  needs nothing installed. It finds the app hosting the Claude session (Terminal,
  iTerm, VS Code, the Claude desktop app) and, for terminals, the exact tab.
- **macOS nudge.** Brings that app forward, selects the matching Terminal or iTerm
  tab (or raises the VS Code window for the project folder), then pastes the
  continue message and presses Return. If the target app doesn't end up in front,
  it doesn't paste, and it retries on the next poll.
- **Permission prompt when you turn it on.** macOS only lets apps send keystrokes
  to other apps after you allow it under **System Settings > Privacy & Security >
  Accessibility**. The widget asks as soon as you flip the switch, so you aren't
  surprised by a prompt when a reset lands. You may also see a one-time prompt
  asking to let Claude Usage control System Events, Terminal, or iTerm.
- On macOS the clipboard is saved and restored around the paste, images included.

### Known limits (macOS)
- A locked screen blocks keystrokes, same as Windows; it sends after you unlock.
- For editors other than VS Code, the message goes to whichever of that app's
  windows was last active.

## v0.5.0 — 2026-09-22

**Auto Continue (Windows).** Hit your 5-hour or weekly limit mid-task, walk away,
and the widget picks the work back up for you. When the limit resets, it brings the
stalled Claude Code window forward and sends:

> I had hit my token limit previously, please continue where we left off.

No more coming back hours later to a session that has been sitting idle since the
reset.

### Added
- **Auto Continue switch** on the widget and in the tray menu. Off by default.
  Turning it on registers a `StopFailure` hook (matcher `rate_limit`) in
  `~/.claude/settings.json`; turning it off removes it. Your settings file is
  backed up to `settings.json.auto-continue-backup` before every change, and a
  settings file that isn't valid JSON is left alone.
- **Resume agents switch.** If the limit also cut off subagents or teammates, the
  continue message names them. With the switch on, it tells Claude to resume each
  one (wake idle teammates with `SendMessage` so they keep their context, relaunch
  any that are gone). With it off, it lists them and asks Claude to wait for you.
  Off by default, since resuming a batch of agents can spend most of a fresh
  window before you're back.
- Works for sessions in any terminal, VS Code, or the Claude Code Desktop app. The
  hook walks up from the Claude process to find the window it's running in.

### How it behaves
- It waits until **both** the 5-hour and weekly bars are under 100%, so it never
  sends a message into a limit that's still in force.
- If your screen is locked when the reset lands, Windows blocks sending keys to
  other windows. The widget retries every minute and sends once you unlock.
- One message per window, no matter how many agents in it hit the limit.
- The message is pasted, not typed, so no characters get dropped. Your clipboard
  is restored afterward (text only; an image on the clipboard would be replaced).
- Turning Auto Continue off clears anything still waiting, so re-enabling it later
  can't send a message about a limit you hit hours ago.

### Notes
- Windows only for now. On macOS the switches are hidden and everything else
  works as before.
- Needs only PowerShell, which ships with Windows. No Python or other installs.

## v0.4.0 — 2026-09-20

**Reads the usage API instead of scraping the settings page.** The widget used to
load `claude.ai/settings/usage` in a hidden browser and pattern-match the rendered
English text. That broke every time Anthropic edited a label — twice already
(v0.3.4's "Extra usage" -> "Usage credits", and now "Weekly limits" -> "This week").
It now calls `GET /api/organizations/{org}/usage` directly, authenticated by the
session cookies the widget already stores.

### Fixed
- **Weekly bar stuck on "—".** The scraper anchored on the literal strings
  "Weekly limits" and "All models". The settings page now says "This week", so the
  weekly percentage came back null while the 5-hour bar kept working. Reading
  `seven_day.utilization` from the API removes the whole class of failure.
- **Expired session was a dead end.** When the cookie lapsed, claude.ai redirected
  the scraper to the login page, and the widget reported "Could not read usage page"
  every poll, forever — the only recovery was a tray menu item nobody would think
  to look for. A 401/403 is now recognized as signed-out, the widget says so, and
  the sign-in window reopens on its own (once, not in a loop).

### Added
- **Monthly spend row** — `$80.31 / $100` from `spend.used` / `spend.limit`, or
  "off" when usage credits aren't enabled.
- **This week by product** — Claude Code / Chats / Cowork / Other, from
  `seven_day_breakdown`. Rows are built from the response, so a new product
  category appears without a code change.
- **Transient network errors stay quiet.** A DNS blip or a sleeping laptop used
  to put a raw `net::ERR_NAME_NOT_RESOLVED` in the status line. It now reads
  "Offline — retrying" and leaves the last good numbers on screen; the next poll
  recovers on its own.
- **Negative balances render correctly** (`-$0.01`). The old regex only matched a
  leading `$` and silently dropped the minus sign.

### Changed
- **Real reset timestamps.** The API returns ISO datetimes, so the widget phrases
  them itself: "in 2h 23m" for the session window, "Wed 11:00 PM" for anything
  more than a day out. Previously it echoed whatever text the page had rendered.
- **No more hidden Chromium window.** Each poll was spinning up and tearing down a
  full browser window. It's now a plain JSON GET through Electron's `net` module.
- **Auto-refresh back to 60 s** (was 5 min). The 5-minute interval existed only
  because scraping was expensive; it isn't anymore.
- Org id is resolved once and cached to `org.json` in userData — from the
  `lastActiveOrg` cookie when present, otherwise `GET /api/organizations`.
  The cache is dropped on a 403 so a stale id can't wedge the widget.

## v0.3.5 — 2026-06-14

### Added
- **Hide button** (`–` in the title bar). Tucks the always-on-top widget away when you need it out of the way; reopen it from the tray / menu-bar icon → **Show widget**.

### Fixed
- **Drop shadow fully gone.** v0.3.1 removed the OS window shadow (`hasShadow: false`), but the card still had a CSS `box-shadow` rendering a drop shadow inside the transparent window. Removed it.

## v0.3.4 — 2026-06-13

### Fixed
- **Extra usage / balance rows broke** (showed "—"). Anthropic renamed the settings-page section from **"Extra usage" → "Usage credits"**, so the scraper's anchor no longer matched and the whole block was skipped. Now matches either name, and the amount→label matching tolerates the new layout's inline buttons ("Adjust limit" / "Buy usage credits") between a dollar amount and its label.

### Changed
- **Context monitor now defaults to the 1M window** (both owners run 1M). Click the detail line to drop to 200K/500K for a standard window; the choice is still remembered.

## v0.3.3 — 2026-06-13

### Added
- **Claude Code context monitor.** New top row showing how full your active Claude Code context window is — the heads-up before auto-compaction. It reads the most-recently-active transcript under `~/.claude/projects/` (last turn's token usage: input + cache), polls every 15 s, and is independent of your claude.ai login. The bar runs green → yellow → **red** as you approach the compaction threshold.
- **Window size selector.** The transcript doesn't record the window size, so click the context detail line to cycle the assumed window (200K → 500K → 1M); the choice is remembered. The bar measures against ~80% of the window, where auto-compact fires.

## v0.3.2 — 2026-06-13

### Changed
- **Auto-refresh interval 60 s → 5 min.** Each poll spins up a hidden browser to scrape the usage page, so 60 s was needlessly heavy. Manual refresh (the ↻ button and tray "Refresh now") is unchanged and still instant.

## v0.3.1 — 2026-06-13

### Fixed
- **macOS — weird frame/halo around the widget:** a frameless transparent window on macOS drew an OS drop shadow around the full window rect, which read as a light frame around the inset card. Disabled the window shadow (`hasShadow: false`), forced a fully transparent backing (`backgroundColor: '#00000000'`), and removed the card's 4px margin so it sits flush to the window edge. Windows was unaffected and is unchanged.

## v0.3.0 — 2026-05-13

**Privacy & reliability pass.** Run a code review and patched every real finding.

### Fixed
- **CRITICAL — privacy:** removed steady-state logging of the rendered page body. Earlier versions logged the user's Claude sidebar (chat titles, etc.) to `startup.log` every 60 s. Body dump is now gated behind `CLAUDE_USAGE_DEBUG=1`. Log rotation added at 1 MB.
- **HIGH — tray icon:** ships real PNG icons for Windows + macOS (template image for menu bar). The tray menu is now actually clickable.
- **HIGH — macOS dock:** widget no longer shows in the Dock (`LSUIElement: true`, `app.dock.hide()`). Pure menu-bar utility on Mac.
- **MEDIUM — memory:** scraper BrowserWindow is now created per-poll and destroyed in `finally`. Previously a 1200×900 hidden Chromium window stayed resident for the whole session.
- **MEDIUM — slow connections:** replaced hardcoded 4 s wait with `waitForText` polling up to 12 s for the usage page to render.
- **MEDIUM — login race:** added `loginHandled` guard so simultaneous nav events can't spawn duplicate widgets/poll loops.
- **MEDIUM — auth detection:** tightened cookie regex to require Claude's actual session cookie (`sessionKey` / `sessionKeyLC`) instead of any `__Secure-` cookie.
- **MEDIUM — quit behavior:** `window-all-closed` now respects platform conventions (keep alive on macOS when tray exists, quit on Win/Linux otherwise).
- **LOW — balance parsing:** balance regex now accepts whole-dollar amounts (`$220` as well as `$220.00`).
- **LOW — dead code:** removed unused `scraper-preload.js` from the bundle.

### Added
- Version display in the widget footer (`v0.3.0`) — easier bug reports.
- Tray menu shows version + supports left-click on Windows to bring the widget back.
- Content Security Policy on the widget page.
- Tray icons: terracotta circle on Windows, black template circle on macOS.

## v0.2.0 — 2026-05-12
- Added Extra-usage spend (with monthly cap) and prepaid Balance rows.
- Bumped widget height to fit the new rows cleanly.
- Public release: macOS builds via GitHub Actions.

## v0.1.0 — 2026-05-12
- Initial release: 5-hour and weekly usage bars with reset countdowns.
- First-run sign-in window with persistent isolated cookies.
- Tray menu (refresh / sign out / quit).
- Windows NSIS installer.
