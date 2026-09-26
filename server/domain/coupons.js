'use strict';

/** A reason in a public event is a short code; a staff note or a calling service's free text never leaves Coupons. */
function publicReason(reason) {
    const r = String(reason || '');
    if (r.startsWith('staff:')) return 'staff';
    return /^[a-z][a-z0-9_]{0,39}$/.test(r) ? r : 'other';
}

/**
 * Codes: submission, restrictions, hints, evidence, status and confidence, expiry.
 *
 * Status is exactly unknown | reported_working | reported_failed | expired | disabled, and only
 * three things move it:
 *   - people's reports (reports.js) through the confidence formula (confidence.js);
 *   - time: a known expiry passing (and old reports decaying back to unknown);
 *   - staff or a service holding coupons.status.update, and only to disabled / expired / back to
 *     active (which recomputes from reports). Nobody can SET reported_working or reported_failed.
 * A submission never carries a status or a confidence: those fields are refused, from people, from
 * services and from AI output alike.
 *
 * Unknown stays unknown: expires_at NULL is "expiry unknown" (never defaulted), confidence NULL is
 * "no recent reports", and "no restrictions stated" is not "no restrictions".
 *
 * Active results = published review state, merchant active, status not expired/disabled, and
 * (expires_at IS NULL OR expires_at > now). The time condition is in the query itself, so a code
 * leaves every active list at the instant it expires, before the sweep records the transition.
 */
const { ids } = require('openvibe-contracts');
const { ApiError } = require('../http/errors');
const confidence = require('./confidence');
const hosts = require('./hosts');

const ACTIVE_SQL = `c.review_state = 'published' AND c.status NOT IN ('expired','disabled')
                    AND (c.expires_at IS NULL OR c.expires_at > @now) AND m.status = 'active'`;

const CODE_RE = /^[\x21-\x7E]{1,64}$/;
const REGION_RE = /^[A-Z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'XAF', 'XOF', 'PYG', 'RWF', 'KMF', 'GNF', 'DJF', 'BIF', 'VUV', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'KWD', 'OMR', 'JOD', 'TND', 'IQD', 'LYD']);
const FORBIDDEN_FIELDS = ['status', 'confidence', 'verified', 'working', 'valid', 'validity'];
const DAY = 24 * 60 * 60 * 1000;

const exponent = (cur) => (ZERO_DECIMAL.has(cur) ? 0 : THREE_DECIMAL.has(cur) ? 3 : 2);
const text = (v, max) => (v == null ? '' : String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max));
const asList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : String(v).split(','));

/** '50' | '49.99' | 50 in `currency` → minor units, or throws. */
function toMinor(amount, currency) {
    const s = String(amount).trim();
    const e = exponent(currency);
    const re = e === 0 ? /^\d{1,9}$/ : new RegExp(`^\\d{1,9}(\\.\\d{1,${e}})?$`);
    if (!re.test(s)) throw new ApiError(422, 'coupon.bad_min_spend', `min spend must be a plain amount with at most ${e} decimals`);
    const [whole, frac = ''] = s.split('.');
    return Number(whole) * 10 ** e + Number((frac + '000').slice(0, e) || 0);
}

function formatMinor(minor, currency) {
    const e = exponent(currency);
    const v = minor / 10 ** e;
    try { return new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: e, maximumFractionDigits: e }).format(v); } catch { return `${v.toFixed(e)} ${currency}`; }
}

/**
 * Expiry input → { expires_at, expires_precision } | null (unknown).
 * 'YYYY-MM-DD' → the end of that day in UTC (the merchant's time zone is not known; documented);
 * a date-time needs an explicit offset or Z (a zone-less time is ambiguous and refused).
 */
function parseExpiry(v, now) {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    let at;
    let precision;
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
        at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
        const d = new Date(at);
        if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) at = NaN;
        precision = 'date';
    } else if ((m = s.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/))) {
        at = Date.parse(s);
        precision = 'instant';
    } else if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
        throw new ApiError(422, 'coupon.ambiguous_expiry', 'an expiry time needs a time zone (Z or ±hh:mm); or give just the date');
    } else {
        throw new ApiError(422, 'coupon.bad_expiry', 'expires must be YYYY-MM-DD or an ISO 8601 date-time with a time zone');
    }
    if (!Number.isFinite(at)) throw new ApiError(422, 'coupon.bad_expiry', 'expires is not a real date');
    if (at <= now) throw new ApiError(422, 'coupon.already_expired', 'that expiry has already passed');
    if (at > now + 5 * 365 * DAY) throw new ApiError(422, 'coupon.bad_expiry', 'expiry more than five years ahead');
    return { expires_at: at, expires_precision: precision };
}

