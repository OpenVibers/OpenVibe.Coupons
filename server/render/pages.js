'use strict';

/**
 * Page bodies (layout.js wraps them). Everything is in the HTML: codes as selectable text, status,
 * confidence, last report time, restrictions, expiry or "unknown", evidence, and plain forms.
 * Values are escaped by ssr.html unless wrapped in raw().
 *
 * Wording rules: an unknown is shown as unknown ("Expiry unknown", "No restrictions stated",
 * "No reports in the last 30 days"), never as a friendly default.
 */
const ssr = require('openvibe-publishing/ssr');
const kit = require('openvibe-shared/kit');

const { html: h, raw } = ssr;
const k = (markup) => raw(String(markup));   // a kit builder's markup (already escaped) inside an h`` template

const STATUS_LABEL = {
    unknown: 'Validity unknown',
    reported_working: 'Reported working',
    reported_failed: 'Reported not working',
    expired: 'Expired',
    disabled: 'Taken down',
};
// The one-line summary of the service: /llms.txt and /llms-full.txt open with it, and the home page
// hands it to the shell as its AI-readable summary (ai-summary meta and WebPage JSON-LD).
const SITE_SUMMARY = 'Coupon codes for online shops with merchant/domain matching, restrictions, honest expiry and validity reports by people; new codes from members and DealNews every hour.';
const BASIS_LABEL = {
    evidence: 'as stated on the evidence page',
    submitter: 'according to the person who submitted it',
    source: 'as stated by the imported source',
    staff: 'set by staff',
};
const REASON_LABEL = {
    invalid: 'Code not accepted', expired: 'Said it has expired', min_spend_not_met: 'Minimum spend not met',
    not_eligible: 'Not eligible (account, region or items)', other: 'Other',
};

const utc = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : null);
const regionName = (() => {
    let names = null;
    try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { /* no ICU */ }
    return (code) => { try { return names ? `${names.of(code)} (${code})` : code; } catch { return code; } };
})();

function hidden(csrf) { return h`<input type="hidden" name="csrf" value="${csrf}">`; }

function statusBadge(status) {
    return h`<span class="status status-${status}">${STATUS_LABEL[status] || status}</span>`;
}

function expiryText(expiry) {
    if (!expiry.known) return h`<span class="unknown">Expiry unknown</span>`;
    const when = expiry.precision === 'date'
        ? h`${raw(ssr.timeTag(expiry.expires_at, { label: expiry.expires_at.slice(0, 10) }))} (end of that day in UTC; the merchant's time zone is not stated)`
        : h`${raw(ssr.timeTag(expiry.expires_at, { label: utc(expiry.expires_at) }))}`;
    return h`Expires ${when}, ${BASIS_LABEL[expiry.basis] || 'source not recorded'}`;
}

function confidenceText(v) {
    if (v.confidence == null) return h`<span class="unknown">No reports in the last ${v.reports.window_days} days</span>`;
    return h`Confidence ${Math.round(v.confidence * 100)}% from ${v.reports.worked} “worked” and ${v.reports.failed} “didn't work” report${v.reports.worked + v.reports.failed === 1 ? '' : 's'} in the last ${v.reports.window_days} days (<a href="/about#confidence">how this is computed</a>)`;
}

function restrictionsList(list) {
    if (!list.length) return h`<p class="unknown">No restrictions stated. That does not mean there are none.</p>`;
    return h`<ul class="restrictions">${list.map((r) => {
        if (r.kind === 'min_spend') return h`<li>Minimum spend ${r.amount}</li>`;
        if (r.kind === 'category') return h`<li>Category: ${r.value}</li>`;
        if (r.kind === 'new_customers_only') return h`<li>New customers only</li>`;
        if (r.kind === 'region') return h`<li>Region: ${regionName(r.value)}</li>`;
        return h`<li>${r.value}</li>`;
    })}</ul>`;
}

function evidenceList(list) {
    const withUrl = list.filter((e) => e.url);
    if (!withUrl.length) return h`<p class="meta">Evidence: none recorded (submitted without a link).</p>`;
    return h`<p class="meta">Evidence: ${withUrl.map((e, i) => h`${i ? ', ' : ''}<a href="${e.url}" rel="nofollow ugc noopener">${hostOf(e.url)}</a>${e.merchant_page ? ' (the merchant\'s own site)' : ''}${e.retrieved_at ? h` (retrieved ${e.retrieved_at.slice(0, 10)})` : ''}`)}</p>`;
}
function hostOf(u) { try { return new URL(u).hostname; } catch { return u; } }

