'use strict';

/**
 * Capability checks for service tokens (audience openvibe.coupons), and the scopes of extension
 * install tokens.
 *
 * Capabilities (roadmap §15.13, as 3-segment ids) are for OpenVibe services holding a Network
 * client-credentials token. Coupons' ids are proposed in docs/capabilities-proposal/ for the next
 * contracts release; until then a grant is decided locally with the library's own matching rule
 * (the exact id, or a `prefix.*` grant covering it). An id the library knows always goes through
 * the library, so the day the release lands nothing changes here.
 *
 * Install scopes (coupons.lookup, coupons.report) are NOT Network capabilities: they are the two
 * things a browser-helper install token may do, issued and revoked on this site
 * (/connect-extension). They map onto the capabilities of the same routes.
 */
const { capabilities } = require('openvibe-contracts');

const CAPABILITIES = Object.freeze({
    COUPON_SUBMIT: 'coupons.coupon.submit',       // charter coupons.submit
    REPORT_CREATE: 'coupons.report.create',       // charter coupons.report
    MERCHANT_RESOLVE: 'coupons.merchant.resolve',
    COUPON_LOOKUP: 'coupons.coupon.lookup',       // charter coupons.lookup
    STATUS_UPDATE: 'coupons.status.update',
    MERCHANT_MANAGE: 'coupons.merchant.manage',
});
const PROPOSED = new Set(Object.values(CAPABILITIES));

const SCOPES = Object.freeze({ LOOKUP: 'coupons.lookup', REPORT: 'coupons.report' });
const ALL_SCOPES = Object.freeze([SCOPES.LOOKUP, SCOPES.REPORT]);

/** → { allowed, code, reason } like capabilities.check(). */
function checkCapability(claims, capabilityId) {
    if (!capabilities.get(capabilityId) && PROPOSED.has(capabilityId)) {
        return capabilities.grants(claims && claims.cap, capabilityId)
            ? { allowed: true, code: null, reason: null }
            : { allowed: false, code: 'capability.denied', reason: `${capabilityId} not granted` };
    }
    return capabilities.check(claims, capabilityId);
}

module.exports = { CAPABILITIES, PROPOSED, SCOPES, ALL_SCOPES, checkCapability };