/** Restrictions input (API object or form fields) → rows. Nothing stated → []. */
function parseRestrictions(r = {}) {
    const out = [];
    const min = r.min_spend;
    if (min && (min.amount !== undefined && min.amount !== '')) {
        const currency = String(min.currency || '').trim().toUpperCase();
        if (!CURRENCY_RE.test(currency)) throw new ApiError(422, 'coupon.bad_currency', 'min spend needs an ISO 4217 currency (e.g. USD)');
        out.push({ kind: 'min_spend', value: null, amount_minor: toMinor(min.amount, currency), currency });
    }
    const cats = asList(r.categories).map((c) => text(c, 60)).filter(Boolean);
    if (cats.length > 10) throw new ApiError(422, 'coupon.too_many_categories', 'at most 10 categories');
    for (const c of new Set(cats)) out.push({ kind: 'category', value: c });
    if (r.new_customers_only === true || r.new_customers_only === 'true' || r.new_customers_only === 'on' || r.new_customers_only === '1') {
        out.push({ kind: 'new_customers_only', value: null });
    }
    const regions = asList(r.regions).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
    for (const x of regions) if (!REGION_RE.test(x)) throw new ApiError(422, 'coupon.bad_region', `region ${x} is not an ISO 3166-1 alpha-2 code`);
    if (regions.length > 50) throw new ApiError(422, 'coupon.too_many_regions', 'at most 50 regions');
    for (const x of new Set(regions)) out.push({ kind: 'region', value: x });
    const other = text(r.other, 300);
    if (other) out.push({ kind: 'other', value: other });
    return out;
}

/** Validate a submission body. → normalized input. */
function parseSubmission(body, now) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(422, 'request.invalid', 'body must be an object');
    for (const f of FORBIDDEN_FIELDS) {
        if (body[f] !== undefined) throw new ApiError(422, 'coupon.status_not_accepted', `"${f}" cannot be submitted: a code's status comes only from people's reports`);
    }
    const code = String(body.code == null ? '' : body.code).trim();
    if (!CODE_RE.test(code)) throw new ApiError(422, 'coupon.bad_code', 'code must be 1–64 printable characters without spaces');
    const title = text(body.title, 140);
    if (title.length < 3) throw new ApiError(422, 'coupon.title_required', 'title (what the code gives, e.g. "15% off shoes") is required');
    const expiry = parseExpiry(body.expires, now);
    let basis = null;
    if (expiry) basis = body.expiry_basis === 'evidence' ? 'evidence' : 'submitter';
    let evidence = null;
    if (body.evidence_url) {
        const u = String(body.evidence_url).trim();
        if (u.length > 2048 || !hosts.hostOfUrl(u)) throw new ApiError(422, 'coupon.bad_evidence', 'evidence_url must be an http(s) URL of a public site');
        evidence = new URL(u).toString();
    }
    if (basis === 'evidence' && !evidence) throw new ApiError(422, 'coupon.evidence_required', 'an expiry "stated on the evidence page" needs the evidence URL');
    const aiRun = body.ai_run_id == null ? null : text(body.ai_run_id, 64);
    return {
        code, code_key: code.toUpperCase(), title,
        description: text(body.description, 1000) || null,
        expiry, expiry_basis: basis, evidence_url: evidence,
        restrictions: parseRestrictions(body.restrictions || {}),
        hint: text(body.hint, 300) || null,
        ai_run_id: aiRun,
    };
}

