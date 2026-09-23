'use strict';
/**
 * The confidence formula (server/domain/confidence.js, README "Confidence"), pinned with numbers.
 */
const assert = require('assert');
const conf = require('../server/domain/confidence');
const { check, done } = require('./helpers/boot');

const NOW = Date.parse('2026-09-22T12:00:00Z');
const DAY = conf.DAY;
const r = (who, outcome, ageDays) => ({ reporter_key: who, outcome, updated_at: NOW - ageDays * DAY });

(async () => {
    await check('no reports → confidence null and status unknown (unknown stays unknown), with or without evidence', async () => {
        assert.deepStrictEqual(conf.fromReports([], { now: NOW }), { confidence: null, W: 0, F: 0, mass: 0, counted: 0, derived: 'unknown' });
        assert.strictEqual(conf.fromReports([], { now: NOW, merchantEvidence: true }).confidence, null);
        assert.strictEqual(conf.evaluate({ status: 'unknown', expires_at: null }, [], { now: NOW }).status, 'unknown');
    });

    await check('one fresh report: worked → 0.67 reported_working; failed → 0.33 reported_failed; one of each → 0.5 unknown', async () => {
        assert.strictEqual(conf.fromReports([r('a', 'worked', 0)], { now: NOW }).confidence, 0.67);
        assert.strictEqual(conf.fromReports([r('a', 'worked', 0)], { now: NOW }).derived, 'reported_working');
        assert.strictEqual(conf.fromReports([r('a', 'failed', 0)], { now: NOW }).confidence, 0.33);
        assert.strictEqual(conf.fromReports([r('a', 'failed', 0)], { now: NOW }).derived, 'reported_failed');
        const mixed = conf.fromReports([r('a', 'worked', 0), r('b', 'failed', 0)], { now: NOW });
        assert.strictEqual(mixed.confidence, 0.5);
        assert.strictEqual(mixed.derived, 'unknown');
    });

    await check('recency: weight halves every 7 days; a lone report decides status for a week; nothing after 30 days', async () => {
        assert.strictEqual(conf.weight(0), 1);
        assert.ok(Math.abs(conf.weight(7 * DAY) - 0.5) < 1e-12);
        assert.ok(Math.abs(conf.weight(14 * DAY) - 0.25) < 1e-12);
        assert.strictEqual(conf.weight(30 * DAY + 1), 0);
        assert.strictEqual(conf.fromReports([r('a', 'worked', 6.9)], { now: NOW }).derived, 'reported_working');
        const week = conf.fromReports([r('a', 'worked', 7.5)], { now: NOW });
        assert.strictEqual(week.derived, 'unknown', 'mass below 0.5 after a week');
        assert.ok(week.confidence > 0.5, 'but the number still leans the way the report said');
        assert.strictEqual(conf.fromReports([r('a', 'worked', 31)], { now: NOW }).confidence, null);
    });

    await check('deduplication: only each reporter\'s most recent report counts', async () => {
        const spam = Array.from({ length: 20 }, (_, i) => r('same-person', 'worked', i));
        const one = conf.fromReports(spam, { now: NOW });
        assert.strictEqual(one.counted, 1);
        assert.strictEqual(one.confidence, 0.67, 'twenty daily "worked" reports by one person count as one');
        const changed = conf.fromReports([r('p', 'worked', 3), r('p', 'failed', 0)], { now: NOW });
        assert.strictEqual(changed.derived, 'reported_failed', 'a later report replaces the earlier one');
    });

    await check('evidence: merchant-published code adds half a report to the prior, never a number on its own', async () => {
        assert.strictEqual(conf.fromReports([r('a', 'worked', 0)], { now: NOW, merchantEvidence: true }).confidence, 0.71);
        const failed = conf.fromReports([r('a', 'failed', 0)], { now: NOW, merchantEvidence: true });
        assert.strictEqual(failed.confidence, 0.43);
        assert.strictEqual(failed.derived, 'unknown');
        assert.strictEqual(conf.fromReports([r('a', 'failed', 0), r('b', 'failed', 0)], { now: NOW, merchantEvidence: true }).derived, 'reported_failed');
    });

    await check('a larger mix: 3 fresh worked, 1 failed a week ago → (1+3+0)/(2+3+0.5) = 0.73', async () => {
        const x = conf.fromReports([r('a', 'worked', 0), r('b', 'worked', 0), r('c', 'worked', 0), r('d', 'failed', 7)], { now: NOW });
        assert.strictEqual(x.W, 3);
        assert.strictEqual(x.F, 0.5);
        assert.strictEqual(x.confidence, 0.73);
        assert.strictEqual(x.derived, 'reported_working');
    });

    await check('status precedence: disabled > expired (known expiry passed or recorded) > reports', async () => {
        const reports = [r('a', 'worked', 0)];
        assert.strictEqual(conf.evaluate({ status: 'disabled', expires_at: null }, reports, { now: NOW }).status, 'disabled');
        assert.strictEqual(conf.evaluate({ status: 'reported_working', expires_at: NOW }, reports, { now: NOW }).status, 'expired', 'at the instant of expiry');
        assert.strictEqual(conf.evaluate({ status: 'reported_working', expires_at: NOW + 1 }, reports, { now: NOW }).status, 'reported_working');
        assert.strictEqual(conf.evaluate({ status: 'expired', expires_at: null, expired_at: NOW - 1 }, reports, { now: NOW }).status, 'expired');
        assert.strictEqual(conf.isActive({ review_state: 'published', status: 'unknown', expires_at: NOW }, NOW), false);
        assert.strictEqual(conf.isActive({ review_state: 'published', status: 'unknown', expires_at: null }, NOW), true);
        assert.strictEqual(conf.isActive({ review_state: 'pending', status: 'unknown', expires_at: null }, NOW), false);
    });

    await check('the function is pure: same input, same output; now is required', async () => {
        const input = [r('a', 'worked', 2), r('b', 'failed', 9)];
        assert.deepStrictEqual(conf.fromReports(input, { now: NOW }), conf.fromReports(input, { now: NOW }));
        assert.throws(() => conf.fromReports(input, {}), /now/);
    });

    done();
})();
