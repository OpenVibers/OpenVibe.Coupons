'use strict';
/**
 * Sharing a watched-shops list (design 2026-11-06, visibility step 6): the one Share sheet (openvibe-sdk/share)
 * and the one check, canView, on the list's page.
 *
 *   - the list is Only me; opening /watching makes its share row at the person's default and shows the Share button;
 *   - Anyone with the link reads the list, and the owner's own page stays private;
 *   - Specific people shows the gate, never a shop's name, to somebody not on the list;
 *   - the default moves the existing list;
 *   - a list is never on a gathered page: not the sitemap, not llms.txt.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const sharing = require('../server/sharing');
const pages = require('../server/render/pages');
const { createPublicRoutes } = require('../server/http/public');

(async () => {
    const t = await boot();
    try {
        await check('the sharing wiring loads: lists are never Everyone', async () => {
            assert.strictEqual(sharing.SERVICE, 'coupons');
            assert.strictEqual(sharing.KIND, 'watchlist');
            assert.deepStrictEqual(sharing.OFFERED, ['private', 'link', 'people']);
            assert.strictEqual(sharing.shareViewer({ kind: 'anonymous' }), null);
            assert.deepStrictEqual(sharing.shareViewer({ kind: 'user', subject: 'usr_x', staff: true }), { subject: { type: 'user', id: 'usr_x' }, staff: false });
            assert.strictEqual(typeof createPublicRoutes, 'function');
            assert.strictEqual(typeof pages.watchingGate, 'function');
        });
        const kim = t.network.addUser('kim');
        const bo = t.network.addUser('bo');
        const acme = await t.merchant({ name: 'Acme Outdoors', host: 'acme-outdoors.com' });

        const call = (p, o = {}) => {
            const { headers, ...rest } = o;
            return t.get(p, { ...rest, headers: { 'x-requested-with': 'ov-share', ...(headers || {}) } });
        };
        const share = (id, o = {}) => call(`/api/v1/watchlist/${encodeURIComponent(id)}/share`, o);
        const setShare = async (id, body, as) => {
            const first = await share(id, { as });
            assert.strictEqual(first.status, 200, first.text);
            const etag = first.headers.get('etag');
            assert.ok(etag);
            return await share(id, { as, method: 'PUT', json: body, headers: { 'if-match': etag } });
        };
        const audienceRow = async (id) => await t.ctx.store.db.maybe(
            'SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', ['coupons', 'watchlist', id]);

        await check('the list is Only me; opening /watching makes its share row and shows the Share button', async () => {
            const watched = await t.get(`/m/${acme.slug}/watch`, { as: kim, form: { csrf: t.csrf(kim), action: 'watch' } });
            assert.strictEqual(watched.status, 303, watched.text);
            assert.strictEqual(await audienceRow(kim.subject), null, 'no row before the owner opens the list');
            const mine = await t.get('/watching', { as: kim });
            assert.strictEqual(mine.status, 200, mine.text);
            assert.deepStrictEqual(await audienceRow(kim.subject), { audience: 'private' });
            assert.ok(mine.text.includes('data-ov-share-sheet') && mine.text.includes('data-kind="watchlist"'));
            assert.ok(mine.text.includes('ov-share.js'));
            assert.ok(mine.text.includes('Acme Outdoors'));
            const other = await t.get(`/watching/${kim.subject}`, { as: bo });
            assert.strictEqual(other.status, 404);
            assert.ok(!other.text.includes('Acme Outdoors'), 'the list is never shown to somebody else');
            assert.strictEqual((await t.get(`/watching/${kim.subject}`)).status, 404);
        });

        await check('Anyone with the link reads the list', async () => {
            const saved = await setShare(kim.subject, { audience: 'link' }, kim);
            assert.strictEqual(saved.status, 200, saved.text);
            const guest = await t.get(`/watching/${kim.subject}`);
            assert.strictEqual(guest.status, 200, guest.text);
            assert.ok(guest.text.includes('Acme Outdoors'));
            assert.ok(guest.text.includes('Anyone with the link'));
            assert.ok(!guest.text.includes('data-ov-share-sheet'), 'a reader gets no Share sheet');
            assert.ok(!guest.text.includes('action="/watching/defaults"'), 'a reader changes nothing');
        });

        await check('Specific people: a viewer reads, a stranger gets the gate', async () => {
            const saved = await setShare(kim.subject, { audience: 'people', members: [{ name: 'bo', role: 'viewer' }] }, kim);
            assert.strictEqual(saved.status, 200, saved.text);
            const viewer = await t.get(`/watching/${kim.subject}`, { as: bo });
            assert.strictEqual(viewer.status, 200, viewer.text);
            assert.ok(viewer.text.includes('Specific people'));
            const stranger = t.network.addUser('di');
            const gate = await t.get(`/watching/${kim.subject}`, { as: stranger });
            assert.strictEqual(gate.status, 404);
            assert.ok(gate.text.includes('shared with specific people'));
            assert.ok(!gate.text.includes('Acme Outdoors'), 'the gate never shows a shop');
            assert.ok(gate.text.includes('data-ov-share-gate'));
        });

        await check('the default moves the existing list', async () => {
            const saved = await t.get('/watching/defaults', { as: kim, form: { csrf: t.csrf(kim), audience: 'link' } });
            assert.strictEqual(saved.status, 303, saved.text);
            assert.deepStrictEqual(await audienceRow(kim.subject), { audience: 'link' });
            const own = await t.get('/watching', { as: kim });
            assert.ok(own.text.includes('Who can open your list'), 'the default is on the product page');
        });

        await check('a list is never on a gathered page: not the sitemap, not llms.txt', async () => {
            assert.ok(!(await t.get('/sitemap.xml')).text.includes(kim.subject));
            assert.ok(!(await t.get('/llms.txt')).text.includes(kim.subject));
        });

        done();
    } finally {
        await t.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
