// Who may talk to the fixture server. Pure functions, so a unit test can check the rules without a socket.
//
// The server holds the developer's provider keys while NB_LIVE=1 and takes unauthenticated POSTs from the autorun
// build, so it answers only requests that really are addressed to a loopback name (a page on another site cannot
// reach it through DNS rebinding) and, on its internal /__ endpoints, only the extension itself or a client that
// sends no Origin at all (curl, Node). A web page on another origin gets a 403 and no CORS header.

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether a Host header names this server: a loopback name with the port the server listens on. */
export function isLoopbackHost(host, port) {
  if (typeof host !== 'string') return false;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i.exec(host.trim());
  if (!match || !LOOPBACK_NAMES.has(match[1].toLowerCase())) return false;
  // A missing port means the scheme's default (80), which is never this server unless it listens there.
  return Number(match[2] ?? 80) === Number(port);
}

/** Whether an Origin header is an extension page or worker. */
export function isExtensionOrigin(origin) {
  return typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

/**
 * The verdict on one request: `{ ok: true, allowOrigin }` where allowOrigin is the value for
 * `access-control-allow-origin` (or undefined for none), or `{ ok: false, status, reason }`.
 * Internal endpoints (/__...) answer the extension and clients with no Origin only; the pages keep the wildcard
 * they have always had, because they hold no secret.
 */
export function judgeRequest({ host, origin, path, port }) {
  if (!isLoopbackHost(host, port)) return { ok: false, status: 421, reason: 'not a loopback host' };
  if (path.startsWith('/__')) {
    if (origin === undefined) return { ok: true, allowOrigin: undefined };
    if (isExtensionOrigin(origin)) return { ok: true, allowOrigin: origin };
    return { ok: false, status: 403, reason: 'internal endpoints answer the extension only' };
  }
  return { ok: true, allowOrigin: '*' };
}
