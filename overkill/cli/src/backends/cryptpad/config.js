// Instance configuration, fetched over plain HTTP. No CryptPad modules needed here.

// /api/config is an AMD module wrapping a JSON object literal.
export async function fetchApiConfig (origin) {
  const txt = await (await fetch(`${origin}/api/config`)).text();
  const start = txt.indexOf('return {');
  const end = txt.lastIndexOf('};');
  const cfg = JSON.parse(txt.slice(start + 'return '.length, end + 1));
  // many instances leave these to CryptPad's defaults (NetConfig.getWebsocketURL): the
  // websocket at /cryptpad_websocket on the main origin, and blocks served by the origin itself
  const ws = cfg.websocketPath || '/cryptpad_websocket';
  cfg.websocketPath = ws.startsWith('/') ? origin.replace(/^http/, 'ws') + ws : ws;
  cfg.fileHost ||= origin;
  cfg.httpUnsafeOrigin ||= origin;
  return cfg;
}

// Instance settings from /customize/application_config.js. Many instances set a loginSalt
// that is appended to the username in the scrypt salt (common-credential.js customSalt).
export async function fetchAppConfig (origin) {
  const res = await fetch(`${origin}/customize/application_config.js`);
  const txt = res.ok ? await res.text() : '';
  const salt = /AppConfig\.loginSalt\s*=\s*(['"])(.*?)\1/.exec(txt);
  const minLen = /AppConfig\.minimumPasswordLength\s*=\s*(\d+)/.exec(txt);
  return { loginSalt: salt ? salt[2] : '', minimumPasswordLength: minLen ? Number(minLen[1]) : 8 };
}
