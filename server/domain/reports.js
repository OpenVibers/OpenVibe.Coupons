'use strict';

/**
 * Worked/failed reports by people.
 *
 *   Who may report: a signed-in person (site form or a Bearer Network token), an extension install
 *   token with the coupons.report scope (it belongs to the person who connected it), or a service
 *   with coupons.report.create acting for a person (X-OV-Subject). Never anonymously, and never as
 *   AI output (X-OV-Origin: ai is refused): a model cannot report that a code works.
 *
 *   Deduplicated: one row per (reporter, coupon, UTC day). A second report the same day with the
 *   same outcome changes nothing; with the other outcome it replaces that day's row (a correction,
 *   still one report). Only each reporter's most recent report counts in the confidence formula.
 *   The reporter is stored as HMAC(COUPONS_REPORTER_KEY_SECRET, subject): every channel of one
 *   person (site, extension installs, API) shares one key, so extra installs add nothing.
 *
 *   Rate-limited: COUPONS_REPORTS_PER_HOUR / _PER_DAY new reports per person (plus per-IP limits
 *   in Express and nginx).
 *
 *   Private: the response is the code's public view (aggregates only). Nothing returned or emitted
 *   names a reporter.
 */
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const { ApiError } = require('../http/errors');

const OUTCOMES = ['worked', 'failed'];
const REASONS = ['invalid', 'expired', 'min_spend_not_met', 'not_eligible', 'other'];
const DEV_KEY = 'openvibe-coupons-development-reporter-key';

function createReports({ store, config, coupons, merchants, publication }) {
    const { db } = store;
    const secret = config.reporterKeySecret || DEV_KEY;
    const q = {
        find: db.prepare('SELECT * FROM coupon_validation_reports WHERE coupon_id = ? AND reporter_key = ? AND day = ?'),
        insert: db.prepare(`INSERT INTO coupon_validation_reports (coupon_id, reporter_key, channel, install_id, day, outcome, reason, created_at, updated_at)
                            VALUES (@coupon_id, @reporter_key, @channel, @install_id, @day, @outcome, @reason, @now, @now)`),
        correct: db.prepare('UPDATE coupon_validation_reports SET outcome = @outcome, reason = @reason, channel = @channel, install_id = @install_id, updated_at = @now WHERE id = @id'),
        since: db.prepare('SELECT COUNT(*) AS n FROM coupon_validation_reports WHERE reporter_key = ? AND created_at > ?'),
        stamp: db.prepare(`UPDATE coupons SET last_report_at = @now,
                               last_worked_at = CASE WHEN @outcome = 'worked' THEN @now ELSE last_worked_at END,
                               last_failed_at = CASE WHEN @outcome = 'failed' THEN @now ELSE last_failed_at END
                           WHERE id = @id`),
    };

    const reporterKey = (subject) => crypto.createHmac('sha256', secret).update(`coupons-reporter:${subject}`).digest('hex');

    /** The person a caller reports as, and the channel. Throws when there is none. */
    function reporterOf(viewer, channel) {
        if (!viewer || viewer.kind === 'anonymous') throw new ApiError(401, 'auth.required', 'sign in (or connect the extension) to report');
        if (viewer.origin === 'ai') throw new ApiError(403, 'report.ai_refused', 'reports come from people; model output cannot report a code as working or failed');
        if (!viewer.subject || !ids.isSubjectId('user', viewer.subject)) throw new ApiError(403, 'auth.person_required', 'a report needs the person it is from (X-OV-Subject for services)');
        return { subject: viewer.subject, channel: viewer.kind === 'install' ? 'extension' : channel, install: viewer.kind === 'install' ? viewer.install : null };
    }

    /**
     * → { accepted, deduplicated, corrected, coupon (public view) }
     */
    function report(viewer, couponId, body, { channel = 'api', traceparent } = {}) {
        const outcome = body && body.outcome;
        if (!OUTCOMES.includes(outcome)) throw new ApiError(422, 'report.bad_outcome', 'outcome must be "worked" or "failed"');
        const reason = body.reason == null || body.reason === '' ? null : body.reason;
        if (reason !== null && !REASONS.includes(reason)) throw new ApiError(422, 'report.bad_reason', `reason must be one of ${REASONS.join(', ')}`);
        if (outcome === 'worked' && reason) throw new ApiError(422, 'report.bad_reason', 'a reason applies to failed reports only');
        const who = reporterOf(viewer, channel);
        const c = coupons.get(couponId);
        if (!c) throw new ApiError(404, 'coupon.not_found', 'no such code');
        const m = merchants.byId(c.merchant_id);
        const now = store.now();
        const isActive = m && m.status === 'active' && c.review_state === 'published' && c.status !== 'expired' && c.status !== 'disabled' && (c.expires_at == null || c.expires_at > now);
        if (!isActive) throw new ApiError(409, 'coupon.not_active', 'this code is not in active results (expired, disabled or not published)');

        const key = reporterKey(who.subject);
        const day = new Date(now).toISOString().slice(0, 10);
        return store.tx(() => {
            const existing = q.find.get(c.id, key, day);
            if (existing && existing.outcome === outcome && existing.reason === reason) {
                return { accepted: true, deduplicated: true, corrected: false, coupon: coupons.view(coupons.get(c.id), { merchant: m }) };
            }
            if (!existing) {
                if (q.since.get(key, now - 60 * 60 * 1000).n >= config.limits.reportsPerHour || q.since.get(key, now - 24 * 60 * 60 * 1000).n >= config.limits.reportsPerDay) {
                    throw new ApiError(429, 'report.rate_limited', 'too many reports; try again later');
                }
                q.insert.run({ coupon_id: c.id, reporter_key: key, channel: who.channel, install_id: who.install, day, outcome, reason, now });
                publication.emit('coupons.report.created', { type: 'coupon', id: c.id }, { merchant_id: c.merchant_id, outcome, ...(reason ? { reason } : {}), channel: who.channel, day }, { traceparent });
            } else {
                q.correct.run({ id: existing.id, outcome, reason, channel: who.channel, install_id: who.install, now });
            }
            q.stamp.run({ id: c.id, now, outcome });
            coupons.recompute(c.id, { reason: 'report', actor: 'system', traceparent });
            return { accepted: true, deduplicated: Boolean(existing), corrected: Boolean(existing), coupon: coupons.view(coupons.get(c.id), { merchant: m }) };
        });
    }

    return { report, reporterKey, OUTCOMES, REASONS, usingDevKey: !config.reporterKeySecret };
}

module.exports = { createReports, OUTCOMES, REASONS };
