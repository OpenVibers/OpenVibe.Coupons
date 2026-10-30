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

const BUDGETS = {
    htmlRawKB: 42,   // 37.3 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); 33.7 with the curated front page (numbers, code tickets, the Companion, six questions and their JSON-LD; 2026-10-22); 24.1 with the showcase (17.4 before it; fresh database)
    htmlBrotliKB: 11,   // 9.1 Shared 4.15.1 footer; 7.9 with the curated front page; 6.2 (4.5 before the showcase)
    jsFiles: 6,   // 6 with the OpenVibe Kit's kit-web.js (Shared 4.20.1, 2026-10-28); 5 (openvibe-shared 2.9 shell: web-runtime.js)
    jsRawKB: 320,   // 319.8 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 312.4 openvibe-shared 4.29.2 (2026-10-28): Notifications 2.0's toast layer (held while a menu is open, grouping, priority, System cards) and the menu's results view; 307.6 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 300.1 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); 297.3 Shared 4.20.1: the kit's kit-web.js (copy buttons, menus, confirms; 7 KB) and 4.18-4.19's menu and footer; 287.2 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 273.2 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 263.4 with shared 4.11.0's seasonal navbar; 254.1 with openvibe-shared 4.9.0 (status text twins in every theme, 2026-10-23); 246.2 with openvibe-shared 4.2.x (Ask Actor in the navbar, 2026-10-15); 239.1 (212.2 before the shell's web-runtime.js) // raised 316 -> 325 for the openvibe-shared Kit 2 pin (kit.css grew) // back to the pre-Kit 2 value: Kit 2 has its own files (kit-data.css) since openvibe-shared v4.37.0, so kit.css weighs what it did
    jsBrotliKB: 80,   // 79.3 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 76.2 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 73.5 Shared 4.20.1 (kit-web.js); 70.5 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 67.9 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 65.3 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 61.7 with shared 4.11.0's seasonal navbar; 59.1 with openvibe-shared 4.4.0 (every site in the launcher, 2026-10-17); 56.3 (49.9 before web-runtime.js) // raised 78 -> 80 for the openvibe-shared Kit 2 pin (kit.css grew) // back to the pre-Kit 2 value: Kit 2 has its own files (kit-data.css) since openvibe-shared v4.37.0, so kit.css weighs what it did
    cssFiles: 3,   // 3 with the OpenVibe Kit's kit.css on every page (Shared 4.20); 2 (coupons.css + showcase.css, home only)
    cssRawKB: 68.5,   // 68.4 touch targets on phones (2026-10-29); 67.9 the home's phone rows and fold (2026-10-29); 62.7 openvibe-shared 4.26.1 (hero visual); 58.4 with a code's reports over time (2026-10-28: weekly columns, legend, phone labels); 55.6 with the OpenVibe Kit's kit.css (Shared 4.20, 2026-10-28: the shop page's head, tabs, folds and menus); 28.2 with Shared 4.13.0 (2026-10-26: account links); 21.8 with the front page's numbers, tickets and questions (2026-10-22); 18.1 before (4.4 before showcase.css) // raised 67 -> 85 for the openvibe-shared Kit 2 pin (kit.css grew) // back to the pre-Kit 2 value: Kit 2 has its own files (kit-data.css) since openvibe-shared v4.37.0, so kit.css weighs what it did
    cssBrotliKB: 14.5,   // 14.1 touch targets on phones (2026-10-29); 12.9 openvibe-shared 4.26.1 (hero visual); 11.5 with kit.css (Shared 4.20); 6.2 with Shared 4.13.0 (2026-10-26: account links); 5.0 with the front page (2026-10-22); 3.6 before (1.2 before showcase.css) // raised 14 -> 17 for the openvibe-shared Kit 2 pin (kit.css grew) // back to the pre-Kit 2 value: Kit 2 has its own files (kit-data.css) since openvibe-shared v4.37.0, so kit.css weighs what it did
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
