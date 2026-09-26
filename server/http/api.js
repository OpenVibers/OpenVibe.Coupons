'use strict';

/**
 * The JSON API (/api/v1). Identity comes from the Authorization header ONLY (cookies are ignored
 * here), so a web page cannot use a visitor's session against it.
 *
 * Public lookup (the browser helper's two calls; anonymous allowed; CORS only for configured
 * extension origins; rate-limited per IP when anonymous, per install with a cpx_ token):
 *   GET  /merchants/resolve?host=        coupons.merchant.resolve  | scope coupons.lookup
 *   GET  /merchants/:id/coupons          coupons.coupon.lookup     | scope coupons.lookup
 * Also public (no CORS):
 *   GET  /merchants/:id                  coupons.coupon.lookup     | scope coupons.lookup
 *   GET  /coupons/:id                    coupons.coupon.lookup     | scope coupons.lookup
 * People (Bearer Network token), installs and services acting for a person:
 *   POST /coupons/:id/report             coupons.report.create     | scope coupons.report
 *   POST /coupons/submit                 coupons.coupon.submit     (installs cannot submit)
 * Staff (Network admins / COUPONS_STAFF_SUBJECTS with a Bearer token) and services:
 *   POST /coupons/:id/status             coupons.status.update     disabled | expired | active
 *   POST /merchants                      coupons.merchant.manage
 *   POST /merchants/:id/domains          coupons.merchant.manage
 *   POST /merchants/:id/status           coupons.merchant.manage   active | disabled
 *
 * Every lookup response is the same bytes for every caller: it holds no data about the caller or
 * any other person (no submitter, no reporter, no install).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const { guard } = require('../auth/viewer');
const { CAPABILITIES, SCOPES } = require('../auth/capabilities');
const { ApiError, run, jsonBody } = require('./errors');
const hosts = require('../domain/hosts');

const MOZ_EXTENSION_RE = /^moz-extension:\/\/[0-9a-f-]{36}$/;

function createApi(ctx) {
    const { config, viewers, merchants, coupons, reports, publication } = ctx;
    const router = express.Router();

    // ── Helpers ─────────────────────────────────────────────
    const noStore = (res) => res.set('Cache-Control', 'private, no-store');

    function extensionOriginAllowed(origin) {
        if (!origin) return false;
        if (config.extensionOrigins.includes(origin)) return true;
        return config.extensionOrigins.includes('moz-extension://*') && MOZ_EXTENSION_RE.test(origin);
    }

    /** CORS for the lookup routes only: exact configured extension origins, never credentials. */
    function lookupCors(req, res, next) {
        res.vary('Origin');
        const origin = req.get('origin');
        if (extensionOriginAllowed(origin)) {
            res.set('Access-Control-Allow-Origin', origin);
            res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.set('Access-Control-Allow-Headers', 'Authorization');
            res.set('Access-Control-Max-Age', '600');
        }
        if (req.method === 'OPTIONS') return res.status(204).end();
        next();
    }

    const tooMany = (code) => (req, res) => {
        noStore(res);
        contracts.http.sendProblem(res, 429, code, { detail: 'Too many requests; slow down and try again shortly.', ctx: req.ov });
    };

    const lookupLimiter = rateLimit({
        windowMs: 60_000,
        standardHeaders: true,
        legacyHeaders: false,
        limit: (req) => (req.viewer.kind === 'install' ? config.limits.lookupTokenPerMin
            : req.viewer.kind === 'service' ? config.limits.lookupServicePerMin : config.limits.lookupAnonPerMin),
        keyGenerator: (req) => (req.viewer.kind === 'install' ? `install:${req.viewer.install}`
            : req.viewer.kind === 'service' ? `service:${req.viewer.service}` : `ip:${req.ip}`),
        handler: tooMany('lookup.rate_limited'),
    });
    // Per-IP ceiling in front of the per-person limits of reports and submissions.
    const writeLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, handler: tooMany('request.rate_limited') });

    const publicCache = (res) => res.set('Cache-Control', 'public, max-age=60');

    function merchantView(m) {
        return {
            id: m.id,
            slug: m.slug,
            name: m.name,
            homepage_url: m.homepage_url,
            url: publication.merchantUrl(m),
            domains: merchants.domains(m).map((d) => ({ host: d.host, include_subdomains: Boolean(d.include_subdomains), path_prefix: d.path_prefix || null })),
            active_codes: coupons.activeCount(m.id),
            hints: coupons.merchantHints(m.id).map((h) => h.text),
        };
    }

    function activeMerchant(idOrSlug) {
        const m = merchants.get(idOrSlug);
        if (!m || m.status !== 'active') throw new ApiError(404, 'merchant.not_found', 'no such merchant');
        return m;
    }

    function requireStaffOrService(req) {
        const v = req.viewer;
        if (v.kind === 'service') return v.service;
        if (v.kind === 'user' && v.staff) return v.subject;
        if (v.kind === 'anonymous') throw new ApiError(401, 'auth.required', 'authentication required');
        throw new ApiError(403, 'auth.staff_required', 'staff only');
    }

    router.use(viewers.api());

    // ── Lookup ──────────────────────────────────────────────
    router.options(['/merchants/resolve', '/merchants/:id/coupons'], lookupCors);

    router.get('/merchants/resolve', lookupCors, lookupLimiter, guard(CAPABILITIES.MERCHANT_RESOLVE, { scope: SCOPES.LOOKUP }), run((req, res) => {
        if (typeof req.query.host !== 'string') throw new ApiError(400, 'host.required', 'pass ?host=<hostname>');
        const found = merchants.resolve(req.query.host);
        publicCache(res);
        if (!found) {
            const host = hosts.normalizeHost(req.query.host);
            throw new ApiError(404, 'merchant.not_found', `no merchant for ${host}`, { host, registrable_domain: hosts.registrable(host) });
        }
        return {
            host: found.host,
            registrable_domain: found.registrable,
            matched_rule: { host: found.rule.host, include_subdomains: Boolean(found.rule.include_subdomains), path_prefix: found.rule.path_prefix || null },
            merchant: merchantView(found.merchant),
        };
    }));

    router.get('/merchants/:id/coupons', lookupCors, lookupLimiter, guard(CAPABILITIES.COUPON_LOOKUP, { scope: SCOPES.LOOKUP }), run((req, res) => {
        const m = activeMerchant(req.params.id);
        publicCache(res);
        return { merchant: merchantView(m), coupons: coupons.active(m.id).map((c) => coupons.view(c, { merchant: m })) };
    }));

    router.get('/merchants/:id', lookupLimiter, guard(CAPABILITIES.COUPON_LOOKUP, { scope: SCOPES.LOOKUP }), run((req, res) => {
        const m = activeMerchant(req.params.id);
        publicCache(res);
        return { merchant: merchantView(m) };
    }));

    router.get('/coupons/:id', lookupLimiter, guard(CAPABILITIES.COUPON_LOOKUP, { scope: SCOPES.LOOKUP }), run((req, res) => {
        const c = coupons.get(req.params.id);
        const m = c && merchants.byId(c.merchant_id);
        if (!c || !m || m.status !== 'active' || c.review_state !== 'published' || c.status === 'disabled') throw new ApiError(404, 'coupon.not_found', 'no such code');
        publicCache(res);
        return { coupon: coupons.view(c, { merchant: m }), merchant: merchantView(m) };
    }));

    // ── Reports ─────────────────────────────────────────────
    router.post('/coupons/:id/report', writeLimiter, jsonBody, guard(CAPABILITIES.REPORT_CREATE, { scope: SCOPES.REPORT }), run((req, res) => {
        noStore(res);
        return reports.report(req.viewer, req.params.id, req.body || {}, { channel: 'api', traceparent: req.get('traceparent') });
    }, (out) => (out.deduplicated ? 200 : 201)));

    // ── Submissions ─────────────────────────────────────────
    router.post('/coupons/submit', writeLimiter, jsonBody, guard(CAPABILITIES.COUPON_SUBMIT), run((req, res) => {
        noStore(res);
        const v = req.viewer;
        let who;
        if (v.kind === 'anonymous') throw new ApiError(401, 'auth.required', 'sign in to submit a code');
        if (v.kind === 'service' && v.origin === 'ai') who = { actor: v.service, kind: 'ai', subject: null };
        else if (v.subject) who = { actor: v.subject, kind: v.kind === 'user' && v.staff ? 'staff' : 'member', subject: v.subject };
        else throw new ApiError(403, 'auth.person_required', 'a submission needs the person it is from (X-OV-Subject for services)');
        const out = submitCode(who, req.body || {}, { traceparent: req.get('traceparent'), limits: v.kind === 'service' ? scaled(config.limits, 10) : config.limits });
        return {
            coupon: coupons.view(out.coupon, { merchant: out.merchant }),
            merchant: { id: out.merchant.id, slug: out.merchant.slug, name: out.merchant.name, status: out.merchant.status },
            duplicate: out.duplicate,
            review_state: out.coupon.review_state,
        };
    }, (out) => (out.duplicate ? 200 : 201)));

    // ── Staff and services ──────────────────────────────────
    router.post('/coupons/:id/status', writeLimiter, jsonBody, guard(CAPABILITIES.STATUS_UPDATE), run((req, res) => {
        noStore(res);
        const actor = requireStaffOrService(req);
        const c = coupons.get(req.params.id);
        if (!c) throw new ApiError(404, 'coupon.not_found', 'no such code');
        const body = req.body || {};
        const after = coupons.setStatus(c, body.status, { actor, note: body.note, traceparent: req.get('traceparent') });
        return { coupon: coupons.view(after) };
    }));

    router.post('/merchants', writeLimiter, jsonBody, guard(CAPABILITIES.MERCHANT_MANAGE), run((req, res) => {
        noStore(res);
        const actor = requireStaffOrService(req);
        const body = req.body || {};
        const status = body.status === 'pending' ? 'pending' : 'active';
        const m = merchants.create(body, { status, actor });
        store().tx(() => coupons.syncMerchant(m));
        return { merchant: { ...merchantView(m), status: m.status } };
    }, 201));

    router.post('/merchants/:id/domains', writeLimiter, jsonBody, guard(CAPABILITIES.MERCHANT_MANAGE), run((req, res) => {
        noStore(res);
        const actor = requireStaffOrService(req);
        const m = merchants.get(req.params.id);
        if (!m) throw new ApiError(404, 'merchant.not_found', 'no such merchant');
        merchants.addDomain(m, req.body || {}, actor);
        return { merchant: { ...merchantView(m), status: m.status } };
    }, 201));

    router.post('/merchants/:id/status', writeLimiter, jsonBody, guard(CAPABILITIES.MERCHANT_MANAGE), run((req, res) => {
        noStore(res);
        const actor = requireStaffOrService(req);
        const m = merchants.get(req.params.id);
        if (!m) throw new ApiError(404, 'merchant.not_found', 'no such merchant');
        const status = (req.body || {}).status;
        if (!['active', 'disabled'].includes(status)) throw new ApiError(422, 'merchant.bad_status', 'status must be active or disabled');
        const after = ctx.moderation.setMerchantStatus(m, status, { actor, traceparent: req.get('traceparent') });
        return { merchant: { ...merchantView(after), status: after.status } };
    }));

    // ── The shared submission path (API and the /submit form) ──
    function submitCode(who, body, { traceparent, limits = config.limits } = {}) {
        const input = coupons.parseSubmission(body, ctx.store.now());
        let merchant = null;
        if (body.merchant_id) {
            merchant = merchants.get(String(body.merchant_id));
            if (!merchant) throw new ApiError(404, 'merchant.not_found', 'no such merchant');
        } else if (body.host || body.url) {
            const at = body.url ? hosts.hostOfUrl(body.url) : { host: hosts.normalizeHost(String(body.host)), path: null };
            if (!at) throw new ApiError(422, 'host.invalid', 'url must be an http(s) URL of a public site');
            const any = merchants.resolve(at.host, { path: at.path, includeStatuses: ['active', 'pending', 'disabled'] });
            if (any) merchant = any.merchant;
            else {
                coupons.checkSubmissionRate(who.actor, limits);
                const reg = hosts.registrable(at.host);
                if (!reg) throw new ApiError(422, 'host.invalid', `${at.host} is a public suffix, not a site`);
                // A site no merchant covers yet: proposed as a PENDING merchant, invisible until staff approve it.
                merchant = merchants.create({ name: reg, domains: [{ host: reg, include_subdomains: true }] }, { status: 'pending', actor: who.actor });
            }
        } else {
            throw new ApiError(422, 'merchant.required', 'name the merchant: merchant_id, host or url');
        }
        if (merchant.status === 'disabled') throw new ApiError(409, 'merchant.disabled', 'this merchant was taken down');
        return coupons.submit(who, merchant, input, { limits, traceparent });
    }

    const store = () => ctx.store;
    const scaled = (limits, k) => ({ ...limits, submissionsPerHour: limits.submissionsPerHour * k, submissionsPerDay: limits.submissionsPerDay * k });

    ctx.submitCode = submitCode;
    return router;
}

module.exports = { createApi };
