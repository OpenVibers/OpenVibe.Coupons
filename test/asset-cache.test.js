'use strict';
/**
 * Static asset caching (openvibe-shared/cache-policy, wired in server/app.js): only a ?v= that is
 * exactly the asset's own assetVersion() is content-addressed and therefore immutable for a year.
 * A wrong hash, and no hash at all, get the short window with a long stale-while-revalidate.
 */
const assert = require('assert');
const cache = require('openvibe-shared/cache-policy');
const { assetVersion } = require('../server/render/layout');
const { boot, check, done } = require('./helpers/boot');

const ASSET = 'css/coupons.css';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, max-age=300, stale-while-revalidate=86400';

(async () => {
    await check('the module: hashed → immutable, otherwise a 5 min window with a day of stale-while-revalidate', async () => {
        assert.strictEqual(cache.IMMUTABLE, IMMUTABLE);
        assert.strictEqual(cache.assetHeaders(ASSET, { hashed: true }), IMMUTABLE);
        assert.strictEqual(cache.assetHeaders(ASSET, { hashed: false }), REVALIDATE);
        assert.strictEqual(cache.htmlHeaders({ maxAge: 300 }), `public, max-age=300, stale-while-revalidate=3600`);
        assert.strictEqual(cache.htmlHeaders({ private: true }), 'private, no-store');
    });

    await check('served assets: the current ?v= is immutable, a wrong hash and no hash are not', async () => {
        const t = await boot();
        try {
            const v = assetVersion(ASSET);
            assert.ok(/^[0-9a-f]{8,64}$/.test(v), `assetVersion looks like a hash: ${v}`);

            const current = await t.get(`/${ASSET}?v=${v}`);
            assert.strictEqual(current.status, 200, current.text.slice(0, 200));
            assert.strictEqual(current.headers.get('cache-control'), IMMUTABLE);

            const wrong = await t.get(`/${ASSET}?v=deadbeefdeadbeef`);
            assert.strictEqual(wrong.status, 200, wrong.text.slice(0, 200));
            assert.strictEqual(wrong.headers.get('cache-control'), REVALIDATE);

            const bare = await t.get(`/${ASSET}`);
            assert.strictEqual(bare.status, 200, bare.text.slice(0, 200));
            assert.strictEqual(bare.headers.get('cache-control'), REVALIDATE);
        } finally { await t.close(); }
    });

    done();
})();
