'use strict';

/**
 * The store page (/m/<slug>): the shop's head (its mark, its name, its domain, one muted line), the best code
 * first, the other codes as compact rows, the tabs, the slim sticky bar and the About tab's quick facts.
 *
 * The rules this page keeps (the research outcomes of 2026-10-30):
 *   - a code's status comes only from people's reports: "87% worked (23 reports)", and under five reports the
 *     page says only "Validity unknown (2 reports)";
 *   - a code whose last report is older than the window says "No reports in the last 30 days" and sorts last;
 *   - the page never says "verified" and never shows a share of people that no report produced;
 *   - a shop with no codes says so; a tab never reads "Codes 0".
 *
 * Everything is in the HTML: the codes are selectable text, the report buttons are plain forms to the report
 * route, and the page works without JavaScript (the sticky bar is then simply not there).
 */
const ssr = require('openvibe-publishing/ssr');
const kit = require('openvibe-shared/kit');

const { html: h, raw } = ssr;
const k = (markup) => raw(String(markup));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const { isProductDeal, headline, shopTab, merchantTrend, couponCard, regionName, BASIS_LABEL } = require('./pages');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Below this many reports a code's rate is not shown at all: the page says only that validity is unknown. */
const MIN_REPORTS = 5;
const DAY = 86400000;

const ORIGIN = {
    member: 'submitted by a member',
    staff: 'set by staff',
    source: 'imported from a source',
    ai: 'found by an AI workflow and reviewed by staff',
};

/** Who said what about a code in the last 30 days: how many said it worked, how many said it did not. */
function tally(v) {
    const worked = Number(v.reports && v.reports.worked) || 0;
    const failed = Number(v.reports && v.reports.failed) || 0;
    return { worked, failed, total: worked + failed };
}

/** The share of people whose report said it worked — only with enough reports for the share to mean something. */
function workedShare(v) {
    const t = tally(v);
    return t.total >= MIN_REPORTS ? t.worked / t.total : null;
}

/** The status line: "87% worked (23 reports)", or, under five reports, only that the validity is unknown. */
function statusText(v) {
    const t = tally(v);
    if (t.total >= MIN_REPORTS) return `${Math.round((t.worked / t.total) * 100)}% worked (${t.total} report${t.total === 1 ? '' : 's'})`;
    if (t.total > 0) return `Validity unknown (${t.total} report${t.total === 1 ? '' : 's'})`;
    return 'Validity unknown';
}

/** When the last report came, in this site's own words: "Last report 30 Oct around 14:00 UTC". */
function lastReport(v, now, windowDays) {
    const at = v.reports && v.reports.last_report_at;
    const t = at ? Date.parse(at) : NaN;
    if (!Number.isFinite(t)) return { text: `No reports in the last ${windowDays} days`, iso: null, recent: false, ever: false };
    if (now - t > windowDays * DAY) return { text: `No reports in the last ${windowDays} days`, iso: at, recent: false, ever: true };
    const d = new Date(t);
    const year = d.getUTCFullYear() === new Date(now).getUTCFullYear() ? '' : ` ${d.getUTCFullYear()}`;
    const hh = String(d.getUTCHours()).padStart(2, '0');
    return { text: `Last report ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year} around ${hh}:00 UTC`, iso: at, recent: true, ever: true };
}

/** The expiry as it was stated: a day (end of that day in UTC) or a moment. */
function expiryOf(v) {
    const e = v.expiry || {};
    if (!e.known || !e.expires_at) return null;
    const iso = String(e.expires_at);
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return null;
    const instant = e.precision === 'instant';
    const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    return {
        instant,
        short: instant ? `Expires ${day} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC` : `Expires ${day} (end of day, UTC)`,
        full: instant ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : `${iso.slice(0, 10)} (end of that day in UTC; the merchant's time zone is not stated)`,
        basis: e.basis || null,
        said: BASIS_LABEL[e.basis] || null,
    };
}

