const childProcess = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { syncBuiltinESMExports } = require('node:module');

const originalSpawn = childProcess.spawn;
const browserCommands = new Set(['rundll32', 'rundll32.exe', 'open', 'xdg-open']);

childProcess.spawn = function patchedSpawn(command, args, options) {
  const argv = Array.isArray(args) ? args : [];
  const executable = String(command).split(/[\\/]/).pop().toLowerCase();
  const authorizationUrl = argv.find((arg) => {
    try {
      return new URL(String(arg)).pathname === '/bridge/authorize';
    } catch {
      return false;
    }
  });

  if (!browserCommands.has(executable)) {
    return originalSpawn.apply(this, arguments);
  }

  const child = new EventEmitter();
  child.unref = () => child;
  child.kill = () => true;

  setImmediate(() => {
    try {
      if (!authorizationUrl) throw new Error('浏览器命令缺少有效授权 URL');
      const authorize = new URL(String(authorizationUrl));
      const redirectUri = authorize.searchParams.get('redirect_uri');
      if (!redirectUri) throw new Error('授权 URL 缺少 redirect_uri');
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', `e2e-pkce-${process.pid}-${randomUUID()}`);
      const request = http.get(callback, (response) => response.resume());
      request.on('error', (error) => {
        console.error(`[e2e-browser-preload] 回调失败：${error.message}`);
        child.emit('error', error);
      });
    } catch (error) {
      console.error(`[e2e-browser-preload] ${error.message}`);
      child.emit('error', error);
    }
  });

  return child;
};

syncBuiltinESMExports();
