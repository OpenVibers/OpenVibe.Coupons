'use strict';

/**
 * Per-source policy for imported codes, keyed by the OpenVibe.Sources `source_key` (as OpenVibe.Deals keeps its own):
 * how a source must be attributed and whether its content may reach a browser extension. A source with no entry may
 * not reach an extension: the answer is "no" unless the source's recorded terms say yes. Sources' `terms_note` is
 * prose and is never parsed; the decision and the line it rests on are written here.
 *
 * Allowed to reach an extension (the Companion):
 *   - `staff-coupon-codes` — "Only codes a merchant published itself, entered with the URL of that page as evidence."
 *     A merchant's own promo page is the merchant's to publish, so its code may be shown anywhere it is shown.
 *   - a submission by a person or staff (`kind` member / staff) — member-submitted codes, the same basis.
 *   - a source row whose evidence is on the merchant's own domain (`merchant_evidence`).
 *
 * Not allowed:
 *   - `dealnews-coupon-codes`, `dealnews-daily` — DealNews' feed terms (https://www.dealnews.com/pages/rss.html): the
 *     feeds may be used with attribution to DealNews as text, but "you [may] not use or include the content in any
 *     browser extension made available for public use". Their codes say "via DealNews" wherever they are shown (the
 *     site keeps them) and are left out of every answer to the OpenVibe Companion.
 *   - any source not named above — no recorded permission, so no.
 */
const DEALNEWS = Object.freeze({ text: 'DealNews', url: 'https://www.dealnews.com/' });
const POLICIES = Object.freeze({
    'dealnews-coupon-codes': Object.freeze({
        attribution: DEALNEWS, extension: false,
        terms: 'DealNews feed terms: never in a browser extension made available for public use',
    }),
    'dealnews-daily': Object.freeze({
        attribution: DEALNEWS, extension: false,
        terms: 'DealNews feed terms: never in a browser extension made available for public use',
    }),
    'staff-coupon-codes': Object.freeze({
        extension: true,
        terms: 'only codes a merchant published itself, with that page as evidence',
    }),
});

const policyFor = (key) => (key && Object.prototype.hasOwnProperty.call(POLICIES, key) ? POLICIES[key] : null);

/** The attribution for a code's live sources ([{ source_key }]): the first whose policy names one, else null. */
function attributionOf(sources) {
    for (const s of sources || []) {
        const p = policyFor(s && s.source_key);
        if (p && p.attribution) return { text: p.attribution.text, url: p.attribution.url };
    }
    return null;
}

/**
 * True when this source row's terms allow the code to reach a browser extension. A source with no policy is not
 * allowed (the default is no).
 */
function mayReachExtension(s) {
    if (!s) return false;
    if (s.kind === 'member' || s.kind === 'staff') return true;
    if (Number(s.merchant_evidence) === 1) return true;
    const p = policyFor(s.source_key);
    return Boolean(p && p.extension === true);
}

/** True when any of the code's live sources forbids its content in a browser extension. */
function hidesFromExtension(sources) {
    const live = (sources || []).filter(Boolean);
    return !live.length || !live.every(mayReachExtension);
}

/** An extension page's origin (Chrome, Edge, Brave, Firefox, Safari). */
const EXTENSION_ORIGIN = /^[a-z][a-z-]*-extension:\/\//i;

/** True when the request comes from a browser extension: its Origin, or a connected install's token. */
function fromExtension(req) {
    return EXTENSION_ORIGIN.test(String(req.get('origin') || '')) || Boolean(req.viewer && req.viewer.kind === 'install');
}

module.exports = { POLICIES, policyFor, attributionOf, mayReachExtension, hidesFromExtension, fromExtension };