/** The stated restrictions as words (none stated is none stated, never "no restrictions"). */
function restrictionText(list) {
    return (list || []).map((r) => {
        if (r.kind === 'min_spend') return `Minimum spend ${r.amount}`;
        if (r.kind === 'category') return `Category: ${r.value}`;
        if (r.kind === 'new_customers_only') return 'New customers only';
        if (r.kind === 'region') return `Region: ${regionName(r.value)}`;
        return r.value;
    });
}

function recency(v) {
    const t = v.reports && v.reports.last_report_at ? Date.parse(v.reports.last_report_at) : NaN;
    return Number.isFinite(t) ? t : 0;
}

/**
 * The order the codes are read in: the one with the most evidence of working first. A code needs five
 * reports before its rate counts; then the higher share of people who said it worked wins, and then the more
 * recent report. A code nobody reported recently can never come first.
 */
function byEvidence(a, b) {
    const ta = tally(a), tb = tally(b);
    const sa = workedShare(a), sb = workedShare(b);
    if (sa != null && sb != null) return sa === sb ? recency(b) - recency(a) : sb - sa;
    if (sa != null) return -1;
    if (sb != null) return 1;
    if (ta.total !== tb.total) return tb.total - ta.total;
    return recency(b) - recency(a);
}

function hostOf(u) { try { return new URL(u).hostname; } catch { return u; } }
function hidden(csrf) { return csrf ? h`<input type="hidden" name="csrf" value="${csrf}">` : ''; }

/** The Copy button: it works only where the clipboard works (the kit shows it then), and copies the code. */
function copyButton(id, { small = false, kind = '' } = {}) {
    return kit.button({ type: 'button', label: 'Copy', icon: 'copy', small, kind, attrs: { 'data-ovk-copy': `#${id}`, hidden: true } });
}

/** The two report buttons: plain forms to the report route, so they work without JavaScript. */
function reportForms(v, { csrf, back }) {
    const token = csrf ? `<input type="hidden" name="csrf" value="${esc(csrf)}">` : '';
    const one = (outcome, label) => `<form method="post" action="/c/${v.id}/report" class="ovk-inline cpn-vote-form">${token}<input type="hidden" name="outcome" value="${outcome}"><input type="hidden" name="back" value="${esc(back)}"><button type="submit" class="cpn-vote">${label}</button></form>`;
    return raw(one('worked', 'It worked') + one('failed', 'It didn\'t work'));
}

/** The best code, first on the page: the code in a dashed box, its rate, when it was last reported and its expiry. */
function bestCard(v, { now, windowDays, csrf, back }) {
    const lr = lastReport(v, now, windowDays);
    const ex = expiryOf(v);
    const limits = restrictionText(v.restrictions);
    const codeId = v.id;
    return h`<section class="cpn-best-card" id="cpn-best-card" aria-labelledby="cpn-best-h">
<h2 class="cpn-best-label" id="cpn-best-h">Best code right now</h2>
<p class="cpn-best-head"><strong class="cpn-off">${headline(v)}</strong> <a class="cpn-best-title" href="/c/${v.id}">${v.title}</a></p>
<div class="cpn-codebox"><code class="cpn-codetext" id="${codeId}">${v.code}</code>${k(copyButton(codeId))}</div>
<p class="cpn-status-line">${statusText(v)}</p>
<p class="cpn-meta">${lr.iso ? h`<time datetime="${lr.iso}">${lr.text}</time>` : lr.text}</p>
<p class="cpn-meta">${ex ? h`${ex.short}${ex.said ? h` (${ex.said})` : ''}` : h`<span class="unknown">Expiry unknown</span>`}</p>
${limits.length ? h`<p class="cpn-meta cpn-limits">${limits.join(' · ')}</p>` : h`<p class="cpn-meta cpn-limits">No restrictions stated. That does not mean there are none.</p>`}
<div class="cpn-votes">${reportForms(v, { csrf, back })}</div>
</section>`;
}

