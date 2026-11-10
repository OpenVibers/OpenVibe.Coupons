'use strict';
// Size budgets for openvibe.coupons' home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the
// server as it runs (a fresh database), measured without a browser. Budgets sit a little above today's
// measurement; raising one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

// 2026-11-08: openvibe-shared v4.152.0; CI measured JS 372.8 KB raw / 89.2 KB brotli.
// 2026-11-08: openvibe-shared v4.150.0; CI measured JS 370.1 KB raw / 88.6 KB brotli.
// 2026-11-08: openvibe-shared v4.149.0; CI measured JS 369.1 KB raw / 88.5 KB brotli.
const BUDGETS = {
    htmlRawKB: 52, // 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 49.9: measured 47.9 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    htmlBrotliKB: 11.5,   // 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 9.1 Shared 4.15.1 footer; 7.9 with the curated front page; 6.2 (4.5 before the showcase)
    jsFiles: 6,   // 6 with the OpenVibe Kit's kit-web.js (Shared 4.20.1, 2026-10-28); 5 (openvibe-shared 2.9 shell: web-runtime.js)
    jsRawKB: 414.5, // 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 398: measured 390 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    jsBrotliKB: 99.5, // 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 95.4: measured 95.3 KB brotli with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 95.1: measured 93.1 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssFiles: 3,   // 3 with the OpenVibe Kit's kit.css on every page (Shared 4.20); 2 (coupons.css + showcase.css, home only)
    cssRawKB: 100.3, // 100.3: measured 95.3 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssBrotliKB: 20.5, // 20.5: measured 19.3 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    externalFiles: 1,   // 0
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    // A database of its own (not the shared dev PGlite in data/pglite, and not whatever the caller's
    // DATABASE_URL names), so the measurement is the server on a fresh database and the run leaves nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-budget-'));
    const pgliteDir = path.join(dir, 'pglite');
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
            DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '',
            COUPONS_PGLITE_DIR: pgliteDir, COUPONS_WORKER: 'off',
            OV_SOURCES_INTERNAL_URL: '', EVENTS_URL: '', INDEXNOW_KEY: '',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 150 && !up; i++) {
            up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${stderr}`);
        assert.ok(fs.existsSync(pgliteDir), 'the server did not use the isolated database (COUPONS_PGLITE_DIR)');
        const m = await measure({ base });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
