'use strict';

/**
 * Coupons → OpenVibe.Events through the shared openvibe-sdk transactional outbox (ADR-004,
 * openvibe-sdk/events createServiceOutbox; plan T1). The table is event_outbox, the relay is off
 * without EVENTS_URL or OV_OAUTH_CLIENT_SECRET, and status() reports pending/rejected rows for
 * /api/ready. moderationAction never names an owner_subject (moderationOwnerSubject: false), as
 * Coupons' audit event never did.
 */
const { createServiceOutbox } = require('openvibe-sdk/events');

function createCouponsOutbox({ db, config, fetchImpl, now, log = console }) {
    return createServiceOutbox({
        db,
        source: 'coupons',
        eventsUrl: config.events.url,
        networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        intervalMs: config.events.intervalMs,
        now,
        fetch: fetchImpl,
        log,
        moderationOwnerSubject: false,
    });
}

module.exports = { createCouponsOutbox };
