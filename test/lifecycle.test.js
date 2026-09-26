'use strict';
/**
 * A code's life: submitted as unknown (expiry and validity unknown stay unknown, everywhere),
 * nothing but people's reports can make it "working", a known expiry takes it out of active
 * results at that instant (API, pages, feeds, sitemaps, Search), staff and services can only
 * disable / expire / re-enable, and every change is in the history, the events and Search.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const shop = await t.merchant({ name: 'Acme Outdoor', host: 'acme-outdoor.com' });

    let unknownCode;
    await check('a submission with no expiry and no restrictions: status unknown, confidence null, expiry unknown — in the API, the page and the JSON', async () => {
        const r = await t.submit(alice, { host: 'www.acme-outdoor.com', code: 'TRAIL15', title: '15% off tents' });
        assert.strictEqual(r.status, 201, r.text);
        const c = r.json().coupon;
        unknownCode = c;
        assert.strictEqual(c.status, 'unknown');
        assert.strictEqual(c.confidence, null);
        assert.deepStrictEqual(c.expiry, { known: false, expires_at: null, precision: null, basis: null });
        assert.deepStrictEqual(c.restrictions, []);
        assert.strictEqual(c.active, true);
        const page = await t.get(`/m/${shop.slug}`);
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /TRAIL15/);
        assert.match(page.text, /Validity unknown/);
        assert.match(page.text, /Expiry unknown/);
        assert.match(page.text, /No restrictions stated. That does not mean there are none./);
        assert.match(page.text, /No reports in the last 30 days/);
        assert.doesNotMatch(page.text, /Expires /);
        const j = (await t.get(`/c/${c.id}.json`)).json();
        assert.strictEqual(j.coupon.expiry.expires_at, null);
        assert.strictEqual(j.coupon.confidence, null);
        const jsonld = page.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g).join('\n');
        assert.doesNotMatch(jsonld, /validThrough|priceValidUntil|aggregateRating|ratingValue|"Offer"/, 'no fabricated offer or validity in structured data');
    });

    await check('the unknown code stays unknown across time and sweeps while nobody reports', async () => {
        t.clock.advance(40 * DAY);
        t.ctx.worker.sweep();
        const c = (await t.get(`/api/v1/coupons/${unknownCode.id}`)).json().coupon;
        assert.strictEqual(c.status, 'unknown');
        assert.strictEqual(c.confidence, null);
        assert.strictEqual(c.expiry.known, false);
        assert.strictEqual(c.active, true, 'unknown expiry never expires by itself');
    });

    await check('nobody can submit a status, a confidence or "verified": people, services and AI output alike', async () => {
        for (const extra of [{ status: 'reported_working' }, { confidence: 0.99 }, { verified: true }, { working: true }]) {
            const r = await t.submit(alice, { host: 'acme-outdoor.com', code: 'X1', title: 'Some code', ...extra });
            assert.strictEqual(r.status, 422, JSON.stringify(extra));
            assert.strictEqual(r.json().code, 'coupon.status_not_accepted');
        }
        const ai = t.network.serviceToken('ai', ['coupons.coupon.submit']);
        const r = await t.get('/api/v1/coupons/submit', { as: ai, headers: { 'x-ov-origin': 'ai' }, json: { host: 'acme-outdoor.com', code: 'AIGUESS', title: 'Model guess', status: 'reported_working' } });
        assert.strictEqual(r.status, 422);
    });

    let aiCode;
    await check('AI-extracted codes are drafts for staff review, start unknown, and a model cannot report', async () => {
        const ai = t.network.serviceToken('ai', ['coupons.coupon.submit', 'coupons.report.create']);
        const r = await t.get('/api/v1/coupons/submit', { as: ai, headers: { 'x-ov-origin': 'ai' }, json: { host: 'acme-outdoor.com', code: 'AIFOUND', title: '10% off boots', evidence_url: 'https://acme-outdoor.com/promos', ai_run_id: 'run_123' } });
        assert.strictEqual(r.status, 201, r.text);
        aiCode = r.json().coupon;
        assert.strictEqual(r.json().review_state, 'pending');
        assert.strictEqual(aiCode.status, 'unknown');
        assert.strictEqual(aiCode.active, false);
        assert.strictEqual((await t.get(`/c/${aiCode.id}`)).status, 404, 'not public before review');
        assert.doesNotMatch((await t.get(`/m/${shop.slug}`)).text, /AIFOUND/);
        const rep = await t.get(`/api/v1/coupons/${unknownCode.id}/report`, { as: ai, headers: { 'x-ov-origin': 'ai', 'x-ov-subject': alice.subject }, json: { outcome: 'worked' } });
        assert.strictEqual(rep.status, 403);
        assert.strictEqual(rep.json().code, 'report.ai_refused');
        // Staff review publishes it — still unknown until people report.
        const approve = await t.get(`/staff/coupons/${aiCode.id}/approve`, { as: t.staff, form: { csrf: t.csrf(t.staff) } });
        assert.strictEqual(approve.status, 200, approve.text.slice(0, 200));
        const after = (await t.get(`/api/v1/coupons/${aiCode.id}`)).json().coupon;
        assert.strictEqual(after.status, 'unknown');
        assert.strictEqual(after.active, true);
        assert.match((await t.get(`/c/${aiCode.id}`)).text, /Extracted by an AI workflow/);
    });

    await check('only people\'s reports make a code "reported working"', async () => {
        const r = await t.get(`/api/v1/coupons/${unknownCode.id}/report`, { as: t.network.userToken(bob), json: { outcome: 'worked' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json().coupon.status, 'reported_working');
        assert.strictEqual(r.json().coupon.confidence, 0.67);
    });

    await check('staff and services can disable, expire or re-enable — never set working/failed', async () => {
        const svc = t.network.serviceToken('moderation', ['coupons.status.update']);
        for (const s of ['reported_working', 'reported_failed', 'unknown']) {
            const r = await t.get(`/api/v1/coupons/${unknownCode.id}/status`, { as: svc, json: { status: s } });
            assert.strictEqual(r.status, 422, s);
            assert.strictEqual(r.json().code, 'coupon.status_not_settable');
        }
        const noCap = await t.get(`/api/v1/coupons/${unknownCode.id}/status`, { as: t.network.serviceToken('other', []), json: { status: 'disabled' } });
        assert.strictEqual(noCap.status, 403);
        const member = await t.get(`/api/v1/coupons/${unknownCode.id}/status`, { as: t.network.userToken(alice), json: { status: 'disabled' } });
        assert.strictEqual(member.status, 403);
        const off = await t.get(`/api/v1/coupons/${unknownCode.id}/status`, { as: svc, json: { status: 'disabled', note: 'merchant asked' } });
        assert.strictEqual(off.status, 200, off.text);
        assert.strictEqual(off.json().coupon.status, 'disabled');
        assert.strictEqual((await t.get(`/c/${unknownCode.id}`)).status, 410);
        assert.strictEqual((await t.get(`/api/v1/coupons/${unknownCode.id}`)).status, 404);
        const on = await t.get(`/api/v1/coupons/${unknownCode.id}/status`, { as: svc, json: { status: 'active' } });
        assert.strictEqual(on.json().coupon.status, 'reported_working', 're-enabled: recomputed from the reports, not set');
    });

    let dated;
    const expiresAt = Date.parse('2026-11-05T09:30:00Z');
    await check('a code with a known expiry leaves every active result at that instant, before any sweep', async () => {
        t.clock.set(Date.parse('2026-11-01T00:00:00Z'));
        const r = await t.submit(alice, { host: 'acme-outdoor.com', code: 'FALL20', title: '20% off jackets', expires: '2026-11-05T09:30:00Z', evidence_url: 'https://acme-outdoor.com/fall', expiry_basis: 'evidence',
            restrictions: { min_spend: { amount: '50', currency: 'USD' }, new_customers_only: true, regions: 'US, CA', categories: ['Jackets'] } });
        assert.strictEqual(r.status, 201, r.text);
        dated = r.json().coupon;
        assert.deepStrictEqual(dated.expiry, { known: true, expires_at: '2026-11-05T09:30:00.000Z', precision: 'instant', basis: 'evidence' });
        assert.strictEqual(dated.evidence[0].merchant_page, true);
        assert.deepStrictEqual(dated.restrictions.map((x) => x.kind).sort(), ['category', 'min_spend', 'new_customers_only', 'region', 'region']);
        const page = await t.get(`/m/${shop.slug}`);
        assert.match(page.text, /Minimum spend \$50\.00/);
        assert.match(page.text, /New customers only/);
        assert.match(page.text, /Canada \(CA\)/);
        assert.match(page.text, /as stated on the evidence page/);

        const listed = async () => {
            const api = (await t.get(`/api/v1/merchants/${shop.id}/coupons`)).json().coupons.map((c) => c.code);
            const html = (await t.get(`/m/${shop.slug}`)).text;
            const feed = (await t.get('/feed.xml')).text;
            const map = (await t.get('/sitemaps/coupons.xml')).text;
            return { api: api.includes('FALL20'), page: /id="cpn_[^"]+"[\s\S]*?FALL20/.test(html.split('Recently ended')[0]), feed: feed.includes('FALL20'), sitemap: map.includes(dated.id) };
        };
        t.clock.set(expiresAt - 1);
        assert.deepStrictEqual(await listed(), { api: true, page: true, feed: true, sitemap: true });
        t.clock.set(expiresAt);
        assert.deepStrictEqual(await listed(), { api: false, page: false, feed: false, sitemap: false });
        const cpage = await t.get(`/c/${dated.id}`);
        assert.strictEqual(cpage.status, 200, 'still readable');
        assert.match(cpage.text, /<meta name="robots" content="noindex, follow">/);
        assert.match(cpage.headers.get('x-robots-tag'), /noindex/);
        assert.match((await t.get(`/m/${shop.slug}`)).text, /Recently ended[\s\S]*FALL20/);
        const rep = await t.get(`/api/v1/coupons/${dated.id}/report`, { as: t.network.userToken(bob), json: { outcome: 'worked' } });
        assert.strictEqual(rep.status, 409, 'no reports on a code out of active results');
    });

    await check('the sweep records the expiry: status, history, coupons.coupon.expired, Search tombstone — once', async () => {
        const before = t.events().length;
        const r = t.ctx.worker.sweep();
        assert.deepStrictEqual(r.expired, [dated.id]);
        const row = t.ctx.coupons.get(dated.id);
        assert.strictEqual(row.status, 'expired');
        assert.strictEqual(row.expired_at, expiresAt, 'expired at the stated instant, not at sweep time');
        const hist = t.ctx.coupons.history(dated.id);
        assert.strictEqual(hist[0].to_status, 'expired');
        assert.strictEqual(hist[0].reason, 'expiry');
        const evs = t.events().slice(before);
        const mine = evs.filter((e) => e.subject.id === dated.id).map((e) => e.event_type).sort();
        assert.deepStrictEqual(mine, ['coupons.coupon.expired', 'coupons.index_document.deleted']);
        assert.ok(evs.some((e) => e.event_type === 'coupons.index_document.upserted' && e.subject.id === shop.id), 'the shop document is re-sent with one active code fewer');
        assert.deepStrictEqual(t.ctx.worker.sweep().expired, [], 'idempotent');
        assert.strictEqual(t.events().length, before + evs.length);
    });

    await check('a date-only expiry means the end of that day in UTC, and the page says the time zone is not stated', async () => {
        const r = await t.submit(alice, { host: 'acme-outdoor.com', code: 'DATEONLY', title: 'Five off socks', expires: '2026-11-10' });
        assert.strictEqual(r.json().coupon.expiry.expires_at, '2026-11-10T23:59:59.999Z');
        assert.strictEqual(r.json().coupon.expiry.basis, 'submitter');
        assert.match((await t.get(`/c/${r.json().coupon.id}`)).text, /end of that day in UTC; the merchant's time zone is not stated/);
        assert.strictEqual((await t.submit(alice, { host: 'acme-outdoor.com', code: 'AMBIG', title: 'Ambiguous time', expires: '2026-11-10T10:00' })).json().code, 'coupon.ambiguous_expiry');
        assert.strictEqual((await t.submit(alice, { host: 'acme-outdoor.com', code: 'PAST', title: 'Already over', expires: '2026-01-01' })).json().code, 'coupon.already_expired');
    });

    await check('a shop with no active codes is served but noindex (thin), and leaves the merchant sitemap', async () => {
        const empty = await t.merchant({ name: 'Quiet Shop', host: 'quiet-shop.com' });
        const page = await t.get(`/m/${empty.slug}`);
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /No active codes for Quiet Shop right now/);
        assert.match(page.text, /<meta name="robots" content="noindex, follow">/);
        assert.doesNotMatch((await t.get('/sitemaps/merchants.xml')).text, /quiet-shop/);
        assert.match((await t.get('/sitemaps/merchants.xml')).text, new RegExp(`/m/${shop.slug}<`));
    });

    await check('members\' codes for a shop nobody lists wait for staff; approving the shop publishes them', async () => {
        const r = await t.submit(bob, { url: 'https://www.new-gadgets.net/cart', code: 'GADGET5', title: 'Five off gadgets' });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json().merchant.status, 'pending');
        assert.strictEqual(r.json().review_state, 'pending');
        assert.strictEqual((await t.get('/api/v1/merchants/resolve?host=new-gadgets.net')).status, 404, 'pending shops do not resolve');
        assert.strictEqual((await t.get(`/m/${r.json().merchant.slug}`)).status, 404);
        const staffPage = await t.get('/staff', { as: t.staff });
        assert.match(staffPage.text, /new-gadgets\.net/);
        const ok = await t.get(`/staff/merchants/${r.json().merchant.id}/status`, { as: t.staff, form: { csrf: t.csrf(t.staff), status: 'active' } });
        assert.strictEqual(ok.status, 200);
        const list = (await t.get(`/api/v1/merchants/${r.json().merchant.id}/coupons`)).json().coupons;
        assert.deepStrictEqual(list.map((c) => [c.code, c.status]), [['GADGET5', 'unknown']]);
        assert.strictEqual((await t.get('/api/v1/merchants/resolve?host=shop.new-gadgets.net')).status, 200);
    });

    await check('duplicates add evidence to the same code; a taken-down code cannot be resubmitted', async () => {
        const a = await t.submit(bob, { host: 'acme-outdoor.com', code: 'trail15', title: 'Same code, other case', evidence_url: 'https://forum.example-deals.org/t/1' });
        assert.strictEqual(a.status, 200);
        assert.strictEqual(a.json().duplicate, true);
        assert.strictEqual(a.json().coupon.id, unknownCode.id);
        assert.ok(a.json().coupon.evidence.some((e) => e.url === 'https://forum.example-deals.org/t/1'));
        await t.get(`/api/v1/coupons/${unknownCode.id}/status`, { as: t.staffToken(), json: { status: 'disabled' } });
        assert.strictEqual((await t.submit(bob, { host: 'acme-outdoor.com', code: 'TRAIL15', title: 'Again' })).json().code, 'coupon.disabled');
    });

    await check('every event is a valid envelope from the service, and none names a person', async () => {
        const all = t.events();
        assert.ok(all.length > 10);
        for (const e of all) {
            const v = contracts.validate('events.event-envelope@1', e);
            assert.ok(v.valid, `${e.event_type}: ${JSON.stringify(v.errors)}`);
            if (e.event_type === 'coupons.moderation.action') {
                // The audit log names the staff member who acted, and nobody else (never a submitter).
                assert.ok(contracts.validate('coupons.moderation.action@1', e.payload).valid);
                assert.strictEqual(e.payload.target.owner_subject, null);
                assert.ok(e.payload.actor_subject === null || e.payload.actor_subject === t.staff.subject);
                assert.doesNotMatch(JSON.stringify(e).split(t.staff.subject).join(''), /usr_[0-9A-Z]{26}/, `${e.event_type} names someone other than staff`);
                continue;
            }
            assert.deepStrictEqual(e.actor, { type: 'service', id: 'coupons' });
            assert.doesNotMatch(JSON.stringify(e), /usr_[0-9A-Z]{26}/, `${e.event_type} names a person`);
            if (e.event_type === 'coupons.index_document.upserted') {
                const d = contracts.validate('search.index-document@1', e.payload);
                assert.ok(d.valid, JSON.stringify(d.errors));
            }
        }
        const types = new Set(all.map((e) => e.event_type));
        for (const want of ['coupons.coupon.created', 'coupons.coupon.updated', 'coupons.coupon.expired', 'coupons.coupon.disabled', 'coupons.report.created', 'coupons.confidence.changed']) assert.ok(types.has(want), want);
    });

    await t.close();
    done();
})();
