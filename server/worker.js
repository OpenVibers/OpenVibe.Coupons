'use strict';
/**
 * Background work in the Coupons process (two timers):
 *
 *   sweep          every COUPONS_SWEEP_INTERVAL_MS: record codes whose known expiry has passed
 *                  (status → expired, history, coupons.coupon.expired, Search tombstone) and let
 *                  old reports decay (status back to unknown, confidence → null after 30 days).
 *                  Active lists never wait for it: they filter on expires_at at query time.
 *   Sources import every COUPONS_SOURCES_INTERVAL_MS when OV_SOURCES_INTERNAL_URL is set.
 */
function createWorker({ config, coupons, importer, outbox, log = console }) {
    let sweepTimer = null;
    let importTimer = null;
    let sweeping = false;
    let importing = false;
    let lastSweep = null;

    function sweep() {
        if (sweeping) return null;
        sweeping = true;
        try {
            const r = coupons.sweep();
            lastSweep = { at: Date.now(), ...r, error: null };
            if (r.expired.length || r.changed.length) outbox.kick();
            return r;
        } catch (err) {
            lastSweep = { at: Date.now(), error: err.message };
            log.error('[Coupons] sweep failed:', err.message);
            return null;
        } finally { sweeping = false; }
    }

    async function importTick() {
        if (importing || !importer.enabled) return null;
        importing = true;
        try {
            const r = await importer.run();
            outbox.kick();
            return r;
        } finally { importing = false; }
    }

    return {
        sweep,
        importTick,
        lastSweep: () => lastSweep,
        start() {
            if (!config.worker.enabled) return;
            sweepTimer = setInterval(sweep, config.worker.intervalMs);
            sweepTimer.unref();
            setTimeout(sweep, 1000).unref();
            if (importer.enabled) {
                importTimer = setInterval(() => importTick().catch((err) => log.warn('[Coupons] import tick failed:', err.message)), config.sources.intervalMs);
                importTimer.unref();
            }
        },
        stop() { clearInterval(sweepTimer); clearInterval(importTimer); },
    };
}

module.exports = { createWorker };