/** One code as a compact row: the code, the same facts and the same buttons. */
function codeRow(v, { now, windowDays, csrf, back }) {
    const lr = lastReport(v, now, windowDays);
    const ex = expiryOf(v);
    const facts = [statusText(v), lr.text, ex ? (ex.said ? `${ex.short} (${ex.said})` : ex.short) : 'Expiry unknown'];
    const limits = restrictionText(v.restrictions);
    const codeId = v.id;
    return kit.row({
        titleHtml: `<a class="cpn-row-code" href="/c/${v.id}"><code>${esc(v.code)}</code></a> <span class="cpn-row-off">${esc(headline(v))}</span>`,
        subHtml: `<span class="cpn-row-facts">${esc(facts.join(' · '))}</span>${limits.length ? `<span class="cpn-row-limits">${esc(limits.join(' · '))}</span>` : ''}`,
        trail: `${copyButton(codeId, { small: true, kind: 'quiet' })}${reportForms(v, { csrf, back })}`,
    });
}

/** A code that ended: what it was and when it ended. */
function endedRow(v) {
    const ex = expiryOf(v);
    const when = v.expired_at ? String(v.expired_at).slice(0, 10) : (ex ? ex.full.split(' ')[0] : '');
    return kit.row({
        titleHtml: `<code>${esc(v.code)}</code> <span class="cpn-row-off">${esc(v.title)}</span>`,
        subHtml: `<span class="cpn-row-facts">${esc([when ? `Ended ${when}` : 'Ended', ex ? ex.short : 'Expiry unknown'].join(' · '))}</span>`,
    });
}

/** The About tab: the quick facts this site backs — where a code came from, what it is restricted to, when it ends. */
function aboutTab({ m, domains, hints, codes, price, now, windowDays }) {
    const facts = codes.map((v) => {
        const ex = expiryOf(v);
        const lr = lastReport(v, now, windowDays);
        const origin = ORIGIN[v.origin] || 'submitted by a member';
        const evidence = (v.evidence || []).filter((e) => e.url);
        const limits = restrictionText(v.restrictions);
        return h`<div class="cpn-fact">
<h3><code>${v.code}</code> — ${v.title}</h3>
<ul class="cpn-fact-list">
<li>Origin: ${origin}${evidence.length ? h` — <a href="${evidence[0].url}" rel="nofollow ugc noopener">${hostOf(evidence[0].url)}</a>${evidence[0].retrieved_at ? ` (retrieved ${String(evidence[0].retrieved_at).slice(0, 10)})` : ''}` : ' (no link recorded)'}</li>
${limits.length ? h`<li>Restrictions: ${limits.join('; ')}</li>` : h`<li>Restrictions: no restrictions stated. That does not mean there are none.</li>`}
<li>Expiry: ${ex ? h`${ex.full}${ex.said ? `, ${ex.said}` : ''}` : h`<span class="unknown">unknown</span> (nobody stated one)`}</li>
<li>${lr.ever ? lr.text : 'No report yet'}</li>
</ul>
</div>`;
    });
    return h`<section class="ovk-section">
<h2>The shop</h2>
<p class="ovk-note">${m.homepage_url ? h`<a href="${m.homepage_url}" rel="nofollow noopener">${hostOf(m.homepage_url)}</a>. ` : ''}Covers ${domains.map((d, i) => h`${i ? '; ' : ''}${d.host}${d.path_prefix || ''}${d.include_subdomains ? ' and its subdomains' : ''}`)}.</p>
${m.description ? h`<p class="ovk-note">${m.description}</p>` : ''}
${hints.length ? h`<ul class="hints ovk-note">${hints.map((x) => h`<li>How to apply codes here: ${x.text}</li>`)}</ul>` : ''}
${price ? h`<p class="ovk-note">Latest price we observed at this shop: ${price.price}${price.currency ? ` ${price.currency}` : ''}${price.name ? ` for ${price.name}` : ''} (observed ${String(price.observed_at).slice(0, 10)}, OpenVibe.Deals).</p>` : ''}
</section>
${facts.length ? h`<section class="ovk-section"><h2>Quick facts</h2>
<p class="ovk-note">What we can back for each code: where it came from, what it is restricted to and when it ends. A code's validity comes only from people's reports.</p>
${facts}</section>` : h`<section class="ovk-section"><h2>Quick facts</h2><p class="ovk-note">This shop has no codes right now, so there is nothing to show here yet.</p></section>`}
<section class="ovk-section"><h2>How codes are labelled</h2><p class="ovk-note">A code is only called working when people reported recently that it worked; nobody else can set that, not the submitter, not staff, not a source, not an AI model. An expiry is shown only when someone stated it, and restrictions only when they were stated. <a href="/about">The whole method</a>.</p></section>
<p class="meta">Follow: <a href="/m/${m.slug}/feed.xml">RSS</a> · <a href="/m/${m.slug}.json">JSON</a></p>`;
}

