'use strict';
/**
 * Plan T9 (J5) — Coupons on the openvibe-publishing 1.1.0 chassis.
 *
 *   - the local copies the brief deletes are unrequired: nothing under server/ requires ./hosts, ./psl
 *     or ./events/outbox any more (the files themselves cannot be removed in this harness);
 *   - a dry-run ingest from the captured Sources fixture (test/fixtures/sources-coupons.json, captured
 *     from the pre-chassis importer before the change) reproduces the same domain rows;
 *   - the Search document is a valid search.index-document@1;
 *   - the outbox row and the state change share the caller's transaction (a rollback leaves neither);
 *   - a cursor already in the old import_state key is copied once into the chassis cursor.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const ROOT = path.join(__dirname, '..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sources-coupons.json'), 'utf8'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The domain rows, projected the same way the golden was captured (ids and ULIDs excluded). */
async function rowsOf(t) {
    const merchants = await t.ctx.store.db.prepare('SELECT id, slug, name, status FROM coupon_merchants ORDER BY slug').all();
    const slugOf = new Map(merchants.map((m) => [m.id, m.slug]));
    const coupons = await t.ctx.store.db.prepare('SELECT * FROM coupons ORDER BY code').all();
    const out = { merchants: merchants.map((m) => ({ slug: m.slug, name: m.name, status: m.status })), coupons: [] };
    for (const c of coupons) {
        const evidence = await t.ctx.store.db.prepare('SELECT kind, evidence_url, merchant_evidence, sources_item_id, sources_item_rev, source_key, retrieved_at, removed_at, removed_reason FROM coupon_sources WHERE coupon_id = ? ORDER BY id').all(c.id);
        const restrictions = await t.ctx.store.db.prepare('SELECT kind, value, amount_minor, currency FROM coupon_restrictions WHERE coupon_id = ? ORDER BY id').all(c.id);
        out.coupons.push({
            merchant: slugOf.get(c.merchant_id), code: c.code, code_key: c.code_key, title: c.title, description: c.description,
            status: c.status, status_reason: c.status_reason, confidence: c.confidence, review_state: c.review_state, origin: c.origin,
            expires_at: c.expires_at, expires_precision: c.expires_precision, expiry_basis: c.expiry_basis, expired_at: c.expired_at,
            disabled_at: c.disabled_at, created_by: c.created_by, created_at: c.created_at, updated_at: c.updated_at, evidence, restrictions,
        });
    }
    return out;
}

