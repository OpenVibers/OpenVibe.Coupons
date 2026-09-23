'use strict';

/**
 * Coupons → OpenVibe.Events through the openvibe-sdk transactional outbox (ADR-004).
 *
 *   coupons.coupon.created|updated|expired|disabled   a code's lifecycle (charter coupons.created|…)
 *   coupons.report.created                             a new validity report (never who reported)
 *   coupons.confidence.changed                         a code's confidence moved (reports or decay)
 *   coupons.index_document.upserted|deleted            OpenVibe.Search documents and tombstones for
 *                                                      coupons and merchants (openvibe-publishing
 *                                                      index-hooks), consumed by Search's
 *                                                      '*.index_document.*' subscription
 *
 * Every envelope's actor is the service itself ({ type: 'service', id: 'coupons' }) and no payload
 * names a person: submitters and reporters stay inside Coupons.
 *
 * emit() runs inside the SQLite transaction that makes the change, so an event exists if and only
 * if its change committed. The relay publishes with Coupons' service token (events.event.publish,
 * audience openvibe.events) only when EVENTS_URL and OV_OAUTH_CLIENT_SECRET are set; otherwise
 * rows wait in event_outbox and /api/ready reports the relay as off.
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createOutbox } = require('openvibe-sdk/events');

function createCouponsOutbox({ db, config, fetchImpl, now, log = console }) {
    const enabled = Boolean(config.events.url && config.oauth.clientSecret);
    const clientOpts = { baseUrls: { events: config.events.url || 'http://127.0.0.1:4300' }, retries: 0 };
    if (fetchImpl) clientOpts.fetch = fetchImpl;
    if (enabled) {
        clientOpts.tokenProvider = createServiceTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
            scope: { 'openvibe.events': 'events.event.publish' }, ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
    } else {
        clientOpts.getToken = async () => { throw new Error('events relay disabled (EVENTS_URL / OV_OAUTH_CLIENT_SECRET unset)'); };
    }
    const events = createEventsClient(createClient(clientOpts), { source: 'coupons' });
    let lastError = null;
    const outbox = createOutbox(db, {
        events,
        intervalMs: config.events.intervalMs,
        now,
        onError: (err) => {
            const msg = err && err.message;
            if (msg !== lastError) log.warn('[Coupons] event publish failed (will retry):', msg);
            lastError = msg;
        },
    });
    outbox.ensureSchema();

    /** Inside the caller's transaction. Returns the complete envelope (with its event_id). */
    function emit(envelope, { traceparent } = {}) {
        return outbox.enqueue(envelope, { traceparent });
    }

    return {
        emit,
        outbox,
        enabled,
        start() { if (enabled) outbox.start(); },
        stop: () => outbox.stop(),
        kick() { if (enabled) outbox.kick(); },
        status: () => ({ enabled, pending: outbox.pending(), rejected: outbox.rejected(), last_error: lastError }),
    };
}

module.exports = { createCouponsOutbox };
