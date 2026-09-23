'use strict';

/**
 * Confidence and status from people's reports — a pure function of (reports, evidence, expiry,
 * disabled flag, now). Nothing else can make a code "working": not a submission, not a model, not
 * a source; only reports by people, and only while they are recent.
 *
 * THE FORMULA (documented in the README; tests pin it)
 *
 *   Deduplication: one row per (reporter, coupon, UTC day) is stored; of those, only each
 *   reporter's MOST RECENT report counts. Reporting the same code every day adds nothing.
 *
 *   Recency: a report of age a days weighs  w = 0.5 ^ (a / HALF_LIFE_DAYS)   (half-life 7 days)
 *            and reports older than WINDOW_DAYS (30) weigh 0.
 *
 *   W = Σ w over counted "worked" reports,  F = Σ w over counted "failed" reports.
 *
 *   Evidence: the prior is Beta(α0, β0) with β0 = 1 and α0 = 1, or 1.5 when the code has merchant
 *   evidence (it was published on one of the merchant's own domains). Evidence alone never produces
 *   a number.
 *
 *   confidence = null                                  when W + F = 0 (no counted report in the window)
 *              = (α0 + W) / (α0 + β0 + W + F)          otherwise, rounded to 2 decimals
 *
 *   status = disabled          when staff or a service disabled it
 *          = expired           when a known expiry has passed (or staff marked it expired)
 *          = unknown           when W + F < MIN_MASS (0.5: roughly one report younger than a week)
 *          = reported_working  when confidence ≥ 0.6
 *          = reported_failed   when confidence ≤ 0.4
 *          = unknown           otherwise (the reports disagree)
 *
 * So one fresh "worked" report gives 0.67 → reported_working; one fresh "failed" gives 0.33 →
 * reported_failed; one of each gives 0.5 → unknown; and a lone report decays back to unknown after
 * a week, and out of the formula (confidence null) after 30 days.
 */
const DAY = 24 * 60 * 60 * 1000;
const HALF_LIFE_DAYS = 7;
const WINDOW_DAYS = 30;
const MIN_MASS = 0.5;
const WORKING_AT = 0.6;
const FAILED_AT = 0.4;
const EVIDENCE_PRIOR = 0.5;

const round2 = (x) => Math.round(x * 100) / 100;

function weight(ageMs) {
    if (ageMs < 0) ageMs = 0;
    if (ageMs > WINDOW_DAYS * DAY) return 0;
    return Math.pow(0.5, ageMs / (HALF_LIFE_DAYS * DAY));
}

/**
 * reports: [{ reporter_key, outcome: 'worked'|'failed', updated_at }] (any order, any number per reporter)
 * → { confidence, W, F, mass, counted, derived: 'unknown'|'reported_working'|'reported_failed' }
 */
function fromReports(reports, { merchantEvidence = false, now }) {
    if (!Number.isFinite(now)) throw new TypeError('now is required');
    const latest = new Map();
    for (const r of reports) {
        const cur = latest.get(r.reporter_key);
        if (!cur || r.updated_at > cur.updated_at) latest.set(r.reporter_key, r);
    }
    let W = 0;
    let F = 0;
    let counted = 0;
    for (const r of latest.values()) {
        const w = weight(now - r.updated_at);
        if (w <= 0) continue;
        counted++;
        if (r.outcome === 'worked') W += w; else F += w;
    }
    const mass = W + F;
    if (mass <= 0) return { confidence: null, W: 0, F: 0, mass: 0, counted: 0, derived: 'unknown' };
    const a0 = 1 + (merchantEvidence ? EVIDENCE_PRIOR : 0);
    const confidence = round2((a0 + W) / (a0 + 1 + W + F));
    let derived = 'unknown';
    if (mass >= MIN_MASS) {
        if (confidence >= WORKING_AT) derived = 'reported_working';
        else if (confidence <= FAILED_AT) derived = 'reported_failed';
    }
    return { confidence, W: round2(W), F: round2(F), mass: round2(mass), counted, derived };
}

/**
 * The full status of a coupon row at `now`.
 * coupon: { status, expires_at, expired_at, disabled_at }
 * → { status, confidence, reason }
 */
function evaluate(coupon, reports, { merchantEvidence = false, now }) {
    const r = fromReports(reports, { merchantEvidence, now });
    if (coupon.status === 'disabled') return { status: 'disabled', confidence: r.confidence, detail: r };
    const expiredByTime = coupon.expires_at != null && coupon.expires_at <= now;
    if (expiredByTime || (coupon.status === 'expired' && coupon.expired_at != null)) return { status: 'expired', confidence: r.confidence, detail: r };
    return { status: r.derived, confidence: r.confidence, detail: r };
}

/** Is the coupon in active results at `now`? (Also enforced in SQL: see coupons.ACTIVE_SQL.) */
function isActive(coupon, now) {
    if (coupon.review_state !== 'published') return false;
    if (coupon.status === 'expired' || coupon.status === 'disabled') return false;
    return coupon.expires_at == null || coupon.expires_at > now;
}

module.exports = {
    fromReports, evaluate, isActive, weight,
    HALF_LIFE_DAYS, WINDOW_DAYS, MIN_MASS, WORKING_AT, FAILED_AT, EVIDENCE_PRIOR, DAY,
};
