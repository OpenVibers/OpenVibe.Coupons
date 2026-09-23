'use strict';

/**
 * Staff actions that span merchants and codes. Every one is recorded: merchant status on the row,
 * code changes in coupon_status_history, and both reach Search (documents or tombstones).
 *
 *   approve a pending merchant   → active; the codes members submitted for it are published
 *                                  (AI-extracted and imported codes still wait for their own review)
 *   disable a merchant           → its page is gone (410), lookups stop, every code leaves active
 *                                  results and Search (tombstones); nothing is deleted
 */
const { ApiError } = require('../http/errors');

function createModeration({ store, merchants, coupons }) {
    return {
        setMerchantStatus(m, status, { actor = 'system' } = {}) {
            if (!['active', 'disabled'].includes(status)) throw new ApiError(422, 'merchant.bad_status', 'status must be active or disabled');
            return store.tx(() => {
                const after = merchants.setStatus(m, status);
                if (status === 'active') coupons.publishWaitingOn(after, { actor });
                coupons.syncMerchant(after);
                return after;
            });
        },
    };
}

module.exports = { createModeration };
