'use strict';
/**
 * Weekly success buckets for a code or a shop, with the privacy floor in one place.
 *
 * A bucket counts PEOPLE, not rows: each reporter's most recent report in the week says whether it worked. A week
 * with fewer than MIN_PEOPLE distinct people is `null` — "too few reports" — so one person's report (or one
 * person's seven daily rows) can never be read off the chart. Nothing here returns a reporter key, a channel, an
 * install id or a day-level row; only a week's aggregate worked/failed counts.
 */
const DAY = 24 * 60 * 60 * 1000;
const MIN_PEOPLE = 3;

/** The Monday (UTC) that starts each of the last `weeks` weeks, oldest first. */
function weekStarts(now, weeks = 12) {
    const today = Math.floor(now / DAY) * DAY;
    const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
    const first = monday - (weeks - 1) * 7 * DAY;
    return Array.from({ length: weeks }, (_, i) => new Date(first + i * 7 * DAY).toISOString().slice(0, 10));
}

/**
 * rows: [{ reporter_key, day: 'YYYY-MM-DD', outcome: 'worked'|'failed', updated_at }] for one code or shop,
 * oldest first is not required (the latest day in the week wins). → { from, to, min_people, weeks: [null | { week,
 * worked, failed }] }.
 */
function buckets(rows, now, weeks = 12) {
    const starts = weekStarts(now, weeks);
    const first = Date.parse(`${starts[0]}T00:00:00Z`);
    const latest = new Map();
    for (const r of rows || []) {
        if (r.outcome !== 'worked' && r.outcome !== 'failed') continue;
        const i = Math.floor((Date.parse(`${r.day}T00:00:00Z`) - first) / (7 * DAY));
        if (!(i >= 0 && i < weeks)) continue;
        const key = `${r.reporter_key}|${i}`;
        const seen = latest.get(key);
        // The latest day wins; on the same day the later update wins (a shop's codes can tie on a day).
        if (!seen || String(r.day) > seen.day || (String(r.day) === seen.day && Number(r.updated_at) >= Number(seen.updated_at))) {
            latest.set(key, { day: String(r.day), outcome: r.outcome, at: Number(r.updated_at) || 0 });
        }
    }
    const count = Array.from({ length: weeks }, () => ({ worked: 0, failed: 0 }));
    for (const [key, r] of latest) count[Number(key.split('|').pop())][r.outcome] += 1;
    return {
        from: starts[0], to: starts[weeks - 1], min_people: MIN_PEOPLE,
        weeks: starts.map((week, i) => {
            const total = count[i].worked + count[i].failed;
            return total >= MIN_PEOPLE ? { week, worked: count[i].worked, failed: count[i].failed } : null;
        }),
    };
}

module.exports = { DAY, MIN_PEOPLE, weekStarts, buckets };
