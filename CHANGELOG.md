# Changelog

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