function reportForms(v, { viewer, csrf, back }) {
    if (!v.active) return '';
    if (!viewer || viewer.kind !== 'user') return h`<p class="meta"><a href="/auth/login?next=${encodeURIComponent(back)}">Sign in</a> to report whether it worked.</p>`;
    return h`<div class="report">
<form method="post" action="/c/${v.id}/report" class="inline">${hidden(csrf)}<input type="hidden" name="outcome" value="worked"><input type="hidden" name="back" value="${back}"><button type="submit">It worked</button></form>
<form method="post" action="/c/${v.id}/report" class="inline">${hidden(csrf)}<input type="hidden" name="outcome" value="failed"><input type="hidden" name="back" value="${back}">
<label>Why <select name="reason"><option value="">(not sure)</option>${Object.entries(REASON_LABEL).map(([k, l]) => h`<option value="${k}">${l}</option>`)}</select></label>
<button type="submit">It didn't work</button></form>
</div>`;
}

// ── A code, as people scan it (the owner, 2026-10-28, showing SimplyCodes' store page: "so much more organized") ──
// The discount first, then the code with Copy and the shop, one status line in this site's own words (an unknown is
// still called unknown), the stated restrictions as chips; everything else (each unknown in full, the evidence, how to
// apply it, a report with its reason) folds under Details, open on the code's own page.

/** DealNews' "Air Monitor for $35 + free shipping": a code for one product, not for the shop. */
const PRODUCT_DEAL_RE = /\bfor (?:(?:from|only|just|as low as) )?\$\s?\d[\d,]*(?:\.\d\d)?\b/i;
const isProductDeal = (v) => PRODUCT_DEAL_RE.test(v.title || '');

/** The headline a person scans for, from the code's own title (then its description): 40% off, $16 off, Free shipping, $24. */
function headline(v) {
    const title = v.title || '';
    const both = `${title} ${v.description || ''}`;
    let m = /(\d{1,2}(?:\.\d)?)\s*%\s*off/i.exec(title) || /\((\d{1,2})%\)\s*off/i.exec(both) || /(\d{1,2})%\s*off/i.exec(both);
    if (m) return `${m[1]}% off`;
    m = /\$\s?(\d[\d,]*(?:\.\d\d)?)\s*off/i.exec(title);
    if (m) return `$${m[1]} off`;
    if (/free shipping/i.test(title) && !PRODUCT_DEAL_RE.test(title)) return 'Free shipping';
    m = PRODUCT_DEAL_RE.exec(title);
    if (m) return m[0].replace(/^for\s*(?:(?:from|only|just|as low as)\s+)?/i, '').replace(/\s+/g, '');
    m = /\$\s?(\d[\d,]*(?:\.\d\d)?)\s*off/i.exec(both);
    if (m) return `$${m[1]} off`;
    return 'Code';
}

/** The stated restrictions as short chips (none stated: no chips; Details says so in full). */
function restrictionChips(list) {
    if (!list.length) return '';
    return h`<ul class="cpn-chips">${list.map((r) => h`<li>${r.kind === 'min_spend' ? `Minimum spend ${r.amount}` : r.kind === 'category' ? `Category: ${r.value}` : r.kind === 'new_customers_only' ? 'New customers only' : r.kind === 'region' ? regionName(r.value) : r.value}</li>`)}</ul>`;
}

/** One status line: the status, what the reports say (or that there are none), when the last one came, the expiry. */
function statusLine(v) {
    const parts = [];
    parts.push(v.confidence == null ? (v.reports.last_report_at ? `No reports in the last ${v.reports.window_days} days` : 'No reports yet') : `Confidence ${Math.round(v.confidence * 100)}%`);
    if (v.reports.last_report_at) parts.push(`last report ${kit.when(v.reports.last_report_at).text}`);
    parts.push(v.expiry.known ? `Expires ${kit.when(v.expiry.expires_at).text}` : 'Expiry unknown');
    return h`<p class="cpn-status">${statusBadge(v.status)} <span>${parts.join(' · ')}</span></p>`;
}

/** Signed in: Worked / Didn't work in one tap (the reason is in Details); signed out, Details says how to report. */
function quickReport(v, { viewer, csrf, back }) {
    if (!v.active || !viewer || viewer.kind !== 'user') return '';
    const one = (outcome, label) => h`<form method="post" action="/c/${v.id}/report" class="inline">${hidden(csrf)}<input type="hidden" name="outcome" value="${outcome}"><input type="hidden" name="back" value="${back}"><button type="submit" class="cpn-vote">${label}</button></form>`;
    return h`<div class="cpn-report"><span>Did it work?</span>${one('worked', 'It worked')}${one('failed', "It didn't")}</div>`;
}

