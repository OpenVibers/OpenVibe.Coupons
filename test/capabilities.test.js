'use strict';
/**
 * Coupons' capabilities are released in openvibe-contracts (v0.97.0), so the local fallback for
 * proposed ids is gone: checkCapability is exactly the library's check, and every id the code
 * enforces is known to the library. Install scopes stay Coupons-local and are never capabilities.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { check, done } = require('./helpers/boot');
const mod = require('../server/auth/capabilities');
const { CAPABILITIES, SCOPES, ALL_SCOPES, checkCapability } = mod;

(async () => {
    await check('every enforced capability is released in openvibe-contracts, owned by coupons', async () => {
        for (const id of Object.values(CAPABILITIES)) {
            const cap = contracts.capabilities.get(id);
            assert.ok(cap, `${id} is not in the contracts library`);
            assert.strictEqual(cap.owner, 'coupons', id);
            assert.notStrictEqual(cap.status, 'retired', id);
        }
    });

    await check('the proposed-id shim is gone: PROPOSED and the local fallback are not exported', async () => {
        assert.ok(!('PROPOSED' in mod), 'PROPOSED is still exported');
        // A capability id the library does not know is unknown, never locally granted.
        const forged = { cap: ['coupons.nonexistent.thing'] };
        assert.deepStrictEqual(checkCapability(forged, 'coupons.nonexistent.thing'), contracts.capabilities.check(forged, 'coupons.nonexistent.thing'));
        assert.strictEqual(checkCapability(forged, 'coupons.nonexistent.thing').code, 'capability.unknown');
    });

    await check('checkCapability is the library check: exact, prefix.* and denied grants', async () => {
        const id = CAPABILITIES.COUPON_LOOKUP;
        assert.deepStrictEqual(checkCapability({ cap: [id] }, id), { allowed: true, code: null, reason: null });
        assert.deepStrictEqual(checkCapability({ cap: ['coupons.*'] }, id), { allowed: true, code: null, reason: null });
        assert.deepStrictEqual(checkCapability({ cap: [] }, id), { allowed: false, code: 'capability.denied', reason: `${id} not granted` });
        assert.deepStrictEqual(checkCapability(null, id), { allowed: false, code: 'capability.denied', reason: `${id} not granted` });
        // No grant for one id leaks to another.
        assert.strictEqual(checkCapability({ cap: [CAPABILITIES.COUPON_LOOKUP] }, CAPABILITIES.STATUS_UPDATE).allowed, false);
    });

    await check('install scopes are exported and are not capabilities', async () => {
        assert.deepStrictEqual(ALL_SCOPES, [SCOPES.LOOKUP, SCOPES.REPORT]);
        assert.deepStrictEqual(ALL_SCOPES, ['coupons.lookup', 'coupons.report']);
        for (const s of ALL_SCOPES) assert.strictEqual(contracts.capabilities.get(s), undefined, `${s} is an install scope, not a capability`);
    });

    done();
})();
