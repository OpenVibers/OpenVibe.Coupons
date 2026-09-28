'use strict';

/**
 * Per-actor rate limits on /api/v1 and the page forms (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * The limits already here stay and keep deciding: the lookup limiter (per install, per service, per
 * address), the per-address write limit, the pages' per-address limit and the per-person report and
 * submission limits. These count requests by who makes them, once req.viewer is resolved
 * (auth/viewer.js):
 *
 *   a person                        user:usr_… (their Network token or cookie, named by a service in
 *                                   X-OV-Subject, an app's on_behalf_of, or an extension install token:
 *                                   every browser helper a person connected counts as that person,
 *                                   never as the address it reports from)
 *   a first-party service relaying  ip:<address> of the signed-out visitor it forwards (X-Forwarded-For)
 *     a signed-out visitor
 *   a service or app acting as      its principal (svc:ai for coupons.extract_coupon, app:app_…)
 *     itself
 *   a signed-out caller             ip:<address>
 *
 * A first-party service reading for itself (no person, no visitor) is not counted on reads: its
 * pages speak for all its visitors, and the lookup limiter already bounds it (600 a minute). Past a
 * limit the route answers 429 problem+json `rate_limited` with Retry-After before it does any work
 * (before the body is read); the refusal is logged once and counted in
 * coupons_rate_limited_total{limit,window}. API reads get COUPONS_LIMITS_MINUTE / COUPONS_LIMITS_HOUR
 * (120 and 3000); every write has its own number below, shared by the API route and the page form that
 * do the same thing. Counters live in this process: a restart forgets them.
 *
 * Never limited: /api/health, /api/ready, /release.json, /metrics, sign-in, revoking a browser helper
 * (a person must always be able to cut one off), and the pages and feeds people read.
 */
const { createActorLimiter, createValkeyLimitStore, defaultActor } = require('openvibe-sdk/limits');

const FIRST_PARTY = /^svc:/;
const LOOPBACK = /^(::1$|127\.|::ffff:127\.)/;

/** A first-party service that forwards the address of the signed-out visitor it acts for. */
function relaysVisitor(req) {
    const v = req.viewer;
    return !!(v && v.kind === 'service' && !v.subject && FIRST_PARTY.test(String(v.service)) && req.get('x-forwarded-for') && req.ip && !LOOPBACK.test(req.ip));
}

function actor(req) {
    const v = req.viewer;
    if (!v || v.kind === 'anonymous') return defaultActor(req);
    if (v.subject) return `user:${v.subject}`;
    if (v.kind === 'service') return relaysVisitor(req) ? `ip:${req.ip}` : v.service;
    return defaultActor(req);
}

/** A first-party service reading for itself: no person, no visitor. */
function serviceItself(req) {
    const v = req.viewer;
    return !!(v && v.kind === 'service' && !v.subject && FIRST_PARTY.test(String(v.service)) && !relaysVisitor(req));
}

/**
 * The writes, each with its numbers per caller (a minute, an hour). Each cap sits above the per-person
 * limit for the same action, so a person inside that limit is never refused here; the difference is
 * room for refused retries. A page form and the API route that do the same thing share one budget.
 */
const BUDGETS = {
    // Reports (20 an hour and 60 a day per person decide, every channel together): 30 a minute, 120 an hour.
    'coupons.report.create': { minute: 30, hour: 120 },
    // Submissions by a person (10 an hour and 30 a day decide): 20 a minute, 60 an hour.
    'coupons.coupon.submit': { minute: 20, hour: 60 },
    // Staff and services: coupon and merchant status, merchants and their domains, approvals.
    'coupons.moderate': { minute: 60, hour: 600 },
    // A browser helper token is minted once per browser (10 active per person at most).
    'coupons.install.create': { minute: 5, hour: 20 },
    // Watching or unwatching a merchant is one toggle.
    'coupons.watch': { minute: 30, hour: 300 },
};
// A service submitting for people gets ten times a person's submission limit (api.js): its cap is too.
const SERVICE_SUBMIT = { minute: 120, hour: 600 };

/**
 * limits(name, own) middleware for one app, plus limits.reads(name) (the defaults on GET/HEAD, a
 * first-party service reading for itself not counted), limits.budget(name) (one of BUDGETS) and
 * limits.submit (the submission budget: a person's, or a service's).
 */
function createActorLimits({ config, now = () => Date.now(), registry = null, log = console, valkey = null }) {
    const refused = registry
        ? registry.counter({ name: 'coupons_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: { minute: config.actorLimits.minute, hour: config.actorLimits.hour },
        actor,
        now,
        // Shared across processes on Valkey (ADR-035) when VALKEY_URL is set; in-process otherwise.
        ...(valkey ? { store: createValkeyLimitStore(valkey) } : {}),
        onLimited(e) {
            // The actor is a subject id, a principal or an address, never a token.
            log.warn(`[Limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name) => {
        const limit = limiter(name);
        return (req, res, next) => ((req.method === 'GET' || req.method === 'HEAD') && !serviceItself(req) ? limit(req, res, next) : next());
    };
    const budgets = new Map(Object.entries(BUDGETS).map(([name, own]) => [name, limiter(name, own)]));
    limiter.budget = (name) => {
        const m = budgets.get(name);
        if (!m) throw new Error(`limits: no budget named ${name}`);
        return m;
    };
    const serviceSubmit = limiter('coupons.coupon.submit', SERVICE_SUBMIT);
    limiter.submit = (req, res, next) => (req.viewer && req.viewer.kind === 'service' ? serviceSubmit : budgets.get('coupons.coupon.submit'))(req, res, next);
    return limiter;
}

module.exports = { createActorLimits, actor, serviceItself, BUDGETS, SERVICE_SUBMIT };