(async () => {
    await check('the local chassis copies are unrequired; the chassis provides hosts and publication', async () => {
        const files = [];
        (function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } })(path.join(ROOT, 'server'));
        const dead = new Set([path.join(ROOT, 'server/domain/hosts.js'), path.join(ROOT, 'server/domain/psl.js')]);
        const needles = ["'./hosts'", "'../domain/hosts'", "'./psl'", "'./events/outbox'", "'../events/outbox'"];
        const hits = [];
        for (const f of files) {
            if (dead.has(f)) continue;
            const src = fs.readFileSync(f, 'utf8');
            if (needles.some((n) => src.includes(n))) hits.push(path.relative(ROOT, f));
        }
        assert.deepStrictEqual(hits, [], `still required by: ${hits.join(', ')}`);
        assert.strictEqual(typeof require('openvibe-publishing/ingest').hosts.normalizeHost, 'function');
        assert.strictEqual(typeof require('openvibe-publishing/publication').createPublication, 'function');
    });

    await check('a dry-run ingest from the captured fixture reproduces the pre-chassis domain rows', async () => {
        const t = await boot();
        try {
            await t.merchant({ name: 'River Books', host: 'riverbooks.com' });
            for (const item of FIXTURE.items) t.sources.put({ ...item });
            const r = await t.ctx.importer.run();
            assert.deepStrictEqual(r.outcomes, FIXTURE.golden.outcomes);
            assert.deepStrictEqual(await rowsOf(t), { merchants: FIXTURE.golden.merchants, coupons: FIXTURE.golden.coupons });
            const row = await t.ctx.store.db.prepare("SELECT cursor FROM coupons_ingest_cursor WHERE name = 'sources'").get();
            assert.ok(row && row.cursor >= 1, 'the chassis cursor advanced');
        } finally { await t.close(); }
    });

    await check('the Search document is a valid search.index-document@1 (coupon and merchant)', async () => {
        const t = await boot();
        try {
            const shop = await t.merchant({ name: 'Doc Shop', host: 'docshop.com' });
            const alice = t.network.addUser('alice');
            const r = await t.submit(alice, { merchant_id: shop.id, code: 'DOC10', title: 'Ten off' });
            assert.strictEqual(r.status, 201, r.text.slice(0, 300));
            const upserts = await t.events('coupons.index_document.upserted');
            const types = new Set();
            for (const env of upserts) {
                const v = contracts.validate('search.index-document@1', env.payload);
                assert.ok(v.valid, `${env.event_type}: ${JSON.stringify(v.errors)}`);
                assert.strictEqual(env.payload.owner, 'coupons');
                types.add(env.payload.type);
            }
            assert.ok(types.has('coupon') && types.has('merchant'), `indexed types: ${[...types]}`);
        } finally { await t.close(); }
    });

    await check('the outbox row and the index revision share the change\'s transaction (a rollback leaves neither)', async () => {
        const t = await boot();
        try {
            const shop = await t.merchant({ name: 'Tx Shop', host: 'txshop.com' });
            const alice = t.network.addUser('alice');
            await t.submit(alice, { merchant_id: shop.id, code: 'TX10', title: 'Ten off' });
            const coupon = await t.ctx.store.db.prepare("SELECT * FROM coupons WHERE code = 'TX10'").get();
            const merchant = await t.ctx.store.db.prepare('SELECT * FROM coupon_merchants WHERE id = ?').get(shop.id);
            const outboxBefore = (await t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM event_outbox').get()).n;
            const revBefore = (await t.ctx.store.db.prepare("SELECT revision FROM coupons_index_revisions WHERE owner = 'coupons' AND type = 'coupon' AND id = ?").get(coupon.id)).revision;
            const doc = { ...t.ctx.publication.couponDocument(coupon, merchant), title: 'changed for the rollback test' };
            await assert.rejects(t.ctx.store.tx(async () => {
                await t.ctx.publication.sendDocument(doc, { page: t.ctx.publication.couponPath(coupon) });
                throw new Error('change failed');
            }), /change failed/);
            assert.strictEqual((await t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM event_outbox').get()).n, outboxBefore, 'no outbox row survives the rollback');
            assert.strictEqual((await t.ctx.store.db.prepare("SELECT revision FROM coupons_index_revisions WHERE owner = 'coupons' AND type = 'coupon' AND id = ?").get(coupon.id)).revision, revBefore, 'no index revision survives the rollback');
        } finally { await t.close(); }
    });

    await check('a cursor already stored under the old key is copied once into the chassis cursor (migration 0002)', async () => {
        const t = await boot();
        try {
            await t.ctx.store.db.prepare("INSERT INTO import_state (key, cursor, last_run_at) VALUES ('sources:coupons', 42, 7) ON CONFLICT (key) DO UPDATE SET cursor = 42").run();
            const sql = read('migrations/0002_ingest_cursor.sql');
            assert.match(sql, /CREATE TABLE IF NOT EXISTS coupons_ingest_cursor/);
            // The runtime role may not create schema objects, so run only the copy statement (the DDL
            // already ran with the migrations); this is the continuity read, exactly as written.
            const copy = sql.slice(sql.indexOf('INSERT INTO coupons_ingest_cursor')).split(';')[0];
            await t.ctx.store.db.query(copy);
            const row = await t.ctx.store.db.prepare("SELECT cursor FROM coupons_ingest_cursor WHERE name = 'sources'").get();
            assert.strictEqual(row.cursor, 42);
        } finally { await t.close(); }
    });

    done();
})();
