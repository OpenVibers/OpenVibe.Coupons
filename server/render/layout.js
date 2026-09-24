'use strict';

/**
 * Page shell. Every page is server-rendered through this and is complete without JavaScript:
 *   - <head>: title, description, canonical and robots from the indexability gate's decision
 *     (openvibe-publishing/seo metaTags — there is no default that makes a page indexable),
 *     Open Graph, JSON-LD built from real fields only, feed links, the shared app icon
 *   - the OpenVibe Frame: navbar.js and theme-loader.js from the Network (progressive), a
 *     <noscript> navigation bar and the server-rendered shared footer (openvibe-shared)
 *   - no script of Coupons' own beyond the navbar init: copying a code is plain text selection
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-publishing/seo');
const { escapeHtml: esc } = require('openvibe-publishing/ssr');
const appIcon = require('openvibe-shared/app-icon');
const frame = require('openvibe-shared/frame');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Coupons';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const NAV = [
    { label: 'Merchants', href: '/' },
    { label: 'Submit a code', href: '/submit' },
    { label: 'Browser helper', href: '/connect-extension' },
];

const hashes = new Map();
function assetVersion(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
    hashes.set(rel, v);
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

/**
 * o: title, description, decision (required), canonical, jsonLd [], feeds [{ type, href, title }],
 *    body (HTML), viewer, config, path, bodyClass
 */
function renderPage(o) {
    if (!o.decision) throw new TypeError('renderPage needs the gate decision');
    const head = seo.metaTags({
        title: o.title ? `${o.title} · ${SITE_NAME}` : SITE_NAME,
        description: o.description || 'Coupon codes with merchant matching, restrictions, honest expiry and people\'s validity reports.',
        decision: o.decision,
        canonical: o.canonical,
        type: 'website',
        siteName: SITE_NAME,
        jsonLd: (o.jsonLd || []).filter(Boolean),
    });
    const viewer = o.viewer || { kind: 'anonymous' };
    const signedIn = viewer.kind === 'user';
    const loginNext = encodeURIComponent(o.path || '/');
    const nav = {
        service: 'coupons',
        apiBase: NETWORK_URL,
        links: NAV.map((l) => ({ label: l.label, href: l.href })),
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${o.config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: `/auth/login?next=${loginNext}`,
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
    };
    // This site's own account links live in the shared navbar's account menu (the page's account
    // bar below is only for visitors without JavaScript).
    if (signedIn) nav.menu = { before: [{ label: 'Watching', href: '/watching', icon: 'fa-bell' }, { label: 'Browser helper', href: '/connect-extension', icon: 'fa-puzzle-piece' }, ...(viewer.staff ? [{ label: 'Staff', href: '/staff', icon: 'fa-shield' }] : [])] };
    const footer = { service: 'coupons', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };
    const account = signedIn
        ? `<a href="/watching">Watching</a> · <a href="/connect-extension">Browser helper</a>${viewer.staff ? ' · <a href="/staff">Staff</a>' : ''} · <a href="/auth/logout?next=${loginNext}">Sign out</a>`
        : `<a href="/auth/login?next=${loginNext}">Sign in with OpenVibe</a>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head}
${seo.feedLinks(o.feeds || [])}
${appIcon.headTags({ site: 'coupons' })}
<link rel="stylesheet" href="${asset('css/coupons.css')}">
<script src="${NETWORK_URL}/shared/theme-loader.js" defer></script>
<script src="${NETWORK_URL}/shared/navbar.js" defer></script>
<script src="${NETWORK_URL}/shared/footer.js" defer></script>
</head>
<body class="${esc(o.bodyClass || '')}">
<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
${frame.noscriptNav({ name: SITE_NAME, home: '/', links: NAV })}
<noscript><div class="account-bar" role="navigation" aria-label="Account">${account}</div></noscript>
<main id="main" class="page">
${o.body || ''}
${o.path === '/' ? frame.shipped({ service: 'coupons', title: `Recently shipped on ${SITE_NAME}` }) : ''}
</main>
${frame.footer(footer)}
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: nav, footer }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeNavbar) OpenVibeNavbar.init(window.__OV_PAGE.navbar); } catch (e) { /* the Frame is optional */ }
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* */ }
});
</script>
</body>
</html>`;
}

module.exports = { renderPage, asset, assetVersion, SITE_NAME, NETWORK_URL };
