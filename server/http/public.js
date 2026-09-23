'use strict';

/**
 * Public, server-rendered routes — useful without JavaScript:
 *
 *   GET  /                          shops, recently added codes, search (?q=)
 *   GET  /about                     statuses, the confidence formula, expiry, privacy, the helper
 *   GET  /m/:slug                   a shop: active codes with status, confidence, last report time,
 *                                   restrictions, expiry or "unknown"; recently ended codes apart
 *   GET  /m/:slug.json              the same as data
 *   GET  /c/:id, /c/:id.json        one code (an expired code: noindex; taken down: 410)
 *   POST /c/:id/report              worked / didn't work (signed in, form token)
 *   POST /m/:slug/watch             watch / stop watching (signed in, form token)
 *   GET  /submit, POST /submit      submit a code (signed in, form token)
 *   GET  /connect-extension         create / revoke browser-helper tokens (signed in, form token)
 *   GET  /watching                  your watched shops (private)
 *   GET  /staff …                   review and moderation (Network admins, COUPONS_STAFF_SUBJECTS)
 *
 * Caching: only pages rendered for an ANONYMOUS visitor with status 200 are `public, max-age=60`;
 * everything else is `private, no-store`. All pages vary on Cookie and Authorization.
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const { renderPage } = require('../render/layout');
const pages = require('../render/pages');
const { csrfToken, checkCsrf } = require('../auth/forms');
const { ApiError } = require('./errors');
const confidence = require('../domain/confidence');
const { SCOPES } = require('../auth/capabilities');

const COUPON_ID_RE = /^cpn_[0-9A-HJKMNP-TV-Z]{26}$/;

function createPublicRoutes(ctx) {
    const { config, store, merchants, coupons, reports, watches, installs, publication, viewers, moderation } = ctx;
    const router = express.Router();
    const form = express.urlencoded({ extended: false, limit: '32kb' });
    router.use(viewers.pages());

    // ── Helpers ─────────────────────────────────────────────
    function cacheHeaders(res, { cacheable, robots }) {
        res.vary('Cookie');
        res.vary('Authorization');
        res.set('Cache-Control', cacheable ? 'public, max-age=60, stale-while-revalidate=60' : 'private, no-store');
        if (robots && robots !== 'index, follow') res.set('X-Robots-Tag', robots);
    }

    function send(req, res, status, page, { cacheable = false } = {}) {
        cacheHeaders(res, { cacheable: cacheable && req.viewer.kind === 'anonymous' && status === 200, robots: page.decision.robots });
        res.status(status).type('html').send(renderPage({ ...page, viewer: req.viewer, config, path: req.originalUrl }));
    }

    /** A decision for pages that are not a shop or a code. */
    function pageDecision(path, { indexable = true, query = [] } = {}) {
        return seo.evaluate({
            state: indexable ? 'published' : 'draft', visibility: indexable ? 'public' : 'private',
            canonicalUrl: seo.canonicalUrl(config.baseUrl, path, { query }), wordCount: 0,
        }, { policy: { minWords: 0 }, now: store.now() });
    }

    function messagePage(req, res, status, heading, text, action) {
        send(req, res, status, { title: heading, decision: pageDecision(req.path, { indexable: false }), body: pages.message({ heading, text, action }) });
    }
    const notFound = (req, res) => messagePage(req, res, 404, 'Not found', 'There is nothing at this address.', { href: '/', label: 'All shops' });

    const csrf = (req) => csrfToken(config, req.viewer);
    function requireUser(req, res) {
        if (req.viewer.kind === 'user' && req.viewer.subject) return true;
        res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        return false;
    }
    function requireForm(req, res) {
        if (!requireUser(req, res)) return false;
        if (!checkCsrf(config, req.viewer, req.body && req.body.csrf)) {
            messagePage(req, res, 403, 'Form expired', 'This form expired or did not come from this site. Go back, reload the page and try again.');
            return false;
        }
        return true;
    }
    const safeBack = (b, fallback) => (typeof b === 'string' && /^\/(?![/\\])[^\s]*$/.test(b) ? b : fallback);
    const withFlash = (path, key) => `${path}${path.includes('?') ? '&' : '?'}done=${key}`;
    const FLASH = {
        reported: 'Thanks — your report was recorded.',
        report_same: 'You already reported that today; nothing changed.',
        report_corrected: 'Your report for today was updated.',
        watching: 'You are watching this shop.',
        unwatched: 'You stopped watching this shop.',
    };

    function jsonLd(m, v) {
        return [
            seo.structuredData.breadcrumbs([{ name: 'Coupons', url: `${config.baseUrl}/` }, { name: m.name, url: publication.merchantUrl(m) }, ...(v ? [{ name: v.code, url: v.url }] : [])]),
            seo.structuredData.webPage({ url: v ? v.url : publication.merchantUrl(m), name: v ? `${v.code} — ${v.title}` : `${m.name} coupon codes`, dateModified: v ? v.updated_at : null, inLanguage: 'en' }),
        ];
    }

    // ── Home, about ─────────────────────────────────────────
    router.get('/', (req, res) => {
        const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 60) : '';
        const recent = coupons.recentActive(12).map((c) => ({ coupon: c, merchant: merchants.byId(c.merchant_id) }));
        const list = merchants.listActive({ limit: 500 }).map((m) => ({ merchant: m, active: coupons.activeCount(m.id) }));
        const decision = q ? pageDecision('/', { indexable: false }) : pageDecision('/');
        send(req, res, 200, {
            title: q ? `Search: ${q}` : null, decision, canonical: `${config.baseUrl}/`,
            feeds: [{ type: 'rss', href: '/feed.xml', title: 'New codes (RSS)' }, { type: 'atom', href: '/atom.xml', title: 'New codes (Atom)' }, { type: 'json', href: '/feed.json', title: 'New codes (JSON Feed)' }],
            jsonLd: [seo.structuredData.webPage({ url: `${config.baseUrl}/`, name: 'OpenVibe.Coupons', inLanguage: 'en' })],
            body: pages.home({ merchants: list, recent, q, results: q ? merchants.search(q) : [], total: list.length }),
        }, { cacheable: true });
    });

    router.get('/about', (req, res) => {
        send(req, res, 200, { title: 'How codes are labelled', decision: pageDecision('/about'), body: pages.about({ confidence }) }, { cacheable: true });
    });

    // ── Shops ───────────────────────────────────────────────
    function merchantData(m) {
        const active = coupons.active(m.id).map((c) => coupons.view(c, { merchant: m }));
        return {
            merchant: { id: m.id, slug: m.slug, name: m.name, homepage_url: m.homepage_url, url: publication.merchantUrl(m),
                domains: merchants.domains(m).map((d) => ({ host: d.host, include_subdomains: Boolean(d.include_subdomains), path_prefix: d.path_prefix || null })),
                hints: coupons.merchantHints(m.id).map((x) => x.text) },
            coupons: active,
        };
    }

    function visibleMerchant(req, res) {
        const m = merchants.get(req.params.slug);
        if (!m || m.slug !== req.params.slug || m.status === 'pending') { notFound(req, res); return null; }
        if (m.status === 'disabled') { messagePage(req, res, 410, 'Gone', 'This shop is no longer listed.', { href: '/', label: 'All shops' }); return null; }
        return m;
    }

    router.get('/m/:slug.json', (req, res) => {
        const m = visibleMerchant(req, res);
        if (!m) return;
        const data = merchantData(m);
        const decision = publication.merchantDecision(m, data.coupons.length);
        res.vary('Cookie'); res.vary('Authorization');
        res.set('Cache-Control', 'public, max-age=60');
        if (!decision.indexable) res.set('X-Robots-Tag', decision.robots);
        res.json({ ...data, indexability: { indexable: decision.indexable, reasons: decision.codes } });
    });

    router.get('/m/:slug', (req, res) => {
        const m = visibleMerchant(req, res);
        if (!m) return;
        const active = coupons.active(m.id).map((c) => coupons.view(c, { merchant: m }));
        const ended = coupons.recentlyEnded(m.id).map((c) => coupons.view(c, { merchant: m }));
        const decision = publication.merchantDecision(m, active.length);
        const flashMsg = FLASH[req.query.done] || null;
        send(req, res, 200, {
            title: `${m.name} coupon codes`,
            description: active.length ? `${active.length} active code${active.length === 1 ? '' : 's'} for ${m.name}, with restrictions, expiry and people's reports.` : `No active codes for ${m.name} right now.`,
            decision, canonical: publication.merchantUrl(m), jsonLd: jsonLd(m, null),
            feeds: [{ type: 'rss', href: `/m/${m.slug}/feed.xml`, title: `${m.name} codes (RSS)` }],
            body: pages.merchant({
                m, domains: merchants.domains(m), hints: coupons.merchantHints(m.id), active, ended,
                viewer: req.viewer, csrf: csrf(req), back: `/m/${m.slug}`, flashMsg,
                watching: watches.isWatching(req.viewer.subject, m),
            }),
        }, { cacheable: !flashMsg });
    });

    router.post('/m/:slug/watch', form, (req, res) => {
        if (!requireForm(req, res)) return;
        const m = merchants.get(req.params.slug);
        if (!m || m.status !== 'active') return notFound(req, res);
        if (req.body.action === 'unwatch') watches.unwatch(req.viewer.subject, m); else watches.watch(req.viewer.subject, m);
        res.redirect(303, withFlash(`/m/${m.slug}`, req.body.action === 'unwatch' ? 'unwatched' : 'watching'));
    });

    // ── Codes ───────────────────────────────────────────────
    function visibleCoupon(req, res) {
        const id = String(req.params.id || '');
        const c = COUPON_ID_RE.test(id) ? coupons.get(id) : null;
        const m = c && merchants.byId(c.merchant_id);
        if (!c || !m || m.status === 'pending' || c.review_state !== 'published') { notFound(req, res); return null; }
        if (c.status === 'disabled' || m.status === 'disabled') { messagePage(req, res, 410, 'Gone', 'This code was taken down.', { href: '/', label: 'All shops' }); return null; }
        return { c, m };
    }

    router.get('/c/:id.json', (req, res) => {
        const found = visibleCoupon(req, res);
        if (!found) return;
        const decision = publication.couponDecision(found.c, found.m);
        res.vary('Cookie'); res.vary('Authorization');
        res.set('Cache-Control', 'public, max-age=60');
        if (!decision.indexable) res.set('X-Robots-Tag', decision.robots);
        res.json({ coupon: coupons.view(found.c, { merchant: found.m }), merchant: { id: found.m.id, slug: found.m.slug, name: found.m.name, url: publication.merchantUrl(found.m) }, indexability: { indexable: decision.indexable, reasons: decision.codes } });
    });

    router.get('/c/:id', (req, res) => {
        const found = visibleCoupon(req, res);
        if (!found) return;
        const { c, m } = found;
        const v = coupons.view(c, { merchant: m });
        const flashMsg = FLASH[req.query.done] || null;
        send(req, res, 200, {
            title: `${v.code} — ${v.title} at ${m.name}`,
            description: `${pages.STATUS_LABEL[v.status]}. ${v.expiry.known ? `Expires ${v.expiry.expires_at.slice(0, 10)}.` : 'Expiry unknown.'}`,
            decision: publication.couponDecision(c, m), canonical: v.url, jsonLd: jsonLd(m, v),
            body: pages.couponPage({ v, m, history: coupons.history(c.id), viewer: req.viewer, csrf: csrf(req), back: `/c/${c.id}`, flashMsg }),
        }, { cacheable: !flashMsg });
    });

    router.post('/c/:id/report', form, (req, res) => {
        if (!requireForm(req, res)) return;
        const back = safeBack(req.body.back, `/c/${req.params.id}`);
        try {
            const out = reports.report(req.viewer, String(req.params.id), { outcome: req.body.outcome, reason: req.body.reason || null }, { channel: 'site' });
            const key = !out.deduplicated ? 'reported' : out.corrected ? 'report_corrected' : 'report_same';
            res.redirect(303, withFlash(back, key));
        } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            messagePage(req, res, err.status, err.status === 429 ? 'Slow down' : 'Could not record that', err.message, { href: back, label: 'Back' });
        }
    });

    // ── Submit ──────────────────────────────────────────────
    router.get('/submit', (req, res) => {
        const m = typeof req.query.merchant === 'string' ? merchants.get(req.query.merchant) : null;
        const values = m && m.status === 'active' ? { merchant: m.slug } : {};
        send(req, res, 200, {
            title: 'Submit a code', decision: pageDecision('/submit', { indexable: false }),
            body: pages.submitForm({ values, csrf: csrf(req), viewer: req.viewer, merchantName: values.merchant ? m.name : null }),
        });
    });

    router.post('/submit', form, (req, res) => {
        if (!requireForm(req, res)) return;
        const b = req.body || {};
        const m = b.merchant ? merchants.get(String(b.merchant)) : null;
        const body = {
            ...(m ? { merchant_id: m.id } : { url: /^https?:\/\//i.test(String(b.url || '')) ? b.url : undefined, host: /^https?:\/\//i.test(String(b.url || '')) ? undefined : b.url }),
            code: b.code, title: b.title, description: b.description, evidence_url: b.evidence_url || null,
            expires: b.expires || null, expiry_basis: b.expiry_basis === 'evidence' ? 'evidence' : 'submitter',
            restrictions: {
                min_spend: b.min_spend_amount ? { amount: b.min_spend_amount, currency: b.min_spend_currency } : null,
                categories: b.categories, new_customers_only: b.new_customers_only, regions: b.regions, other: b.restriction_other,
            },
            hint: b.hint,
        };
        const who = { actor: req.viewer.subject, kind: req.viewer.staff ? 'staff' : 'member', subject: req.viewer.subject };
        try {
            const out = ctx.submitCode(who, body, {});
            send(req, res, out.duplicate ? 200 : 201, { title: 'Submitted', decision: pageDecision('/submit', { indexable: false }), body: pages.submitted(out) });
        } catch (err) {
            if (!(err instanceof ApiError) && err.name !== 'HostError') throw err;
            send(req, res, err.status || 422, {
                title: 'Submit a code', decision: pageDecision('/submit', { indexable: false }),
                body: pages.submitForm({ values: b, errs: [err.message], csrf: csrf(req), viewer: req.viewer, merchantName: m ? m.name : null }),
            });
        }
    });

    // ── Browser helper tokens ───────────────────────────────
    function connectPage(req, res, status, extra = {}) {
        const list = req.viewer.kind === 'user' && req.viewer.subject ? installs.list(req.viewer.subject) : [];
        send(req, res, status, {
            title: 'Connect the browser helper', decision: pageDecision('/connect-extension', { indexable: req.viewer.kind === 'anonymous' }),
            body: pages.connect({ viewer: req.viewer, installs: list, csrf: csrf(req), ...extra }),
        }, { cacheable: req.viewer.kind === 'anonymous' });
    }
    router.get('/connect-extension', (req, res) => connectPage(req, res, 200));
    router.post('/connect-extension', form, (req, res) => {
        if (!requireForm(req, res)) return;
        try {
            const created = installs.create(req.viewer.subject, { label: req.body.label, scopes: req.body.scope_report ? [SCOPES.LOOKUP, SCOPES.REPORT] : [SCOPES.LOOKUP] });
            connectPage(req, res, 201, { created });
        } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            connectPage(req, res, err.status, { errs: [err.message] });
        }
    });
    router.post('/connect-extension/:id/revoke', form, (req, res) => {
        if (!requireForm(req, res)) return;
        installs.revoke(req.viewer.subject, String(req.params.id));
        res.redirect(303, '/connect-extension');
    });

    router.get('/watching', (req, res) => {
        if (!requireUser(req, res)) return;
        send(req, res, 200, { title: 'Watching', decision: pageDecision('/watching', { indexable: false }), body: pages.watching({ merchants: watches.list(req.viewer.subject) }) });
    });

    // ── Staff ───────────────────────────────────────────────
    function requireStaff(req, res) {
        if (!requireUser(req, res)) return false;
        if (!req.viewer.staff) { messagePage(req, res, 403, 'Staff only', 'This page is for OpenVibe staff.'); return false; }
        return true;
    }
    function staffPage(req, res, status = 200, extra = {}) {
        const pendingMerchants = merchants.pending().map((m) => ({ ...m, domains: merchants.domains(m).map((d) => d.host + (d.path_prefix || '')), codes: coupons.pendingOfMerchant(m.id).length }));
        const pendingCoupons = coupons.pendingReview().map((c) => {
            const m = merchants.byId(c.merchant_id);
            const v = coupons.view(c, { merchant: m });
            return { id: c.id, code: c.code, title: c.title, origin: c.origin, merchant: m ? m.name : '?', evidence: (v.evidence.find((e) => e.url) || {}).url || null };
        });
        send(req, res, status, {
            title: 'Staff', decision: pageDecision('/staff', { indexable: false }),
            body: pages.staff({ pendingMerchants, pendingCoupons, holds: ctx.importer.holds(), csrf: csrf(req), flashMsg: FLASH[req.query.done] || extra.flashMsg || null, errs: extra.errs }),
        });
    }
    function staffAction(fn) {
        return (req, res) => {
            if (!requireStaff(req, res)) return;
            if (!checkCsrf(config, req.viewer, req.body && req.body.csrf)) return messagePage(req, res, 403, 'Form expired', 'Reload the page and try again.');
            try {
                const msg = fn(req);
                staffPage(req, res, 200, { flashMsg: msg });
            } catch (err) {
                if (!(err instanceof ApiError) && err.name !== 'HostError') throw err;
                staffPage(req, res, err.status || 422, { errs: [err.message] });
            }
        };
    }
    router.get('/staff', (req, res) => { if (requireStaff(req, res)) staffPage(req, res); });
    router.post('/staff/merchants', form, staffAction((req) => {
        const b = req.body;
        const m = merchants.create({ name: b.name, domains: [{ host: b.host, include_subdomains: Boolean(b.include_subdomains), path_prefix: b.path_prefix || '' }] }, { status: 'active', actor: req.viewer.subject });
        store.tx(() => coupons.syncMerchant(m));
        return `Added ${m.name}.`;
    }));
    router.post('/staff/merchants/:id/status', form, staffAction((req) => {
        const m = merchants.get(req.params.id);
        if (!m) throw new ApiError(404, 'merchant.not_found', 'no such shop');
        const after = moderation.setMerchantStatus(m, req.body.status, { actor: req.viewer.subject });
        return `${after.name} is now ${after.status}.`;
    }));
    router.post('/staff/coupons/:id/approve', form, staffAction((req) => {
        const c = coupons.get(req.params.id);
        if (!c) throw new ApiError(404, 'coupon.not_found', 'no such code');
        const m = merchants.byId(c.merchant_id);
        if (m.status !== 'active') throw new ApiError(409, 'merchant.not_active', 'approve the shop first');
        coupons.approve(c, { actor: req.viewer.subject });
        return `Published ${c.code}.`;
    }));
    router.post(['/staff/coupons/status', '/staff/coupons/:id/status'], form, staffAction((req) => {
        const c = coupons.get(req.params.id || req.body.id);
        if (!c) throw new ApiError(404, 'coupon.not_found', 'no such code');
        const after = coupons.setStatus(c, req.body.status, { actor: req.viewer.subject, note: req.body.note });
        return `${c.code} is now ${pages.STATUS_LABEL[after.status].toLowerCase()}.`;
    }));

    return { router, notFound };
}

module.exports = { createPublicRoutes };
