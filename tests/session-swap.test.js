const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const clone = (value) => JSON.parse(JSON.stringify(value));
const event = () => ({ addListener() { } });

function loadSessionSwap() {
    const state = {
        local: {},
        jars: new Map([['0', []], ['1', []]]),
        pageStorage: new Map(),
        cookieReads: [],
        cookieSets: [],
        failSetName: null,
        menus: new Map([
            ['qa-cap-root', { id: 'qa-cap-root' }],
            ['qa-cap-visible', { id: 'qa-cap-visible', parentId: 'qa-cap-root' }]
        ])
    };

    const runtime = { lastError: null, onMessage: event() };
    const callback = (cb, value, error) => {
        runtime.lastError = error ? { message: error } : null;
        cb(value);
        runtime.lastError = null;
    };
    const partition = (cookie) => JSON.stringify(cookie.partitionKey || null);
    const key = (cookie) => [cookie.name, cookie.domain, cookie.path || '/', partition(cookie)].join('|');
    const matchesUrl = (cookie, rawUrl) => {
        const url = new URL(rawUrl);
        const domain = String(cookie.domain || '').replace(/^\./, '');
        return url.hostname === domain || url.hostname.endsWith('.' + domain);
    };

    const chrome = {
        runtime,
        storage: {
            local: {
                get(keys, cb) {
                    const result = {};
                    for (const k of keys || []) if (Object.hasOwn(state.local, k)) result[k] = clone(state.local[k]);
                    callback(cb, result);
                },
                set(values, cb) {
                    Object.assign(state.local, clone(values));
                    callback(cb);
                }
            }
        },
        cookies: {
            getAllCookieStores(cb) {
                callback(cb, [
                    { id: '0', tabIds: [10] },
                    { id: '1', tabIds: [20] }
                ]);
            },
            getAll(details, cb) {
                state.cookieReads.push(clone(details));
                const cookies = (state.jars.get(details.storeId || '0') || [])
                    .filter((c) => !details.url || matchesUrl(c, details.url));
                callback(cb, clone(cookies));
            },
            get(details, cb) {
                const cookie = (state.jars.get(details.storeId || '0') || []).find((c) =>
                    c.name === details.name && matchesUrl(c, details.url) &&
                    partition(c) === JSON.stringify(details.partitionKey || null));
                callback(cb, cookie ? clone(cookie) : null);
            },
            set(details, cb) {
                state.cookieSets.push(clone(details));
                if (details.name === state.failSetName) return callback(cb, null, 'mock cookie write failure');
                const url = new URL(details.url);
                const cookie = {
                    name: details.name,
                    value: details.value,
                    domain: details.domain || url.hostname,
                    hostOnly: !details.domain,
                    path: details.path || '/',
                    secure: !!details.secure,
                    httpOnly: !!details.httpOnly,
                    sameSite: details.sameSite,
                    storeId: details.storeId || '0',
                    session: details.expirationDate == null
                };
                if (details.partitionKey) cookie.partitionKey = clone(details.partitionKey);
                const jar = state.jars.get(cookie.storeId) || [];
                const next = jar.filter((c) => key(c) !== key(cookie));
                next.push(cookie);
                state.jars.set(cookie.storeId, next);
                callback(cb, clone(cookie));
            },
            remove(details, cb) {
                const storeId = details.storeId || '0';
                const jar = state.jars.get(storeId) || [];
                const index = jar.findIndex((c) => c.name === details.name && matchesUrl(c, details.url) &&
                    partition(c) === JSON.stringify(details.partitionKey || null));
                let removed = null;
                if (index >= 0) removed = jar.splice(index, 1)[0];
                callback(cb, removed ? { url: details.url, name: details.name, storeId } : null);
            }
        },
        scripting: {
            async executeScript(options) {
                const tabId = options.target.tabId;
                if (options.args) {
                    state.pageStorage.set(tabId, clone(options.args[0]));
                    return [{ result: true }];
                }
                return [{ result: clone(state.pageStorage.get(tabId) || { local: {}, session: {} }) }];
            }
        },
        tabs: {
            query(_query, cb) { callback(cb, []); },
            sendMessage(_id, _message, cb) { if (cb) callback(cb); },
            update(_id, options, cb) { callback(cb, { id: _id, ...options }); },
            get(id, cb) { callback(cb, { id, url: 'https://app.test/' }); },
            onActivated: event(),
            onUpdated: event()
        },
        contextMenus: {
            create(options, cb) { state.menus.set(options.id, clone(options)); if (cb) callback(cb); },
            remove(id, cb) {
                const existed = state.menus.has(id);
                state.menus.delete(id);
                for (const [childId, item] of state.menus) if (item.parentId === id) state.menus.delete(childId);
                callback(cb, undefined, existed ? null : 'Cannot find menu item');
            },
            onClicked: event()
        }
    };

    const context = vm.createContext({ chrome, console, self: {}, URL, setTimeout, clearTimeout });
    const source = fs.readFileSync(path.join(__dirname, '..', 'session-swap.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'session-swap.js' });
    return { api: context.self.SessionSwap, state };
}

function authCookie(value, storeId, extra = {}) {
    return {
        name: 'auth', value, domain: 'app.test', hostOnly: true, path: '/',
        secure: true, httpOnly: true, sameSite: 'lax', session: true, storeId,
        ...extra
    };
}

test('save reads cookies from the target incognito tab store', async () => {
    const { api, state } = loadSessionSwap();
    state.jars.set('0', [authCookie('regular', '0')]);
    state.jars.set('1', [authCookie('private', '1')]);
    state.pageStorage.set(20, { local: { token: 'private' }, session: {} });

    const result = await api.saveCurrent({ id: 20, url: 'https://app.test/' }, 'Private', 'op-private');

    assert.equal(result.ok, true);
    assert.equal(state.local.qaLoginSnapshots['https://app.test'][0].cookies[0].value, 'private');
    assert.ok(state.cookieReads.every((details) => details.storeId === '1'));
});

test('save retries with one operation id do not create duplicates', async () => {
    const { api, state } = loadSessionSwap();
    state.jars.set('0', [authCookie('regular', '0')]);

    const first = await api.saveCurrent({ id: 10, url: 'https://app.test/' }, 'Admin', 'same-operation');
    const second = await api.saveCurrent({ id: 10, url: 'https://app.test/' }, 'Admin', 'same-operation');

    assert.equal(first.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(state.local.qaLoginSnapshots['https://app.test'].length, 1);
});

test('regular and incognito tabs keep separate active-login markers', async () => {
    const { api, state } = loadSessionSwap();
    state.jars.set('0', [authCookie('regular', '0')]);
    const regular = await api.saveCurrent({ id: 10, url: 'https://app.test/' }, 'Regular', 'op-regular');
    state.jars.set('1', [authCookie('private', '1')]);
    const privateResult = await api.saveCurrent({ id: 20, url: 'https://app.test/' }, 'Private', 'op-private');

    const regularList = await api.listFor('https://app.test/', 10);
    const privateList = await api.listFor('https://app.test/', 20);

    assert.equal(regularList.find((s) => s.active).id, regular.id);
    assert.equal(privateList.find((s) => s.active).id, privateResult.id);
    assert.equal(state.local.qaActiveLogin['https://app.test::cookie-store::0'], regular.id);
    assert.equal(state.local.qaActiveLogin['https://app.test::cookie-store::1'], privateResult.id);
});

test('restore targets the current tab store and preserves partition keys', async () => {
    const { api, state } = loadSessionSwap();
    const partitionKey = { topLevelSite: 'https://app.test' };
    state.jars.set('0', [authCookie('saved', '0', { partitionKey })]);
    await api.saveCurrent({ id: 10, url: 'https://app.test/' }, 'Saved', 'op-saved');
    const id = state.local.qaLoginSnapshots['https://app.test'][0].id;
    state.jars.set('1', [authCookie('old-private', '1')]);

    const result = await api.restore({ id: 20, url: 'https://app.test/' }, id);

    assert.equal(result.ok, true);
    const restored = state.jars.get('1').find((c) => c.value === 'saved');
    assert.ok(restored);
    assert.deepEqual(restored.partitionKey, partitionKey);
    assert.ok(state.cookieSets.some((details) => details.storeId === '1' && details.partitionKey));
});

test('restore rolls back the previous login when a cookie write fails', async () => {
    const { api, state } = loadSessionSwap();
    state.jars.set('0', [authCookie('saved', '0', { name: 'broken' })]);
    await api.saveCurrent({ id: 10, url: 'https://app.test/' }, 'Broken', 'op-broken');
    const id = state.local.qaLoginSnapshots['https://app.test'][0].id;
    state.jars.set('1', [authCookie('old-private', '1')]);
    state.pageStorage.set(20, { local: { token: 'old-private' }, session: {} });
    state.failSetName = 'broken';

    const result = await api.restore({ id: 20, url: 'https://app.test/' }, id);

    assert.equal(result.ok, false);
    assert.match(result.error, /previous login restored/);
    assert.deepEqual(state.jars.get('1').map((c) => c.value), ['old-private']);
    assert.deepEqual(state.pageStorage.get(20), { local: { token: 'old-private' }, session: {} });
});

test('rebuilding session menus does not remove capture menus', async () => {
    const { api, state } = loadSessionSwap();

    await api.rebuildMenuFor({ id: 10, url: 'https://app.test/' });

    assert.ok(state.menus.has('qa-cap-root'));
    assert.ok(state.menus.has('qa-cap-visible'));
    assert.ok(state.menus.has('qaSwapRoot'));
});
