'use strict';

/**
 * Members watching a merchant (coupon_watches). A watch is private to its member: it is never
 * shown to anyone else and never leaves Coupons.
 *
 * Delivery is not built yet: Coupons records watches and lists them on /watching, but sends no
 * notification. It will go through the Network's notification store (roadmap W3) when Coupons is
 * granted a notification capability; until then the page says so.
 */
const { ids } = require('openvibe-contracts');
const { ApiError } = require('../http/errors');

const MAX_WATCHES = 200;

function createWatches({ store }) {
    const { db } = store;
    const q = {
        add: db.prepare('INSERT INTO coupon_watches (subject, merchant_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'),
        remove: db.prepare('DELETE FROM coupon_watches WHERE subject = ? AND merchant_id = ?'),
        has: db.prepare('SELECT 1 FROM coupon_watches WHERE subject = ? AND merchant_id = ?'),
        count: db.prepare('SELECT COUNT(*) AS n FROM coupon_watches WHERE subject = ?'),
        mine: db.prepare(`SELECT m.* FROM coupon_watches w JOIN coupon_merchants m ON m.id = w.merchant_id
                          WHERE w.subject = ? AND m.status = 'active' ORDER BY lower(m.name)`),
    };
    const person = (subject) => {
        if (!ids.isSubjectId('user', subject)) throw new ApiError(403, 'auth.person_required', 'sign in to watch a merchant');
        return subject;
    };
    return {
        async watch(subject, merchant) {
            person(subject);
            if (!await q.has.get(subject, merchant.id) && (await q.count.get(subject)).n >= MAX_WATCHES) throw new ApiError(409, 'watch.limit', `at most ${MAX_WATCHES} watches`);
            await q.add.run(subject, merchant.id, store.now());
        },
        async unwatch(subject, merchant) { await q.remove.run(person(subject), merchant.id); },
        isWatching: async (subject, merchant) => Boolean(subject && await q.has.get(subject, merchant.id)),
        list: async (subject) => await q.mine.all(person(subject)),
    };
}

module.exports = { createWatches };
