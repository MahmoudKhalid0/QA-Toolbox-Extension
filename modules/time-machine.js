// Runs in the PAGE (MAIN world) at document_start, in every frame.
//
// Why this is a STATIC content script and not an executeScript from the background:
// executeScript always lands AFTER the document's first inline script has run. An app
// that reads the clock while it boots - Angular bootstrap, a moment() in a config, a
// "current month" computed once at startup - would already be anchored to the REAL
// month, so a month-based check never moves and its counter never resets. Only a
// document_start content script beats the page's own scripts.
//
// The config can't be passed in as an argument (registered content scripts take none)
// and chrome.storage is async - far too late. So the panel writes it to sessionStorage,
// which is per-tab, survives reloads, and is readable SYNCHRONOUSLY right here.
(function () {
    var W = window;
    if (W.__qaTMInstall) return;

    // cfg = {mode:'freeze'|'advance', targetMs, anchorMs}
    W.__qaTMInstall = function (cfg) {
        try {
            if (!cfg || typeof cfg.targetMs !== 'number') return;
            if (!W.__qaRealDate) W.__qaRealDate = W.Date;
            W.__qaTMcfg = cfg;
            if (W.__qaTMInstalled) return;          // already wrapped - the cfg update is enough
            var RealDate = W.__qaRealDate;
            var shift = function () {
                var c = W.__qaTMcfg;
                if (!c) return RealDate.now();
                return c.mode === 'freeze' ? c.targetMs : c.targetMs + (RealDate.now() - c.anchorMs);
            };
            // A plain function, not `class ... extends`: a subclass gets its own prototype,
            // so Dates created before the override would fail `x instanceof Date`. Sharing
            // RealDate.prototype keeps that intact, and lets Date() work without `new`.
            function FakeDate() {
                if (!new.target) return new RealDate(shift()).toString();
                if (arguments.length === 0) return Reflect.construct(RealDate, [shift()], new.target);
                return Reflect.construct(RealDate, arguments, new.target);
            }
            FakeDate.prototype = RealDate.prototype;
            Object.setPrototypeOf(FakeDate, RealDate);          // inherit parse / UTC
            FakeDate.now = function () { return Math.floor(shift()); };
            try { Object.defineProperty(FakeDate, 'name', { value: 'Date' }); } catch (e) { }
            W.Date = FakeDate;

            // Intl.DateTimeFormat().format() with no argument reads the real clock inside
            // the engine - it never goes through window.Date - so a page formatting "today"
            // that way would still print the real month.
            try {
                var DTF = W.Intl && W.Intl.DateTimeFormat;
                if (DTF && !DTF.prototype.__qaTMWrapped) {
                    var origFormat = DTF.prototype.format;
                    DTF.prototype.format = function (d) {
                        return origFormat.call(this, arguments.length === 0 ? new RealDate(shift()) : d);
                    };
                    DTF.prototype.__qaTMWrapped = true;
                }
            } catch (e) { }

            W.__qaTMInstalled = true;
        } catch (e) { }
    };

    W.__qaTMUninstall = function () {
        try { if (W.__qaRealDate) W.Date = W.__qaRealDate; W.__qaTMInstalled = false; W.__qaTMcfg = null; } catch (e) { }
    };

    // Same-origin child frames (including srcdoc) share this sessionStorage, so they get
    // the override too. A cross-origin frame has its own storage and is left alone - it is
    // a different app.
    try {
        var raw = sessionStorage.getItem('__qaTM');
        if (raw) W.__qaTMInstall(JSON.parse(raw));
    } catch (e) { }
})();
