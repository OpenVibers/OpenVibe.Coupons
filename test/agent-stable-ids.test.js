'use strict';
// AGT-4: agent.json says what an id in a Coupons address is, and the code behaves as it says.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { agentManifest } = require('openvibe-shared/agent-layer');

const ids = agentManifest(require('../server/agent-descriptor')).policy.stableIds;
assert.deepStrictEqual(ids.map((x) => [x.kind, x.url]), [['code', 'https://openvibe.coupons/c/{id}'], ['shop', 'https://openvibe.coupons/m/{slug}']]);
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', f), 'utf8');
// A code id is a ULID minted once, and no code row is ever deleted (so no id is freed to be minted again).
assert.match(read('domain/coupons.js'), /const id = `cpn_\$\{ids\.ulid\(now\)\}`;/);
const all = fs.readdirSync(path.join(__dirname, '..', 'server'), { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => read(f)).join('\n');
assert.doesNotMatch(all, /DELETE FROM coupons\b/i, 'a code is taken down, never deleted');
// Taken down: 410, both a code and a shop.
const pub = read('http/public.js');
assert.match(pub, /messagePage\(req, res, 410, 'Gone', 'This code was taken down\.'/);
assert.match(pub, /messagePage\(req, res, 410, 'Gone', 'This shop is no longer listed\.'/);
console.log('agent stable ids: ok');
