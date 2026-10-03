#!/usr/bin/env node
/**
 * Runs every test/*.test.js in its own process and fails if any fails. They use temp PostgreSQL
 * databases (PGlite) and in-process mocks of OpenVibe.Network and OpenVibe.Sources; none needs the
 * network or a running site.
 *
 *   npm test                 # everything
 *   npm test -- schedule     # only files whose name contains one of the words
 *   npm test -- --strict     # a skipped test fails the run too
 *
 * A test that cannot run something here prints `<label>: skipped (<why>)`: that file is listed with
 * ○ and not counted as passed (openvibe-shared/test-runner).
 *
 * The per-file cap is 120 s, not the runner's 60 s default: the slowest files (chassis, indexnow)
 * take about 50 s on a loaded machine and were being killed, not failing.
 */
'use strict';
const { run } = require('openvibe-shared/test-runner');

// VERBOSE=1 also prints every file's output, then the summary again.
run({ dir: __dirname, timeoutMs: 120000, pad: 34, parallel: 1 }).then((r) => {
    if (process.env.VERBOSE) {
        for (const t of r.results) console.log(`\n── ${t.file} ──\n${t.output.trimEnd()}`);
        console.log(`\n${r.summary}`);
    }
    process.exit(r.exitCode);
}, (err) => { console.error(err); process.exit(1); });
