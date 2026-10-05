'use strict';

/**
 * Capability checks for service tokens (audience openvibe.coupons), and the scopes of extension
 * install tokens.
 *
 * Capabilities (roadmap §15.13, as 3-segment ids) are for OpenVibe services holding a Network
 * client-credentials token. Coupons' ids were released in openvibe-contracts v0.97.0 from
 * docs/capabilities-proposal/; a grant is decided by the library's own matching rule (the exact
 * id, or a `prefix.*` grant covering it).
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

const SCOPES = Object.freeze({ LOOKUP: 'coupons.lookup', REPORT: 'coupons.report' });
const ALL_SCOPES = Object.freeze([SCOPES.LOOKUP, SCOPES.REPORT]);

/** → { allowed, code, reason } like capabilities.check(). */
function checkCapability(claims, capabilityId) {
    return capabilities.check(claims, capabilityId);
}

module.exports = { CAPABILITIES, SCOPES, ALL_SCOPES, checkCapability };
