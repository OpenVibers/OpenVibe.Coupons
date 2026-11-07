'use strict';

/**
 * OpenVibe.Coupons — Express app factory. server/index.js listens and starts the worker; tests build
 * their own instance with a temp database, an injectable clock and mock neighbours.
 *
 *   Pages (server-rendered, http/public.js)    API (/api/v1, http/api.js; Authorization header only)
 *   Discovery (robots, llms, sitemaps, feeds)  /auth/* (Network SSO)
 *   /api/health, /api/ready, /release.json, /metrics
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');

const { createSsoClient } = require('openvibe-sdk/sso');
const { jwksClient } = require('openvibe-sdk/auth');
const { createServiceOutbox } = require('openvibe-sdk/events');
const { createIndexNow } = require('openvibe-shared/indexnow');
const cache = require('openvibe-shared/cache-policy');

const configLib = require('./config');
const { openStore } = require('./db');
const { createViewerResolver } = require('./auth/viewer');
const { createPublication } = require('./domain/publication');
const { createMerchants } = require('./domain/merchants');
const { createCoupons } = require('./domain/coupons');
const { createReports } = require('./domain/reports');
const { createInstalls } = require('./domain/installs');
const { createWatches } = require('./domain/watches');
const { createSharing } = require('./sharing');
const { createFacts } = require('./domain/facts');
const { createModeration } = require('./domain/moderation');
const { createSourcesImporter } = require('./clients/sources');
const { createApi } = require('./http/api');
const { createPublicRoutes } = require('./http/public');
const { createDiscoveryRoutes } = require('./http/discovery');
const { createCouponsReadiness } = require('./observability');
const { createActorLimits } = require('./http/actor-limits');
const { createWorker } = require('./worker');
const { assetVersion } = require('./render/layout');
const { createWebhookRouter } = require('./events/consumer');
const accountDataLib = require('./account-data');
const { createNetworkSender } = require('openvibe-sdk/account-data');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;
const { createHttpTelemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink } = require('openvibe-sdk/telemetry');

/**
 * opts: config, store, now (clock), fetchImpl, auth (an openvibe-sdk/sso client), jwks, log,
 * limitsNow (the per-actor limiter's clock, tests)
 */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    // IndexNow (openvibe-shared/indexnow): created once at boot. No INDEXNOW_KEY → off, nothing mounted,
    // nothing sent. Tests inject a spy; the pings themselves are queued and never fatal.
    const indexnow = opts.indexnow !== undefined ? opts.indexnow : createIndexNow({
        host: config.baseUrl,
        key: config.indexnowKey,
        fetch: fetchImpl,
        log: (...args) => log.warn(...args),
    });
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test, a script) hands in a store.
    const store = opts.store || await openStore(config, { now: opts.now, log });
    const accountData = opts.accountData || accountDataLib.create({ db: store.db, log });
    const accountSend = opts.accountSend || (config.oauth.clientSecret ? createNetworkSender({
        networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl,
    }) : null);

    // OpenVibe.Events through the shared openvibe-sdk transactional outbox (ADR-004, plan T1/T9): rows are
    // written inside the change's own transaction; moderationAction never names an owner_subject.
    const outbox = createServiceOutbox({
        db: store.db, source: 'coupons', eventsUrl: config.events.url, networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, intervalMs: config.events.intervalMs,
        now: store.now, fetch: fetchImpl, log, moderationOwnerSubject: false,
    });
    const publication = createPublication({ store, config, outbox, indexnow });
    const merchants = createMerchants({ store });
    const coupons = createCoupons({ store, merchants, publication, outbox });
    const reports = createReports({ store, config, coupons, merchants, publication });
    const installs = createInstalls({ store, config });
    // The one sharing system (design 2026-11-06): a person's watched shops are theirs until the Share sheet says otherwise.
    const sharing = opts.sharing || createSharing({ db: store.db, config, fetchImpl, log });
    const watches = createWatches({ store });
    // A neighbour's facts about a shop (the latest price we observed for one of its products).
    const facts = createFacts({ config, log });
    const moderation = createModeration({ store, merchants, coupons, outbox });
    const importer = createSourcesImporter({ store, config, merchants, coupons, fetchImpl, log });
    // Offline session verification and the service-token key share the SDK's process-wide JWKS client.
    const jwksUrl = `${config.networkInternalUrl}/api/.well-known/jwks`;
    const jwks = opts.jwks || jwksClient(jwksUrl, { log });
    const auth = opts.auth || createSsoClient({
        site: 'coupons',
        baseUrl: config.baseUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        redirectUri: config.oauth.redirectUri,
        scope: config.oauth.scope,
        networkUrl: config.networkUrl,
        networkInternalUrl: config.networkInternalUrl,
        issuer: config.issuer || config.networkUrl,
        secureCookies: config.cookies.secure,
        jwks: jwksUrl,
        fetch: fetchImpl,
        log,
    });
    const viewers = createViewerResolver({ auth, jwks, config, installs });
    const worker = createWorker({ config, coupons, importer, outbox, log });

    const ctx = { config, store, accountData, accountSend, outbox, publication, merchants, coupons, reports, installs, watches, sharing, moderation, importer, auth, jwks, viewers, worker, indexnow, facts };

    const app = express();
    // GET /openapi.json (SEO-3): this service's public API as OpenAPI 3.1, generated from the contracts
    // (openvibe-contracts); the operations they mark internal-only are left out.
    app.get('/openapi.json', (_req, res) => {
        const doc = require('openvibe-contracts').openapi.document('coupons');
        if (!doc) return res.status(404).type('text/plain').send('No API document.');
        const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);
        const paths = {};
        for (const [p, item] of Object.entries(doc.paths || {})) {
            const kept = {};
            for (const [k, op] of Object.entries(item || {})) {
                if (!METHODS.has(k)) { kept[k] = op; continue; }
                const vis = [].concat((op && op['x-openvibe-visibility']) || []);
                if (vis.length && vis.every((v) => v === 'internal')) continue;
                kept[k] = op;
            }
            if (Object.keys(kept).some((k) => METHODS.has(k))) paths[p] = kept;
        }
        res.set('Cache-Control', 'public, max-age=3600').set('Access-Control-Allow-Origin', '*').json({ ...doc, paths });
    });
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'coupons', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'coupons', release: release.release });
    app.locals.metrics = metrics.registry;
    // Request telemetry (openvibe-sdk/service, plan T1): one aggregated sample per route template, method and status
    // class each flush, stored in this service's telemetry_samples table; /shared, health, readiness and /metrics make
    // none. server/index.js flushes it every minute and on stop, and keeps the table to 14 days.
    ctx.telemetry = createHttpTelemetry({ service: 'coupons', sink: opts.telemetrySink || createPgTelemetrySink({ db: store.db, log }), skipPrefixes: ['/shared'], intervalMs: 60_000 });
    app.use(ctx.telemetry.middleware());
    app.locals.ctx = ctx;
    // Per-actor limits (http/actor-limits.js) for the API and the page forms, counted once each router
    // resolved req.viewer; the lookup, per-address and per-person limits stay.
    // Valkey (ADR-035): shared, never-authoritative state (per-actor limit counters). Optional.
    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;
    ctx.actorLimits = createActorLimits({ config, now: opts.limitsNow || (() => Date.now()), registry: metrics.registry, log, valkey });

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // The OpenVibe Frame (theme-loader, navbar, footer) comes from the Network; the inline init is ours.
                // Cloudflare Web Analytics: the edge injects its beacon into every page (as on Wiki and Live).
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media'],
                // openvibe.events: release notifications (release-watch's EventSource, openvibe-shared 1.17).
                // The navbar's Messages count asks Chat (openvibe-shared 4.130.0).
                connectSrc: ["'self'", 'https://openvibe.chat', 'https://openvibe.network', 'https://openvibe.events', 'https://cloudflareinsights.com'],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        frameguard: { action: 'deny' },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    app.use(cookieParser());

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-coupons', version: VERSION }));
    // GET /release.json (ADR-016) and POST /release-metrics: open tabs' update reports into /metrics.
    release.mount(app, { registry: metrics.registry });
    const readiness = createCouponsReadiness({ store, jwks, outbox, worker, importer, reports, config, release: release.release, valkey: ctx.valkey });
    app.get('/api/ready', readiness.handler);
    // GET /<key>.txt — the IndexNow key file, mounted only when a key is configured (nothing else).
    if (indexnow.enabled) app.get(`/${config.indexnowKey}.txt`, indexnow.keyFile);

    // ── Inbound events (OpenVibe.Events webhook, signed) ─────
    // Mounted before sign-in and body-parser: reads its own raw body for the HMAC.
    app.use(createWebhookRouter(express, { config, store, importer, accountData, accountSend, log }));

    // ── Sign-in (OAuth2 client of OpenVibe.Network) ─────────
    // /auth/me is the navbar's who-is-signed-in read on every page, so it is not counted with sign-ins: 60 page views in 15 minutes made a signed-in visitor look signed out.
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 60, skip: (req) => req.path === '/me', standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', auth.router(express));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'coupons', service: 'coupons', host: 'openvibe.coupons', name: 'OpenVibe.Coupons', profile: 'ugc' })); }

    // ── Static assets (content-hashed ?v= → immutable) ──────
    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── /api/v1/watchlist/:id/share — the one Share sheet's API (openvibe-sdk/share) ──
    // GET/PUT .../share, .../share/requests, .../share/transfer[/accept|decline|cancel], GET /api/v1/share/people
    // and /api/v1/shared-with-me. Access is still decided by canView on the list's page; the router answers only its
    // own paths. The list's id is its owner's subject (usr_…).
    {
        const shareApi = express.Router();
        shareApi.use(viewers.pages());
        shareApi.use(sharing.shares.router({
            service: 'coupons',
            authenticate: (req) => sharing.shareViewer(req.viewer),
            describe: sharing.describe,
        }));
        const SHARE_PATH = /^\/api\/v1\/(?:shared-with-me$|share\/people$|[^/]+\/[^/]+\/share(?:\/|$))/;
        app.use((req, res, next) => (SHARE_PATH.test(req.path) ? shareApi(req, res, next) : next()));
    }
    // Expire members and transfers and send queued share events/notifications. Unref'd: it never holds a test open.
    if (opts.startSharingWorker !== false) {
        const timer = setInterval(() => { sharing.work().catch(() => { /* logged inside */ }); }, 15_000);
        if (timer.unref) timer.unref();
        app.locals.sharingTimer = timer;
    }

    // ── API ─────────────────────────────────────────────────
    app.use('/api/v1', createApi(ctx));
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Discovery and pages ─────────────────────────────────
    app.use(createDiscoveryRoutes(ctx));
    const pages = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });
    const publicRoutes = createPublicRoutes(ctx);
    // The agent layer (openvibe-shared/agent-layer): /.well-known/agent.json and the Markdown twins of the
    // public pages. Mounted before the page routes but gated to twin requests only, so a browser keeps the
    // page's own render (signed in or out) and only a twin request reaches the agent layer. The manifest
    // path is matched exactly, so /.well-known/security.txt and the rest of /.well-known/ are untouched.
    const agentLayer = require('openvibe-shared/agent-layer');
    agentLayer.mount({ use: (mw) => app.use((req, res, next) => {
        const p = req.path || '';
        const twin = p.endsWith('.md') || req.query.format === 'markdown' || /text\/markdown/.test(String(req.get('accept') || ''));
        if (p !== '/.well-known/agent.json' && !twin) return next();
        return mw(req, res, next);
    }) }, {
        descriptor: require('./agent-descriptor'),
        render: require('./agent-pages').createAgentPages({ router: publicRoutes.router }).renderPublicPage,
    });

    app.use(require('./link-header').linkHeader());   // SEO-24: the head's twin and llms.txt links, as a Link: header
    app.use(pages, publicRoutes.router);
    app.use((req, res) => publicRoutes.notFound(req, res));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        log.error('[Coupons]', err && err.stack ? err.stack : err);
        if (res.headersSent) return;
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
