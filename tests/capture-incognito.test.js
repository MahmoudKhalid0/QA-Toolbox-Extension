const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function event() {
    return { addListener() { } };
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function loadCaptureWorker() {
    const calls = { createdTabs: [], createdWindows: [], queriedTabs: 0, menus: new Map([
        ['qaSwapRoot', { id: 'qaSwapRoot' }],
        ['swapSaveNow', { id: 'swapSaveNow', parentId: 'qaSwapRoot' }]
    ]) };
    const chrome = {
        action: {
            setBadgeBackgroundColor() { },
            setBadgeText() { }
        },
        commands: { onCommand: event() },
        contextMenus: {
            create(options, callback) { calls.menus.set(options.id, options); if (callback) callback(); },
            onClicked: event(),
            remove(id, callback) {
                calls.menus.delete(id);
                for (const [childId, item] of calls.menus) if (item.parentId === id) calls.menus.delete(childId);
                if (callback) callback();
            },
            removeAll(callback) { if (callback) callback(); }
        },
        offscreen: {
            async createDocument() { },
            async hasDocument() { return false; }
        },
        runtime: {
            getContexts: async () => [],
            getURL: (value) => `chrome-extension://qa-toolkit/${value}`,
            lastError: null,
            onInstalled: event(),
            onMessage: event(),
            onStartup: event(),
            sendMessage: async () => ({ ready: true })
        },
        scripting: { executeScript: async () => [] },
        storage: {
            local: {
                get(_keys, callback) { if (callback) callback({}); else return Promise.resolve({}); },
                remove() { },
                set(_value, callback) { if (callback) callback(); else return Promise.resolve(); }
            },
            sync: { get(_keys, callback) { callback({}); } }
        },
        tabs: {
            async create(options) { calls.createdTabs.push(options); return options; },
            get(_id, callback) { callback(null); },
            onActivated: event(),
            onUpdated: event(),
            query(_query, callback) { calls.queriedTabs++; callback([]); },
            captureVisibleTab() { }
        },
        windows: {
            async create(options) { calls.createdWindows.push(options); return options; },
            async getAll() { return []; },
            onFocusChanged: event()
        }
    };

    const context = vm.createContext({
        CapStore: {}, chrome, clearInterval, clearTimeout, console,
        navigator: { platform: 'test', userAgent: 'test' },
        result: {}, setInterval, setTimeout
    });
    const source = fs.readFileSync(path.join(__dirname, '..', 'capture', 'cap-background.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'capture/cap-background.js' });
    return { calls, chrome, context };
}

test('incognito captures open their editor in an existing regular window', async () => {
    const { calls, chrome, context } = loadCaptureWorker();
    chrome.windows.getAll = async () => [
        { id: 11, incognito: true, focused: true },
        { id: 22, incognito: false, focused: false }
    ];

    await context.capCreateEditorTab(
        { id: 7, index: 3, windowId: 11, incognito: true },
        'capture/editor.html?id=shot'
    );

    assert.deepEqual(plain(calls.createdTabs), [{
        url: 'chrome-extension://qa-toolkit/capture/editor.html?id=shot',
        windowId: 22,
        active: true
    }]);
    assert.equal(calls.createdWindows.length, 0);
});

test('incognito captures create a regular window when none exists', async () => {
    const { calls, context } = loadCaptureWorker();

    await context.capCreateEditorTab(
        { id: 7, index: 3, windowId: 11, incognito: true },
        'capture/editor.html?id=shot'
    );

    assert.deepEqual(plain(calls.createdWindows), [{
        url: 'chrome-extension://qa-toolkit/capture/editor.html?id=shot',
        incognito: false,
        focused: true,
        state: 'maximized'
    }]);
    assert.equal(calls.createdTabs.length, 0);
});

test('regular captures keep the editor beside their source tab', async () => {
    const { calls, context } = loadCaptureWorker();

    await context.capCreateEditorTab(
        { id: 7, index: 3, windowId: 11, incognito: false },
        'capture/editor.html?id=shot'
    );

    assert.deepEqual(plain(calls.createdTabs), [{
        url: 'chrome-extension://qa-toolkit/capture/editor.html?id=shot',
        index: 4,
        windowId: 11,
        openerTabId: 7
    }]);
    assert.equal(calls.createdWindows.length, 0);
});

test('the shared capture path retains the initiating tab', () => {
    const { calls, context } = loadCaptureWorker();
    vm.runInContext(`
        captureScreenshot = (_reply, tab) => { result.captureTab = tab; };
        handleDelayedCapture = (_reply, tab) => { result.delayedTab = tab; };
    `, context);
    const sourceTab = { id: 7, windowId: 11, incognito: true };

    context.capPerform(sourceTab, 'capture');
    context.capPerform(sourceTab, 'delayed');

    assert.deepEqual(context.result.captureTab, sourceTab);
    assert.deepEqual(context.result.delayedTab, sourceTab);
    assert.equal(calls.queriedTabs, 0);
});

test('rebuilding capture menus does not remove session menus', async () => {
    const { calls, context } = loadCaptureWorker();

    await context.capBuildMenus();

    assert.ok(calls.menus.has('qaSwapRoot'));
    assert.ok(calls.menus.has('swapSaveNow'));
    assert.ok(calls.menus.has('qa-cap-root'));
});
