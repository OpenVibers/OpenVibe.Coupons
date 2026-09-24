'use strict';

/**
 * OpenVibe.Coupons configuration. Every value comes from the environment (production:
 * /etc/openvibe/coupons.env, see .env.example). Only environment variable NAMES appear in code and
 * docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();

const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4850);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.coupons' : `http://localhost:${port}`));

    return {
        service: 'coupons',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        // Public origin: canonical URLs, feeds, sitemaps and JSON-LD are built from it.
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,

        dbPath: env.COUPONS_DB_PATH || './data/coupons.db',

        // OpenVibe.Network: SSO (OAuth2 authorization server), JWKS, client-credentials tokens.
        networkUrl: trim(env.OV_NETWORK_URL || 'https://openvibe.network'),
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'coupons',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile theme',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },
        // Signs the per-session form token (CSRF). Unset: a random per-process key.
        formSecret: env.COUPONS_FORM_SECRET || '',
        // Keys the reporter column of coupon_validation_reports (HMAC of the person's subject), so
        // the table never holds who reported what in the clear. Unset: a fixed development key and
        // /api/ready says so. Changing it restarts same-day deduplication.
        reporterKeySecret: env.COUPONS_REPORTER_KEY_SECRET || '',

        // Staff (merchant approval, moderation): staff.editorial.manage (Network admins), plus these subjects (usr_…).
        staffSubjects: list(env.COUPONS_STAFF_SUBJECTS),

        // Browser-extension origins allowed by CORS on the two lookup routes ONLY (never on
        // reports, submissions or pages). Exact origins (chrome-extension://<id>) or the literal
        // pattern moz-extension://* (Firefox gives every install a random origin). Empty: no CORS
        // at all — the extension still works through its host permission for the API origin.
        extensionOrigins: list(env.COUPONS_EXTENSION_ORIGINS),

        limits: {
            // Lookup routes, per minute: anonymous callers by IP, extension installs by install.
            lookupAnonPerMin: int(env.COUPONS_LOOKUP_ANON_PER_MIN, 30),
            lookupTokenPerMin: int(env.COUPONS_LOOKUP_TOKEN_PER_MIN, 120),
            lookupServicePerMin: int(env.COUPONS_LOOKUP_SERVICE_PER_MIN, 600),
            // Validity reports per person (every channel together: site, extension, API).
            reportsPerHour: int(env.COUPONS_REPORTS_PER_HOUR, 20),
            reportsPerDay: int(env.COUPONS_REPORTS_PER_DAY, 60),
            // Submissions per person.
            submissionsPerHour: int(env.COUPONS_SUBMISSIONS_PER_HOUR, 10),
            submissionsPerDay: int(env.COUPONS_SUBMISSIONS_PER_DAY, 30),
            // Active extension installs per person.
            installsPerSubject: int(env.COUPONS_INSTALLS_PER_SUBJECT, 10),
        },
        // Extension install tokens expire after this many days (a new one is one click away).
        installTtlDays: int(env.COUPONS_INSTALL_TTL_DAYS, 365),

        // OpenVibe.Sources: codes from the `coupons` category (e.g. staff-coupon-codes, a manual
        // source) are imported when OV_SOURCES_INTERNAL_URL and the client secret are set.
        sources: {
            internalUrl: trim(env.OV_SOURCES_INTERNAL_URL || ''),
            keys: list(env.COUPONS_SOURCES_KEYS),
            intervalMs: int(env.COUPONS_SOURCES_INTERVAL_MS, 10 * 60 * 1000),
            // false (default): imported codes wait for staff review before they are listed.
            autoPublish: env.COUPONS_SOURCES_AUTO_PUBLISH === 'true',
        },

        // OpenVibe.Events: the outbox relay runs only when EVENTS_URL and the client secret are set.
        events: {
            url: trim(env.EVENTS_URL || ''),
            intervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
        },

        // Expiry and confidence-decay sweep.
        worker: {
            enabled: env.COUPONS_WORKER !== 'off',
            intervalMs: int(env.COUPONS_SWEEP_INTERVAL_MS, 60 * 1000),
        },
    };
}

module.exports = { load };
