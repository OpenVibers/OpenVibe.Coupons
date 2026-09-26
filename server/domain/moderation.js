'use strict';

/**
 * Staff actions that span merchants and codes. Every one is recorded: merchant status on the row,
 * code changes in coupon_status_history, and both reach Search (documents or tombstones).
 *
 *   approve a pending merchant   → active; the codes members submitted for it are published
 *                                  (AI-extracted and imported codes still wait for their own review)
 *   disable a merchant           → its page is gone (410), lookups stop, every code leaves active
 *                                  results and Search (tombstones); nothing is deleted
 *
 * Each also reaches Network's moderation audit log as coupons.moderation.action (ADR-022).
 */
const { ApiError } = require('../http/errors');

function createModeration({ store, merchants, coupons, outbox = null }) {
    return {
        setMerchantStatus(m, status, { actor = 'system', traceparent } = {}) {
            if (!['active', 'disabled'].includes(status)) throw new ApiError(422, 'merchant.bad_status', 'status must be active or disabled');
            return store.tx(() => {
                const after = merchants.setStatus(m, status);
                const published = status === 'active' ? coupons.publishWaitingOn(after, { actor }) : [];
                coupons.syncMerchant(after);
                // The moderation audit log (ADR-022): who approved, disabled or re-enabled the shop, never who proposed it.
                if (outbox && m.status !== status && actor !== 'system') {
                    const action = status === 'disabled' ? 'merchant.disabled' : (m.status === 'pending' ? 'merchant.approved' : 'merchant.enabled');
                    outbox.moderationAction({
                        action, target: { type: 'merchant', id: m.id }, actorSubject: /^usr_/.test(String(actor)) ? actor : null,
                        details: { previous: m.status, status, ...(published.length ? { codes_published: published.length } : {}) },
                    }, { traceparent });
                }
                return after;
            });
        },
    };
}

module.exports = { createModeration };
