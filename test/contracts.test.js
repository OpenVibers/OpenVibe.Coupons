'use strict';
/**
 * The proposals the lead releases in the next openvibe-contracts version are valid against the
 * released schemas, match what the code enforces and emits, and do not collide with released ids.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { check, done } = require('./helpers/boot');
const { PROPOSED, ALL_SCOPES } = require('../server/auth/capabilities');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'docs', 'capabilities-proposal');

(async () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
    const caps = files.map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'service-manifest-proposal.json'), 'utf8'));

    await check('every capability proposal is a valid capabilities.capability@1 with 3+ segments, owned by coupons', async () => {
        for (const c of caps) {
            const v = contracts.validate('capabilities.capability@1', c);
            assert.ok(v.valid, `${c.id}: ${JSON.stringify(v.errors)}`);
            assert.strictEqual(c.owner, 'coupons');
            assert.ok(c.id.split('.').length >= 3, c.id);
            assert.strictEqual(`${c.id}.json`, files[caps.indexOf(c)]);
            assert.ok(!contracts.capabilities.get(c.id) || contracts.capabilities.get(c.id).owner === 'coupons', `${c.id} collides with a released capability`);
        }
    });

    await check('the proposals are exactly the capabilities the code enforces; install scopes are not capabilities', async () => {
        assert.deepStrictEqual(caps.map((c) => c.id).sort(), [...PROPOSED].sort());
        assert.deepStrictEqual([...manifest.capabilities].sort(), [...PROPOSED].sort());
        for (const s of ALL_SCOPES) assert.ok(!PROPOSED.has(s), `${s} is an install scope, not a capability`);
    });

    await check('the service manifest proposal is a valid registry.service-manifest@1 and declares every event capabilities name', async () => {
        const v = contracts.validate('registry.service-manifest@1', manifest);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(manifest.id, 'coupons');
        for (const c of caps) for (const e of c.events) assert.ok(manifest.eventsProduced.includes(e), `${c.id} names ${e}, missing from eventsProduced`);
    });

    await check('every event type the code emits is declared, and every declared one is emitted somewhere', async () => {
        const src = ['server/domain/coupons.js', 'server/domain/reports.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
        const emitted = new Set([...src.matchAll(/'(coupons\.[a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]).filter((x) => !PROPOSED.has(x)));
        emitted.add('coupons.index_document.upserted');
        emitted.add('coupons.index_document.deleted');
        for (const e of emitted) assert.ok(manifest.eventsProduced.includes(e), `${e} emitted but not declared`);
        for (const e of manifest.eventsProduced) assert.ok(emitted.has(e), `${e} declared but never emitted`);
    });

    await check('the port and service id match the platform table (4850, coupons)', async () => {
        assert.strictEqual(require('../server/config').load({}).port, 4850);
        assert.match(manifest.notes, /Port 4850/);
    });

    done();
})();
