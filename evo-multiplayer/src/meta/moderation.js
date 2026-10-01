// Automatic text moderation for world chat and private messages.
//
// Cheap, deterministic rules that run on every message (no external call on
// the hot path); anything subtler goes through player reports to humans.
//  * blocklist words are masked (BLOCKLIST file, shared with the gateway);
//  * links are blocked unless their domain is allow-listed (phishing is the
//    #1 scam once items have value);
//  * contact-info solicitation ("加微信", long digit strings, QQ numbers) is
//    blocked in messages to non-friends (off-platform trade scams);
//  * repeating the same text 3 times within 60 s is spam;
//  * each blocked message is a strike; STRIKES_TO_MUTE strikes within 10 min
//    auto-mute the sender for MUTE_MINUTES (and is written to the audit log).

import fs from 'node:fs';

export const STRIKES_TO_MUTE = 5;
export const MUTE_MINUTES = 10;

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s]+|[a-z0-9-]{2,}\.(?:com|net|org|cn|io|gg|xyz|top|cc|me|co|info|link|shop|vip|site|app)\b[^\s]*)/giu;
const CONTACT_RE = /(加\s*[vV微威薇]|微\s*信|[vV][xX]\s*[:：]?|wechat|q\s*q\s*[:：号]?|扣扣|telegram|whatsapp|tg\s*[:：])|(\d[\d\s-]{6,}\d)/iu;

export function loadBlocklist(file) {
  if (!file) return null;
  try {
    const words = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((w) => w.trim())
      .filter((w) => w && !w.startsWith('#'));
    if (!words.length) return null;
    return new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'giu');
  } catch {
    return null;
  }
}

export class Moderator {
  constructor({ blocklist = null, allowDomains = [], onAutoMute = () => {} } = {}) {
    this.blockRe = blocklist;
    this.allow = new Set(allowDomains.map((d) => d.toLowerCase()));
    this.onAutoMute = onAutoMute;
    this.recent = new Map(); // account -> [{ text, t }]
    this.strikes = new Map(); // account -> [t]
  }

  linkAllowed(url) {
    const host = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#:]/)[0].toLowerCase();
    for (const d of this.allow) if (host === d || host.endsWith('.' + d)) return true;
    return false;
  }

  // ctx: { account, channel: 'world'|'dm', toFriend: bool }
  // -> { ok, text, reasons: [] }   (ok=false means do not deliver)
  check(raw, ctx = {}) {
    let text = String(raw ?? '').trim();
    const reasons = [];
    if (!text) return { ok: false, text, reasons: ['empty'] };
    if (this.blockRe) {
      const masked = text.replace(this.blockRe, (m) => '*'.repeat([...m].length));
      if (masked !== text) reasons.push('masked');
      text = masked;
    }
    let block = false;
    URL_RE.lastIndex = 0;
    const links = text.match(URL_RE) || [];
    if (links.some((l) => !this.linkAllowed(l))) {
      block = true;
      reasons.push('link');
    }
    if (!ctx.toFriend && CONTACT_RE.test(text)) {
      block = true;
      reasons.push('contact');
    }
    const now = Date.now();
    if (ctx.account) {
      const list = (this.recent.get(ctx.account) || []).filter((m) => now - m.t < 60000);
      const same = list.filter((m) => m.text === text).length;
      if (same >= 2) {
        block = true;
        reasons.push('repeat');
      }
      list.push({ text, t: now });
      this.recent.set(ctx.account, list.slice(-10));
      if (this.recent.size > 200000) this.recent.clear();
      if (block) this.strike(ctx.account, reasons);
    }
    return { ok: !block, text, reasons };
  }

  strike(account, reasons) {
    const now = Date.now();
    const list = (this.strikes.get(account) || []).filter((t) => now - t < 10 * 60000);
    list.push(now);
    this.strikes.set(account, list);
    if (list.length >= STRIKES_TO_MUTE) {
      this.strikes.set(account, []);
      this.onAutoMute(account, now + MUTE_MINUTES * 60000, reasons);
    }
  }
}