/** One code. v: coupons.view(); opts: { viewer, csrf, back, link, page, shopUrl } (page: its own page, where the title is the h1) */
function couponCard(v, opts = {}) {
    const title = opts.link ? h`<a href="/c/${v.id}">${v.title}</a>` : v.title;
    return h`<article class="coupon cpn cpn--${v.status}" id="${v.id}">
<div class="cpn-top"><strong class="cpn-off">${headline(v)}</strong>${isProductDeal(v) ? h`<span class="cpn-scope">One product</span>` : ''}</div>
${opts.page ? h`<h1 class="coupon-title">${title}</h1>` : h`<h3 class="cpn-title">${title}</h3>`}
<div class="cpn-code"><code class="code" id="code-${v.id}">${v.code}</code>${k(kit.iconButton({ type: 'button', icon: 'copy', label: `Copy ${v.code}`, attrs: { 'data-ovk-copy': `#code-${v.id}`, hidden: true } }))}${opts.shopUrl ? k(kit.button({ href: opts.shopUrl, label: 'Shop', icon: 'open', kind: 'quiet', small: true, attrs: { rel: 'nofollow noopener', target: '_blank' } })) : ''}</div>
${statusLine(v)}
${restrictionChips(v.restrictions)}
${quickReport(v, opts)}
<details class="cpn-more"${opts.page ? ' open' : ''}><summary>Details</summary>
${v.description ? h`<p>${v.description}</p>` : ''}
<p class="meta">${confidenceText(v)}</p>
<p class="meta">${v.reports.last_report_at ? h`Last report ${v.reports.last_report_at.slice(0, 10)} around ${v.reports.last_report_at.slice(11, 13)}:00 UTC` : 'No reports yet'}</p>
<p class="meta">${expiryText(v.expiry)}</p>
${restrictionsList(v.restrictions)}
${v.hints.length ? h`<ul class="hints">${v.hints.map((x) => h`<li>How to apply: ${x.text}</li>`)}</ul>` : ''}
${evidenceList(v.evidence)}
${v.attribution ? h`<p class="meta">Code via <a href="${v.attribution.url}" rel="nofollow noopener">${v.attribution.text}</a></p>` : ''}
${v.origin === 'ai' ? h`<p class="disclosure">Extracted by an AI workflow from the evidence page and reviewed by staff before listing. Its validity comes only from people's reports.</p>` : ''}
${reportForms(v, opts)}
</details>
</article>`;
}

function flash(msg) {
    if (!msg) return '';
    return h`<p class="notice" role="status">${msg}</p>`;
}

function errors(list) {
    if (!list || !list.length) return '';
    return h`<div class="errors" role="alert"><p>Please fix:</p><ul>${list.map((e) => h`<li>${e}</li>`)}</ul></div>`;
}

// Under the showcase (the front page) its hero is the page's one h1 and says what the site is, so the page starts at the
// search form; a search result page keeps the site's own h1 and lede.
function home({ merchants, recent, q, results, total, showcase = false }) {
    return h`${showcase ? '' : h`<h1>Coupon codes, honestly labelled</h1>
<p class="lede">Codes for online shops with their restrictions, their expiry (or “unknown”) and what people reported when they tried them. A code is only ever called working because people said it worked recently.</p>
`}<section class="find sc-sec${showcase ? ' after-showcase' : ''}" aria-labelledby="find-h"><h2 id="find-h">Find a shop</h2>
<form method="get" action="/" class="search" role="search"><label class="sr-only" for="q">Shop name or domain</label><input id="q" name="q" type="search" value="${q || ''}" maxlength="60" placeholder="Shop name or domain, like amazon.com"> <button type="submit" class="primary">Search</button></form></section>
${q ? h`<h2>Shops matching “${q}”</h2>${results.length ? h`<ul class="chips">${results.map((m) => h`<li><a class="chip" href="/m/${m.slug}">${m.name}</a></li>`)}</ul>` : h`<p class="empty">No shop matches. <a href="/submit">Submit a code</a> for a new one.</p>`}` : ''}
<section class="sc-sec" aria-labelledby="recent-h"><h2 id="recent-h">Recently added codes</h2>
${recent.length ? h`<ul class="offers">${recent.map((r) => h`<li><a class="offer-title" href="/c/${r.coupon.id}">${r.coupon.title}</a><span class="offer-meta"><a href="/m/${r.merchant.slug}">${r.merchant.name}</a> ${statusBadge(r.coupon.status)}</span></li>`)}</ul>` : h`<p class="empty">No codes yet.</p>`}</section>
${shopsSection(merchants, total)}
<p class="meta"><a href="/about">How statuses and confidence work</a> · <a href="/feed.xml">RSS</a> · <a href="/atom.xml">Atom</a> · <a href="/feed.json">JSON Feed</a></p>`;
}

// The shops: the ones with an active code first (most codes first) as chips with their count; the rest fold away under
// one line, so thirty shops with nothing today do not bury the few that have something.
function shopsSection(merchants, total) {
    if (!merchants.length) return h`<section class="sc-sec" aria-labelledby="shops-h"><h2 id="shops-h">Shops</h2><p class="empty">No shops listed yet.</p></section>`;
    const byName = (a, b) => a.merchant.name.localeCompare(b.merchant.name, 'en', { sensitivity: 'base' });
    const live = merchants.filter((m) => m.active > 0).sort((a, b) => (b.active - a.active) || byName(a, b));
    const quiet = merchants.filter((m) => !(m.active > 0)).sort(byName);
    const chip = (m) => h`<li><a class="chip" href="/m/${m.merchant.slug}">${m.merchant.name}${m.active > 0 ? h` <span class="chip-n">${String(m.active)}<span class="sr-only"> active code${m.active === 1 ? '' : 's'}</span></span>` : ''}</a></li>`;
    return h`<section class="sc-sec" aria-labelledby="shops-h"><h2 id="shops-h">Shops</h2>
<p class="meta">${String(total)} shop${total === 1 ? '' : 's'} listed${live.length ? h`; ${String(live.length)} with an active code right now` : ''}.</p>
${live.length ? h`<ul class="chips">${live.map(chip)}</ul>` : ''}
${quiet.length ? h`<details class="quiet"><summary>${live.length ? 'Shops with no active code right now' : 'All shops'} (${String(quiet.length)})</summary><ul class="chips">${quiet.map(chip)}</ul></details>` : ''}</section>`;
}

const SHOP_TABS = ['codes', 'deals', 'about'];
/** The shop's tabs: Codes (for the shop or a category), Product deals (a code for one product), About; the first that has something opens. */
function shopTab(query, active) {
    const codes = active.filter((v) => !isProductDeal(v)).length;
    const asked = query && SHOP_TABS.includes(String(query.tab)) ? String(query.tab) : null;
    return asked || (codes || !active.length ? 'codes' : 'deals');
}

/**
 * A shop (GET /m/:slug): the head (the shop, its codes, Watch, Submit and more as icons), the best code right now, and
 * one tab at a time. ended is only read for the Codes tab (the route passes [] otherwise).
 */
function merchant({ m, domains, hints, active, ended, viewer, csrf, watching, back, flashMsg, tab = 'codes' }) {
    const codes = active.filter((v) => !isProductDeal(v));
    const deals = active.filter(isProductDeal);
    const shopUrl = m.homepage_url || null;
    const base = `/m/${m.slug}`;
    const tabs = kit.tabs({ base, active: tab, label: `${m.name} sections`, items: [
        { key: 'codes', label: 'Codes', count: codes.length },
        ...(deals.length ? [{ key: 'deals', label: 'Product deals', count: deals.length }] : []),
        { key: 'about', label: 'About' },
    ] });
    const watchForm = viewer && viewer.kind === 'user'
        ? String(h`<form method="post" action="/m/${m.slug}/watch" class="ovk-inline">${hidden(csrf)}<input type="hidden" name="action" value="${watching ? 'unwatch' : 'watch'}">${k(kit.iconButton({ icon: 'bell', label: watching ? 'Stop watching this shop (while you watch, new codes reach your OpenVibe notifications)' : 'Watch this shop (private to you; new codes reach your OpenVibe notifications)', kind: watching ? 'on' : '' }))}</form>`)
        : '';
    const head = kit.head({
        title: `${m.name} coupon codes`,
        subHtml: String(h`${shopUrl ? h`<a href="${shopUrl}" rel="nofollow noopener">${hostOf(shopUrl)}</a> · ` : ''}${String(active.length)} active code${active.length === 1 ? '' : 's'}`),
        back: { href: '/', label: 'All shops' },
        actions: [watchForm, kit.iconButton({ href: `/submit?merchant=${encodeURIComponent(m.slug)}`, icon: 'plus', label: `Submit a code for ${m.name}` }),
            kit.more({ label: 'More', items: [{ href: '/about', label: 'How codes are labelled', icon: 'help' }, { href: `${base}/feed.xml`, label: 'RSS feed', icon: 'link' }, { href: `${base}.json`, label: 'As JSON', icon: 'code' }] })],
        tabs,
    });
    const best = codes.filter((v) => v.status === 'reported_working' && v.confidence != null).sort((a, b) => b.confidence - a.confidence)[0];
    const card = (v) => couponCard(v, { viewer, csrf, back, link: true, shopUrl });
    let body;
    if (tab === 'about') {
        body = h`<section class="ovk-section"><h2>The shop</h2><p class="ovk-note">${shopUrl ? h`<a href="${shopUrl}" rel="nofollow noopener">${hostOf(shopUrl)}</a>. ` : ''}Covers ${domains.map((d, i) => h`${i ? '; ' : ''}${d.host}${d.path_prefix || ''}${d.include_subdomains ? ' and its subdomains' : ''}`)}.</p>
${m.description ? h`<p class="ovk-note">${m.description}</p>` : ''}
${hints.length ? h`<ul class="hints ovk-note">${hints.map((x) => h`<li>How to apply codes here: ${x.text}</li>`)}</ul>` : ''}</section>
<section class="ovk-section"><h2>How codes are labelled</h2><p class="ovk-note">A code is only called working when people reported recently that it worked; nobody else can set that, not the submitter, staff, a source or an AI model. An expiry is shown only when someone stated it, and restrictions only when they were stated. <a href="/about">The whole method</a>.</p></section>
<p class="meta">Follow: <a href="${base}/feed.xml">RSS</a> · <a href="${base}.json">JSON</a></p>`;
    } else if (tab === 'deals') {
        body = h`<p class="ovk-note cpn-lede">Codes that take money off one product, as the source posted them.</p>
${deals.length ? deals.map(card) : h`<p class="empty">No product deals for ${m.name} right now.</p>`}`;
    } else {
        body = h`${best ? h`<a class="cpn-best" href="#${best.id}"><span>Best code now</span><strong>${headline(best)}</strong><code>${best.code}</code><span class="meta">${`Confidence ${Math.round(best.confidence * 100)}%`}</span></a>` : ''}
${codes.length ? codes.map(card) : active.length ? h`<p class="empty">No code for the whole shop right now; ${String(deals.length)} product deal${deals.length === 1 ? '' : 's'} <a href="${base}?tab=deals">in Product deals</a>.</p>` : h`<p class="empty">No active codes for ${m.name} right now.</p>`}
<p>${k(kit.button({ href: `/submit?merchant=${encodeURIComponent(m.slug)}`, label: `Submit a code for ${m.name}`, icon: 'plus', kind: 'quiet', small: true }))}</p>
${ended.length ? k(kit.fold({ title: 'Recently ended (not in active results)', meta: String(ended.length), body: String(h`<ul class="ended">${ended.map((v) => h`<li><code>${v.code}</code> — ${v.title} · ${v.status === 'expired' ? 'expired' : 'past its expiry'} ${v.expired_at ? v.expired_at.slice(0, 10) : v.expiry.expires_at ? v.expiry.expires_at.slice(0, 10) : ''}</li>`)}</ul>`) })) : ''}`;
    }
    return h`${k(head)}
${flash(flashMsg)}
${body}`;
}

function couponPage({ v, m, history, viewer, csrf, back, flashMsg }) {
    return h`${raw(ssr.breadcrumbsHtml([{ name: 'Coupons', url: '/' }, { name: m.name, url: `/m/${m.slug}` }, { name: v.code }]))}
${flash(flashMsg)}
${v.active ? '' : h`<p class="notice">This code is not in active results (${STATUS_LABEL[v.status] ? STATUS_LABEL[v.status].toLowerCase() : v.status}${v.expiry.known && !v.active && v.status !== 'expired' ? ', past its expiry' : ''}).</p>`}
${couponCard(v, { viewer, csrf, back, page: true })}
<h2>Status history</h2>
${history.length ? h`<ol class="history">${history.map((x) => h`<li>${utc(new Date(x.created_at).toISOString())}: ${x.from_status ? h`${STATUS_LABEL[x.from_status] || x.from_status} → ` : ''}${STATUS_LABEL[x.to_status] || x.to_status}${x.confidence_after != null ? h`, confidence ${Math.round(x.confidence_after * 100)}%` : ''} <span class="meta">(${x.reason.startsWith('staff') ? 'staff' : x.reason.startsWith('service:') ? 'service' : x.reason})</span></li>`)}</ol>` : h`<p class="empty">No changes yet.</p>`}
<p class="meta"><a href="/c/${v.id}.json">This code as JSON</a></p>`;
}

function about({ confidence }) {
    return h`<h1>How OpenVibe.Coupons labels codes</h1>
<h2 id="statuses">Statuses</h2>
<ul>
<li><strong>Validity unknown</strong>: nobody reported on it recently, or the reports disagree. New codes always start here, whoever submitted them.</li>
<li><strong>Reported working</strong> / <strong>Reported not working</strong>: what recent reports by people say. Nothing else can set these: not the submitter, not staff, not a source, not an AI model.</li>
<li><strong>Expired</strong>: its known expiry has passed (or staff recorded that it ended). It leaves active results at that moment.</li>
<li><strong>Taken down</strong>: removed by staff.</li>
</ul>
<h2 id="confidence">Confidence</h2>
<p>Only each person's most recent report on a code counts, one per day at most. A report weighs 0.5<sup>age / ${confidence.HALF_LIFE_DAYS} days</sup> and stops counting after ${confidence.WINDOW_DAYS} days. With W the weight of “worked” reports and F of “didn't work” reports:</p>
<p class="formula">confidence = (1 + e + W) / (2 + e + W + F)</p>
<p>where e is ${confidence.EVIDENCE_PRIOR} when the code was published on the merchant's own site, otherwise 0. With no report in the last ${confidence.WINDOW_DAYS} days there is no confidence at all (shown as “no reports”), because evidence alone says nothing about whether a code works today. A code is shown as reported working at ${Math.round(confidence.WORKING_AT * 100)}% or more and reported not working at ${Math.round(confidence.FAILED_AT * 100)}% or less, and only once the reports weigh at least ${confidence.MIN_MASS} (about one report younger than a week).</p>
<h2 id="expiry">Expiry</h2>
<p>An expiry is shown only when someone stated it, with who stated it. A date without a time means the end of that day in UTC, because the merchant's time zone is not known. When nobody stated an expiry it is “unknown”.</p>
<h2 id="privacy">Privacy</h2>
<p>Codes and their aggregates are public. Who submitted or reported a code is never shown, never returned by the API and never sent in events. Reports are stored under a keyed hash of the person, not their account id.</p>
<h2 id="helper">The OpenVibe Companion</h2>
<p>The <a href="/companion">OpenVibe Companion</a> browser extension sends this site only the <strong>hostname</strong> of the tab you are on, and only when you open it, to list that shop's codes. When you press “Try these codes on this page” it reads the page in your own browser (the coupon box, its Apply button and the order total) and nothing from the page leaves your browser. It never rewrites links or adds referral tags, and it holds no OpenVibe sign-in: to report from it you <a href="/connect-extension">connect it</a> with a token that can only look up and report, and that you can revoke at any time.</p>`;
}

