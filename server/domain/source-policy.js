'use strict';

/**
 * Per-source policy for imported codes, keyed by the OpenVibe.Sources `source_key` (as OpenVibe.Deals keeps its own):
 * how a source must be attributed and whether its content may reach a browser extension. A source with no entry has
 * no attribution and no extension rule. Sources' `terms_note` is prose and is never parsed.
 *
 * DealNews' feed terms (https://www.dealnews.com/pages/rss.html): the feeds may be used with attribution to DealNews
 * as text, and "you [may] not use or include the content in any browser extension made available for public use".
 * `dealnews-coupon-codes` reads that feed, so its codes say "via DealNews" wherever they are shown and are left out of
 * every answer to the OpenVibe Companion (an extension origin, or a connected install's cpx_ token).
 */
const DEALNEWS = Object.freeze({ text: 'DealNews', url: 'https://www.dealnews.com/' });
const POLICIES = Object.freeze({
    'dealnews-coupon-codes': Object.freeze({ attribution: DEALNEWS, noExtension: true }),
    'dealnews-daily': Object.freeze({ attribution: DEALNEWS, noExtension: true }),
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

/** True when any of the code's live sources forbids its content in a browser extension. */
function hidesFromExtension(sources) {
    return (sources || []).some((s) => { const p = policyFor(s && s.source_key); return Boolean(p && p.noExtension); });
}

/** An extension page's origin (Chrome, Edge, Brave, Firefox, Safari). */
const EXTENSION_ORIGIN = /^[a-z][a-z-]*-extension:\/\//i;

/** True when the request comes from a browser extension: its Origin, or a connected install's token. */
function fromExtension(req) {
    return EXTENSION_ORIGIN.test(String(req.get('origin') || '')) || Boolean(req.viewer && req.viewer.kind === 'install');
}

module.exports = { POLICIES, policyFor, attributionOf, hidesFromExtension, fromExtension };
