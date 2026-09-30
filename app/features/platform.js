// The platform features' part of the app itself: pick the folder a skill is installed from
// (Settings › Skills). Only the window may ask (ctx.fromWindow).
'use strict';

const os = require('os');
const path = require('path');

// The window says what the dialog asks, in its own language (a short line of text only).
function words(text, fallback) {
  return typeof text === 'string' && text.trim() && text.length <= 200 ? text : fallback;
}

function handlers({ dialog, getWindow }) {
  const parent = () => { const w = getWindow(); return w && !w.isDestroyed() ? w : undefined; };
  return {
    async pickSkillFolder(message) {
      const said = words(message, 'Choose a skill, or a folder of skills');
      const result = await dialog.showOpenDialog(parent(), {
        title: said,
        message: said,
        defaultPath: path.join(os.homedir(), 'Downloads'),
        properties: ['openDirectory'],
      });
      return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
    },
  };
}

function install(ctx) {
  const { dialog } = require('electron');
  const h = handlers({ dialog, getWindow: ctx.getWindow });
  ctx.ipcMain.handle('feature:platform:pick-folder', (event, message) => (ctx.fromWindow(event) ? h.pickSkillFolder(message) : null));
}

module.exports = { install, handlers };