function createCoupons({ store, merchants, publication, outbox = null }) {
    const { db } = store;
    const q = {
        byId: db.prepare('SELECT * FROM coupons WHERE id = ?'),
        byKey: db.prepare('SELECT * FROM coupons WHERE merchant_id = ? AND code_key = ?'),
        insert: db.prepare(`INSERT INTO coupons (id, merchant_id, code, code_key, title, description, status, confidence, review_state, origin,
                                                 expires_at, expires_precision, expiry_basis, created_by, created_at, updated_at)
                            VALUES (@id, @merchant_id, @code, @code_key, @title, @description, 'unknown', NULL, @review_state, @origin,
                                    @expires_at, @expires_precision, @expiry_basis, @created_by, @now, @now)`),
        restrictionInsert: db.prepare('INSERT INTO coupon_restrictions (coupon_id, kind, value, amount_minor, currency, created_at) VALUES (@coupon_id, @kind, @value, @amount_minor, @currency, @now)'),
        restrictions: db.prepare('SELECT kind, value, amount_minor, currency FROM coupon_restrictions WHERE coupon_id = ? ORDER BY id'),
        hintInsert: db.prepare('INSERT INTO coupon_application_hints (merchant_id, coupon_id, text, created_by, created_at) VALUES (?, ?, ?, ?, ?)'),
        hints: db.prepare('SELECT id, coupon_id, text FROM coupon_application_hints WHERE merchant_id = ? AND (coupon_id IS NULL OR coupon_id = ?) ORDER BY coupon_id IS NOT NULL, id'),
        merchantHints: db.prepare('SELECT id, coupon_id, text FROM coupon_application_hints WHERE merchant_id = ? AND coupon_id IS NULL ORDER BY id'),
        sourceInsert: db.prepare(`INSERT INTO coupon_sources (coupon_id, kind, evidence_url, merchant_evidence, sources_item_id, sources_item_rev, source_key, retrieved_at, ai_run_id, submitted_by, created_at)
                                  VALUES (@coupon_id, @kind, @evidence_url, @merchant_evidence, @sources_item_id, @sources_item_rev, @source_key, @retrieved_at, @ai_run_id, @submitted_by, @now)`),
        sources: db.prepare('SELECT * FROM coupon_sources WHERE coupon_id = ? ORDER BY id'),
        sameEvidence: db.prepare('SELECT 1 FROM coupon_sources WHERE coupon_id = ? AND evidence_url = ? AND removed_at IS NULL'),
        merchantEvidence: db.prepare('SELECT 1 FROM coupon_sources WHERE coupon_id = ? AND merchant_evidence = 1 AND removed_at IS NULL LIMIT 1'),
        submittedSince: db.prepare('SELECT COUNT(*) AS n FROM coupon_sources WHERE submitted_by = ? AND created_at > ?'),
        reportsFor: db.prepare('SELECT reporter_key, outcome, updated_at FROM coupon_validation_reports WHERE coupon_id = ? AND updated_at > ?'),
        update: db.prepare(`UPDATE coupons SET status = @status, confidence = @confidence, status_reason = @status_reason, expired_at = @expired_at,
                            disabled_at = @disabled_at, updated_at = @now WHERE id = @id`),
        history: db.prepare(`INSERT INTO coupon_status_history (coupon_id, from_status, to_status, confidence_before, confidence_after, reason, actor, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        historyFor: db.prepare('SELECT from_status, to_status, confidence_before, confidence_after, reason, created_at FROM coupon_status_history WHERE coupon_id = ? ORDER BY id DESC LIMIT 50'),
        active: db.prepare(`SELECT c.* FROM coupons c JOIN coupon_merchants m ON m.id = c.merchant_id WHERE c.merchant_id = @merchant AND ${ACTIVE_SQL}
                            ORDER BY CASE c.status WHEN 'reported_working' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END, COALESCE(c.last_worked_at, 0) DESC, c.created_at DESC LIMIT 200`),
        activeCount: db.prepare(`SELECT COUNT(*) AS n FROM coupons c JOIN coupon_merchants m ON m.id = c.merchant_id WHERE c.merchant_id = @merchant AND ${ACTIVE_SQL}`),
        recentlyEnded: db.prepare(`SELECT c.* FROM coupons c JOIN coupon_merchants m ON m.id = c.merchant_id
                                   WHERE c.merchant_id = @merchant AND c.review_state = 'published' AND m.status = 'active'
                                     AND (c.status = 'expired' OR (c.expires_at IS NOT NULL AND c.expires_at <= @now)) AND c.status <> 'disabled'
                                   ORDER BY COALESCE(c.expired_at, c.expires_at) DESC LIMIT 10`),
        recentActive: db.prepare(`SELECT c.* FROM coupons c JOIN coupon_merchants m ON m.id = c.merchant_id WHERE ${ACTIVE_SQL}
                                  ORDER BY c.created_at DESC LIMIT @limit`),
        allActive: db.prepare(`SELECT c.* FROM coupons c JOIN coupon_merchants m ON m.id = c.merchant_id WHERE ${ACTIVE_SQL} ORDER BY c.created_at DESC LIMIT 50000`),
        dueExpiry: db.prepare(`SELECT id FROM coupons WHERE expires_at IS NOT NULL AND expires_at <= ? AND status NOT IN ('expired','disabled') LIMIT 500`),
        decaying: db.prepare(`SELECT DISTINCT c.id FROM coupons c LEFT JOIN coupon_validation_reports r ON r.coupon_id = c.id
                              WHERE c.status NOT IN ('expired','disabled') AND (c.confidence IS NOT NULL OR c.status <> 'unknown' OR r.updated_at > ?) LIMIT 2000`),
        pendingReview: db.prepare(`SELECT c.* FROM coupons c WHERE c.review_state = 'pending' AND c.status <> 'disabled' ORDER BY c.created_at LIMIT 200`),
        setReview: db.prepare("UPDATE coupons SET review_state = 'published', updated_at = ? WHERE id = ? AND review_state = 'pending'"),
        setExpiry: db.prepare('UPDATE coupons SET expires_at = ?, expires_precision = ?, expiry_basis = ?, updated_at = ? WHERE id = ?'),
        reportCounts: db.prepare(`SELECT outcome, COUNT(*) AS n FROM (
                                      SELECT reporter_key, outcome, MAX(updated_at) AS t FROM coupon_validation_reports WHERE coupon_id = ? AND updated_at > ? GROUP BY reporter_key)
                                  GROUP BY outcome`),
        byMerchantPending: db.prepare("SELECT id FROM coupons WHERE merchant_id = ? AND review_state = 'pending'"),
        ofMerchant: db.prepare('SELECT id FROM coupons WHERE merchant_id = ?'),
    };

    const get = (id) => q.byId.get(String(id || ''));

    function restrictionsOf(id) { return q.restrictions.all(id); }

    function restrictionsText(rows) {
        return rows.map((r) => {
            if (r.kind === 'min_spend') return `Minimum spend ${formatMinor(r.amount_minor, r.currency)}`;
            if (r.kind === 'category') return `Category: ${r.value}`;
            if (r.kind === 'new_customers_only') return 'New customers only';
            if (r.kind === 'region') return `Region: ${r.value}`;
            return r.value;
        }).join('\n');
    }

    function sourceRefs(id) {
        return q.sources.all(id).filter((s) => s.sources_item_id && !s.removed_at)
            .map((s) => ({ service: 'sources', type: 'item', id: s.sources_item_id, ...(Number.isInteger(s.sources_item_rev) ? { revision: s.sources_item_rev } : {}), ...(s.evidence_url ? { url: s.evidence_url } : {}), ...(s.retrieved_at ? { retrievedAt: s.retrieved_at } : {}) }));
    }

    function activeCount(merchantId) { return q.activeCount.get({ merchant: merchantId, now: store.now() }).n; }

    /** Send the Search documents of a code and its merchant (inside a transaction). */
    function syncIndex(c, { traceparent } = {}) {
        const m = merchants.byId(c.merchant_id);
        publication.sendDocument(publication.couponDocument(c, m, { restrictionsText: restrictionsText(restrictionsOf(c.id)), sourceRefs: sourceRefs(c.id) }), { traceparent });
        if (m) publication.sendDocument(publication.merchantDocument(m, activeCount(m.id)), { traceparent });
    }

    function syncMerchant(m, { traceparent } = {}) {
        publication.sendDocument(publication.merchantDocument(m, activeCount(m.id)), { traceparent });
        for (const { id } of q.ofMerchant.all(m.id)) {
            const c = get(id);
            publication.sendDocument(publication.couponDocument(c, m, { restrictionsText: restrictionsText(restrictionsOf(c.id)), sourceRefs: sourceRefs(c.id) }), { traceparent });
        }
    }

    function publiclyListed(c) {
        const m = merchants.byId(c.merchant_id);
        return Boolean(m && m.status === 'active' && confidence.isActive(c, store.now()));
    }

    function lifecyclePayload(c, extra = {}) {
        return { merchant_id: c.merchant_id, status: c.status, confidence: c.confidence, review_state: c.review_state,
            expires_at: c.expires_at != null ? new Date(c.expires_at).toISOString() : null, canonical_url: publication.couponUrl(c), ...extra };
    }

    /**
     * Recompute status and confidence from reports and time (inside a transaction), record the
     * change in coupon_status_history, emit events and Search documents.
     * forceStatus: 'disabled' | 'expired' | 'unknown' (re-enable) for staff/service changes.
     */
    function recompute(id, { reason, actor = 'system', forceStatus = null, traceparent } = {}) {
        const before = get(id);
        if (!before) return null;
        const now = store.now();
        let base = before;
        if (forceStatus === 'disabled') base = { ...before, status: 'disabled' };
        else if (forceStatus === 'expired') base = { ...before, status: 'expired', expired_at: now };
        else if (forceStatus === 'unknown') base = { ...before, status: 'unknown', expired_at: null, disabled_at: null };
        const reports = q.reportsFor.all(id, now - confidence.WINDOW_DAYS * DAY);
        const ev = confidence.evaluate(base, reports, { merchantEvidence: Boolean(q.merchantEvidence.get(id)), now });
        const statusChanged = ev.status !== before.status;
        const confChanged = ev.confidence !== before.confidence;
        if (!statusChanged && !confChanged && !forceStatus) return before;
        let expiredAt = null;
        if (ev.status === 'expired') expiredAt = before.status === 'expired' && before.expired_at ? before.expired_at : (before.expires_at != null && before.expires_at <= now ? before.expires_at : now);
        q.update.run({
            id, status: ev.status, confidence: ev.confidence, now,
            status_reason: statusChanged || forceStatus ? reason : before.status_reason,
            expired_at: expiredAt,
            disabled_at: ev.status === 'disabled' ? (before.disabled_at || now) : null,
        });
        const after = get(id);
        if (statusChanged || confChanged) q.history.run(id, before.status, after.status, before.confidence, after.confidence, reason, actor, now);
        if (statusChanged) {
            const type = after.status === 'expired' ? 'coupons.coupon.expired' : after.status === 'disabled' ? 'coupons.coupon.disabled' : 'coupons.coupon.updated';
            publication.emit(type, { type: 'coupon', id }, lifecyclePayload(after, { previous_status: before.status, reason: publicReason(reason) }), { isPublic: publiclyListed(after) || publiclyListed(before), traceparent });
        }
        if (confChanged) {
            publication.emit('coupons.confidence.changed', { type: 'coupon', id }, { merchant_id: after.merchant_id, from: before.confidence, to: after.confidence, status: after.status }, { traceparent });
        }
        syncIndex(after, { traceparent });
        return after;
    }

    function addSource(couponId, merchant, { kind, evidence_url = null, sources_item_id = null, sources_item_rev = null, source_key = null, retrieved_at = null, ai_run_id = null, submitted_by = null }) {
        q.sourceInsert.run({
            coupon_id: couponId, kind, evidence_url, merchant_evidence: evidence_url && merchants.ownsUrl(merchant, evidence_url) ? 1 : 0,
            sources_item_id, sources_item_rev, source_key, retrieved_at, ai_run_id, submitted_by, now: store.now(),
        });
    }

    function checkSubmissionRate(actorId, limits) {
        const now = store.now();
        if (q.submittedSince.get(actorId, now - 60 * 60 * 1000).n >= limits.submissionsPerHour
            || q.submittedSince.get(actorId, now - DAY).n >= limits.submissionsPerDay) {
            throw new ApiError(429, 'submission.rate_limited', 'too many submissions; try again later');
        }
    }

    /**
     * Create a code (or add evidence to the same code). Inside one transaction.
     * who: { actor: usr_…|svc:…, kind: 'member'|'staff'|'ai', subject }
     * target: { merchant } (resolved by the caller)
     * → { coupon, merchant, duplicate, created }
     */
    function submit(who, merchant, input, { limits, traceparent } = {}) {
        checkSubmissionRate(who.actor, limits);
        return store.tx(() => {
            const existing = q.byKey.get(merchant.id, input.code_key);
            if (existing) {
                if (existing.status === 'disabled') throw new ApiError(409, 'coupon.disabled', 'this code was taken down and cannot be resubmitted');
                if (existing.status === 'expired' || (existing.expires_at != null && existing.expires_at <= store.now())) {
                    throw new ApiError(409, 'coupon.expired', 'this code is recorded as expired');
                }
                if (!input.evidence_url || !q.sameEvidence.get(existing.id, input.evidence_url)) {
                    addSource(existing.id, merchant, { kind: who.kind, evidence_url: input.evidence_url, ai_run_id: input.ai_run_id, submitted_by: who.actor });
                    recompute(existing.id, { reason: 'evidence', actor: 'system', traceparent });
                }
                return { coupon: get(existing.id), merchant, duplicate: true, created: false };
            }
            const now = store.now();
            const id = `cpn_${ids.ulid(now)}`;
            const review = who.kind === 'ai' || merchant.status !== 'active' ? 'pending' : 'published';
            q.insert.run({
                id, merchant_id: merchant.id, code: input.code, code_key: input.code_key, title: input.title, description: input.description,
                review_state: review, origin: who.kind,
                expires_at: input.expiry ? input.expiry.expires_at : null,
                expires_precision: input.expiry ? input.expiry.expires_precision : null,
                expiry_basis: input.expiry ? (who.kind === 'staff' && input.expiry_basis === 'submitter' ? 'staff' : input.expiry_basis) : null,
                created_by: who.actor, now,
            });
            for (const r of input.restrictions) q.restrictionInsert.run({ coupon_id: id, kind: r.kind, value: r.value ?? null, amount_minor: r.amount_minor ?? null, currency: r.currency ?? null, now });
            if (input.hint) q.hintInsert.run(merchant.id, id, input.hint, who.actor, now);
            addSource(id, merchant, { kind: who.kind, evidence_url: input.evidence_url, ai_run_id: input.ai_run_id, submitted_by: who.actor });
            q.history.run(id, null, 'unknown', null, null, 'created', who.actor, now);
            const c = get(id);
            publication.emit('coupons.coupon.created', { type: 'coupon', id }, lifecyclePayload(c, { origin: c.origin }), { isPublic: publiclyListed(c), traceparent });
            syncIndex(c, { traceparent });
            return { coupon: c, merchant, duplicate: false, created: true };
        });
    }

    /** Import one OpenVibe.Sources item as a code (inside the importer's transaction). */
    function importFromSource(merchant, item, parsed, { autoPublish }) {
        const existing = q.byKey.get(merchant.id, parsed.code_key);
        const src = {
            kind: 'source', evidence_url: item.canonical_url || null, sources_item_id: item.id, sources_item_rev: item.revision,
            source_key: item.source_key, retrieved_at: Date.parse(item.provenance && item.provenance.retrieved_at) || null, submitted_by: 'svc:sources',
        };
        if (existing) {
            const known = q.sources.all(existing.id).find((s) => s.sources_item_id === item.id);
            if (known) db.prepare('UPDATE coupon_sources SET sources_item_rev = ?, retrieved_at = ?, removed_at = NULL, removed_reason = NULL WHERE id = ?').run(item.revision, src.retrieved_at, known.id);
            else addSource(existing.id, merchant, src);
            if (existing.expires_at == null && parsed.expiry && existing.status !== 'expired') {
                q.setExpiry.run(parsed.expiry.expires_at, parsed.expiry.expires_precision, 'source', store.now(), existing.id);
            }
            recompute(existing.id, { reason: 'evidence', actor: 'svc:sources' });
            return { coupon: get(existing.id), created: false };
        }
        const now = store.now();
        const id = `cpn_${ids.ulid(now)}`;
        q.insert.run({
            id, merchant_id: merchant.id, code: parsed.code, code_key: parsed.code_key, title: parsed.title, description: parsed.description,
            review_state: autoPublish && merchant.status === 'active' ? 'published' : 'pending', origin: 'source',
            expires_at: parsed.expiry ? parsed.expiry.expires_at : null,
            expires_precision: parsed.expiry ? parsed.expiry.expires_precision : null,
            expiry_basis: parsed.expiry ? 'source' : null, created_by: 'svc:sources', now,
        });
        for (const r of parsed.restrictions) q.restrictionInsert.run({ coupon_id: id, kind: r.kind, value: r.value ?? null, amount_minor: r.amount_minor ?? null, currency: r.currency ?? null, now });
        addSource(id, merchant, src);
        q.history.run(id, null, 'unknown', null, null, 'created', 'svc:sources', now);
        const c = get(id);
        publication.emit('coupons.coupon.created', { type: 'coupon', id }, lifecyclePayload(c, { origin: 'source' }), { isPublic: publiclyListed(c) });
        syncIndex(c);
        return { coupon: c, created: true };
    }

    /** A Sources item was removed: its evidence is withdrawn; a code with no other evidence is disabled. */
    function withdrawSourceItem(itemId, reason) {
        const rows = db.prepare('SELECT * FROM coupon_sources WHERE sources_item_id = ? AND removed_at IS NULL').all(itemId);
        for (const s of rows) {
            db.prepare('UPDATE coupon_sources SET removed_at = ?, removed_reason = ? WHERE id = ?').run(store.now(), String(reason || 'removed at the source').slice(0, 300), s.id);
            const remaining = db.prepare('SELECT COUNT(*) AS n FROM coupon_sources WHERE coupon_id = ? AND removed_at IS NULL').get(s.coupon_id).n;
            if (!remaining) recompute(s.coupon_id, { reason: 'source_removed', actor: 'svc:sources', forceStatus: 'disabled' });
            else recompute(s.coupon_id, { reason: 'evidence', actor: 'svc:sources' });
        }
        return rows.length;
    }

    /**
     * Staff/service status change: 'disabled' | 'expired' | 'active' (re-enable: recomputed from
     * reports and time). reported_working / reported_failed cannot be set by anyone.
     */
    function setStatus(c, target, { actor, note = '', traceparent } = {}) {
        const why = `${actor.startsWith('svc:') ? `service:${actor.slice(4)}` : 'staff'}${note ? `:${text(note, 200)}` : ''}`;
        const force = { disabled: 'disabled', expired: 'expired', active: 'unknown' }[target];
        if (!force) throw new ApiError(422, 'coupon.status_not_settable', 'status can be set to disabled, expired or active only; working/failed come from people\'s reports');
        if (target === 'expired' && c.status === 'disabled') throw new ApiError(409, 'coupon.disabled', 'enable the code before marking it expired');
        if (target === 'active' && c.expires_at != null && c.expires_at <= store.now()) throw new ApiError(409, 'coupon.expiry_passed', 'its known expiry has passed; change the expiry first');
        return store.tx(() => {
            const after = recompute(c.id, { reason: why, actor, forceStatus: force, traceparent });
            // Staff or a staff-capable service acting on someone else's code: the moderation audit log (ADR-022).
            if (after && after.status !== c.status && actor !== c.created_by) moderated(`coupon.${target === 'active' ? 'enabled' : target}`, c, actor, { reason: note ? text(note, 200) : null, details: { previous: c.status, status: after.status }, traceparent });
            return after;
        });
    }

    /** coupons.moderation.action for a staff or service action (never the submitter; see events/outbox.js). */
    function moderated(action, c, actor, { reason = null, details = {}, traceparent } = {}) {
        if (!outbox) return null;
        const person = /^usr_/.test(String(actor || '')) ? actor : null;
        return outbox.moderationAction({ action, target: { type: 'coupon', id: c.id }, actorSubject: person, reason, details: { merchant_id: c.merchant_id, origin: c.origin, ...details } }, { traceparent });
    }

    /** Staff: publish a code that waits for review. */
    function approve(c, { actor, audit = true, traceparent } = {}) {
        return store.tx(() => {
            if (q.setReview.run(store.now(), c.id).changes !== 1) return get(c.id);
            const after = get(c.id);
            q.history.run(c.id, c.status, after.status, c.confidence, after.confidence, 'staff:approved', actor, store.now());
            if (audit && actor !== c.created_by) moderated('coupon.approved', c, actor, { traceparent });
            publication.emit('coupons.coupon.updated', { type: 'coupon', id: c.id }, lifecyclePayload(after, { previous_status: c.status, reason: 'approved' }), { isPublic: publiclyListed(after) });
            syncIndex(after);
            return after;
        });
    }

    /** Staff: set or clear a code's expiry (clear = back to unknown). */
    function setExpiry(c, value, { actor }) {
        const expiry = value ? parseExpiry(value, store.now()) : null;
        return store.tx(() => {
            q.setExpiry.run(expiry ? expiry.expires_at : null, expiry ? expiry.expires_precision : null, expiry ? 'staff' : null, store.now(), c.id);
            const updated = get(c.id);
            publication.emit('coupons.coupon.updated', { type: 'coupon', id: c.id }, lifecyclePayload(updated, { reason: 'expiry_changed' }), { isPublic: publiclyListed(updated) });
            recompute(c.id, { reason: 'staff:expiry', actor });
            syncIndex(get(c.id));
            return get(c.id);
        });
    }

    function addMerchantHint(m, hint, { actor }) {
        const t = text(hint, 300);
        if (!t) throw new ApiError(422, 'hint.empty', 'hint text is required');
        q.hintInsert.run(m.id, null, t, actor, store.now());
    }

    /**
     * The sweep: record expiries that have passed and let old reports decay. Idempotent.
     * → { expired: [ids], changed: [ids] }
     */
    function sweep() {
        const now = store.now();
        const expired = [];
        const changed = [];
        for (const { id } of q.dueExpiry.all(now)) {
            const after = store.tx(() => recompute(id, { reason: 'expiry', actor: 'system' }));
            if (after && after.status === 'expired') expired.push(id);
        }
        for (const { id } of q.decaying.all(now - (confidence.WINDOW_DAYS + 1) * DAY)) {
            const before = get(id);
            const after = store.tx(() => recompute(id, { reason: 'decay', actor: 'system' }));
            if (after && before && (after.status !== before.status || after.confidence !== before.confidence)) changed.push(id);
        }
        return { expired, changed };
    }

    /** Counted reports in the window: { worked, failed } (aggregates only, never who). */
    function reportCounts(id) {
        const out = { worked: 0, failed: 0 };
        for (const r of q.reportCounts.all(id, store.now() - confidence.WINDOW_DAYS * DAY)) out[r.outcome] = r.n;
        return out;
    }

    /**
     * The public view of a code. Never includes who submitted or reported it.
     */
    function view(c, { merchant = null } = {}) {
        const now = store.now();
        const m = merchant || merchants.byId(c.merchant_id);
        const sources = q.sources.all(c.id).filter((s) => !s.removed_at);
        const iso = (t) => (t == null ? null : new Date(t).toISOString());
        // Report times are published to the hour: enough for "last report 3 hours ago", too coarse
        // to tie a report to the moment someone made it.
        const hour = (t) => (t == null ? null : new Date(Math.floor(t / 3600000) * 3600000).toISOString());
        return {
            id: c.id,
            merchant_id: c.merchant_id,
            code: c.code,
            title: c.title,
            description: c.description,
            status: c.status,
            active: Boolean(m && m.status === 'active' && confidence.isActive(c, now)),
            confidence: c.confidence,
            reports: { ...reportCounts(c.id), window_days: confidence.WINDOW_DAYS, last_report_at: hour(c.last_report_at), last_worked_at: hour(c.last_worked_at), last_failed_at: hour(c.last_failed_at) },
            expiry: c.expires_at == null
                ? { known: false, expires_at: null, precision: null, basis: null }
                : { known: true, expires_at: iso(c.expires_at), precision: c.expires_precision, basis: c.expiry_basis },
            restrictions: restrictionsOf(c.id).map((r) => (r.kind === 'min_spend'
                ? { kind: r.kind, amount: formatMinor(r.amount_minor, r.currency), amount_minor: r.amount_minor, currency: r.currency }
                : r.kind === 'new_customers_only' ? { kind: r.kind } : { kind: r.kind, value: r.value })),
            hints: m ? q.hints.all(m.id, c.id).map((h) => ({ text: h.text, scope: h.coupon_id ? 'code' : 'merchant' })) : [],
            evidence: sources.map((s) => ({
                kind: s.kind, url: s.evidence_url, merchant_page: Boolean(s.merchant_evidence),
                ...(s.sources_item_id ? { sources_item: s.sources_item_id, retrieved_at: iso(s.retrieved_at) } : {}),
            })),
            origin: c.origin,
            created_at: iso(c.created_at),
            updated_at: iso(c.updated_at),
            expired_at: iso(c.expired_at),
            url: publication.couponUrl(c),
        };
    }

    return {
        ACTIVE_SQL, parseSubmission, parseExpiry, parseRestrictions, formatMinor, restrictionsText,
        get, submit, checkSubmissionRate, importFromSource, withdrawSourceItem, recompute, setStatus, approve, setExpiry, addMerchantHint, sweep, view,
        restrictionsOf, reportCounts, activeCount, syncIndex, syncMerchant,
        history: (id) => q.historyFor.all(id),
        active: (merchantId) => q.active.all({ merchant: merchantId, now: store.now() }),
        recentlyEnded: (merchantId) => q.recentlyEnded.all({ merchant: merchantId, now: store.now() }),
        recentActive: (limit = 30) => q.recentActive.all({ now: store.now(), limit }),
        allActive: () => q.allActive.all({ now: store.now() }),
        pendingReview: () => q.pendingReview.all(),
        pendingOfMerchant: (merchantId) => q.byMerchantPending.all(merchantId).map((r) => r.id),
        /** Publish the codes that waited only because their merchant was pending (not AI or source codes). */
        publishWaitingOn(merchant, { actor }) {
            const out = [];
            for (const id of q.byMerchantPending.all(merchant.id).map((r) => r.id)) {
                const c = get(id);
                if (c.origin === 'member' || c.origin === 'staff') out.push(approve(c, { actor, audit: false }));  // the shop's approval is the audited action
            }
            return out;
        },
        merchantHints: (merchantId) => q.merchantHints.all(merchantId),
    };
}

module.exports = { createCoupons, parseSubmission, parseExpiry, parseRestrictions, ACTIVE_SQL, FORBIDDEN_FIELDS };
