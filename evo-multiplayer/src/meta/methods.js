// Shared between gateways and meta replicas (no dependencies, so the gateway
// does not pull in database drivers).

// Methods a client may call through a gateway -> whether they need a
// logged-in account. Anything not listed never leaves the gateway.
export const CLIENT_METHODS = {
  'auth.register': false,
  'auth.login': false,
  'auth.recover': false,
  'auth.logout': true,
  'auth.logoutAll': true,
  'auth.sessions': true,
  'auth.password': true,
  'auth.totpSetup': true,
  'auth.totpEnable': true,
  'auth.totpDisable': true,
  'auth.privacy': true,
  'auth.me': true,
  'wallet.get': true,
  'market.browse': false,
  'market.list': true,
  'market.cancel': true,
  'market.buy': true,
  'market.mine': true,
  'trade.open': true,
  'trade.get': true,
  'trade.mine': true,
  'trade.offer': true,
  'trade.confirm': true,
  'trade.cancel': true,
  'friends.list': true,
  'friends.request': true,
  'friends.respond': true,
  'friends.remove': true,
  'block.add': true,
  'block.remove': true,
  'block.list': true,
  'dm.send': true,
  'dm.history': true,
  'dm.unread': true,
  'dm.read': true,
  'player.find': false,
  'report.create': true,
};

// Admin endpoints served by meta (GET or POST) -> minimum role.
export const ADMIN_METHODS = {
  reports: { method: 'GET', role: 'mod' },
  audit: { method: 'GET', role: 'mod' },
  economy: { method: 'GET', role: 'mod' },
  account: { method: 'GET', role: 'mod' },
  closeReport: { method: 'POST', role: 'mod' },
  sanction: { method: 'POST', role: 'mod' },
  role: { method: 'POST', role: 'admin' },
};

// Account ids below 2^30; guests get world identities in [2^30, 2^31) so a
// guest can never take over an account's lineage.
export const GUEST_PID_MIN = 2 ** 30;

// Home replica of an account (holds its presence, delivers its events).
export function homeReplica(acct, replicas) {
  return ((Number(acct) % replicas) + replicas) % replicas;
}

// Stable replica for a string (login throttling by user name).
export function replicaForKey(key, replicas) {
  let h = 2166136261;
  for (const ch of String(key)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return (h >>> 0) % replicas;
}
