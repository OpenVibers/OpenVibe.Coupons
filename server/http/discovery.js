'use strict';

/**
 * Crawl and machine-readability artifacts (roadmap §32.4/§32.5):
 *
 *   GET /robots.txt                sitemap location + explicit automated-consumer policy
 *   GET /llms.txt                  orientation for language models
 *   GET /sitemap.xml               sitemap index over the two sections below
 *   GET /sitemaps/merchants.xml    active shops with at least one active code (the gate decides)
 *   GET /sitemaps/coupons.xml      active codes only; lastmod = the code's real last change
 *   GET /feed.xml, /atom.xml, /feed.json    newly added active codes
 *   GET /m/:slug/feed.xml                  one shop's active codes
 *
 * Built from the database on every request, never for a viewer. Expired, taken-down, pending and
 * not-yet-reviewed codes, and pending or disabled shops, never appear: the lists start from the
 * active-results query, and every entry also passes through the gate.
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const sharedSeo = require('openvibe-shared/seo');
const pages = require('../render/pages');

function createDiscoveryRoutes({ config, store, merchants, coupons, publication }) {
    const router = express.Router();
    const abs = (p) => seo.canonicalUrl(config.baseUrl, p);
    const xml = (res, body, type = 'application/xml') => res.type(type).set('Cache-Control', 'public, max-age=300').send(body);

    function activeEntries() {
        const byMerchant = new Map();
        const out = [];
        for (const c of coupons.allActive()) {
            let m = byMerchant.get(c.merchant_id);
            if (!m) { m = merchants.byId(c.merchant_id); byMerchant.set(c.merchant_id, m); }
            out.push({ c, m, decision: publication.couponDecision(c, m) });
        }
        return out;
    }

    router.get('/robots.txt', (_req, res) => {
        const body = [
            '# openvibe.coupons automated-consumer policy: search engines and AI crawlers are welcome to read',
            '# shop and code pages, their .json twins, feeds and sitemaps. Forms, sign-in, staff pages and the',
            '# API are not for crawling. Pages decide their own indexability (meta robots / X-Robots-Tag):',
            '# an expired code stays readable but is noindex; a Disallow is not a noindex.',
            sharedSeo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: ['/auth/', '/api/', '/submit', '/connect-extension', '/staff', '/watching'] }),
        ].join('\n');
        res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(body);
    });

    router.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(sharedSeo.llmsTxt({
            name: 'OpenVibe.Coupons',
            summary: 'Coupon codes for online shops with merchant/domain matching, restrictions, honest expiry and validity reports by people.',
            details: 'A code\'s status is exactly one of unknown, reported_working, reported_failed, expired or disabled. Only recent reports by people can make a code reported_working or reported_failed; a submission, a source or a model cannot. An expiry that nobody stated is "unknown" (null in JSON), and restrictions that were not stated are absent, not "none". Every shop page has a JSON twin at /m/<slug>.json and every code at /c/<id>.json with the same content. Expired and taken-down codes are not in lists, feeds or sitemaps.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'All shops', url: abs('/'), note: 'with recently added codes' },
                    { title: 'How codes are labelled', url: abs('/about'), note: 'statuses, the confidence formula, expiry, privacy' },
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                ] },
                { title: 'Feeds', links: [{ title: 'RSS', url: abs('/feed.xml') }, { title: 'Atom', url: abs('/atom.xml') }, { title: 'JSON Feed', url: abs('/feed.json') }] },
                { title: 'Data', links: [
                    { title: 'Shop JSON', url: abs('/'), note: 'append .json to a shop URL (/m/<slug>.json)' },
                    { title: 'Merchant lookup API', url: abs('/api/v1/merchants/resolve?host=example.com'), note: 'GET /api/v1/merchants/resolve?host= and GET /api/v1/merchants/<id>/coupons; anonymous, rate-limited' },
                ] },
            ],
        }));
    });

    router.get('/sitemap.xml', (_req, res) => {
        const entries = activeEntries().filter((e) => e.decision.indexable);
        const newest = entries.length ? Math.max(...entries.map((e) => e.c.updated_at)) : null;
        xml(res, seo.sitemapIndex([
            { loc: abs('/sitemaps/merchants.xml'), ...(newest ? { lastmod: new Date(newest).toISOString() } : {}) },
            { loc: abs('/sitemaps/coupons.xml'), ...(newest ? { lastmod: new Date(newest).toISOString() } : {}) },
        ]));
    });

    router.get('/sitemaps/coupons.xml', (_req, res) => {
        xml(res, seo.sitemap(activeEntries().map((e) => ({ loc: publication.couponUrl(e.c), lastmod: e.c.updated_at, decision: e.decision }))).files[0]);
    });

    router.get('/sitemaps/merchants.xml', (_req, res) => {
        const byMerchant = new Map();
        for (const e of activeEntries()) {
            const cur = byMerchant.get(e.m.id);
            if (!cur) byMerchant.set(e.m.id, { m: e.m, count: 1, lastmod: e.c.updated_at });
            else { cur.count++; cur.lastmod = Math.max(cur.lastmod, e.c.updated_at); }
        }
        const list = [...byMerchant.values()].map(({ m, count, lastmod }) => ({ loc: publication.merchantUrl(m), lastmod: Math.max(lastmod, m.updated_at), decision: publication.merchantDecision(m, count) }));
        xml(res, seo.sitemap(list).files[0]);
    });

    // ── Feeds ───────────────────────────────────────────────
    function feedItems(list) {
        return list.map(({ c, m, decision }) => ({
            id: `urn:openvibe:coupons:${c.id}`,
            url: publication.couponUrl(c),
            title: `${c.code} — ${c.title} (${m.name})`,
            summary: `${pages.STATUS_LABEL[c.status]}. ${c.expires_at != null ? `Expires ${new Date(c.expires_at).toISOString().slice(0, 10)}.` : 'Expiry unknown.'}`,
            published: c.created_at,
            updated: c.updated_at,
            tags: [m.name],
            decision,
        }));
    }
    const recent = () => activeEntries().slice(0, 50);
    const channel = { title: 'OpenVibe.Coupons — new codes', link: abs('/'), description: 'Codes added to OpenVibe.Coupons, with their status and expiry.' };

    router.get('/feed.xml', (_req, res) => xml(res, seo.rssFeed({ ...channel, feedUrl: abs('/feed.xml'), language: 'en' }, feedItems(recent())), 'application/rss+xml'));
    router.get('/atom.xml', (_req, res) => {
        const items = feedItems(recent());
        // Atom needs an <updated>; an empty feed has been empty since this process started, so that
        // instant is its last change (never the request time).
        xml(res, seo.atomFeed({ ...channel, feedUrl: abs('/atom.xml'), ...(items.length ? {} : { updated: bootTime }) }, items), 'application/atom+xml');
    });
    router.get('/feed.json', (_req, res) => {
        res.type('application/feed+json').set('Cache-Control', 'public, max-age=300').send(JSON.stringify(seo.jsonFeed({ ...channel, feedUrl: abs('/feed.json') }, feedItems(recent()))));
    });
    router.get('/m/:slug/feed.xml', (req, res, next) => {
        const m = merchants.get(req.params.slug);
        if (!m || m.status !== 'active' || m.slug !== req.params.slug) return next();
        const list = coupons.active(m.id).map((c) => ({ c, m, decision: publication.couponDecision(c, m) }));
        xml(res, seo.rssFeed({ title: `${m.name} codes — OpenVibe.Coupons`, link: publication.merchantUrl(m), description: `Active codes for ${m.name}.`, feedUrl: abs(`/m/${m.slug}/feed.xml`), language: 'en' }, feedItems(list)), 'application/rss+xml');
    });

    const bootTime = store.now();
    return router;
}

module.exports = { createDiscoveryRoutes };
