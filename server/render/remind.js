'use strict';

/**
 * "Remind me" on a code's end (plan L48 R3): a link to openvibe.today/remind that sets a one-off reminder for the
 * moment the code ends. The person signs in there, picks how long before, and it reaches them in the bell and as a
 * push on every OpenVibe site.
 *
 * The link is only there when the end is known and still ahead: a code that ended, or one nobody dated, gets none.
 * The instant is the end itself, in UTC (a stated day means the end of that day in UTC, as the page says).
 */
const kit = require('openvibe-shared/kit');

const HOST = 'openvibe.coupons';
const REMIND = 'https://openvibe.today/remind';

/** The moment a code ends, in UTC, or null when nobody stated an end. */
function endsAt(v) {
    const e = v && v.expiry;
    if (!e || !e.known || !e.expires_at) return null;
    const ms = Date.parse(e.expires_at);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The reminder's title: the code's own name, the shop it is at, and that it ends. */
function remindTitle(v, shop = '') {
    const name = String(v && v.title ? v.title : '').trim();
    const where = String(shop || '').trim();
    return where ? `${name} at ${where} ends` : `${name} ends`;
}

/** Today's "Remind me" link for this code, or '' when there is nothing to remind about. */
function remindHref(v, { now = Date.now(), shop = '', url = '' } = {}) {
    const at = endsAt(v);
    if (!at || Date.parse(at) <= now) return '';
    const query = new URLSearchParams({ title: remindTitle(v, shop), at, url: url || (v && v.url) || '', from: HOST });
    return `${REMIND}?${query}`;
}

/** The link, as a quiet small button. */
function remindLink(v, opts = {}) {
    const href = remindHref(v, opts);
    if (!href) return '';
    return kit.button({ href, label: 'Remind me', icon: 'bell', kind: 'quiet', small: true });
}

/** The same link as a bell only, for a row that has no room for words. */
function remindIcon(v, opts = {}) {
    const href = remindHref(v, opts);
    if (!href) return '';
    return kit.iconButton({ href, icon: 'bell', label: 'Remind me' });
}

module.exports = { endsAt, remindTitle, remindHref, remindLink, remindIcon, HOST, REMIND };
