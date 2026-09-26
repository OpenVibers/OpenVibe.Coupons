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

const configLib = require('./config');
const { openStore } = require('./db');
const { createAuthClient, createAuthRoutes } = require('./auth/sso');
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
const { createWorker } = require('./worker');
const { assetVersion } = require('./render/layout');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

/** opts: config, store | dbPath, now (clock), fetchImpl, auth (a createAuthClient-like object), log */
function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const store = opts.store || openStore(opts.dbPath || config.dbPath, { now: opts.now });

    const outbox = createCouponsOutbox({ db: store.db, config, fetchImpl, now: store.now, log });
    const publication = createPublication({ store, config, outbox });
    const merchants = createMerchants({ store });
    const coupons = createCoupons({ store, merchants, publication, outbox });
    const reports = createReports({ store, config, coupons, merchants, publication });
    const installs = createInstalls({ store, config });
    const watches = createWatches({ store });
    const moderation = createModeration({ store, merchants, coupons, outbox });
    const importer = createSourcesImporter({ store, config, merchants, coupons, fetchImpl, log });
    const auth = opts.auth || createAuthClient(config);
    const viewers = createViewerResolver({ auth, config, installs });
    const worker = createWorker({ config, coupons, importer, outbox, log });

    const ctx = { config, store, outbox, publication, merchants, coupons, reports, installs, watches, moderation, importer, auth, viewers, worker };

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'coupons', root: path.join(__dirname, '..') });
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'coupons', release: release.release });
    app.locals.metrics = metrics.registry;
    app.locals.ctx = ctx;

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
    const readiness = createCouponsReadiness({ store, auth, outbox, worker, importer, reports, config, release: release.release });
    app.get('/api/ready', readiness.handler);

    // ── Sign-in (OAuth2 client of OpenVibe.Network) ─────────
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', createAuthRoutes(config, auth));
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
