/**
 * Dev-only DNS shim, preloaded via `node --require` by dev.mjs.
 *
 * Node (unlike browsers) does not resolve `*.localhost`, so Next's server-side `/api`
 * proxy can't reach the tenant host `demo.localhost:3000`. Patching the Node resolver
 * here (before Next/undici load) maps any `*.localhost` to 127.0.0.1 — so `pnpm dev`
 * works with no Windows hosts-file edit. Not used in production (same-origin there).
 */
const dns = require('node:dns');
const orig = dns.lookup.bind(dns);
dns.lookup = (host, options, cb) => {
  if (typeof host === 'string' && /(^|\.)localhost$/i.test(host)) {
    const callback = typeof options === 'function' ? options : cb;
    if (typeof options === 'object' && options && options.all) {
      return callback(null, [{ address: '127.0.0.1', family: 4 }]);
    }
    return callback(null, '127.0.0.1', 4);
  }
  return orig(host, options, cb);
};
