'use strict';

/**
 * Errors as RFC 9457 problems (contracts errors.problem@1, which keeps the legacy { error } field),
 * and the small request helpers every router shares. Built from openvibe-sdk/service (docs/service.md,
 * the Blog row) so every service answers the same way; the exports stay put so no call site moves.
 * Only an ApiError or a HostError is a refusal: the SDK's default would also echo any error carrying
 * { status, code }, so anything else reaches it stripped to its stack and answers a generic 500.
 */
const svc = require('openvibe-sdk/service');
const cache = require('openvibe-shared/cache-policy');

/** A refusal with a stable problem code (e.g. 404 'coupon.not_found'). */
const ApiError = svc.createServiceError('ApiError');

const o = { name: 'Coupons API' };

/** Domain errors (HostError, …) carry { status, code } too. */
function asApiError(err) {
    if (err instanceof ApiError) return err;
    if (err && err.name === 'HostError') return new ApiError(err.status, err.code, err.message);
    return null;
}

/** An unexpected error with nothing a client may see: logged by its stack, answered as internal.error. */
const internal = (err) => ({ stack: err && err.stack ? err.stack : String(err) });

/** Wrap a JSON handler: its return value is the body; errors become problems. */
const run = (fn, status) => svc.run(async (req, res) => {
    try {
        return await fn(req, res);
    } catch (err) {
        throw asApiError(err) || internal(err);
    }
}, status, o);

/** JSON body parser whose failures are problems too: malformed 400, over the limit 413. */
const jsonBody = svc.jsonBody({ limit: '32kb' });

/** Private, per-viewer responses: never stored by a shared cache, never indexed. */
function privateNoStore(res) {
    res.set('Cache-Control', cache.htmlHeaders({ private: true }));
    res.vary('Cookie');
    res.vary('Authorization');
}

module.exports = { ApiError, asApiError, run, jsonBody, privateNoStore };
