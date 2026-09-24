'use strict';

/**
 * Who is calling, resolved once per request into `req.viewer`.
 *
 * Pages (forms, server-rendered HTML) — viewers.pages():
 *   { kind: 'anonymous' }
 *   { kind: 'user', subject, staff, user }      the Network user JWT from the ov_token cookie
 *   Anything else (service tokens, extension tokens) is treated as anonymous: pages are for people.
 *
 * API (/api/v1) — viewers.api(): the Authorization header ONLY. Cookies are ignored, so a request a
 * web page makes with the visitor's ambient cookies carries no identity at all (no CSRF, no data):
 *   { kind: 'anonymous' }                                 no Authorization header
 *   { kind: 'install', install, subject, scopes }         Bearer cpx_… (extension install token)
 *   { kind: 'service', service, claims, subject, origin } Bearer Network client-credentials token for
 *                                                         audience openvibe.coupons; X-OV-Subject names
 *                                                         the person it acts for, X-OV-Origin: ai marks
 *                                                         model output (OpenVibe.AI coupons.extract_coupon).
 *                                                         Apps (app:…) and modules (mod:…) act only for
 *                                                         their on_behalf_of person; sandbox tokens: 401
 *   { kind: 'user', subject, staff, user }                Bearer Network user JWT (apps)
 * A presented credential that does not verify is refused (401), never downgraded to anonymous.
 *
 * Identity never comes from a request body or query.
 */
const contracts = require('openvibe-contracts');
const { extractToken, claimsToUser, decodeJwtPayload } = require('./sso');
const { checkCapability } = require('./capabilities');
const { ApiError } = require('../http/errors');

const { ids, serviceAuth, http, staff: staffMap } = contracts;
const PRINCIPAL_SUB = /^(svc|app|mod):/;
const AUDIENCE = 'openvibe.coupons';

const ANONYMOUS = Object.freeze({ kind: 'anonymous', subject: null, staff: false, origin: 'user' });

function createViewerResolver({ auth, config, installs }) {
    const staffSubjects = new Set(config.staffSubjects || []);

    function userFromClaims(claims, token) {
        if (!claims || (typeof claims.sub === 'string' && PRINCIPAL_SUB.test(claims.sub))) return null;
        const subject = ids.isSubjectId('user', claims.subject_id) ? claims.subject_id : null;
        // Staff = the contracts staff map's staff.editorial.manage (ADR-022), or a subject in COUPONS_STAFF_SUBJECTS.
        const staff = Boolean(subject) && (staffMap.can(claims, 'staff.editorial.manage') || staffSubjects.has(subject));
        return { kind: 'user', subject, staff, origin: 'user', user: claimsToUser(claims), token };
    }

    async function fromServiceToken(req, token) {
        const publicKey = await auth.ensureKey();
        if (!publicKey) throw new ApiError(503, 'identity.unavailable', 'the Network signing key is not loaded yet');
        const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.networkUrl, audience: AUDIENCE });
        if (!r.ok) throw new ApiError(401, r.code, r.reason);
        // Developer apps (app:…) and modules (mod:…) are third parties: they act only for the person
        // who authorized them (on_behalf_of), never for whoever X-OV-Subject names. Only first-party
        // service principals (svc:…) are trusted to name the acting person.
        const claims = r.claims;
        const firstParty = claims.actor_type === 'service' && String(claims.sub).startsWith('svc:');
        if (!firstParty && claims.env !== undefined && claims.env !== 'production') {
            throw new ApiError(401, 'token.sandbox_refused', 'sandbox tokens are not accepted by openvibe.coupons');
        }
        const originHeader = req.get('x-ov-origin');
        if (originHeader && originHeader !== 'ai' && originHeader !== 'user') throw new ApiError(400, 'request.invalid_origin', 'X-OV-Origin must be "ai" or "user"');
        const subjectHeader = req.get('x-ov-subject');
        let subject = null;
        if (subjectHeader) {
            if (!ids.isSubjectId('user', subjectHeader)) throw new ApiError(400, 'subject.invalid', 'X-OV-Subject must be a usr_… subject id');
            if (!firstParty && subjectHeader !== claims.on_behalf_of) {
                throw new ApiError(403, 'subject.not_delegated', 'an app acts only for the person who authorized it (on_behalf_of)');
            }
            subject = subjectHeader;
        } else if (!firstParty && ids.isSubjectId('user', claims.on_behalf_of)) {
            subject = claims.on_behalf_of;
        }
        return { kind: 'service', service: claims.sub, claims, subject, origin: originHeader === 'ai' ? 'ai' : 'user', staff: false };
    }

    /** API callers: the Authorization header only. */
    async function resolveApi(req) {
        const header = String(req.headers.authorization || '');
        if (!header) return ANONYMOUS;
        if (!header.startsWith('Bearer ')) throw new ApiError(401, 'auth.unsupported', 'use Authorization: Bearer <token>');
        const token = header.slice(7).trim();
        if (token.startsWith('cpx_')) {
            const v = installs.verify(token);
            return { kind: 'install', install: v.install, subject: v.subject, scopes: v.scopes, staff: false, origin: 'user' };
        }
        const payload = decodeJwtPayload(token);
        if (!payload) throw new ApiError(401, 'token.invalid', 'malformed bearer token');
        if (typeof payload.sub === 'string' && PRINCIPAL_SUB.test(payload.sub)) return fromServiceToken(req, token);
        const claims = await auth.verify(token);
        const user = userFromClaims(claims, token);
        if (!user) throw new ApiError(401, 'token.invalid', 'invalid or expired token');
        return user;
    }

    /** Pages: the ov_token cookie (or a Bearer user token); services and installs are anonymous here. */
    async function resolvePage(req) {
        const token = extractToken(req);
        if (!token || token.startsWith('cpx_')) return ANONYMOUS;
        const payload = decodeJwtPayload(token);
        if (!payload || (typeof payload.sub === 'string' && PRINCIPAL_SUB.test(payload.sub))) return ANONYMOUS;
        return userFromClaims(await auth.verify(token), token) || ANONYMOUS;
    }

    return {
        resolveApi,
        resolvePage,
        api() {
            return async (req, res, next) => {
                try {
                    req.viewer = await resolveApi(req);
                    next();
                } catch (err) {
                    if (!(err instanceof ApiError)) return next(err);
                    res.set('Cache-Control', 'private, no-store');
                    http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
                }
            };
        },
        pages() {
            return async (req, _res, next) => {
                try { req.viewer = await resolvePage(req); next(); } catch (err) { next(err); }
            };
        },
    };
}

/**
 * Route guard for the API. A service token must hold `cap`; an install token must hold `scope`
 * (when the route accepts installs at all); people and anonymous callers pass here and are judged
 * by the route itself.
 */
function guard(cap, { scope = null } = {}) {
    return (req, res, next) => {
        const v = req.viewer;
        if (v && v.kind === 'service') {
            const c = checkCapability(v.claims, cap);
            if (c.allowed) return next();
            return http.sendProblem(res, 403, c.code, { detail: c.reason, ctx: req.ov });
        }
        if (v && v.kind === 'install') {
            if (scope && v.scopes.includes(scope)) return next();
            return http.sendProblem(res, 403, 'token.scope', { detail: scope ? `this extension token lacks the ${scope} scope` : 'extension tokens cannot use this route', ctx: req.ov });
        }
        return next();
    };
}

module.exports = { createViewerResolver, guard, ANONYMOUS };