function submitForm({ values = {}, errs = [], csrf, viewer, merchantName = null }) {
    if (!viewer || viewer.kind !== 'user') {
        return h`<h1>Submit a code</h1><p><a href="/auth/login?next=%2Fsubmit">Sign in with OpenVibe</a> to submit a code. Submitted codes start as “validity unknown” until people report on them.</p>`;
    }
    const v = (k) => values[k] || '';
    return h`<h1>Submit a code</h1>
<p class="lede">It will be listed as “validity unknown” until people report whether it works. Codes for a shop we do not list yet wait until staff add the shop.</p>
${errors(errs)}
<form method="post" action="/submit" class="form">${hidden(csrf)}
<fieldset><legend>The shop</legend>
${merchantName ? h`<p>Shop: <strong>${merchantName}</strong></p><input type="hidden" name="merchant" value="${v('merchant')}">` : h`<label>Shop website (address or domain) <input name="url" required maxlength="2048" value="${v('url')}" placeholder="https://www.example-shop.com/"></label>`}
</fieldset>
<fieldset><legend>The code</legend>
<label>Code <input name="code" required maxlength="64" value="${v('code')}" autocomplete="off" spellcheck="false"></label>
<label>What it gives <input name="title" required maxlength="140" value="${v('title')}" placeholder="15% off shoes"></label>
<label>Details (optional) <textarea name="description" maxlength="1000" rows="3">${v('description')}</textarea></label>
<label>Where you found it (optional, a link) <input name="evidence_url" type="url" maxlength="2048" value="${v('evidence_url')}"></label>
</fieldset>
<fieldset><legend>Expiry</legend>
<label>Expires on (leave empty if unknown) <input name="expires" type="date" value="${v('expires')}"></label>
<label><input type="checkbox" name="expiry_basis" value="evidence"${values.expiry_basis === 'evidence' ? raw(' checked') : ''}> The linked page states this expiry</label>
</fieldset>
<fieldset><legend>Restrictions (only what is stated)</legend>
<label>Minimum spend <input name="min_spend_amount" inputmode="decimal" maxlength="12" value="${v('min_spend_amount')}" placeholder="50.00"></label>
<label>Currency <input name="min_spend_currency" maxlength="3" value="${v('min_spend_currency')}" placeholder="USD"></label>
<label>Only for categories (comma-separated) <input name="categories" maxlength="400" value="${v('categories')}"></label>
<label><input type="checkbox" name="new_customers_only" value="1"${values.new_customers_only ? raw(' checked') : ''}> New customers only</label>
<label>Only in regions (ISO codes, comma-separated) <input name="regions" maxlength="200" value="${v('regions')}" placeholder="US, CA"></label>
<label>Other conditions <input name="restriction_other" maxlength="300" value="${v('restriction_other')}"></label>
<label>How to apply it (optional) <input name="hint" maxlength="300" value="${v('hint')}" placeholder="Enter it in the Promo code box at checkout"></label>
</fieldset>
<button type="submit">Submit</button>
</form>`;
}

