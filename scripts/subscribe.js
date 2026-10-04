#!/usr/bin/env node
'use strict';
/**
 * Coupons' OpenVibe.Events side: create the Sources subscriptions the import loop wakes on, or
 * reconcile the OpenVibe.Search index in one bounded pass.
 *
 *   node scripts/subscribe.js [--endpoint http://127.0.0.1:4850/internal/events]
 *   node scripts/subscribe.js --reconcile [--page-size 200] [--max-pages 200]
 *
 * Subscribe reads the environment (.env; the service itself gets /etc/openvibe/coupons.env from systemd):
 *   EVENTS_URL, OV_NETWORK_INTERNAL_URL, OV_OAUTH_CLIENT_ID, OV_OAUTH_CLIENT_SECRET  (the coupons
 *   principal needs events.subscription.manage for audience openvibe.events)
 *   COUPONS_EVENTS_SECRET  the delivery signing secret; the first value is handed to Events, so
 *                          generate it before running this (e.g. `openssl rand -hex 32`). Nothing
 *                          secret is printed.
 * Patterns: sources.item.* and sources.fetch.failed. Only sources.item.created runs the import; the
 * rest are acknowledged and the cursor pull catches up either way. An existing identical subscription is reported
 * ("exists"), never duplicated.
 *
 * --reconcile pages coupon_merchants and coupons, every status of both (a shop or code that left active
 * results must reach Search as unpublished or as a tombstone), re-stamping each Search document through
 * ctx.publication.sendDocument — an unchanged document costs nothing. The rows land in event_outbox;
 * when the relay is configured the CLI publishes them once before exiting, otherwise the running
 * service relays them. It is idempotent and bounded by --page-size/--max-pages; the report is
 * { sent, unchanged }.
 */
require('dotenv').config();
const { serviceAuth } = require('openvibe-contracts');
const { load } = require('../server/config');

const PATTERNS = ['sources.item.*', 'sources.fetch.failed'];
const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES = 200;

/** The endpoint Events delivers to: this service's own inbound webhook. */
const defaultEndpoint = (config) => `http://127.0.0.1:${config.port}/internal/events`;

function parseArgs(argv) {
    const o = { reconcile: false, endpoint: null, pageSize: DEFAULT_PAGE_SIZE, maxPages: DEFAULT_MAX_PAGES };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--reconcile') o.reconcile = true;
        else if (a === '--endpoint') o.endpoint = argv[++i];
        else if (a === '--page-size') o.pageSize = Number(argv[++i]);
        else if (a === '--max-pages') o.maxPages = Number(argv[++i]);
        else throw new Error(`unknown argument ${a}`);
    }
    if (o.endpoint !== null && !o.endpoint) throw new Error('--endpoint needs a value');
    if (!Number.isInteger(o.pageSize) || o.pageSize < 1) throw new Error('--page-size must be a positive integer');
    if (!Number.isInteger(o.maxPages) || o.maxPages < 1) throw new Error('--max-pages must be a positive integer');
    return o;
}

/**
 * Create one subscription per pattern, as the coupons principal. The caller's delivery secret is
 * handed to Events here; `fetchImpl` is injectable so the test can stub Network and Events.
 */
async function subscribe({ config, endpoint = defaultEndpoint(config), fetchImpl = globalThis.fetch, log = console.log } = {}) {
    if (!config.events.url) throw new Error('EVENTS_URL is not set');
    const secret = (config.events.webhookSecrets || [])[0];
    if (!secret || secret.length < 32) throw new Error('COUPONS_EVENTS_SECRET must be set (32+ characters) before subscribing');
    if (!config.oauth.clientSecret) throw new Error('OV_OAUTH_CLIENT_SECRET is not set');
    const tokens = serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.events', scope: 'events.subscription.manage', fetchImpl,
    });
    const out = [];
    for (const pattern of PATTERNS) {
        const res = await fetchImpl(`${config.events.url}/api/v1/subscriptions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(await tokens.authHeaders()) },
            body: JSON.stringify({ topic_pattern: pattern, endpoint, secret }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && body.subscription_id) {
            log(`subscription exists: ${body.subscription_id} (${pattern} → ${endpoint})`);
            out.push({ pattern, subscription_id: body.subscription_id, existed: true });
            continue;
        }
        if (!res.ok) throw new Error(`Events answered ${res.status} for ${pattern}: ${body.code || ''} ${body.detail || ''}`.trim());
        log(`subscribed: ${body.id} (${pattern} → ${endpoint}). Replay history with POST /api/v1/deliveries/replay { subscription_id, from_seq }.`);
        out.push({ pattern, subscription_id: body.id, existed: false });
    }
    return out;
}

/**
 * One bounded pass over every merchant and every code, re-stamping each Search document into the
 * outbox. → { sent, unchanged } (sendDocument returns null for an unchanged doc).
 */
async function reconcile({ ctx, pageSize = DEFAULT_PAGE_SIZE, maxPages = DEFAULT_MAX_PAGES, log = console.log } = {}) {
    if (!ctx || !ctx.merchants || !ctx.coupons || !ctx.publication) throw new Error('reconcile needs the running service context (see server/app.js createApp)');
    let sent = 0;
    let unchanged = 0;
    const account = (doc) => { if (doc) sent++; else unchanged++; };

    for (let page = 0; page < maxPages; page++) {
        const merchants = await ctx.merchants.listAll({ limit: pageSize, offset: page * pageSize });
        for (const m of merchants) {
            account(await ctx.publication.sendDocument(ctx.publication.merchantDocument(m, await ctx.coupons.activeCount(m.id)), { page: ctx.publication.merchantPath(m) }));
        }
        if (merchants.length < pageSize) break;
    }
    for (let page = 0; page < maxPages; page++) {
        const coupons = await ctx.coupons.allPage({ limit: pageSize, offset: page * pageSize });
        for (const c of coupons) {
            const m = await ctx.merchants.byId(c.merchant_id);
            const doc = ctx.publication.couponDocument(c, m, {
                restrictionsText: ctx.coupons.restrictionsText(await ctx.coupons.restrictionsOf(c.id)),
                sourceRefs: await ctx.coupons.sourceRefs(c.id),
            });
            account(await ctx.publication.sendDocument(doc, { page: ctx.publication.couponPath(c) }));
        }
        if (coupons.length < pageSize) break;
    }
    log(`reconcile: ${sent} sent, ${unchanged} unchanged`);
    return { sent, unchanged };
}

/** CLI. Reconcile boots the app; subscribing needs only the config. */
async function main(argv, { fetchImpl = globalThis.fetch, log = console.log } = {}) {
    const args = parseArgs(argv);
    const config = load();
    if (!args.reconcile) return await subscribe({ config, endpoint: args.endpoint || defaultEndpoint(config), fetchImpl, log });
    const { createApp } = require('../server/app');
    const { ctx } = await createApp({ config });
    try {
        const report = await reconcile({ ctx, pageSize: args.pageSize, maxPages: args.maxPages, log });
        // The relay is not started here, so publish once; without EVENTS_URL the running service relays.
        if (ctx.outbox.enabled) await ctx.outbox.outbox.flush();
        else log('events relay off: the rows wait in event_outbox for the running service');
        return report;
    } finally {
        await ctx.outbox.stop();
        await ctx.store.close();
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).then(() => process.exit(0), (err) => {
        console.error(`subscribe failed: ${err.message}`);
        process.exit(1);
    });
}

module.exports = { subscribe, reconcile, parseArgs, PATTERNS, defaultEndpoint, DEFAULT_PAGE_SIZE, DEFAULT_MAX_PAGES };
