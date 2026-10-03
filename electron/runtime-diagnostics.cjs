const fs = require('node:fs');
const path = require('node:path');

/** Opt-in local evidence only. Never change exit, reload, or recovery behavior. */
function installRuntimeDiagnostics({
  app,
  processEvents = process,
  logFile = process.env.DAOYAN_ELECTRON_DIAGNOSTICS_FILE,
}) {
  if (!logFile) return;
  let enabled = true;
  const record = (event, details = {}) => {
    if (!enabled) return;
    try {
      fs.appendFileSync(
        logFile,
        JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details }) +
          '\n',
      );
    } catch (error) {
      enabled = false;
      console.error('[runtime-diagnostics] Local logging disabled:', error.message);
    }
  };
  try {
    if (!path.isAbsolute(logFile)) throw new Error('Use an absolute diagnostics file path');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  } catch (error) {
    console.error('[runtime-diagnostics] Local logging unavailable:', error.message);
    return;
  }
  record('process-start', { electron: process.versions.electron, platform: process.platform });
  if (!enabled) return;

  app.on('child-process-gone', (_event, details) => {
    record('child-process-gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  app.on('web-contents-created', (_event, contents) => {
    const webContentsId = contents.id;
    contents.on('render-process-gone', (_event, details) => {
      record('render-process-gone', {
        webContentsId,
        reason: details.reason,
        exitCode: details.exitCode,
      });
    });
    contents.on('did-finish-load', () => record('did-finish-load', { webContentsId }));
    contents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
      record('did-fail-load', { webContentsId, errorCode, isMainFrame });
    });
  });
  app.on('browser-window-created', (_event, window) => {
    const windowId = window.id;
    record('window-created', { windowId });
    for (const event of ['close', 'closed', 'unresponsive', 'responsive']) {
      window.on(event, () => record('window-' + event, { windowId }));
    }
  });
  for (const event of ['before-quit', 'will-quit', 'window-all-closed']) {
    app.on(event, () => record(event));
  }
  app.on('quit', (_event, exitCode) => record('app-quit', { exitCode }));
  // Unlike uncaughtException, this monitor preserves Node's fatal-exception behavior.
  processEvents.on('uncaughtExceptionMonitor', (error, origin) => {
    record('uncaught-exception', { origin, stack: String(error.stack ?? error).slice(0, 8000) });
  });
  processEvents.on('exit', (exitCode) => record('process-exit', { exitCode }));
}

module.exports = { installRuntimeDiagnostics };
