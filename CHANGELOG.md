# Changelog

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
