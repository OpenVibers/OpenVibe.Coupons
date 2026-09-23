'use strict';

/**
 * What the outside world sees of a merchant or a code: canonical URLs, the indexability gate's
 * decision (openvibe-publishing/seo), the OpenVibe.Search document and the product events.
 *
 *   /m/:slug    merchant page   indexable when the merchant is active and has at least one active
 *                               code; otherwise noindex ("thin": no active codes) — still served
 *   /c/:id      code page       indexable while the code is active; an expired code is noindex
 *                               (gate reason `expired`), a disabled one is hidden (`takedown`, 410),
 *                               a code waiting for review or on a pending merchant is hidden (`draft`)
 *
 * Search documents are coupons (type `coupon`) and merchants (type `merchant`). A code that leaves
 * active results becomes a tombstone; a resource that was never indexed gets no tombstone.
 */
const seo = require('openvibe-publishing/seo');
const hooks = require('openvibe-publishing/index-hooks');
const { isActive } = require('./confidence');

const ACTOR = Object.freeze({ type: 'service', id: 'coupons' });
const COUPON_POLICY = { minWords: 0 };
const MERCHANT_POLICY = { minWords: 1 };

function createPublication({ store, config, outbox }) {
    const abs = (p) => seo.canonicalUrl(config.baseUrl, p);
    const merchantPath = (m) => `/m/${m.slug}`;
    const couponPath = (c) => `/c/${c.id}`;

    /** The gate's decision for a code page. */
    function couponDecision(c, m, now = store.now()) {
        const visible = m && m.status === 'active' && c.review_state === 'published';
        const expiredAt = c.expires_at != null ? c.expires_at : (c.status === 'expired' ? (c.expired_at || now) : null);
        return seo.evaluate({
            state: visible ? 'published' : 'draft',
            visibility: 'public',
            takedown: c.status === 'disabled' || (m && m.status === 'disabled'),
            canonicalUrl: abs(couponPath(c)),
            wordCount: 0,
            ...(expiredAt != null ? { expiresAt: expiredAt } : {}),
        }, { policy: COUPON_POLICY, now });
    }

    /** The gate's decision for a merchant page; `activeCount` = its active codes right now. */
    function merchantDecision(m, activeCount, now = store.now()) {
        return seo.evaluate({
            state: m.status === 'active' ? 'published' : 'draft',
            visibility: 'public',
            takedown: m.status === 'disabled',
            canonicalUrl: abs(merchantPath(m)),
            // A merchant page's substance is its active codes: none → thin (noindex, still served).
            wordCount: activeCount,
        }, { policy: MERCHANT_POLICY, now });
    }

    function couponDocument(c, m, { restrictionsText = '', sourceRefs = [] } = {}) {
        const now = store.now();
        const decision = couponDecision(c, m, now);
        const active = m && m.status === 'active' && isActive(c, now);
        const statusLabel = { unknown: 'validity unknown', reported_working: 'reported working', reported_failed: 'reported not working' }[c.status] || c.status;
        return hooks.buildIndexDocument({
            owner: 'coupons', type: 'coupon', id: c.id, revision: 0,
            state: active ? 'published' : 'unpublished', visibility: 'public',
            canonicalUrl: abs(couponPath(c)),
            title: `${c.code} — ${c.title}${m ? ` (${m.name})` : ''}`,
            summary: `${statusLabel}; expiry ${c.expires_at != null ? new Date(c.expires_at).toISOString().slice(0, 10) : 'unknown'}`,
            body: [c.description || '', restrictionsText].filter(Boolean).join('\n'),
            facets: { merchant: m ? m.slug : 'unknown', status: c.status, expiry_known: c.expires_at != null },
            provenance: sourceRefs,
            decision,
            publishedAt: c.created_at,
            updatedAt: c.updated_at,
            language: 'en',
        });
    }

    function merchantDocument(m, activeCount) {
        const decision = merchantDecision(m, activeCount);
        return hooks.buildIndexDocument({
            owner: 'coupons', type: 'merchant', id: m.id, revision: 0,
            state: m.status === 'active' ? 'published' : 'unpublished', visibility: 'public',
            canonicalUrl: abs(merchantPath(m)),
            title: `${m.name} coupon codes`,
            summary: `${activeCount} active code${activeCount === 1 ? '' : 's'}`,
            body: m.description || '',
            facets: { active_codes: activeCount },
            decision,
            publishedAt: m.created_at,
            updatedAt: m.updated_at,
            language: 'en',
        });
    }

    /** Stamp and enqueue a Search document (inside the caller's transaction). */
    function sendDocument(doc, { traceparent } = {}) {
        if (doc.deleted && store.sequencer.current(doc.owner, doc.type, doc.id) == null) return null; // never indexed
        const current = store.sequencer.current(doc.owner, doc.type, doc.id);
        const stamped = store.sequencer.stamp(doc);
        if (current === stamped.revision) return null; // the same document again: nothing to send
        return outbox.emit(hooks.indexEvent({ document: stamped, now: store.now() }), { traceparent });
    }

    /**
     * A product event (inside the caller's transaction). Public only while the code is publicly
     * listed; the actor is always the service and the payload never names a person.
     */
    function emit(eventType, subject, payload, { isPublic = false, traceparent } = {}) {
        return outbox.emit({
            event_type: eventType,
            actor: ACTOR,
            visibility: isPublic ? 'public' : 'internal',
            subject,
            payload,
        }, { traceparent });
    }

    return {
        abs, merchantPath, couponPath,
        merchantUrl: (m) => abs(merchantPath(m)),
        couponUrl: (c) => abs(couponPath(c)),
        couponDecision, merchantDecision, couponDocument, merchantDocument, sendDocument, emit,
    };
}

module.exports = { createPublication, ACTOR };
