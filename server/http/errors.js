'use strict';

/**
 * Errors as RFC 9457 problems (contracts errors.problem@1, which keeps the legacy { error } field),
 * and the small request helpers every router shares. Built from openvibe-sdk/service (docs/service.md,
 * the Blog row) so every service answers the same way; the exports stay put so no call site moves.
 */
const svc = require('openvibe-sdk/service');

/** A refusal with a stable problem code (e.g. 404 'coupon.not_found'). */
const ApiError = svc.createServiceError('ApiError');

const o = {
    name: 'Coupons API',
    ServiceError: ApiError,
    /** Domain errors (HostError, …) carry { status, code } too. */
    map: (err) => (err && err.name === 'HostError' ? new ApiError(err.status, err.code, err.message) : null),
};

const asApiError = (err) => svc.asServiceError(err, o);

/** Wrap a JSON handler: its return value is the body; errors become problems. */
const run = (fn, status) => svc.run(fn, status, o);

/** JSON body parser whose failures are problems too: malformed 400, over the limit 413. */
const jsonBody = svc.jsonBody({ limit: '32kb' });

/** Private, per-viewer responses: never stored by a shared cache, never indexed. */
const privateNoStore = svc.privateNoStore;

module.exports = { ApiError, asApiError, run, jsonBody, privateNoStore };
