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
 *   coupons.moderation.action                          staff (or a service holding the staff
 *                                                      capability) disabled, expired, re-enabled or
 *                                                      approved someone else's code, or approved,
 *                                                      disabled or re-enabled a shop
 *                                                      (common.moderation-action@1, ADR-022), for
 *                                                      Network's moderation audit log
 *
 * Every envelope's actor is the service itself ({ type: 'service', id: 'coupons' }) and no payload
 * names a person: submitters and reporters stay inside Coupons. The one exception is the staff
 * member who took a moderation action, named in coupons.moderation.action (the audit log exists
 * to say who acted); its target never names the submitter.
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

    /**
     * coupons.moderation.action, inside the caller's transaction. actorSubject: the staff member (null
     * for a service); target: { type, id }, owner_subject always null. Never the code or its text.
     */
    function moderationAction({ action, target, actorSubject, reason = null, details = {} }, { traceparent } = {}) {
        const t = { type: target.type, id: String(target.id).slice(0, 200), owner_subject: null };
        return emit({
            event_type: 'coupons.moderation.action',
            actor: actorSubject ? { type: 'user', id: actorSubject } : { type: 'service', id: 'coupons' },
            subject: { type: 'moderation_action', id: `${t.type}:${t.id}`.slice(0, 200) },
            visibility: 'internal',
            payload: { action, target: t, actor_subject: actorSubject || null, reason: reason ? String(reason).slice(0, 500) : null, details: details || {} },
        }, { traceparent });
    }

    return {
        emit,
        moderationAction,
        outbox,
        enabled,
        start() { if (enabled) outbox.start(); },
        stop: () => outbox.stop(),
        kick() { if (enabled) outbox.kick(); },
        status: () => ({ enabled, pending: outbox.pending(), rejected: outbox.rejected(), last_error: lastError }),
    };
}

module.exports = { createCouponsOutbox };
