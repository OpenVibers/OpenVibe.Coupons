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
const { createIndexNow } = require('openvibe-shared/indexnow');

const configLib = require('./config');
const { openStore } = require('./db');
const { createViewerResolver } = require('./auth/viewer');
const { createCouponsOutbox } = require('./events/outbox');
const { createPublication } = require('./domain/publication');
const { createMerchants } = require('./domain/merchants');
const { createCoupons } = require('./domain/coupons');
const { createReports } = require('./domain/reports');
const { createInstalls } = require('./domain/installs');
const { createWatches } = require('./domain/watches');
const { createModeration } = require('./domain/moderation');
const { createSourcesImporter } = require('./clients/sources');
const { createApi } = require('./http/api');
const { createPublicRoutes } = require('./http/public');
const { createDiscoveryRoutes } = require('./http/discovery');
const { createCouponsReadiness } = require('./observability');
const { createActorLimits } = require('./http/actor-limits');
const { createWorker } = require('./worker');
const { assetVersion } = require('./render/layout');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

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

    const outbox = createCouponsOutbox({ db: store.db, config, fetchImpl, now: store.now, log });
    const publication = createPublication({ store, config, outbox, indexnow });
    const merchants = createMerchants({ store });
    const coupons = createCoupons({ store, merchants, publication, outbox });
    const reports = createReports({ store, config, coupons, merchants, publication });
    const installs = createInstalls({ store, config });
    const watches = createWatches({ store });
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

    const ctx = { config, store, outbox, publication, merchants, coupons, reports, installs, watches, moderation, importer, auth, jwks, viewers, worker, indexnow };

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'coupons', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'coupons', release: release.release });
    app.locals.metrics = metrics.registry;
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
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media'],
                // events.openvibe.network: release notifications (release-watch's EventSource, openvibe-shared 1.17).
                connectSrc: ["'self'", 'https://openvibe.network', 'https://events.openvibe.network'],
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

    // ── Sign-in (OAuth2 client of OpenVibe.Network) ─────────
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
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
            res.setHeader('Cache-Control', v && v === assetVersion(rel) ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
        },
    }));

    // ── API ─────────────────────────────────────────────────
    app.use('/api/v1', createApi(ctx));
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Discovery and pages ─────────────────────────────────
    app.use(createDiscoveryRoutes(ctx));
    const pages = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });
    const publicRoutes = createPublicRoutes(ctx);
    app.use(pages, publicRoutes.router);
    app.use((req, res) => publicRoutes.notFound(req, res));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        log.error('[Coupons]', err && err.stack ? err.stack : err);
        if (res.headersSent) return;
        res.set('Cache-Control', 'private, no-store');
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
