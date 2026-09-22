// Auto Continue nudge, macOS. JavaScript for Automation, run as:
//   osascript -l JavaScript nudge_mac.js <appPath> <tty> <folderName>
// The widget puts the message on the clipboard before running this and
// restores the clipboard afterward.
//
// Brings the app forward, selects the tab whose tty matches (Terminal,
// iTerm) or raises the window whose title contains the project folder
// (VS Code and other editors), then pastes and presses Return. Throws, so
// osascript exits non-zero and the widget retries, if the target app didn't
// actually end up frontmost.

function run(argv) {
  const appPath = argv[0];
  const ttyPath = argv[1] || '';
  const folderName = argv[2] || '';
  const appName = appPath.replace(/\/$/, '').split('/').pop().replace(/\.app$/, '');

  const me = Application.currentApplication();
  me.includeStandardAdditions = true;
  me.doShellScript('open -a ' + shellQuote(appPath));
  delay(0.8);

  // Tab/window targeting is best-effort: if it fails, the app is still in
  // front and the paste goes to whichever window was last active in it.
  try {
    if (ttyPath && appName === 'Terminal') {
      const term = Application(appPath);
      term.windows().forEach((w) => {
        w.tabs().forEach((t) => {
          if (t.tty() === ttyPath) {
            t.selected = true;
            w.index = 1;
          }
        });
      });
    } else if (ttyPath && /^iTerm/.test(appName)) {
      const iterm = Application(appPath);
      iterm.windows().forEach((w) => {
        w.tabs().forEach((t) => {
          t.sessions().forEach((s) => {
            if (s.tty() === ttyPath) {
              w.select();
              t.select();
              s.select();
            }
          });
        });
      });
    } else if (folderName) {
      const se = Application('System Events');
      const proc = se.processes.whose({ frontmost: true })[0];
      const win = proc.windows().find((w) => String(w.name()).indexOf(folderName) !== -1);
      if (win) win.actions.byName('AXRaise').perform();
    }
  } catch (e) {}
  delay(0.4);

  const se = Application('System Events');
  const front = se.processes.whose({ frontmost: true })[0];
  const frontPath = String(front.applicationFile().posixPath()).replace(/\/$/, '');
  if (frontPath !== appPath.replace(/\/$/, '')) {
    throw new Error('target app did not come to the front (front is ' + frontPath + ')');
  }

  se.keystroke('v', { using: 'command down' });
  delay(0.3);
  se.keyCode(36);
  delay(0.2);
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
