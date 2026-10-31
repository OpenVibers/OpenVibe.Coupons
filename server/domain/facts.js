'use strict';

/**
 * A fact about a shop that lives in a neighbour of ours: the latest price we observed for one of its
 * products (OpenVibe.Deals). Every value is one the neighbour reported, with the date it was observed, and
 * a neighbour that is slow or down never delays the page: the fact is skipped and the page says nothing
 * about it. Nothing here is counted or estimated.
 */
const TTL_MS = 15 * 60 * 1000;   // how long a fact is reused
const TIMEOUT_MS = 1200;         // a neighbour that takes longer than this is treated as down

function createFacts({ config, log }) {
    const cache = new Map();

    /** The newest price observation a neighbour holds for this shop, or null when it holds none. */
    async function latestPrice(host) {
        const key = String(host || '').trim().toLowerCase();
        if (!key || !config.dealsUrl || config.nodeEnv === 'test') return null;
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
        const value = await fetchLatestPrice(key);
        cache.set(key, { at: Date.now(), value });
        return value;
    }

    async function fetchLatestPrice(host) {
        try {
            const res = await fetch(`${config.dealsUrl}/api/v1/stores/${encodeURIComponent(host)}`, {
                headers: { accept: 'application/json' },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (!res.ok) return null;
            const body = await res.json();
            const offers = Array.isArray(body && body.offers) ? body.offers : [];
            let best = null;
            for (const offer of offers) {
                const obs = offer && offer.latest_observation;
                if (!obs || obs.price == null || !obs.observed_at) continue;
                const at = Date.parse(obs.observed_at);
                if (!Number.isFinite(at)) continue;
                if (!best || at > best.at) {
                    best = {
                        at,
                        price: String(obs.price),
                        currency: obs.currency || null,
                        name: (offer.product && offer.product.name) || offer.title || null,
                    };
                }
            }
            return best ? { price: best.price, currency: best.currency, name: best.name, observed_at: new Date(best.at).toISOString() } : null;
        } catch (err) {
            if (log && log.warn) log.warn({ err }, 'the shop facts lookup failed; the page carries no price');
            return null;
        }
    }

    return { latestPrice };
}

module.exports = { createFacts };