function submitted({ coupon, merchant, duplicate }) {
    if (coupon.review_state === 'pending') {
        return h`<h1>Thanks — waiting for review</h1><p>${merchant.status === 'pending' ? `${merchant.name} is not listed yet. Staff will review the shop; your code will be listed with it.` : 'This code waits for staff review before it is listed.'}</p><p><a href="/">Back to all shops</a></p>`;
    }
    return h`<h1>${duplicate ? 'Already listed — your evidence was added' : 'Thanks — your code is listed'}</h1><p>It shows as “${STATUS_LABEL[coupon.status]}” until people report on it.</p><p><a href="/m/${merchant.slug}#${coupon.id}">See it on ${merchant.name}'s page</a></p>`;
}

function connect({ viewer, installs, csrf, created, errs = [] }) {
    const intro = h`<h1>Connect the OpenVibe Companion</h1>
<p class="lede">The <a href="/companion">OpenVibe Companion</a> shows and tries codes for the shop you are on. It works without connecting; connecting lets it report whether a code worked, as you, so the next person sees it.</p>
<ul>
<li>It sends this site only the <strong>hostname</strong> of the current tab, and only when you open it.</li>
<li>When you ask it to try codes, it reads the checkout page in your browser; nothing from the page is sent anywhere. It never sends full addresses and has no access to your OpenVibe account: the token below can only look up codes and (if you allow it) report on them.</li>
<li>Revoking a token here takes effect on its next request.</li>
</ul>`;
    if (!viewer || viewer.kind !== 'user') return h`${intro}<p><a href="/auth/login?next=%2Fconnect-extension">Sign in with OpenVibe</a> to create a token.</p>`;
    return h`${intro}
${errors(errs)}
${created ? h`<div class="token-once" role="status"><p><strong>Your token for “${created.install.label}”</strong> — copy it into the helper's settings now. It is shown only once.</p><p><code class="token">${created.token}</code></p></div>` : ''}
<h2>Create a token</h2>
<form method="post" action="/connect-extension" class="form">${hidden(csrf)}
<label>Name this browser <input name="label" maxlength="60" placeholder="Firefox on my laptop"></label>
<label><input type="checkbox" name="scope_report" value="1" checked> Allow it to report whether codes worked</label>
<p class="meta">Looking up codes is always allowed. Nothing else is possible with this token.</p>
<button type="submit">Create token</button>
</form>
<h2>Your connected browsers</h2>
${installs.length ? h`<table class="installs"><thead><tr><th>Name</th><th>Token</th><th>Can</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${installs.map((i) => h`<tr>
<td>${i.label}</td><td><code>${i.token_hint}…</code></td><td>${i.scopes.map((s) => (s === 'coupons.report' ? 'look up, report' : '')).filter(Boolean)[0] || 'look up'}</td>
<td>${i.created_at.slice(0, 10)}</td><td>${i.last_used_at ? i.last_used_at.slice(0, 10) : 'never'}</td>
<td>${i.active ? h`<form method="post" action="/connect-extension/${i.id}/revoke">${hidden(csrf)}<button type="submit">Revoke</button></form>` : (i.revoked_at ? 'revoked' : 'expired')}</td></tr>`)}</tbody></table>` : h`<p class="empty">None yet.</p>`}`;
}

const COMPANION_RELEASE = 'https://github.com/OpenVibers/OpenVibe.Extensions/releases/latest';
const COMPANION_SOURCE = 'https://github.com/OpenVibers/OpenVibe.Extensions/tree/main/browser';

/**
 * /companion below its showcase (server/http/public.js draws the hero and the feature cards): what the OpenVibe
 * Companion (OpenVibers/OpenVibe.Extensions `browser/`) sees and sends, how to install it, connecting it.
 */
function companion() {
    return h`<h2 id="privacy">What it can see, and what it sends</h2>
<ul>
<li><strong>Permissions:</strong> the active tab (only after you click it), running its own code there when you press a button, and its own storage. It has no access to other tabs, your history or cookies, and no background process.</li>
<li><strong>Sent to OpenVibe.Coupons:</strong> the tab's hostname when you open it (for example <code>shop.example</code>), and a worked or did not work report when you have connected it and say so.</li>
<li><strong>Read from the page:</strong> the tab's address and title when you open it; the checkout page's coupon box, Apply button and total only when you press “Try these codes on this page”; a review site's rating only when you press “Save its rating to OpenVibe Reviews”, which opens openvibe.reviews with it in a tab you see. Nothing else read from the page leaves your browser.</li>
<li><strong>Stored:</strong> only the optional connection token, on that device.</li>
</ul>
<h2 id="install">Install it</h2>
<p>It is not in the browser stores yet, so it installs from its release file:</p>
<ol>
<li>Download the zip from the <a href="${COMPANION_RELEASE}">latest release</a> and unzip it.</li>
<li><strong>Chrome, Edge or Brave:</strong> open <code>chrome://extensions</code>, turn on Developer mode, choose “Load unpacked” and pick the unzipped folder.</li>
<li><strong>Firefox:</strong> open <code>about:debugging</code>, choose “This Firefox”, then “Load Temporary Add-on”, and pick the <code>manifest.json</code> in the folder.</li>
<li>Pin it to the toolbar, open a shop's site and click it.</li>
</ol>
<h2>Connect it (optional)</h2>
<p>Without connecting, it looks up and tries codes. <a href="/connect-extension">Connect it</a> to report whether a code worked, so the labels stay honest for everyone. The token can only look up and report, and you can revoke it at any time.</p>
<p class="meta">Source code and the full privacy table: <a href="${COMPANION_SOURCE}">OpenVibers/OpenVibe.Extensions</a>. How codes are labelled: <a href="/about">the method</a>.</p>`;
}

function watching({ merchants }) {
    return h`<h1>Shops you watch</h1>
<p class="meta">Private to you. When a new code for one of these shops is listed, you get a notification in your OpenVibe inbox (unless you muted service notifications there).</p>
${merchants.length ? h`<ul class="merchant-list">${merchants.map((m) => h`<li><a href="/m/${m.slug}">${m.name}</a></li>`)}</ul>` : h`<p class="empty">You are not watching any shop. Use “Watch this shop” on a shop's page.</p>`}`;
}

function staff({ pendingMerchants, pendingCoupons, holds, csrf, flashMsg, errs = [] }) {
    return h`<h1>Staff</h1>
${flash(flashMsg)}${errors(errs)}
<h2>Add a shop</h2>
<form method="post" action="/staff/merchants" class="form">${hidden(csrf)}
<label>Name <input name="name" required maxlength="120"></label>
<label>Domain <input name="host" required maxlength="253" placeholder="example-shop.com"></label>
<label><input type="checkbox" name="include_subdomains" value="1" checked> Include subdomains</label>
<label>Only under this path (optional) <input name="path_prefix" maxlength="200" placeholder="/shop/name"></label>
<button type="submit">Add</button></form>
<h2>Shops waiting for review (${pendingMerchants.length})</h2>
${pendingMerchants.length ? h`<ul>${pendingMerchants.map((m) => h`<li>${m.name} (${m.domains.join(', ')}) · ${m.codes} code(s)
<form method="post" action="/staff/merchants/${m.id}/status" class="inline">${hidden(csrf)}<input type="hidden" name="status" value="active"><button>Approve</button></form>
<form method="post" action="/staff/merchants/${m.id}/status" class="inline">${hidden(csrf)}<input type="hidden" name="status" value="disabled"><button>Reject</button></form></li>`)}</ul>` : h`<p class="empty">None.</p>`}
<h2>Codes waiting for review (${pendingCoupons.length})</h2>
${pendingCoupons.length ? h`<ul>${pendingCoupons.map((c) => h`<li><code>${c.code}</code> — ${c.title} at ${c.merchant} (${c.origin})${c.evidence ? h` · <a href="${c.evidence}" rel="nofollow noopener">evidence</a>` : ''}
<form method="post" action="/staff/coupons/${c.id}/approve" class="inline">${hidden(csrf)}<button>Publish</button></form>
<form method="post" action="/staff/coupons/${c.id}/status" class="inline">${hidden(csrf)}<input type="hidden" name="status" value="disabled"><button>Reject</button></form></li>`)}</ul>` : h`<p class="empty">None.</p>`}
<h2>Change a code</h2>
<form method="post" action="/staff/coupons/status" class="form">${hidden(csrf)}
<label>Code id <input name="id" required pattern="cpn_[0-9A-Z]{26}" placeholder="cpn_…"></label>
<label>Set <select name="status"><option value="disabled">Take down</option><option value="expired">Mark expired</option><option value="active">Back to active (recomputed from reports)</option></select></label>
<label>Note <input name="note" maxlength="200"></label>
<button type="submit">Apply</button></form>
<h2>Imported items held (${holds.length})</h2>
${holds.length ? h`<ul>${holds.map((x) => h`<li>${x.item_id} from ${x.source_key || '?'}: ${x.reason}${x.detail ? h` (${x.detail})` : ''} · ${x.attempts} attempt(s)</li>`)}</ul>` : h`<p class="empty">None.</p>`}`;
}

function message({ heading, text, action }) {
    return h`<h1>${heading}</h1><p>${text}</p>${action ? h`<p><a href="${action.href}">${action.label}</a></p>` : ''}`;
}

module.exports = {
    shopTab, isProductDeal, headline, home, shopsSection, merchant, couponPage, couponCard, about, submitForm, submitted, connect, companion, COMPANION_RELEASE, watching, staff, message, STATUS_LABEL, SITE_SUMMARY };