/**
 * The store page. codes: the shop's active codes (a code for the whole shop), deals: the codes for one product,
 * ended: the codes that ended, reportsThisWeek: how many reports the shop's codes collected this week.
 */
function storePage({ m, domains, hints, codes, deals, ended, reportsThisWeek, price, now, windowDays, viewer, csrf, watching, back, flashMsg, tab = 'codes', success = null }) {
    const base = `/m/${m.slug}`;
    const host = (domains[0] && domains[0].host) || (m.homepage_url ? hostOf(m.homepage_url) : m.name);
    const all = [...codes, ...deals];
    const best = all.slice().sort(byEvidence)[0] || null;
    const others = codes.filter((v) => !best || v.id !== best.id).sort(byEvidence);
    const signedIn = Boolean(viewer && viewer.kind === 'user');

    // The tabs: a count only when there is something to count, so no tab ever reads "Codes 0".
    const tabs = kit.tabs({ base, active: tab, label: `${m.name} sections`, items: [
        { key: 'codes', label: 'Codes', count: codes.length ? String(codes.length) : null },
        { key: 'deals', label: 'Product deals', count: deals.length ? String(deals.length) : null },
        { key: 'about', label: 'About' },
    ] });

    const watchForm = signedIn
        ? String(h`<form method="post" action="${base}/watch" class="ovk-inline">${hidden(csrf)}<input type="hidden" name="action" value="${watching ? 'unwatch' : 'watch'}">${k(kit.iconButton({ icon: 'bell', label: watching ? `Stop watching ${m.name} (while you watch, new codes reach your OpenVibe notifications)` : `Watch ${m.name} (private to you; new codes reach your OpenVibe notifications)`, kind: watching ? 'on' : '' }))}</form>`)
        : '';
    const head = kit.head({
        titleHtml: `<span class="cpn-shop-title">${k(kit.mark({ name: m.name, square: true }))}<span class="cpn-shop-name">${esc(m.name)}</span></span>`,
        subHtml: `${m.homepage_url ? `<a href="${esc(m.homepage_url)}" rel="nofollow noopener">${esc(host)}</a>` : `<span class="cpn-shop-name">${esc(host)}</span>`}<span class="cpn-muted cpn-counts">${codes.length + deals.length ? `${String(codes.length + deals.length)} code${codes.length + deals.length === 1 ? '' : 's'}${reportsThisWeek ? ` · ${String(reportsThisWeek)} report${reportsThisWeek === 1 ? '' : 's'} this week` : ''}` : 'no codes yet'}</span>`,
        back: { href: '/', label: 'All shops' },
        actions: [watchForm, kit.iconButton({ href: `/submit?merchant=${encodeURIComponent(m.slug)}`, icon: 'plus', label: `Submit a code for ${m.name}` }),
            kit.more({ label: 'More', items: [{ href: '/about', label: 'How codes are labelled', icon: 'help' }, { href: `${base}/feed.xml`, label: 'RSS feed', icon: 'link' }, { href: `${base}.json`, label: 'As JSON', icon: 'code' }] })],
        tabs,
    });

    const flashMsgHtml = flashMsg ? h`<p class="notice" role="status">${flashMsg}</p>` : '';

    let body;
    if (tab === 'about') {
        body = h`${aboutTab({ m, domains, hints, codes: all, price, now, windowDays })}`;
    } else if (tab === 'deals') {
        body = h`<p class="ovk-note cpn-lede">Codes that take money off one product, as the source posted them.</p>
${deals.length ? h`${deals.map((v) => couponCard(v, { viewer, csrf, back, link: true, shopUrl: m.homepage_url }))}` : h`<p class="empty">No product deals for ${m.name} right now.</p>`}
${merchantTrend(success, m.name)}`;
    } else if (!codes.length) {
        // A shop with no codes says so, and offers the watch that tells us when one appears.
        body = h`<section class="cpn-empty">
<p class="cpn-empty-line">No codes for ${host} right now</p>
<p class="ovk-note">When someone reports a code that works here, it appears on this page — and, if you watch this shop, in your OpenVibe notifications.</p>
${watchLink({ m, csrf, signedIn, watching, base })}
${deals.length ? h`<p class="ovk-note">${String(deals.length)} product deal${deals.length === 1 ? '' : 's'} <a href="${base}?tab=deals">in Product deals</a>.</p>` : ''}
</section>
${ended.length ? k(kit.fold({ title: 'Expired', meta: String(ended.length), body: String(kit.list(ended.map(endedRow))) })) : ''}`;
    } else {
        body = h`${best ? bestCard(best, { now, windowDays, csrf, back }) : ''}
${others.length ? k(`<div class="cpn-list">${kit.list(others.map((v) => codeRow(v, { now, windowDays, csrf, back })), { title: 'Other codes' })}</div>`) : ''}
${merchantTrend(success, m.name)}
<p class="cpn-submit">${k(kit.button({ href: `/submit?merchant=${encodeURIComponent(m.slug)}`, label: `Submit a code for ${m.name}`, icon: 'plus', kind: 'quiet', small: true }))}</p>
${ended.length ? k(kit.fold({ title: 'Expired', meta: String(ended.length), body: String(kit.list(ended.map(endedRow))) })) : ''}`;
    }

    // The slim bar: the best code stays one tap away while the page is scrolled. It is there only with
    // JavaScript (the kit's script shows it when the best code leaves the screen).
    const sticky = best ? h`<div class="cpn-sticky" id="cpn-sticky" hidden>
<span class="cpn-sticky-label">Best code</span>
<code class="cpn-sticky-code">${best.code}</code>
${k(copyButton(best.id, { small: true }))}
</div>` : '';

    return h`${k(head)}
${flashMsgHtml}
${body}
${sticky}`;
}

