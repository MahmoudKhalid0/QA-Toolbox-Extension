const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

test('storage panel action buttons cannot be stretched by host-page CSS', () => {
    assert.match(source, /#qa-storage \.st-head \.qa-minbtn, #qa-storage \.st-close \{[^}]*min-width: 26px !important;[^}]*max-width: 26px !important;/s);
    assert.match(source, /#qa-storage \.st-tools button \{[^}]*min-width: 30px !important;[^}]*max-width: 30px !important;[^}]*flex: 0 0 30px !important;/s);
    assert.match(source, /#qa-storage \.st-row button \{[^}]*min-width: 24px !important;[^}]*max-width: 24px !important;[^}]*flex: 0 0 24px !important;/s);
});

test('storage panel keeps readable space for cookie names', () => {
    assert.match(source, /#qa-storage \{[^}]*width: 480px;[^}]*max-width: calc\(100vw - 32px\);/s);
    assert.match(source, /#qa-storage \.st-k \{[^}]*min-width: 90px;/s);
});