/**
 * The few lines that show the slim bar once the best code has left the screen. Without JavaScript the bar
 * stays hidden: the page itself never depends on it.
 */
const STICKY_SCRIPT = '<script>document.addEventListener(' + '"DOMContentLoaded"' + ',function(){var bar=document.getElementById(' + '"cpn-sticky"' + '),card=document.getElementById(' + '"cpn-best-card"' + ');if(!bar||!card||!(' + '"IntersectionObserver" in window))return;new IntersectionObserver(function(entries){for(var i=0;i<entries.length;i++){bar.hidden=entries[i].isIntersecting;}},{threshold:0}).observe(card);});</script>';

/** The watch, as a link or a button: "Tell me when one appears". */
function watchLink({ m, csrf, signedIn, watching, base }) {
    if (signedIn && watching) return h`<p class="ovk-note">You are watching this shop: a new code reaches your OpenVibe notifications.</p>`;
    if (signedIn) return h`<form method="post" action="${base}/watch" class="ovk-inline">${hidden(csrf)}<input type="hidden" name="action" value="watch"><button type="submit" class="ovk-btn ovk-btn--primary">Tell me when one appears</button></form>`;
    return h`<p class="ovk-note"><a class="ovk-btn ovk-btn--primary" href="/auth/login?next=${encodeURIComponent(base)}">Tell me when one appears</a></p>`;
}

module.exports = { storePage, STICKY_SCRIPT, statusText, lastReport, expiryOf, byEvidence, workedShare, tally, MIN_REPORTS };
