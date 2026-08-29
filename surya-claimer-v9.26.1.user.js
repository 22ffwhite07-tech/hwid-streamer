// ==UserScript==
// @name         Surya Claimer (All-in-One)
// @namespace    https://surya.claimer/
// @version      9.26.1
// @updateURL    https://scripts.mvpsensi.in/claimer.user.js
// @downloadURL  https://scripts.mvpsensi.in/claimer.user.js
// @description  v9.26 SINGLE-FILE MERGE. FCFC scraper + Bridge silently baked in. On the settings/offers page the script silently activates a hidden, no-UI FCFC scraper and a local bridge that dispatches captured codes to the claimer instantly via surya:code CustomEvent. On all other stake pages the claimer works normally (WS listener to ws.mvpsensi.in). Zero visible UI from FCFC/Bridge, zero console noise, one install. Prior: v9.25 amount+HUD brightness, v9.24 local bridge listener.
// @author       Surya
// @match        *://*.stake.com/*
// @match        *://*.stake.ac/*
// @match        *://*.stake.games/*
// @match        *://*.stake.bet/*
// @match        *://*.stake.pet/*
// @match        *://*.stake1001.com/*
// @match        *://*.stake1002.com/*
// @match        *://*.stake1003.com/*
// @match        *://*.stake.mba/*
// @match        *://*.stake.jp/*
// @match        *://*.stake.bz/*
// @match        *://*.staketr.com/*
// @match        *://*.stake.krd/*
// @match        *://*.stake.ceo/*
// @match        *://*.stake1017.com/*
// @match        *://*.stake1021.com/*
// @match        *://*.stake1022.com/*
// @match        *://*.stake3018.com/*
// @match        *://*.stake3097.com/*
// @match        *://*.stake3017.com/*
// @match        *://*.stake3039.com/*
// @match        *://*.stake1073.com/*
// @match        *://*.stake1038.com/*
// @match        *://*.stake1039.com/*
// @match        *://*.stake1069.com/*
// @match        *://*.stake1070.com/*
// @match        *://*stake*/*settings/offers*
// @require      https://code.jquery.com/jquery-3.7.1.min.js
// @require      https://www.hh123.site/static/socket.io.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_info
// @grant        unsafeWindow
// @connect      *
// @run-at       document-start
// @noframes
// ==/UserScript==

/* ============================================================================
 * SURYA CLAIMER v9.26.0 — SILENT SCRAPER PRELUDE
 * ----------------------------------------------------------------------------
 * Only activates on the stake settings/offers page (where FCFC natively runs).
 * On any other page, this block is a no-op and the claimer below runs normally.
 *
 * What it does when active:
 *   1. Injects CSS that hides every FCFC UI selector (drop-status, autoDropwrap,
 *      recharge-wrap, user-set-wrap, loader, turnstile placeholder) before FCFC's
 *      document-idle handler paints anything.
 *   2. Suppresses FCFC's console.log output via a scope-shadowed `console`.
 *   3. Monkey-patches unsafeWindow.FCFC (exposed by FCFC at boot) so that FCFC's
 *      own claim pipeline becomes a no-op — the claimer wins every claim race.
 *   4. Installs the Bridge extractor: MutationObserver + .value-setter override
 *      on FCFC's <textarea class="log"> so that every code FCFC decodes is
 *      instantly dispatched via `surya:code` CustomEvent, which the claimer
 *      already listens for (v9.24+ local fast-path).
 * ============================================================================ */
(function () {
	'use strict';
	if (!/\/settings\/offers/i.test(location.pathname)) return;

	// ---- 1) Hide FCFC UI immediately (before document-idle) -------------------
	try {
		const HIDE_CSS = ''
			+ '#autoDropwrap, #drop-status, #_turnstile,'
			+ '#autoDropwrap *, .autoDropwrap, .autoDropwrap *,'
			+ '.recharge-wrap, .user-set-wrap, .loader-wrap, .service-wrap,'
			+ '.get-redeem-code-btn, .redeem-btn, .recharge-btn, .setting-btn,'
			+ '[class*="turnstile-scripts"]{'
			+ '  display:none !important; visibility:hidden !important;'
			+ '  opacity:0 !important; pointer-events:none !important;'
			+ '  position:fixed !important; left:-99999px !important; top:-99999px !important;'
			+ '  width:0 !important; height:0 !important; z-index:-9999 !important;'
			+ '}';
		if (typeof GM_addStyle === 'function') GM_addStyle(HIDE_CSS);
		else {
			const inject = () => {
				const s = document.createElement('style');
				s.textContent = HIDE_CSS;
				(document.head || document.documentElement).appendChild(s);
			};
			if (document.head || document.documentElement) inject();
			else document.addEventListener('DOMContentLoaded', inject, { once: true });
		}
	} catch (e) {}

	// ---- 2) Disable FCFC's own claim path once it exposes itself --------------
	try {
		const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
		const nooper = function () { return Promise.resolve({ ok: false, skipped: true, reason: 'claimer-owns-claiming' }); };
		let patched = false;
		const patchFCFC = () => {
			if (patched) return;
			const f = W.FCFC || W.FCFCTestClaim;
			if (!f) return;
			const keys = ['runDirectClaim', 'runCheckedClaim', 'claimCode', 'claimWithRetries', 'testClaim', 'FCTestClaim', 'directClaim', 'startClaim'];
			for (const k of keys) {
				try { if (typeof f[k] === 'function') f[k] = nooper; } catch (_) {}
			}
			patched = true;
		};
		const poll = setInterval(() => { patchFCFC(); if (patched) clearInterval(poll); }, 250);
		setTimeout(() => clearInterval(poll), 30000);
	} catch (e) {}

	// ---- 3) Bridge extractor: watch FCFC's log textarea, dispatch surya:code --
	// Regexes cribbed from bridge v3.9.
	const RE_CODE_VALID  = /^[A-Za-z0-9._-]{8,48}$/;
	const RE_CODE_IN_LOG = /\b(?:CODE|bonus[_\s-]?code|drop[_\s-]?code|redeem[_\s-]?code)[:\s=]+([A-Za-z0-9._-]{8,48})/i;
	const RE_STAKE_CODE  = /(?<![A-Za-z0-9])stake[a-z0-9._-]{5,40}/i;

	const seen = new Map(); // dedup 10-min TTL
	function _seen(code) {
		const now = Date.now();
		for (const [k, t] of seen) if (now - t > 600000) seen.delete(k);
		if (seen.has(code)) return true;
		seen.set(code, now);
		return false;
	}

	function _extractCodes(line) {
		const out = [];
		if (!line || typeof line !== 'string') return out;
		let m = RE_CODE_IN_LOG.exec(line);
		if (m && m[1] && RE_CODE_VALID.test(m[1])) out.push(m[1]);
		m = RE_STAKE_CODE.exec(line);
		if (m && m[0] && RE_CODE_VALID.test(m[0])) out.push(m[0]);
		// dedupe within a line
		return Array.from(new Set(out));
	}

	function _dispatch(code, source, raw) {
		if (!code || _seen(code)) return;
		try {
			const detail = { code: code, source: source || 'fcfc-inline', raw: raw ? String(raw).slice(0, 240) : undefined, ts: Date.now(), bridgeVersion: '9.26.0-inline' };
			const evt = new CustomEvent('surya:code', { detail: detail, bubbles: true });
			(document || window.document).dispatchEvent(evt);
		} catch (_) {}
	}

	function _findLog() {
		try {
			return document.querySelector(
				'textarea#autoDropwrap, textarea.log, textarea.scrolly, textarea[class*="log"], textarea[class*="scrolly"], '
				+ '#autoDropwrap textarea, #autoDropwrap .log, #autoDropwrap .log-panel, '
				+ '.autoDropwrap textarea, .autoDropwrap .log'
			);
		} catch (_) { return null; }
	}

	function _readLog(el) {
		if (!el) return '';
		if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
		return el.textContent || el.innerText || '';
	}

	function _processDiff(el, newVal) {
		const prev = el.__suryaLastVal || '';
		if (!newVal || newVal === prev) { el.__suryaLastVal = newVal || prev; return; }
		let fresh = newVal;
		if (newVal.startsWith(prev)) fresh = newVal.slice(prev.length);
		el.__suryaLastVal = newVal;
		const lines = fresh.split(/\r?\n/);
		for (const line of lines) {
			const codes = _extractCodes(line);
			for (const c of codes) _dispatch(c, 'log', line);
		}
	}

	function _attachToLog() {
		const el = _findLog();
		if (!el || el.__suryaAttached) return !!el;
		el.__suryaAttached = true;
		const isTA = (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');

		// Process any existing content at attach time
		const initial = _readLog(el);
		if (initial) {
			const lines = initial.split(/\r?\n/);
			for (const line of lines) {
				const codes = _extractCodes(line);
				for (const c of codes) _dispatch(c, 'log-initial', line);
			}
			el.__suryaLastVal = initial;
		}

		if (isTA) {
			// Try setter-override for zero-latency capture
			try {
				const proto = (el.tagName === 'INPUT') ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
				const desc = Object.getOwnPropertyDescriptor(proto, 'value');
				if (desc && typeof desc.set === 'function' && typeof desc.get === 'function') {
					const origSet = desc.set;
					const origGet = desc.get;
					Object.defineProperty(el, 'value', {
						configurable: true,
						get: function () { return origGet.call(this); },
						set: function (v) { origSet.call(this, v); try { _processDiff(el, String(v == null ? '' : v)); } catch (_) {} }
					});
				}
			} catch (_) {}
			// Poll fallback (50ms)
			setInterval(() => { try { _processDiff(el, _readLog(el)); } catch (_) {} }, 50);
			try { el.addEventListener('input', () => _processDiff(el, _readLog(el))); } catch (_) {}
		} else {
			try {
				const mo = new MutationObserver(() => { try { _processDiff(el, _readLog(el)); } catch (_) {} });
				mo.observe(el, { childList: true, subtree: true, characterData: true });
			} catch (_) {}
		}
		return true;
	}

	// Retry attach until the FCFC log element appears
	let attachTries = 0;
	const attachTimer = setInterval(() => {
		attachTries++;
		if (_attachToLog()) { clearInterval(attachTimer); return; }
		if (attachTries > 400) clearInterval(attachTimer); // ~2 min max
	}, 300);

	// Also watch DOM globally in case FCFC replaces the textarea later
	try {
		const globalObs = new MutationObserver(() => { _attachToLog(); });
		const start = () => globalObs.observe(document.documentElement, { childList: true, subtree: true });
		if (document.documentElement) start();
		else document.addEventListener('DOMContentLoaded', start, { once: true });
	} catch (_) {}
})();


/* ============================================================================
 * BEGIN INLINED FCFC IIFE (v6.5, unmodified, silenced + hidden by prelude above)
 * ============================================================================
 * FCFC runs its own IIFE below. We wrap it in an offers-page URL guard and
 * shadow `console` with a no-op so its logs stay quiet. All UI it paints is
 * hidden by the CSS injected in the prelude, and its claim methods are
 * neutered by the monkey-patch above.
 * ============================================================================ */
if (/\/settings\/offers/i.test(location.pathname)) {
	(function () {
		// Shadow console for the entire FCFC scope
		const _noop = function () {};
		const console = { log: _noop, warn: _noop, error: _noop, info: _noop, debug: _noop, dir: _noop, table: _noop, group: _noop, groupEnd: _noop, trace: _noop, assert: _noop, count: _noop, time: _noop, timeEnd: _noop };
		/* --- FCFC BODY INLINED BELOW --- */

/* ============================================================================
 * SURYA CLAIMER v9.26.1 — SELF-HEALING SCRAPER WATCHDOG
 * ----------------------------------------------------------------------------
 * URL-guarded to the offers page (same guard as prelude). Runs independently
 * of the prelude — both dispatch to `surya:code`, dedup guarantees no dupes.
 *
 * Responsibilities:
 *   1. Re-attach MutationObserver + value-setter hook when FCFC rebuilds its
 *      log textarea (was the one un-handled failure mode in v9.26.0).
 *   2. Detect "log stopped growing" while page is visible → soft-reload the
 *      tab (rate-limited to 3 reloads / hour). Never reloads backgrounded tabs.
 *   3. Emit a 5-minute `surya:heartbeat` CustomEvent for VPS-side liveness
 *      tracking (server-side listener can log which RDPs are alive).
 *   4. Expose `window.__suryaScraperDiag()` for one-shot health inspection
 *      from DevTools.
 * ==========================================================================*/
(function () {
	'use strict';
	if (!/\/settings\/offers/i.test(location.pathname)) return;

	const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
	const D = (W.document || document);

	const state = {
		lastTextareaRef: null,
		lastLogLength: 0,
		lastLogGrowthAt: Date.now(),
		lastHeartbeatAt: 0,
		reattachCount: 0,
		startedAt: Date.now(),
	};

	const RE_LOG = /\b(?:CODE|bonus[_\s-]?code|drop[_\s-]?code|redeem[_\s-]?code)[:\s=]+([A-Za-z0-9._-]{8,48})/i;
	const RE_STAKE = /(?<![A-Za-z0-9])stake[a-z0-9._-]{5,40}/i;
	const seen = new Map();
	const DEDUP_TTL = 600000;

	function dispatch(code, source) {
		if (!code) return;
		const now = Date.now();
		if (seen.has(code) && (now - seen.get(code)) < DEDUP_TTL) return;
		seen.set(code, now);
		try {
			D.dispatchEvent(new CustomEvent('surya:code', {
				detail: { code, source: source || 'inline-fcfc-wd', ts: now },
				bubbles: true,
			}));
		} catch (_) {}
	}

	function scanAndDispatch(text) {
		if (!text || typeof text !== 'string') return;
		let m = text.match(RE_LOG);
		if (m) dispatch(m[1], 'inline-fcfc-wd');
		m = text.match(RE_STAKE);
		if (m) dispatch(m[0], 'inline-fcfc-wd-stake');
	}

	function attachTo(el) {
		if (!el) return false;
		if (el === state.lastTextareaRef && D.contains(el)) return false;
		state.lastTextareaRef = el;
		state.reattachCount++;

		try {
			const mo = new MutationObserver(() => scanAndDispatch(el.value || el.textContent || ''));
			mo.observe(el, { childList: true, characterData: true, subtree: true });
		} catch (_) {}

		try { el.addEventListener('input', () => scanAndDispatch(el.value || '')); } catch (_) {}

		try {
			const proto = Object.getPrototypeOf(el);
			const desc = Object.getOwnPropertyDescriptor(proto, 'value');
			if (desc && desc.set && !el.__suryaWdHooked) {
				el.__suryaWdHooked = true;
				Object.defineProperty(el, 'value', {
					configurable: true,
					enumerable: true,
					get() { return desc.get.call(this); },
					set(v) {
						desc.set.call(this, v);
						try { scanAndDispatch(String(v == null ? '' : v)); } catch (_) {}
					},
				});
			}
		} catch (_) {}

		try { scanAndDispatch(el.value || ''); } catch (_) {}
		return true;
	}

	function findLogTextarea() {
		return D.querySelector(
			'textarea#autoDropwrap, textarea.log, textarea.scrolly, ' +
			'textarea[class*="log"], #autoDropwrap textarea, #autoDropwrap .log'
		);
	}

	/* --- 30s heartbeat: reattach + track growth --- */
	setInterval(() => {
		try {
			const el = findLogTextarea();
			if (el) {
				if (el !== state.lastTextareaRef || !D.contains(state.lastTextareaRef)) attachTo(el);
				const len = (el.value || '').length;
				if (len > state.lastLogLength) {
					state.lastLogLength = len;
					state.lastLogGrowthAt = Date.now();
				}
			}
		} catch (_) {}
	}, 30000);

	/* --- Boot attach with retries (in case FCFC paints slow) --- */
	(function bootAttach(attempts) {
		const el = findLogTextarea();
		if (el) { attachTo(el); return; }
		if (attempts > 0) setTimeout(() => bootAttach(attempts - 1), 500);
	})(120); // 60 seconds of retries

	/* --- Stale-log recovery: if visible + no growth for 5min → reload --- */
	const STALE_MS = 5 * 60 * 1000;
	const MAX_RELOADS_PER_HOUR = 3;
	const RELOAD_WINDOW_MS = 60 * 60 * 1000;

	setInterval(() => {
		try {
			if (D.hidden) return;
			if (Date.now() - state.startedAt < 90 * 1000) return; // grace period on boot
			const stale = Date.now() - state.lastLogGrowthAt;
			if (stale < STALE_MS) return;
			let stamps;
			try { stamps = JSON.parse(sessionStorage.getItem('__surya_reload_stamps__') || '[]'); } catch (_) { stamps = []; }
			stamps = stamps.filter(t => Date.now() - t < RELOAD_WINDOW_MS);
			if (stamps.length >= MAX_RELOADS_PER_HOUR) return;
			stamps.push(Date.now());
			try { sessionStorage.setItem('__surya_reload_stamps__', JSON.stringify(stamps)); } catch (_) {}
			try { console.warn('[Surya WD] log stale ' + Math.round(stale / 1000) + 's — reloading'); } catch (_) {}
			W.location.reload();
		} catch (_) {}
	}, 60000);

	/* --- 5-minute heartbeat CustomEvent --- */
	setInterval(() => {
		const now = Date.now();
		if (now - state.lastHeartbeatAt < 5 * 60 * 1000) return;
		state.lastHeartbeatAt = now;
		try {
			D.dispatchEvent(new CustomEvent('surya:heartbeat', {
				detail: {
					uptime: now - state.startedAt,
					reattaches: state.reattachCount,
					logLen: state.lastLogLength,
					lastGrowthAgo: now - state.lastLogGrowthAt,
					attached: !!state.lastTextareaRef && D.contains(state.lastTextareaRef),
				},
				bubbles: true,
			}));
		} catch (_) {}
	}, 60000);

	/* --- Diagnostic hook for DevTools — window.__suryaScraperDiag() --- */
	try {
		W.__suryaScraperDiag = function () {
			return {
				uptimeMs: Date.now() - state.startedAt,
				reattaches: state.reattachCount,
				logLen: state.lastLogLength,
				lastGrowthAgoMs: Date.now() - state.lastLogGrowthAt,
				textareaAttached: !!state.lastTextareaRef && D.contains(state.lastTextareaRef),
				seenCodes: seen.size,
			};
		};
	} catch (_) {}
})();

const _0xc350=['YWlXekY=','YW9HdVc=','aW5pdFdzVjNLZXk=','bG9ndGV4dA==','TG9nc1I=','WXZWUko=','dGhlbWU=','MzgwcHg=','RlBKc2M=','YVltR04=','aHJlZg==','I2F1dG9Ecm9wd3JhcCAucmVkZWVtLXdyYXAgZm9ybSAucmVkZWVtLWFtb3VudCBpbnB1dA==','c3Rha2UudXM=','Q3JlYXRlVmF1bHREZXBvc2l0RXJyb3I6IA==','UUZBeVI=','aW5jbHVkZXM=','bm93','56eSICg=','T2tmanQ=','Z0ZRR1E=','b3R4SnM=','UGllZnA=','S0daSXk=','TFpYbEU=','c3ZNZXU=','UHJncEc=','cmVmcmVzaA==','bGdiZXM=','VVhXQVo=','ZVFZcmM=','ZGVidWc=','ZmF6enM=','Z1RTUks=','Z056SWs=','amdpbGU=','cnVuRGlyZWN0Q2xhaW0=','Q29ubmVjdGVk','YmFsYW5jZQ==','ZWFjaA==','UWlrbW0=','d05ScU8=','eVlBaFY=','IElEOg==','anpFQ2k=','aVpzSFk=','Zm9yRWFjaA==','SlFjUG4=','Z2V0VG9rZW4=','R2xmUk0=','dXNlclNldHRpbmdTdG9yZUtleQ==','6L+e5o6l5pat5byA77ya','andURkM=','ICAgLSByZW1vdmU6','RkJlVVA=','UmVjaGFyZ2U=','Y3hIZEE=','ekZybUg=','77yM562J5b6FMjBz5bem5Y+z5YaN6I635Y+W5YWF5YC856CB44CC','Z2VuZXJhdGlvblNwYWNpbmdNcw==','UmN1VWE=','bWF4','5YWR5o2i57uT5p6c','ZnhQaU4=','PC9kaXY+CiAgICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICAgICAgICAgICAgPGRpdj4KICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImJsb2NrLXRpdGxlIj4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJtYXJrIj48c3Bhbj48L3NwYW4+PC9kaXY+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPHAgY2xhc3M9InRleHQiPg==','cFZwcWE=','RXpyeXA=','blRBaWs=','c2xpY2U=','VUNXdUQ=','PC9zcGFuPjwvYnV0dG9uPgogICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBzdHlsZT0icGFkZGluZzogMTBweCAwOyBib3JkZXItYm90dG9tOiAycHggc29saWQgIzJGNDU1MyI+','aWZqUEQ=','QXlOVmQ=','aHVzRGY=','bnZPdkk=','Q0xhWHM=','dWdhUlo=','S0hYd2Y=','eWpGV2I=','RlRacGo=','R0VOZHM=','WnlMSWo=','VVhLUGQ=','alZUV24=','eGRuaks=','WW91IGhhdmUgYWxyZWFkeSBjbGFpbWVkIHRoaXMgY29kZS4=','d3dzQWU=','R0lFc1A=','aXNTb2Z0RXhwaXJlZA==','cHZOUFI=','Y2JEeXM=','d2lkZ2V0SWQ=','clJTeVY=','Z2V0U29mdEV4cGlyZWRUb2tlbkNvdW50','U0F5dVU=','QmtpVW8=','TnpRdEw=','cEVBaEo=','d3NWM0NyeXB0b0tleQ==','VENKSlg=','WWVJa1k=','YXBwZW5kQ2hpbGQ=','TGp3YW4=','Ym90TmFtZQ==','cUxodHA=','cVhwQWo=','RExPUFA=','RUFXZkU=','Q0Vadko=','YmFzZTY0VG9VaW50OEFycmF5','NjBweA==','R2V0dGluZyBiYWxhbmNlLi4u','R3hGVUs=','UGxlYXNlIGVudGVyIHRoZSByZWNoYXJnZSBjb2RlLg==','dldudHk=','bXV0YXRpb24gQ3JlYXRlVmF1bHREZXBvc2l0KCRjdXJyZW5jeTogQ3VycmVuY3lFbnVtISwgJGFtb3VudDogRmxvYXQhKSB7CiAgY3JlYXRlVmF1bHREZXBvc2l0KGN1cnJlbmN5OiAkY3VycmVuY3ksIGFtb3VudDogJGFtb3VudCkgewogICAgaWQKICAgIGFtb3VudAogICAgY3VycmVuY3kKICAgIHVzZXIgewogICAgICBpZAogICAgICBiYWxhbmNlcyB7CiAgICAgICAgYXZhaWxhYmxlIHsKICAgICAgICAgIGFtb3VudAogICAgICAgICAgY3VycmVuY3kKICAgICAgICB9CiAgICAgICAgdmF1bHQgewogICAgICAgICAgYW1vdW50CiAgICAgICAgICBjdXJyZW5jeQogICAgICAgIH0KICAgICAgfQogICAgfQogICAgX190eXBlbmFtZQogIH0KfQo=','c2l0ZUtleQ==','bmFtZQ==','aG9YT20=','WmlNcHc=','TVRud0Y=','ZFVSV2k=','Y3JlYXRlVG9rZW5Qcm9taXNl','Z1NhU2Y=','RGVVQks=','Y29pbg==','5L2Z6aKdOg==','RGJQaVc=','cHdJcnk=','a2JXbEo=','UFJrYnU=','6Ieq5Yqo6K6k6aKG54q25oCBOg==','RFFNbEY=','eHBZREg=','d3lDS3I=','dWN4bmg=','SW1ValM=','cklHUmk=','Y2xlYXJTa2lw','SU5wdks=','Y29ubmVjdGVk','ck9LVkw=','VEROZWY=','IiB0YXJnZXQ9Il9ibGFuayI+d3d3LmhoMTIzLnNpdGU8L2E+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IHN0eWxlPSI=','WkhRTmo=','aWdiWHk=','V1REQ28=','I2F1dG9Ecm9wd3JhcCAubG9n','VGxwd3Q=','U3dlSUQ=','Z21NRk8=','Y2Z3T1Q=','VW5KVFI=','WlRKQko=','RVRoQlA=','dlRUdFE=','5pyA5bCP5YWF5YC86YeR6aKd5Li6MXVzZA==','WFRVSHY=','b3JpZ2lu','dmFhTlQ=','LFdhaXQgYWJvdXQgMjBzIGJlZm9yZSBnZXR0aW5nIHRoZSByZWNoYXJnZSBjb2RlLg==','TkdZR2E=','QklEV3Y=','ICAgLSByZXNldDo=','T0JUdnU=','cExNbGU=','ZXJyb3ItY2FsbGJhY2s=','blVnSmc=','SE1Samk=','Rk5hWUc=','QXNnUmc=','QXpURm8=','dHVybnN0aWxlVG9rZW4=','dGZmekQ=','THZWdGw=','SXFSWlE=','RWFST3M=','ekJwZGs=','S2lXT1A=','KTog','dUZpRkI=','WW91ciBlbWFpbCBhZGRyZXNzIGlzIG5vdCB2ZXJpZmllZC4gUGxlYXNlIHZlcmlmeSB5b3VyIGVtYWlsIGFkZHJlc3MgYW5kIHRyeSBhZ2Fpbi4=','b0RTdFQ=','alJzWXc=','d2Vic29ja2V0','b25lcnJvcg==','UlNnZWo=','YWVjcUo=','VE9nT28=','cXVlcnk=','RGFpbHlPdGhlcg==','bWFya1NraXA=','ZlhpY0c=','b3BhY2l0eQ==','dmZOUmY=','aXBQYXk=','cHJvdG90eXBl','LSBXaWRnZXQgSUQ6','I2UxOWExNA==','dVFKU1c=','VkVWVHk=','dHJ4','bmxaeUs=','TWlYVmo=','SnliUk8=','blF5ZUQ=','O3otaW5kZXg6MTAwMDAwMDtiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjUpO2JvcmRlci1yYWRpdXM6NXB4O3dpZHRoOg==','enlhdGQ=','dUVPa24=','bW9kZQ==','TkRBR3U=','cFFCVkU=','cG54U0E=','RVhSVE4=','RkxmQW8=','8J+TrSDnvJPlrZjkuLrnqbo=','Y09Nd1g=','bVhPdEs=','dFdWYk0=','cFhEZmo=','dUhJc3U=','cnVuQ2hlY2tlZENsYWlt','Ukp3eEM=','Y2hlY2tDb2RlQXZhaWxhYmlsaXR5','cFRjekk=','VkNEUnU=','SEVaR2g=','SWFadEY=','ZXJyb3Jz','ZXJvZkQ=','RWhVcGo=','d2xwUXU=','TE9HSU5fRVJST1I6IA==','UElXUWw=','aEdaT08=','U1pkU04=','YWJQRlE=','T3dWUFA=','4p2MIOW8uuWItuWIneWni+WMluWksei0pTo=','cmNlVGo=','YlJYQnI=','TllqY04=','RFdSeUI=','T0NtTEg=','dlFva2Y=','Y29uc3RydWN0b3I=','WkhXTUM=','enlaQ1c=','YXBwbGljYXRpb24vanNvbg==','WHFQYUM=','5aWW6YeR5pyq5om+5Yiw5oiW5LiN5Y+v55So','c3VjY2Vzcw==','TkxDSUw=','T1ljUkk=','ZGVjcnlwdFdzVjNNZXNzYWdl','VkZjWEo=','eVFBQms=','TFN5bW4=','VEhCeHg=','UGJXYmg=','b2FMaGg=','dWpEUGw=','dkdGVUc=','Q0xBSU1fU1VDQ0VTUw==','U3VaYVM=','ckxOZEs=','Y2hhbmdl','bUxuYkw=','eU1MV3A=','ZXJyTXNn','SnpDVFA=','6K+35L+d5a2Y5aW95L2g55qE5YWF5YC856CB77yM5LiN6KaB5rOE6Zyy57uZ5Lu75L2V5Lq644CC','VFlTSnk=','eUNNdU4=','Z3ZHaHo=','LnVz','cmVjZWl2ZWRBdA==','enh2Ymk=','SGhRVU8=','aW5pdGlhbGl6ZWQ=','ZEt0SE8=','U1BRTng=','TWlmUXk=','dnhCRHc=','RUZ4R0g=','Y3JwZ1o=','eXRqSEI=','a0FxeFY=','I2F1dG9Ecm9wd3JhcCAubG9hZGVyLXdyYXA=','b3JwZUg=','cUJ0TG8=','cUNacEE=','CiAgICAgICAgLmxvYWRpbmcgewogICAgICAgICAgICB3aWR0aDogNC43NXJlbTsKICAgICAgICAgICAgaGVpZ2h0OiAuNzVyZW07CiAgICAgICAgICAgIGJhY2tncm91bmQtY29sb3I6ICMyZjQ1NTM7CiAgICAgICAgICAgIHRvcDogNDYlOwogICAgICAgICAgICBsZWZ0OiA1MCU7CiAgICAgICAgICAgIHRyYW5zZm9ybTogdHJhbnNsYXRlKC01MCUsIC01MCUpOwogICAgICAgICAgICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgICAgICAgICAgIGJvcmRlci1yYWRpdXM6IHZhcigtLXJhZGl1cy1sZyk7CiAgICAgICAgfQogICAgICAgIC5sb2FkaW5nLWFuaW1hdGlvbiB7CiAgICAgICAgICAgIGJvcmRlci1yYWRpdXM6IHZhcigtLXJhZGl1cy1sZyk7CiAgICAgICAgICAgIHBvc2l0aW9uOiBhYnNvbHV0ZTsKICAgICAgICAgICAgYmFja2dyb3VuZC1jb2xvcjogI2ExYzhmMzsKICAgICAgICAgICAgdG9wOiAwLjEyNXJlbTsKICAgICAgICAgICAgYm90dG9tOiAwLjEyNXJlbTsKICAgICAgICAgICAgYW5pbWF0aW9uOiBzdmVsdGUtc2xpZGUgMC44cyBpbmZpbml0ZSBlYXNlOwogICAgICAgIH0KICAgICAgICBAa2V5ZnJhbWVzIHN2ZWx0ZS1zbGlkZSB7CiAgICAgICAgICAgIDAlIHsKICAgICAgICAgICAgICAgIHJpZ2h0OiA0cmVtOwogICAgICAgICAgICAgICAgbGVmdDogLjEyNXJlbTsKICAgICAgICAgICAgfQogICAgICAgICAgICA1JSB7CiAgICAgICAgICAgICAgICBsZWZ0OiAuMTI1cmVtOwogICAgICAgICAgICB9CiAgICAgICAgICAgIDUwJSB7CiAgICAgICAgICAgICAgICByaWdodDogLjEyNXJlbTsKICAgICAgICAgICAgICAgIGxlZnQ6IDRyZW07CiAgICAgICAgICAgIH0KICAgICAgICAgICAgNTUlIHsKICAgICAgICAgICAgICAgIHJpZ2h0OiAuMTI1cmVtOwogICAgICAgICAgICB9CiAgICAgICAgICAgIDEwMCUgewogICAgICAgICAgICAgICAgcmlnaHQ6IDRyZW07CiAgICAgICAgICAgICAgICBsZWZ0OiAuMTI1cmVtOwogICAgICAgICAgICB9CiAgICAgICAgfQogICAgICAgIC5wdWxzaW5nLXRleHQgewogICAgICAgICAgICBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7CiAgICAgICAgICAgIGFuaW1hdGlvbjogcHVsc2UgMXMgaW5maW5pdGUgZWFzZS1pbi1vdXQ7CiAgICAgICAgfQoKICAgICAgICBAa2V5ZnJhbWVzIHB1bHNlIHsKICAgICAgICAgICAgMCUgeyB0cmFuc2Zvcm06IHNjYWxlKDEpOyB9CiAgICAgICAgICAgIDUwJSB7IHRyYW5zZm9ybTogc2NhbGUoMC41KTsgfQogICAgICAgICAgICAxMDAlIHsgdHJhbnNmb3JtOiBzY2FsZSgxKTsgfQogICAgICAgIH0KICAgICAgICAjYXV0b0Ryb3B3cmFwIC5jb2luLXF0eTo6LXdlYmtpdC1pbm5lci1zcGluLWJ1dHRvbiwubm8tc3Bpbm5lcnM6Oi13ZWJraXQtb3V0ZXItc3Bpbi1idXR0b257LXdlYmtpdC1hcHBlYXJhbmNlOiBub25lO21hcmdpbjogMDt9CiAgICAgICAgI2F1dG9Ecm9wd3JhcCAuY29pbi1xdHk6Oi13ZWJraXQtaW5wdXQtcGxhY2Vob2xkZXIge2NvbG9yOiAjNzc4Njk5fQogICAgICAgICNkcm9wLXN0YXR1cyB7cG9zaXRpb246Zml4ZWQ7cmlnaHQ6IDA7dG9wOjI1NXB4O3BhZGRpbmc6MCA1cHg7aGVpZ2h0OjMwcHg7dGV4dC1hbGlnbjpjZW50ZXI7bGluZS1oZWlnaHQ6MzBweDtiYWNrZ3JvdW5kOiMxNDc1RTE7Y29sb3I6I2ZmZjtmb250LXNpemU6MTJweDtjdXJzb3I6cG9pbnRlcjt6LWluZGV4OjEwMDAwMDE7Ym9yZGVyLXRvcC1sZWZ0LXJhZGl1czogMTZweDsKICAgIGJvcmRlci1ib3R0b20tbGVmdC1yYWRpdXM6IDE2cHg7fQogICAgICAgICNhdXRvRHJvcHdyYXAgLmxvZyB7cGFkZGluZzo1cHg7bWFyZ2luLXRvcDoxMHB4O2ZvbnQtc2l6ZTowLjc4cmVtO2JhY2tncm91bmQ6IzBGMjEyRTtib3JkZXItcmFkaXVzOjRweDtvdXRsaW5lOiBub25lO2ZvbnQtZmFtaWx5OmF1dG87d2lkdGg6MTAwJTtoZWlnaHQ6NDIwcHg7Ym9yZGVyOjFweCBzb2xpZCAjMmY0NTUzO30KICAgICAgICAjYXV0b0Ryb3B3cmFwIC5yZWNoYXJnZS13cmFwIHtkaXNwbGF5Om5vbmU7cG9zaXRpb246YWJzb2x1dGU7dG9wOjQ2cHg7bGVmdDoyMHB4O3JpZ2h0OjIwcHg7cGFkZGluZzo4cHg7aGVpZ2h0Ojc4JTtiYWNrZ3JvdW5kOiMxYTJjMzg7Ym9yZGVyLXJhZGl1czo1cHg7Ym9yZGVyOiAxcHggc29saWQgIzJmNDU1Mztmb250LXNpemU6MTJweDtsaW5lLWhlaWdodDoxLjU7Y29sb3I6I2IxYmFkMztib3gtc2hhZG93OiAwIDAgMjBweCAjMmY0NTUzO292ZXJmbG93OmF1dG87fQogICAgICAgICNhdXRvRHJvcHdyYXAgLnJlY2hhcmdlLXdyYXAgLmJsb2NrLXRpdGxlIHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO3BhZGRpbmc6IDEwcHggMDt9CiAgICAgICAgI2F1dG9Ecm9wd3JhcCAucmVjaGFyZ2Utd3JhcCAuYmxvY2stdGl0bGUgLm1hcmsge2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjt3aWR0aDo4cHg7aGVpZ2h0OjEycHg7YmFja2dyb3VuZDojMTQ3NUUxO21hcmdpbi1yaWdodDo1cHg7Ym9yZGVyLXRvcC1yaWdodC1yYWRpdXM6IDZweDtib3JkZXItYm90dG9tLXJpZ2h0LXJhZGl1czogNnB4O30KICAgICAgICAjYXV0b0Ryb3B3cmFwIC5yZWNoYXJnZS13cmFwIC5ibG9jay10aXRsZSAubWFyayBzcGFuIHtkaXNwbGF5OiBibG9jazt3aWR0aDozcHg7aGVpZ2h0OjNweDtib3JkZXItcmFkaXVzOjJweDtiYWNrZ3JvdW5kOiNmZmY7fQogICAgICAgICNhdXRvRHJvcHdyYXAgLnJlY2hhcmdlLXdyYXAgLmJsb2NrLXRpdGxlIC50ZXh0IHtjb2xvcjojZDhkYWRmO2ZvbnQtd2VpZ2h0OmJvbGQ7fQogICAgICAgICNhdXRvRHJvcHdyYXAgLnJlZGVlbS13cmFwIGZvcm0ge2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczogY2VudGVyO2p1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2Vlbjt9CiAgICAgICAgI2F1dG9Ecm9wd3JhcCAucmVkZWVtLXdyYXAgZm9ybSAuZm9ybS1pdGVtIHtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO30KICAgICAgICAjYXV0b0Ryb3B3cmFwIC5yZWRlZW0td3JhcCBmb3JtIC5mb3JtLWl0ZW0gaW5wdXQge3BhZGRpbmc6NXB4O2hlaWdodDozMHB4O2JhY2tncm91bmQ6IzBGMjEyRTtib3JkZXI6MXB4IHNvbGlkICMyRjQ1NTM7Ym9yZGVyLXJhZGl1czo1cHg7Y29sb3I6I2ZmZjt9CiAgICAgICAgI2F1dG9Ecm9wd3JhcCAucmVkZWVtLXdyYXAgLnJlZGVlbS1idG4ge3BhZGRpbmc6IDAgNXB4O21hcmdpbi10b3A6MTBweDtoZWlnaHQ6IDMwcHg7d2lkdGg6MTAwJTtib3JkZXItcmFkaXVzOiA0cHg7YmFja2dyb3VuZDogIzE0NzVFMTtjb2xvcjojZmZmO2N1cnNvcjpuby1kcm9wO29wYWNpdHk6MC42O30KCiAgICAgICAgI2F1dG9Ecm9wd3JhcCAuZ2V0LXJlZGVlbS1jb2RlLWJ0biB7cGFkZGluZzowIDZweDtoZWlnaHQ6MTAwJTt3aWR0aDoxMDAlO2JhY2tncm91bmQ6bm9uZTtib3JkZXI6bm9uZTtjb2xvcjojMTQ3NUUxO2ZvbnQtd2VpZ2h0OmJvbGQ7Y3Vyc29yOnBvaW50ZXI7fQogICAgICAgICNhdXRvRHJvcHdyYXAgLnRpcC1idXktd3JhcCB7bWFyZ2luLXRvcDo1cHg7fQogICAgICAgICNhdXRvRHJvcHdyYXAgLnJlY2hhcmdlLWNsb3NlIHtwb3NpdGlvbjphYnNvbHV0ZTtib3R0b206LTIwcHg7bGVmdDo1MCU7bWFyZ2luLWxlZnQ6LTEwcHg7aGVpZ2h0OjIwcHg7d2lkdGg6MjBweDtib3JkZXItcmFkaXVzOiAxNnB4O2JvcmRlcjoxcHggc29saWQgIzJmNDU1MztsaW5lLWhlaWdodDoyMHB4O3RleHQtYWxpZ246Y2VudGVyO2N1cnNvcjogcG9pbnRlcjt9CiAgICAgICAgI2F1dG9Ecm9wd3JhcCAuc2VydmljZS13cmFwIHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7aGVpZ2h0OjMwcHg7Ym9yZGVyLXJhZGl1czo1cHg7Ym9yZGVyOjFweCBzb2xpZCAjMmY0NTUzO30KICAgICAgICAjYXV0b0Ryb3B3cmFwIC5zZXJ2aWNlLXdyYXAgYSB7Y29sb3I6IzE0NzVFMTtwYWRkaW5nOjJweCA2cHg7Ym9yZGVyLXJhZGl1czozMHB4O2ZvbnQtd2VpZ2h0OmJvbGQ7fQogICAgICAgICNhdXRvRHJvcHdyYXAgLnN1cG9ydC1jdXJyZW5jeSBzcGFuIHtkaXNwbGF5OmlubGluZS1ibG9jaztwYWRkaW5nOjAgMnB4O2JhY2tncm91bmQ6ICM1NDVjNjI7fQoKICAgICAgICAjYXV0b0Ryb3B3cmFwIC51c2VyLXNldC13cmFwIHtkaXNwbGF5Om5vbmU7cG9zaXRpb246YWJzb2x1dGU7dG9wOjQ2cHg7bGVmdDoyMHB4O3JpZ2h0OjIwcHg7cGFkZGluZzo1cHg7aGVpZ2h0Ojc0JTtiYWNrZ3JvdW5kOiMxYTJjMzg7Ym9yZGVyLXJhZGl1czo1cHg7Ym9yZGVyOiAxcHggc29saWQgIzJmNDU1Mztmb250LXNpemU6MTJweDtsaW5lLWhlaWdodDoxLjU7Y29sb3I6I2IxYmFkMztib3gtc2hhZG93OiAwIDAgMjBweCAjMmY0NTUzO30KICAgICAgICAjYXV0b0Ryb3B3cmFwIC51c2VyLXNldC13cmFwIC5jbG9zZSB7cG9zaXRpb246YWJzb2x1dGU7Ym90dG9tOi0yMHB4O2xlZnQ6NTAlO21hcmdpbi1sZWZ0Oi0xMHB4O2hlaWdodDoyMHB4O3dpZHRoOjIwcHg7Ym9yZGVyLXJhZGl1czogMTZweDtib3JkZXI6MXB4IHNvbGlkICMyZjQ1NTM7bGluZS1oZWlnaHQ6MjBweDt0ZXh0LWFsaWduOmNlbnRlcjtjdXJzb3I6IHBvaW50ZXI7fQogICAgICAgICNhdXRvRHJvcHdyYXAgLnVzZXItc2V0LXdyYXAgLmN1cnJlbmN5LXdyYXAge2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47cGFkZGluZzo1cHg7bWFyZ2luLWJvdHRvbTogNXB4O2JvcmRlcjoxcHggc29saWQgIzJmNDU1Mztib3JkZXItcmFkaXVzOjVweDt9CiAgICAgICAgI2F1dG9Ecm9wd3JhcCAudXNlci1zZXQtd3JhcCAuY3VycmVuY3ktd3JhcCAudGl0bGUge2ZvbnQtd2VpZ2h0OmJvbGQ7Y29sb3I6ICNlNzllMDA7fQogICAgICAgICNhdXRvRHJvcHdyYXAgLnVzZXItc2V0LXdyYXAgLmN1cnJlbmN5LXdyYXAgLmN1cnJlbmN5IHtwYWRkaW5nOjAgMTBweDt3aWR0aDoxMDBweDtoZWlnaHQ6MzBweDtiYWNrZ3JvdW5kOiAjMEYyMTJFO3RleHQtYWxpZ246IGNlbnRlcjtmb250LXNpemU6IDEzcHg7Ym9yZGVyLXJhZGl1czo1cHg7fQogICAgICAgICNhdXRvRHJvcHdyYXAgLnVzZXItc2V0LXdyYXAgZm9ybSB7ZmxleDoxO3BhZGRpbmc6NXB4O2JvcmRlcjoxcHggc29saWQgIzJmNDU1Mztib3JkZXItcmFkaXVzOjVweDt9CiAgICAgICAgI2F1dG9Ecm9wd3JhcCAudXNlci1zZXQtd3JhcCBmb3JtIGlucHV0W3R5cGVdIHstd2Via2l0LWFwcGVhcmFuY2U6IGF1dG87YXBwZWFyYW5jZTogYXV0bzt9CiAgICAgICAgI2F1dG9Ecm9wd3JhcCAudXNlci1zZXQtd3JhcCAudmF1bHQtZGVzcG9zaXQge2ZsZXg6MTtwYWRkaW5nOjVweDttYXJnaW4tbGVmdDo1cHg7Ym9yZGVyOjFweCBzb2xpZCAjMmY0NTUzO2JvcmRlci1yYWRpdXM6NXB4O30KICAgICAgICAjYXV0b0Ryb3B3cmFwIC51c2VyLXNldC13cmFwIC52YXVsdC1kZXNwb3NpdCBpbnB1dFt0eXBlXSB7LXdlYmtpdC1hcHBlYXJhbmNlOiBhdXRvO2FwcGVhcmFuY2U6IGF1dG87fQogICAg','QW1vdW50KCQp','ckZSQ0c=','dUxUQ3M=','am5yV2U=','SmdlV2o=','cXJ2VEk=','UnBIamI=','dW9CdkI=','aEFxQ0g=','Y29uZWN0ZWQ=','8J+OgSAt','WXh3aUs=','VXZ5eXI=','VU9IRlQ=','bWlu','bmx5UGY=','UHFhTng=','PC9wPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxwPkRhaWx5IERyb3BzPC9wPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgc3R5bGU9InBhZGRpbmctbGVmdDoxNXB4OyI+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGxhYmVsPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8aW5wdXQgdHlwZT0iY2hlY2tib3giIHZhbHVlPSJEYWlseTEiPiAkMQogICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvbGFiZWw+PGJyPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxsYWJlbD4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGlucHV0IHR5cGU9ImNoZWNrYm94IiB2YWx1ZT0iRGFpbHkyIj4gJDIKICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2xhYmVsPjxicj4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8bGFiZWw+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxpbnB1dCB0eXBlPSJjaGVja2JveCIgdmFsdWU9IkRhaWx5MyI+ICQzCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9sYWJlbD48YnI+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGxhYmVsPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8aW5wdXQgdHlwZT0iY2hlY2tib3giIHZhbHVlPSJEYWlseU90aGVyIj4gT3RoZXJzCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9sYWJlbD48YnI+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9kaXY+CgogICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxsYWJlbD4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8aW5wdXQgdHlwZT0iY2hlY2tib3giIHZhbHVlPSJIaWdoUm9sbGVycyI+IEhpZ2ggUm9sbGVycwogICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvbGFiZWw+PGJyPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxsYWJlbD4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8aW5wdXQgdHlwZT0iY2hlY2tib3giIHZhbHVlPSJXZWVrbHlTdHJlYW0iPiBXZWVrbHkgU3RyZWFtIERyb3BzCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9sYWJlbD48YnI+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGxhYmVsPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8aW5wdXQgdHlwZT0iY2hlY2tib3giIHZhbHVlPSJPdGhlckRyb3BzIj4gT3RoZXIgRHJvcHMKICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2xhYmVsPjxicj4KICAgICAgICAgICAgICAgICAgICAgICAgIDwvZm9ybT4KICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9InZhdWx0LWRlc3Bvc2l0Ij4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8bGFiZWwgc3R5bGU9ImNvbG9yOiNlNzllMDA7Zm9udC13ZWlnaHQ6Ym9sZDsiPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8aW5wdXQgdHlwZT0iY2hlY2tib3giPiA=','bnhSTGU=','8J+UhCDnlJ/miJDnirbmgIE6IA==','cXVlcnkgQm9udXNDb2RlSW5mb3JtYXRpb24oJGNvZGU6IFN0cmluZyEsICRjb3Vwb25UeXBlOiBDb3Vwb25UeXBlISkgewogIGJvbnVzQ29kZUluZm9ybWF0aW9uKGNvZGU6ICRjb2RlLCBjb3Vwb25UeXBlOiAkY291cG9uVHlwZSkgewogICAgYXZhaWxhYmlsaXR5U3RhdHVzCiAgICBib251c1ZhbHVlCiAgfQp9Cg==','VnBHa2E=','SnpHTU0=','WEJzWWw=','VHVybnN0aWxlTWFuYWdlciDlrZjlnKg6','b25SVVc=','UkxDekg=','dWx6c00=','eVVXa0o=','WHd1YVc=','I2Ryb3Atc3RhdHVz','c1BNWkQ=','Vlh6VGg=','5oKo55qE55S15a2Q6YKu5Lu25Zyw5Z2A5pyq57uP6aqM6K+B77yM6K+36aqM6K+B5oKo55qE55S15a2Q6YKu5Lu25Zyw5Z2A77yM54S25ZCO6YeN6K+V','ZGZWbUY=','V3ROZEM=','Y2xhaW1Db25kaXRpb25Cb251c0NvZGU=','Y1FjVmc=','anlDSU0=','WWFuTVI=','RGR0Qmw=','UHFCeHg=','aW5pdA==','aGFz','aHR0cHM6Ly9jb2RlLmhoMTIzLnNpdGU=','a05HYUQ=','bGVuZ3Ro','RGlPdWM=','d0d0Q3c=','Z0RkSEM=','YmRGT2I=','V3FVTGc=','RGFpbHkz','YXd4QXk=','c3ViX3N5c3RlbQ==','Zmxvb3I=','YWRk','WnB6Y00=','bXJpenc=','aExNWWI=','cXJyTVc=','TUpuRmE=','4p2MIOehrOi/h+acnw==','Z2djV2c=','YWN0aXZlVGFzaw==','Q29udGVudC1UeXBl','6I635Y+W5YWF5YC856CB','Qm9udXNDb2RlSW5mb3JtYXRpb24=','YmFja2dyb3VuZA==','VHVybnN0aWxlIGNvbnRhaW5lciB1bmF2YWlsYWJsZS4=','RUZ4RVk=','dGFza01hcA==','d3NIRHU=','dkFBUlU=','a2lk','c2VFaUM=','YXBlWmQ=','Z3hVV2g=','bmZvdEo=','Zm1kQmw=','ZXV1b0I=','YXZhaWxhYmxlSW5DcnlwdG9Pbmx5','RVdPenI=','YUlDWVQ=','SFlHQ2c=','4pyFIOe7tOaKpOWZqOW3sui/kOihjA==','bm90Rm91bmQ=','dGlIbWs=','aHRtbA==','aXNSdW5uaW5n','T1pVaWo=','cmJVYUI=','TWdlVXM=','Q0lhVkk=','bkFWQXM=','blJyaVI=','cVVYS3o=','ZldnUm0=','WUdLcHM=','SFVZR3k=','cHVoRnY=','d0tmQmc=','bFpRcFE=','aEp2Q1g=','ZVdNZkk=','c3RyaW5naWZ5','elpEeFE=','aXdxTUM=','QnNjV1A=','TFNkVng=','YWlHVVY=','SFpnU2M=','bG9hZFR1cm5zdGlsZVNjcmlwdA==','ICAg5Ymp5L2ZOiA=','V3VNVXc=','dU5kVnc=','aWlpREY=','PC9zcGFuPgogICAgICAgICAgICAgICAgICAgICAgICA8c2VsZWN0IG5hbWU9ImN1cnJlbmN5IiBjbGFzcz0iY3VycmVuY3kiPjwvc2VsZWN0PgogICAgICAgICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICAgICAgICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4OyI+CiAgICAgICAgICAgICAgICAgICAgICAgICA8Zm9ybSBjbGFzcz0iY29kZS1jbGFpbS1zZXQiPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxwIHN0eWxlPSJjb2xvcjojZTc5ZTAwO2ZvbnQtd2VpZ2h0OiBib2xkOyI+','WWtwRlc=','c3ViX2NvZGVfdjM=','ZGFp','dU5SUEU=','TFNJelc=','ZWxhcHNlZE1z','anJic3A=','TVFYaXY=','cGtqUG8=','bWluUmVzZXJ2ZVRva2Vucw==','bWV0aG9k','TUZERmE=','aFp6bkw=','RlVpZFM=','UFdSUUk=','8J+UpyDnu7TmiqTnirbmgIE6IA==','SWYgY2hlY2sgdGhpcyBvcHRpb24sIHRoZSBjbGFpbWVkIGFtb3VudCB3aWxsIGJlIGF1dG8gZGVwb3NpdGVkIGludG8gdmF1bHQgYWZ0ZXIgc3VjY2Vzc2Z1bGx5IGNsYWltaW5nIHRoZSBjb2RlLg==','RXZ6UUI=','d2pGb1E=','cVZPSUo=','THZWWHg=','VlVlWEU=','WVhGekY=','Q3JpTGI=','ZFhobEc=','c2NyaXB0','QWN2c3E=','UEdCRVo=','Y3JlYXRlRWxlbWVudA==','aU5JTVg=','dG9rZW4=','bWFw','WlNST1I=','UGN5Q3I=','S1RwQ0U=','c29mdFRva2VuVGltZW91dA==','aWhEQWg=','QUZuT2M=','VmZqUEo=','RE9zQ2E=','cHVzaA==','6I635Y+W57uT5p6c','cFdEeHc=','bmV4dENvZGU=','VGhlIG1pbmltdW0gcmVxdWlyZWQgYW1vdW50IGlzIDF1c2Qu','V21Vd28=','T1RJVHY=','UERBTHQ=','UU5RSU8=','am9RQ2k=','TVBzbVc=','Wm5YS1I=','cG9s','dEpHVUw=','c3RBSU8=','bG9jYXRpb24=','cWJjUko=','Y29ubmVjdA==','cmV0cnlEZWxheU1z','eEtHaEk=','RFp4R28=','UWtzR3Q=','dG9rZW5UaW1lb3V0','b212R1M=','bkdHdU8=','Z3RVR1E=','cXFlZ2E=','ZWFPT1c=','aXNHZW5lcmF0aW5n','R1VJY04=','a2tQdHE=','UFlGR3k=','R2V0IFJlY2hhcmdlIENvZGU=','dHJpbQ==','c3RhdHVz','bGR1bnM=','PGRpdiBpZD0iZHJvcC1zdGF0dXMiPkNsYWltZXI8L2Rpdj4KICAgICAgICAgICAgICAgIDxkaXYgaWQ9ImF1dG9Ecm9wd3JhcCIgc3R5bGU9InBvc2l0aW9uOmZpeGVkO3RvcDo3MnB4O2xlZnQ6','c3RUV2E=','6YCa6L+H5bCP6LS56LSt5Lmw5YWF5YC856CB','cWFpYWw=','YnRj','ZGFyaw==','Q0ltS1c=','NS4g5pa55rOV5rWL6K+VOg==','QllyeU8=','aW1wb3J0S2V5','c3ViX2JhbGFuY2U=','b0FvdVo=','ZWptRUY=','YXVERGw=','ZXJyb3JUeXBl','LSBUb2tlbue8k+WtmOeKtuaAgTo=','V0JOcWk=','V05yUWs=','aElid0o=','c2hvdw==','RWhHcnA=','S2Z5elg=','UWlYblI=','YWxyZWFkeUNsYWltZWQ=','eU9tb0Q=','aHR0cDovL2xvY2FsaG9zdDozMDAw','dlZxTlE=','c3R5bGU=','V2Vla2x5U3RyZWFt','dG9GaXhlZA==','RkxiTEY=','bm9UaXBGdW5jdGlvbg==','IFZlcnNpb246IA==','R2dqcmk=','4p2MIEZhaWxlZCB0byBsb2FkIGtleSByZXNvdXJjZXMsIHBsZWFzZSByZWZyZXNoIHRoZSBwYWdlIHRvIHJlbG9hZC4=','Q3NZZ24=','ZnhncFI=','Y2FsbGJhY2s=','WGlPT0w=','R1REZkI=','dWZDa2M=','aXN3VXI=','Uk9Qa2Q=','TkN6dnE=','bEZydm4=','PC9wPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJzZXJ2aWNlLXdyYXAiPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxhIGNsYXNzPSJidXktY29kZS1saW5rIiBocmVmPSI=','aGtmUUg=','ZlNhdmE=','Ij4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJibG9jay10aXRsZSI+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9Im1hcmsiPjxzcGFuPjwvc3Bhbj48L2Rpdj4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPHAgY2xhc3M9InRleHQiPg==','S1hsd0E=','cWx3bWc=','TXlKS2s=','RUxzbXE=','6YCJ5oup6aKG5Y+W5biB56eN','QnJ6dWE=','cmVtb3ZlQ2xhc3M=','R212c3c=','b0pwVWw=','QW1iR2I=','dUVrQ2E=','dGlwTmFtZQ==','I2F1dG9Ecm9wd3JhcA==','dHlwZQ==','bGJERGo=','Q2hNcGQ=','cVVyV3Q=','dlN2TGw=','bGlzdENvZGVz','bG9n','c3Bhbg==','d2FybXVwVGltZXI=','dXNlcg==','TG5NeFo=','4pyFIOaWsOmynA==','VUdKdXU=','cm9YU1A=','cmVjZWl2ZQ==','TWluaW11bSAkMQ==','VFZQUWw=','REZIR20=','QXpGQnE=','R3FiU2g=','SEJJUk0=','ZFhLWGU=','d1ZoT3Y=','UXpSTXM=','enpRVHY=','eHNOaUs=','Ym9udXNDb2RlSW5hY3RpdmU=','PG9wdGlvbiB2YWx1ZT0i','c2V0','Y2hlY2tDb2Rl','dXNlclNldEluZm8=','SFNrQUY=','c3ViX3JlZGVlbV9jb2Rl','Y3JlYXRlVmF1bHREZXBvc2l0','Tm9iREU=','YXZhaWxhYmxl','ZlJZQ3o=','VGhpcyBjb2RlIGlzIGF2YWlsYWJsZS4=','R3JjR0c=','PT09IOaJi+WKqCBUdXJuc3RpbGUg6LCD6K+VID09PQ==','dXBkYXRlQmFsYW5jZQ==','WlhMdkk=','S3J1RVo=','5Y+v5Zyo6K6+572u5Lit5L+u5pS544CC','cGlKenQ=','cmVwbGFjZQ==','T2dieUY=','eXRVVkk=','RXNhYmU=','U0tmTnA=','ZU1xdHk=','RHJKWGo=','ICAg54q25oCBOiA=','SlZJdUI=','WUVmR1c=','R2Fxb0k=','cWp3Qlg=','4p2MIFJlcXVlc3QgZmFpbGVkOiA=','I2F1dG9Ecm9wd3JhcCAuc2V0dGluZy1idG4=','cXF1ZnE=','ZGlyZWN0Q2xhaW0=','UElORWg=','bWRHRG8=','SUFVWno=','dmhiSXM=','alFleXQ=','VGhlIHJlY2hhcmdlIGNvZGUgY2FuIGJlIHNwbGl0IGFuZCB1c2VkIG11bHRpcGxlIHRpbWVzLCBhbmQgY2FuIGFsc28gYmUgdXNlZCBvbiBvdGhlciBhY2NvdW50cy4=','U2VsZWN0IGNsYWltIGN1cnJlbmN5','bE1jWUY=','ak5XS2w=','YXR0cg==','cU5HZWw=','bm8tZHJvcA==','bWh6eGM=','TnhrcVM=','bXZLcmE=','V1lYb04=','cmVmcmVzaERlbGF5','dmVDdVQ=','ZnBKVHA=','QktPbHU=','eC1vcGVyYXRpb24tbmFtZQ==','VVFOVWg=','LSDpmJ/liJflhoXlrrk6','ZUJaZmM=','5L2g55qE5YWF5YC856CB5Li6','c0JoQ2g=','bkN4cWk=','Z2V0SW5zdGFuY2U=','RXRrSUc=','d1ZLVWE=','SkhGU0M=','cmV0cnlDb3VudA==','eC1vcGVyYXRpb24tdHlwZQ==','L2FwaS9sb2dpbg==','4p2MIFdpZGdldOmHjee9ruWksei0pTo=','R1JKS0w=','c1lnQ3c=','ZHdnQkk=','aW1wb3J0V3NWM0tleQ==','Y0JBVlk=','PC9wPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ic2VydmljZS13cmFwIHRpcC1idXktd3JhcCI+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iZ2V0LXJlZGVlbS1jb2RlLWJ0biIgdHlwZT0iYnV0dG9uIj48c3Bhbj4=','Z2V0UmVkZWVtQ29kZVN1Y2Nlc3NUaXBz','eFBOU04=','dHBYSWY=','amhFeHg=','TFVqb0U=','eGJWcFE=','YUdWc1Y=','bEFYb1A=','VW5rbm93biBlcnJvcg==','VkFZQ0M=','eVNjZ2E=','Wk1qU2o=','UkFRRk0=','bGFuZ3VhZ2U=','SWRPWks=','Z0VVVm8=','Smp2Qlg=','TGtReW0=','cG9w','ZlZZVW0=','Q2xhaW0gY29kZSB0eXBl','6YCa6L+H572R56uZ6LSt5Lmw5YWF5YC856CB','WFRCZFk=','RXdQVGw=','QnN6b00=','ZnJvbQ==','Slh0eEY=','dHhIdVI=','VGVGZlM=','Z2VuZXJhdGVDYWNoZVRva2Vu','Q3JlYXRlVmF1bHREZXBvc2l0','ZUZvS3Q=','cGxhdGZvcm0=','dGRrSm0=','Y3Vyc29y','REFwVU8=','V2FNQUU=','b2RzWEc=','a2FUS1M=','eVdaR0k=','Wkd6emg=','clFtY1A=','d2FybXVwQ2FjaGVTaXpl','U292Tm0=','QXh3ZHI=','Y1lRQno=','YXF3alU=','c2hpZnQ=','TkN3aVA=','VFJYdWM=','WGtsUGc=','VWZNeVQ=','SlZXdEs=','UXJjY0w=','I2F1dG9Ecm9wd3JhcCAuZ2V0LXJlZGVlbS1jb2RlLWJ0bg==','T2V1Zlc=','eklJSE0=','aW5wdXQ=','WFNPcVk=','Ij4KICAgICAgICAgICAgICAgICAgICA8ZGl2IHN0eWxlPSJwYWRkaW5nOjEwcHggOHB4O2JhY2tncm91bmQ6IzIxMzc0MzttYXJnaW46MCBhdXRvO2JvcmRlci1yYWRpdXM6NXB4O2JvcmRlcjoycHggc29saWQgIzJmNDU1MzsiPgogICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47Ij4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IHN0eWxlPSJmb250LXNpemU6MTRweDtmb250LXdlaWdodDpib2xkO2NvbG9yOiNmZmYiPg==','VHR1SVY=','ZGVmYXVsdFRlbGVncmFtVXJs','T3RoZXJEcm9wcw==','a0pIZWQ=','bXB1blI=','TVNkblo=','5pyN5Yqh5Zmo56Gu6K6k77ya','cXVlcnlTZWxlY3Rvcg==','bFlRUUk=','VXFEVWc=','Z2V0UmVkZWVtQ29kZVN1Y2Nlc3M=','5oKo5bey6aKG5Y+W5q2k5Luj56CB','cUtob3o=','WVhvdkM=','am1Tdlo=','ak5jeFE=','aGVhZA==','VGhlIGJvbnVzIGRyb3AgbGltaXQgaGFzIGJlZW4gcmVhY2hlZC4=','dWRZVVE=','6K+35YaN5qyh5Yi35paw6aG16Z2i44CC','RnBHYWU=','dGZMdHM=','ZHdjckc=','Z2V0LXJlZGVlbS1jb2Rl','T09pbmo=','aEdVWnY=','ZmRndFU=','UnFkdG8=','YVJEa0o=','Z2V0VG9rZW5BZ2U=','cmVmZXNo','dHVybnN0aWxl','aHR6QkI=','Sk50am8=','YU5rTm0=','Ym9keQ==','SlRVSXU=','cGlCZGI=','YW1RdW0=','c2JjWHk=','bWJTZlg=','4p2MIOWFs+mUrui1hOa6kOWKoOi9veWksei0pTo=','aGtJelA=','dVF6T3Q=','anRUZkw=','cmVzZXQ=','V2FNSXQ=','TmN2Ylk=','Tm13UUE=','RGVwb3NpdCBpbiB2YXVsdA==','SmdHaWg=','eXJTZmo=','Q21VZXU=','UmV0cnkgY2xhaW0=','bVlidkQ=','bWFudWFs','eHZjdWw=','anZEakU=','WXNRR24=','c2xlZXA=','alRVSlI=','bWFpbnRlbmFuY2VJblByb2dyZXNz','Z3hObGo=','dG9nZ2xl','dXNlcm5hbWU=','MXw2fDB8MnwzfDV8NA==','cnVuTWFpbnRlbmFuY2VDeWNsZQ==','aFJIelQ=','WHlBUUg=','QVN1V0o=','TEVPSlg=','d2l0aGRyYXdFcnJvcg==','eEtWeFo=','Y3VycmVuY3k=','YndxcFk=','TUtlS04=','ZnVsbENhY2hlQWxsb3dlZEF0','WkVaclo=','RkNfbG9naW4=','bHlkSFA=','Z2V0RGF0ZQ==','TFhUaUI=','dXNkYw==','6YCa6L+H5a6i5pyN6LSt5Lmw5YWF5YC856CB','Z29rSmE=','cmVjZWl2ZU1hbnVhbA==','RkNGQw==','ZGVmYXVsdFRpcE5hbWU=','cFpFd0c=','Qk9GcHM=','YXZMeVk=','aGlkZQ==','Y1l1RWg=','WFlqRGs=','Y1h6R0s=','bnNRVWU=','I2F1dG9Ecm9wd3JhcCAudXNlci1zZXQtd3JhcCAuY29kZS1jbGFpbS1zZXQgaW5wdXRbdHlwZT1jaGVja2JveF0=','aUxMd2M=','aERZdk0=','cHJvcA==','cU1Ta3Y=','ICAg6ZW/5bqmOiA=','ZEFDVGI=','S0Fmclk=','bFFhT2U=','bm1Malk=','YUptcVY=','bWhKaHc=','cGlk','RXdjU2w=','PC9sYWJlbD4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGlucHV0IHR5cGU9Im51bWJlciIgc3R5bGU9ImZvbnQtd2VpZ2h0OiBib2xkOyIvPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICAgICAgICAgICAgICAgPC9mb3JtPgogICAgICAgICAgICAgICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0icmVkZWVtLWJ0biI+PHNwYW4+','TlpCT1A=','V0luVE4=','VmFJcmE=','bktSV2U=','SmNEb0o=','Qk9zdk0=','VVVqYmg=','Y29kZVRpcA==','R0VUX1VTRVJOQU1FX0VSUk9SOiA=','I2F1dG9Ecm9wd3JhcCAuc2VydmljZQ==','Y1lVenI=','I2F1dG9Ecm9wd3JhcCAucmVjaGFyZ2Utd3JhcA==','b2pzVW4=','Y1VqeGk=','dE1lUEQ=','ZmlsdGVy','aGlkZUxvYWRpbmc=','em1DR0s=','6L+e5o6l5oiQ5Yqf','a3NJR0I=','UWFxaVI=','UkpSUW0=','Tm9ubmY=','ZGVmYXVsdFVjdXJs','PC9sYWJlbD4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9InJlZGVlbS1jb2RlLWJhbGFuY2UiIHN0eWxlPSJjb2xvcjojMDBDNTAwOyI+PC9zcGFuPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGlucHV0IHR5cGU9InRleHQiIC8+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0icmVkZWVtLWFtb3VudCBmb3JtLWl0ZW0iIHN0eWxlPSJ3aWR0aDo0MCU7Ij4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGxhYmVsPg==','em5Peng=','VVRocmU=','T0x3Y2U=','SUtsS0k=','clNJZGU=','dmhtbHY=','UUdOZUI=','dk9qaXA=','QXJOTVU=','SXFkd0I=','aWdvRUw=','bGNRS0U=','akVYWUk=','eUNHeUE=','dkxTY0g=','Y29kZUNsYWltU2V0','dW5jaw==','aXNBdXRvQ2xhaW1pbmc=','c2lnbmFs','Y09XVUg=','cE5Ub2Y=','S2RhbXA=','c2hvdWxkQWNjZXB0','4pqg77iPIA==','XihbXiBdKyggK1teIF0rKSspK1teIF19','VlJTUnc=','VVdpT1I=','aGFneE8=','emlrSHE=','aWlXUWY=','QnV5IHJlY2hhcmdlIGNvZGUgYnkgdGlw','dG9rZW5DYWNoZQ==','I2F1dG9Ecm9wd3JhcCAucmVjaGFyZ2UtYnRu','UWRMYkU=','bGN6V2M=','Z2V0U3Rha2VVc2Vy','SWNrRFQ=','Y2xhaW1Db2Rl','Y2xlYXI=','SGlnaFJvbGxlcnM=','TmVSUGg=','YmhoS0o=','Q0hSTko=','UE9TVA==','d3NWMyBrZXkgbm90IGluaXRpYWxpemVkLg==','Z2N3cnk=','RXVGWHE=','Ym5IUGs=','Rk5pWnM=','Q3JlZGl0IFJlY2hhcmdl','RGFpbHkx','Rkxoa3I=','bG9nZ2Vy','dGlOY1o=','Z2V0UmVkZWVtQ29kZQ==','b25sb2Fk','cFNQU3k=','S3RPTUo=','R3NVdG8=','bFFySWY=','Sk1xZVE=','UnpTQ24=','S3FXdk8=','a29uWHY=','dWZFVm8=','ZktyUWQ=','dmFyaWFibGVz','Y29kZUFscmVhZHlDbGFpbWVk','bnV0S1c=','dUlaUFc=','SkFjWGk=','cnRPRVQ=','V0JNYVg=','8J+UpyDlvLrliLbph43mlrDliJ3lp4vljJYgVHVybnN0aWxlTWFuYWdlci4uLg==','bldIb1U=','cmVkZWVtRm9ybQ==','bWtsTU4=','dmFs','SUx0Q3I=','YmdLQWs=','5Y+R6YCB5bCP6LS557uZ','RHJQd2I=','U0VTU0Q=','UGF2TFY=','dG9VcHBlckNhc2U=','Ij4KICAgICAgICAgICAgICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0aXRsZSI+','8J+bkSDnu7TmiqTlmajlt7LlgZzmraI=','SFh2Z2E=','WXB0bVg=','UnFSRmw=','PC9wPgogICAgICAgICAgICAgICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJyZWRlZW0td3JhcCI+CiAgICAgICAgICAgICAgICAgICAgICAgICA8Zm9ybT4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJyZWRlZW0tY29kZSBmb3JtLWl0ZW0iIHN0eWxlPSJtYXJnaW4tcmlnaHQ6NXB4O3dpZHRoOjYwJTsiPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmctcmlnaHQ6MTBweDsiPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8bGFiZWw+','QnZiaHM=','V1pjUWQ=','ZFZmbUw=','cFRDQkg=','VmdveHQ=','c3BxcFE=','Q2RmQXE=','eGlRQ3o=','dGVsZWdyYW1Vcmw=','cXVlcnkgVXNlck1ldGEoJG5hbWU6IFN0cmluZywgJHNpZ251cENvZGU6IEJvb2xlYW4gPSBmYWxzZSkgewogIHVzZXIobmFtZTogJG5hbWUpIHsKICAgIGlkCiAgICBuYW1lCiAgICBpc011dGVkCiAgICBpc1JhaW5wcm9vZgogICAgaXNCYW5uZWQKICAgIGNyZWF0ZWRBdAogICAgY2FtcGFpZ25TZXQKICAgIHNlbGZFeGNsdWRlIHsKICAgICAgaWQKICAgICAgc3RhdHVzCiAgICAgIGFjdGl2ZQogICAgICBjcmVhdGVkQXQKICAgICAgZXhwaXJlQXQKICAgIH0KICAgIHNpZ251cENvZGUgQGluY2x1ZGUoaWY6ICRzaWdudXBDb2RlKSB7CiAgICAgIGlkCiAgICAgIGNvZGUgewogICAgICAgIGlkCiAgICAgICAgY29kZQogICAgICB9CiAgICB9CiAgfQp9Cg==','R0hFSXE=','S1hNY3I=','aEdvWlU=','5bey5pS+5byA','b3ZFV2U=','S3BlZ28=','Y3dSUlk=','Jm5ic3A7PC9zcGFuPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJiYWxhbmNlIiBzdHlsZT0iZm9udC1zaXplOjEzcHg7bGluZS1oZWlnaHQ6MS4yOyI+MDwvZGl2PgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8c3BhbiBzdHlsZT0iZm9udC1zaXplOjFlbTttYXJnaW4tbGVmdDozcHg7Ij5VU0Q8L3NwYW4+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBzdHlsZT0icGFkZGluZzowIDhweDtoZWlnaHQ6MjBweDtib3JkZXItcmFkaXVzOjIwcHg7bGluZS1oZWlnaHQ6MjBweDt0ZXh0LWFsaWduOmNlbnRlcjtiYWNrZ3JvdW5kOiMxNDc1RTE7Y29sb3I6I2ZmZjttYXJnaW4tbGVmdDoxMHB4O2ZvbnQtc2l6ZToxMnB4OyI+','ZmlsbENhY2hlVG8=','dmVsSE4=','S2l0UVk=','RUthWFc=','ZHZjT0o=','I2F1dG9Ecm9wd3JhcCAudXNlci1zZXQtd3JhcA==','U0xVbFk=','TXJKeGY=','b1RUemI=','SWJ5bXo=','TVlCcVA=','b3BlcmF0aW9uTmFtZQ==','SndmdGE=','dk1zTW0=','UmVjaGFyZ2UgQ29kZQ==','c3BsaWNl','dmVyc2lvbg==','V0J1UHU=','cmVtb3Zl','YlRQWko=','8J+TiiDnvJPlrZjnu5/orqE6IA==','YUNIR04=','dGltZXN0YW1w','VFNsdnI=','6aKG5Y+W5Luj56CB57G75Z6L','U0Vld1U=','ZHJvcFVuYXZhaWxhYmxl','ckhvck0=','I2F1dG9Ecm9wd3JhcCAjX3R1cm5zdGlsZQ==','QUFUZUg=','UFZoUlE=','Y3Nz','R3VCemo=','5Yid5aeL5YyWLi4u','5bey5a2Y5YWl5L+d6Zmp5bqT44CC','c2V0dGluZ3M=','bXV0YXRpb24gQ2xhaW1Db25kaXRpb25Cb251c0NvZGUoJGNvZGU6IFN0cmluZyEsICRjdXJyZW5jeTogQ3VycmVuY3lFbnVtISwgJHR1cm5zdGlsZVRva2VuOiBTdHJpbmchKSB7CiAgY2xhaW1Db25kaXRpb25Cb251c0NvZGUoCiAgICBjb2RlOiAkY29kZQogICAgY3VycmVuY3k6ICRjdXJyZW5jeQogICAgdHVybnN0aWxlVG9rZW46ICR0dXJuc3RpbGVUb2tlbgogICkgewogICAgYm9udXNDb2RlIHsKICAgICAgaWQKICAgICAgY29kZQogICAgICBfX3R5cGVuYW1lCiAgICB9CiAgICBhbW91bnQKICAgIGN1cnJlbmN5CiAgICB1c2VyIHsKICAgICAgaWQKICAgICAgYmFsYW5jZXMgewogICAgICAgIGF2YWlsYWJsZSB7CiAgICAgICAgICBhbW91bnQKICAgICAgICAgIGN1cnJlbmN5CiAgICAgICAgICBfX3R5cGVuYW1lCiAgICAgICAgfQogICAgICAgIF9fdHlwZW5hbWUKICAgICAgfQogICAgICBfX3R5cGVuYW1lCiAgICB9CiAgICBfX3R5cGVuYW1lCiAgfQp9Cg==','b2RudEs=','SXladE0=','b2FoWXQ=','eHdSQnQ=','cFhVWkI=','clh2bUc=','PC9zcGFuPg==','SXNFQ28=','bm9OZWVkVG9DbGFpbUFnYWlu','RU9iYXk=','c3ViX3JlZGVlbV9iYWxhbmNl','T2RXQUQ=','d2ZheEo=','I2IxYmFkMw==','S1pXaFI=','RXpqY0Y=','bnR5b1U=','R1p2bmg=','cUhjcWI=','UkJseG8=','U09uRXg=','bG9jYWxl','dUJGR2Q=','ZHBKTGw=','dnpqclM=','d2Vic2l0ZU9yaWdpbg==','WWtJZmU=','RWx2REI=','ZWN5aW0=','bldLcHU=','Z2V0SG91cnM=','R1JjdlY=','YXV0aG9y','Sk5DVEg=','5bCd6K+V5aSa5qyh6aKG5Y+W5aSx6LSl77yM6K+35qOA5p+l572R57uc6L+e5o6l','Q1J6SWU=','bUFjcWc=','c29ja2V0VXJs','RndGR2U=','UGxheVNtYXJ0ZXI=','UFF5SnQ=','cGFyc2U=','WW91ciByZWNoYXJnZSBjb2RlIGlz','T0NrSmY=','RHR6Wlk=','VkNGdVM=','Sm9ET2o=','WlloUmQ=','aFhSS0U=','4o+x77iPIOesrOS4ieS4qlRva2Vu5pS+5byAOiA=','Y05MQWQ=','cldhWWk=','SFRUUCBFcnJvciBb','ZW1pdA==','a2pjb1k=','S1NRdnc=','ZGhJaUw=','Z3B0eXE=','bVpQcWM=','SktTZ1I=','cUt4TE4=','blZhdWs=','d1RFRm8=','QVZwRlE=','TFNZQXQ=','UExwaWE=','WW9UUUc=','eFBNSmg=','VVdWV2I=','4p2MIOenu+mZpHdpZGdldOWksei0pTo=','c29ja2V0','blhkck0=','TEtWVmU=','RmdsRGo=','Y3JlYXRl','dXNkdA==','bGluaw==','bXNn','V2dVQ3U=','RmJUUEk=','R01pb24=','cmVwbGFjZVNvZnRFeHBpcmVkVG9rZW5z','U1pIS3Q=','c291cmNl','dmF1bHRUaXA=','QW12UVo=','Wml4UVM=','SEhDQVQ=','U1NmVGY=','RG9SQUw=','bG9nRUw=','U1dKc2E=','V1pCU3o=','dGFrZUJlc3RDYWNoZWRUb2tlbg==','S2hYWHg=','Vk1iVUc=','VFdid3M=','akZkTVI=','RUpVeEQ=','eE1GY2s=','cmF3UGF5bG9hZA==','T1hObWM=','U2V0dGluZ3M=','b1RlQ3Y=','emZjeg==','dWZYd3Y=','VkxxQWw=','Q1JGTUU=','RUhTRHM=','bVRKUWc=','S3lYWEg=','aHR0cHM6Ly9jaGFsbGVuZ2VzLmNsb3VkZmxhcmUuY29tL3R1cm5zdGlsZS92MC9hcGkuanM=','b29QekQ=','TXBXb0I=','MS4gdW5zYWZlV2luZG93LnR1cm5zdGlsZTo=','WkFTV3k=','YWFNaHM=','dG9Mb3dlckNhc2U=','KyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tICsKTmFtZTog','cmVjaGFyZ2VCeVRpcA==','YW1vdW50','QkthaEs=','b3JlTk8=','My4g5a655ZmoOg==','VlhRUlA=','I2F1dG9Ecm9wd3JhcCAudXNlci1zZXQtd3JhcCAudmF1bHQtZGVzcG9zaXQgaW5wdXRbdHlwZT1jaGVja2JveF0=','4pyFIFQg6ISa5pys5Yqg6L295a6M5oiQOg==','VkpJSFo=','VlV2UnA=','cmV0cnlDbGFpbQ==','UGJhV0c=','PC9kaXY+CiAgICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0icmVjaGFyZ2Utd3JhcCBzY3JvbGxZIj4KICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImJsb2NrLXRpdGxlIj4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJtYXJrIj48c3Bhbj48L3NwYW4+PC9kaXY+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPHAgY2xhc3M9InRleHQiPg==','Y2xlYXJTa2lwSW50ZXJ2YWxNcw==','WzQwMV0=','RGFjUXc=','dUxKZVo=','Z2V0U2Vjb25kcw==','cmpXS00=','d2ZsdGg=','Y2xhaW1XaXRoUmV0cmllcw==','eUlrUXQ=','VFFsRVk=','bUZVblg=','NC4gVHVybnN0aWxlTWFuYWdlcjo=','ZmluZEluZGV4','ZGZRcVc=','dW5p','c3RhcnROZXh0','R05STlU=','ZnJlZXpl','eGVlSkM=','eFpkVFk=','S2xvbUg=','U3pBT0Y=','enFOWHU=','cmVtb3ZlT2xkZXN0U29mdEV4cGlyZWRUb2tlbg==','RUhxSUs=','dmF1bHQ=','c092enU=','aW5pdFJlY2hhcmdl','UXprVFY=','YVlTZlM=','ZHdaUUM=','Q0VkTlI=','c3VidGxl','UW9pWGs=','TUtWQXg=','b050Z08=','bWF4Q2FjaGVTaXpl','QnV5IHJlY2hhcmdlIGNvZGUgYnkgY3VzdG9tZXIgc2VydmljZQ==','ZG5WcWI=','YWN0aXZlVGltZXI=','YnRWRnU=','5YWF5YC856CB','SXhtQ0Q=','UmJQcVk=','d21HWG8=','c3Jj','VnVHemI=','UllRdHM=','Q2xCcE8=','Z2NTZVI=','YUF6RUc=','Y3VSblU=','b2JqZWN0','QktWdEk=','akh0Z3U=','c2NoZWR1bGVSZWZpbGw=','bFNpd0w=','VG5Bamo=','clRrbE4=','SWFueUs=','WmRtcnA=','UVJtYXM=','aHZIV1A=','dXNlclRva2Vu','QWloQXQ=','aWdVS1g=','WFNZTm0=','UmdZUnc=','QkFLV0M=','THFma3g=','cHVsc2luZy10ZXh0','T3FwelM=','dmF1bHRTdWNjZXNz','R2tsWFI=','TEJJaG0=','QWJqbGs=','WEtud1k=','LSDmraPlnKjnlJ/miJBUb2tlbjo=','TVRRaHQ=','Y29tcGxldGU=','TExZc0Y=','cmVk','WGhHalc=','IzAwQzUwMA==','eHJw','YW5rcnU=','a1ZBUWs=','cFRObmI=','RlZncG8=','Z3plRUQ=','RElNUmo=','Y2JRRkw=','YWRkQ2xhc3M=','ZnlyYXA=','cHhxSGk=','5q2k5Luj56CB5Y+v55So','5YWF5YC856CB5Y+v5Lul5ouG5YiG5aSa5qyh5L2/55So77yM5Lmf5Y+v5Lul5Zyo5YW25LuW6LSm5Y+35LiK5L2/55So44CC','eUFBcUs=','UGxlYXNlIGtlZXAgeW91ciByZWNoYXJnZSBjb2RlIHNhZmUgYW5kIGRvIG5vdCBkaXNjbG9zZSBpdCB0byBhbnlvbmUu','alNvTUk=','Y2xhaW1TdGFydA==','VVRCamY=','ICAg5bm06b6EOiA=','TG1yRVM=','aUlCS2I=','Y2xlYW5FeHBpcmVkVG9rZW5z','bUVTVkc=','aFBWYWQ=','4pqg77iPIOi9r+i/h+acnw==','Q3FwdUk=','aGVhZGVycw==','Y29kZVR5cGU=','WXBoV0s=','R2pvR1g=','dFlsb1g=','SWVpZEc=','UVRmU3U=','b09nd3o=','Z2V0QmFsYW5jZUZvcm0=','WXZiZ0w=','Umt3UFo=','VkRlUWs=','Rm1hVHA=','4o+wIOi9r+i/h+acn+mYiOWAvDog','c29ydA==','Q1NFZko=','Z2pkQkM=','UnVVdHE=','8J+nuSBUdXJuc3RpbGVNYW5hZ2VyIOW3suWujOWFqOmUgOavgQ==','I2F1dG9Ecm9wd3JhcCAudXNlci1zZXQtd3JhcCAuY2xvc2U=','cmV0cnlDbGFpbURvbmU=','dWhmS0I=','eWpUUlQ=','Y2ZRRFg=','V0N6clA=','Rllxd2k=','dGlwSW50cm8=','dGltZW91dC1jYWxsYmFjaw==','blBFWkg=','aUtUeHI=','c1BBU0I=','cUpNTEI=','RGFQSWU=','dGFNV3g=','SmtucGM=','cEZRaHA=','Y2VpbA==','YXlqY3Q=','QVdmVXo=','5q2j5Zyo55Sf5oiQ','a2JmanE=','ZFhmY0w=','Y2xlYXJBY3RpdmVUaW1lcg==','ZHpOaU8=','U3hOYnM=','dXBkYXRlQ3VycmVuY3lPcHRpb25z','elJJbWc=','TnNsRW4=','Y2hhckNvZGVBdA==','eHJnVHE=','dHRha1U=','ZGlxTW8=','bllYd28=','d2Vla2x5V2FnZXJSZXF1aXJlbWVudA==','RGtyaGs=','RGxRSVo=','Y2R2QW0=','UGxlYXNlIHJlZnJlc2ggdGhlIHBhZ2UgYWdhaW4u','dGZDVXE=','TGtGYmM=','ZElweUQ=','b1RIQ2M=','L3po','YmNQcnY=','Y29tcGlsZQ==','8J+TiiA9PT0g6ISa5pys54q25oCB5qOA5p+lID09PQ==','U1V5c1M=','b2NaYVk=','VnVRR0I=','aU9MekE=','UUpHQXI=','YnNKc2Y=','Q2txd0c=','bE1BYW0=','PHNwYW4gc3R5bGU9ImNvbG9yOg==','eEROdGk=','SFpjam4=','UkVmYVI=','SUxCV0E=','SFZxTlI=','QkJwSW4=','eVVlQXU=','Z3draFI=','UXZHbVk=','Y29sb3I=','eW5FZUc=','dm91YnI=','cXVldWVOZXh0RGVsYXlNcw==','ZXJyb3I=','d3NWMw==','dHVybnN0aWxlTWFuYWdlcg==','5b2T5YmN6K6k6aKG5biB56eN5Li6','IHwg','Z2V0RnVsbFllYXI=','RktXWHU=','d2x2VHU=','bXNnVHlwZQ==','R3luUmQ=','IGRlYnVnOiA=','VG93RGQ=','6I635Y+W5L2Z6aKd5LitLi4u','Q3JQaWw=','R1BVaE8=','Z2V0VGFzaw==','aXp3THU=','bWx6TmY=','d3JGZEY=','VVdHcno=','eERwYmI=','d3NWMyBrZXkgaW5pdCBmYWlsZWQu','YUFSWVY=','5q2k5Luj56CB5bey6L6+5Yiw6aKG5Y+W5LiK6ZmQ','UlpNYkY=','WEVEUGk=','eGFoVVQ=','bWF4Q2xhaW1RdWV1ZVNpemU=','aWZGUFY=','bGlzdA==','S1ZjV0E=','UHRBQ3I=','VmFEaHQ=','8J+agCDlkK/liqjnu7TmiqTlmag=','a2V5','enBVaVc=','ZWpvVEY=','bWRCQ1Y=','Z2V0','VVhUak0=','RUJJVmU=','d3NWM0tleUluZm8=','cFZkV1c=','TUpvaFA=','eHdBZlc=','TFlMVko=','c2RuTFE=','d1JkVlY=','QWJKZHE=','aldvUVg=','Z2V0VGltZQ==','c3BsaXQ=','d01VR2Y=','dGVzdENsYWlt','TWlDUkI=','6K+36YCJ5oup5biB56eN','REhPV0Y=','bWFpbnRlbmFuY2VJbnRlcnZhbA==','c3JaSmI=','ZHJvcHM=','QURDdEI=','dmF1bHRUZXh0','SmZrVEc=','SWhPbkU=','dFZ3Q0g=','TW1iUk4=','c2F5ZVE=','dW5rbm93biBlcnJvcg==','bHVESnc=','RWdXQ0k=','bktwTkE=','YWJvcnQ=','V2ZLTlU=','U3Bvckg=','562J5b6F6K6k6aKG6Zif5YiXOg==','U2dFU3g=','ZWJWdUo=','T0p0TG4=','akVOd1A=','eERJb3c=','a3ljTGV2ZWxOb3RTdWZmaWNpZW50','cXJsSnU=','WGVaUG4=','Y2FsbA==','ZHJvcENvbXBsZXRlZA==','eUdjeEE=','dWN1cmw=','VFFjY0o=','eVllTVQ=','WVhyaHo=','CvCfk50gVG9rZW5b','ZUVjQXA=','cG9sbGluZw==','d2FpdHRpbmdDb2Rlcw==','ICI8c3BhbiBjbGFzcz0idGlwLW5hbWUiIHN0eWxlPSJjb2xvcjojZmZmO2ZvbnQtd2VpZ2h0OmJsb2Q7Ij4=','TWZTS1o=','RUZIS0k=','SmdDTWI=','UVptR0E=','TXdycnk=','WW91IGhhdmUgYWxyZWFkeSByZWRlZW1lZCB0aGlzIGNvZGUu','d3NWM0tleUluaXRQcm9taXNl','TktQWHQ=','RnNpa0o=','WURQWkM=','SGd0TXo=','VHJXTHA=','Q2tqb3Y=','Skd1WkU=','aW5kZXhPZg==','Y2F0Y2g=','Y3VycmVuY2llcw==','cHFzWlY=','UUlTTHk=','SmNNVWs=','Z29sZA==','cmFvWmg=','d2xEaGs=','I2F1dG9Ecm9wd3JhcCAudHVyYm8tc3RhdGU=','cnVkdHY=','aHR0cHM6Ly93d3cuaGgxMjMuc2l0ZQ==','ZW9yU2U=','4pyFIFdpZGdldOW3suenu+mZpA==','aG9zdG5hbWU=','SlR6Ykc=','dGhlbg==','Q0J2blk=','d3hLSWo=','YmhHcHg=','YnVUdlU=','UnpseWc=','Z2V0TWludXRlcw==','WkVIWVE=','c3ViX2NvZGVfdjMgZGVjcnlwdCBmYWlsZWQ=','SVJ0bmU=','Qm9udXMgY2Fubm90IGJlIGZvdW5kIG9yIGlzIHVuYXZhaWxhYmxlLg==','U3l4aU0=','WW91IGhhdmUgbm90IHBsYXllZCBlbm91Z2ggaW4gdGhlIGxhc3Qgd2VlayB0byBjbGFpbSB0aGlzIGNvZGUu','Y2xhaW1UaW1lb3V0TXM=','c29ydFRva2VuQ2FjaGU=','UEhJZG0=','eXlEbUM=','ZlVWbEo=','dGV4dA==','RGlzY29ubmVjdDog','dU1FSWo=','UmxGeHo=','WUptbEw=','ZW5xdWV1ZQ==','V2RiWkw=','SVRuR1Y=','SkdVc28=','cGxNQ0o=','cmVuZGVy','R09yZlQ=','WzQwM10=','Q2xhaW1Db25kaXRpb25Cb251c0NvZGU=','SG9kRno=','Wm1rWk0=','RmFpbGVkIHRvIG9idGFpbiB0b2tlbi4=','UmRvRnc=','RVRtTWw=','dkFzSFQ=','ZW1haWxVbnZlcmlmaWVk','UFpUS3E=','Y3BIWnc=','a3pkcUY=','bG50ZGQ=','ZmluYWxseQ==','ZGVjcnlwdA==','eHhVdmM=','Z2x6ekg=','UGFuaUY=','anFuWGY=','YXZhaWxhYmxlQ3VycmVuY2llcw==','SVRHcGk=','WnFDSHo=','6YeN5paw5bCd6K+V','a1VPdlI=','d2lkdGg=','UlZiWUY=','Z2V0LXJlZGVlbS1iYWxhbmNl','dXBkYXRlVHVyYm9TdGF0ZQ==','b0xRSVY=','8J+UjSA9PT0gVG9rZW7nvJPlrZjor6bnu4bkv6Hmga8gPT09','ZnBPWWQ=','aTE4bg==','ZGVsZXRl','ZFVJYmc=','Y2xhaW1DdXJyZW5jeQ==','aEpSSlI=','Zm9ybVJ1bGVz','SFVHcVc=','PC9wPgogICAgICAgICAgICAgICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJzZXJ2aWNlLXdyYXAiPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxhIGNsYXNzPSJzZXJ2aWNlIiBocmVmPSI=','c1RWVko=','I2F1dG9Ecm9wd3JhcCAucmVkZWVtLXdyYXAgLnJlZGVlbS1idG4=','YnV5UmVjaGFyZ2VDb2Rl','aW5uZXJIVE1M','VFlKTGo=','aHdad1M=','c2NoZWR1bGVTdGFnZ2VyZWRXYXJtdXA=','bllucmY=','eFZ4RUk=','dnBkYnA=','QmZOUWU=','6K+36L6T5YWl6KaB5YWF5YC855qE6YeR6aKd','RkNUZXN0Q2xhaW0=','dEJoY3Y=','ZkJZVEE=','SEVpanY=','aUxSYmk=','RGVwb3NpdGVkIGluIHRoZSB2YXVsdC4=','dGVzdA==','TFBuYnc=','d0lzQkY=','TXNrTGU=','U3RhdHVzOiA=','UVpTYmw=','WW91IG5lZWQgdG8gbWFrZSBhIGRlcG9zaXQgaW4gdGhpcyBjdXJyZW5jeSBiZWZvcmUgeW91IGNhbiBjbGFpbSB3aXRoIGl0Lg==','cGluZw==','TkxXd3k=','SlJkcWQ=','ZmtXTmo=','8J+OiSBNYW5hZ2VyIOWIneWni+WMluWujOaIkA==','Y095cXo=','aXNBcnJheQ==','TGtJTk0=','SndrY2I=','c2V0VXNlcm5hbWU=','dXBkYXRlU2VydmljZUluZm8=','V1FCT3c=','cXNteWw=','cmVjaGFyZ2U=','b0Vya3U=','UWVPU1Q=','bWJjb1Y=','dXNkQW1vdW50','ZG9JUVk=','SkpQQ0U=','cE9KdEE=','6K+36L6T5YWl5YWF5YC856CB','Z1BMTVA=','cmpFQ2I=','VGFJRUs=','bWVzc2FnZQ==','Q29rZFM=','TlRZbkY=','bVZjbG0=','VHpDcVQ=','cG9pbnRlcg==','ZGxXdlg=','c1RjVWU=','WVVUTHI=','IzAwYzUwMA==','V1hEcUQ=','dGhlQ3VycmVuY3lUb0dldA==','bWFpbnRlbmFuY2VUaW1lcg==','6L+Q6KGM5Lit','b1ZxdWk=','bm9ybWFsaXplUGF5bG9hZA==','Y29kZUFscmVhZHlSZWRlZW1lZA==','ZGlzYWJsZWQ=','aGFzU29mdEV4cGlyZWRUb2tlbnM=','dWhwd2E=','bWFpbnRhaW5Ub2tlbnM=','ampucVg=','ZG9nZQ==','PC9vcHRpb24+','d3NWMyBrZXkgaW5pdCBmYWlsZWQ=','cmV0dXJuIC8iICsgdGhpcyArICIv','aHR0cHM6Ly90Lm1lL2ZjZmNmYWNl','U1NEaE0=','ekNBdXU=','PHNwYW4+PC9idXR0b24+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0iYmxvY2stdGl0bGUiPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9Im1hcmsiPjxzcGFuPjwvc3Bhbj48L2Rpdj4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8cCBjbGFzcz0idGV4dCI+','RXJyb3I6IA==','PT09PT09PT09PT09PT09PT09PT09PT09PQ==','Y3JlYXRlVG9rZW4=','eC1hY2Nlc3MtdG9rZW4=','55So5oi36K6+572u5LiN6K6k6aKGIA==','c1lrd1o=','TXVsdGlwbGUgYXR0ZW1wdHMgdG8gY2xhaW0gZmFpbGVkLCBwbGVhc2UgY2hlY2sgdGhlIG5ldHdvcmsgY29ubmVjdGlvbi4=','TE5Ib00=','eVlUaVE=','dU9KdXg=','UFdJdFc=','YWZ1cmg=','bVNXbGQ=','R0VUX1NFU1NJT05fRVJST1I6IA==','ZHJvcA==','emxyTXQ=','ZGF0YQ==','Sk10cXA=','YW1vdW50VGlw','UGJuTWU=','UlJISkI=','VnVNdUM=','UnRSbE0=','Y2hhbmdlQ29ubmVjdFN0YXR1cw==','UFJKTGg=','ZkVFVXA=','dkV1bFI=','TldVbW4=','bnJyVFc=','elNMVFo=','aXNIYXJkRXhwaXJlZA==','bEZoSmU=','RUduUGM=','c2hvd0xvYWRpbmc=','YXBwbHk=','cnR6S2k=','ZGVzdHJveQ==','d2FObWw=','YXZhaWxhYmlsaXR5U3RhdHVz','UWhNeXQ=','eEtZZ2w=','bWl1Q0g=','cmVkZWVtVGlw','UEx5YVI=','Z0NweUM=','TllEc0M=','RE1FR2s=','VENjSVI=','a2x0Z24=','ZVBBU2s=','QVNDa0E=','PC9zcGFuPjwvZGl2PgogICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Ij4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPHN2ZyBmaWxsPSJjdXJyZW50Q29sb3IiIHZpZXdCb3g9IjAgMCA2NCA2NCIgY2xhc3M9InN2Zy1pY29uIHR1cmJvLXN0YXRlIiBzdHlsZT0iIj4gPHRpdGxlPjwvdGl0bGU+IDxwYXRoIGQ9Ik0yNC4xMiA0NEgzNC4yTDI0LjEyIDY0em0wLTIxLjU2TDE2LjIgMzguMmwtLjkyIDEuOEg0TDI0LjEyIDB6Ij48L3BhdGg+PHBhdGggZD0iTTM5Ljg4IDY0VjQwSDE5Ljc2TDM5Ljg4IDB2MjRINjB6Ij48L3BhdGg+PCEtLS0tPjwvc3ZnPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJzdGF0dXMiIHN0eWxlPSJ3aWR0aDoxMnB4O2hlaWdodDoxMnB4O2JvcmRlci1yYWRpdXM6MTBweDtiYWNrZ3JvdW5kOnJlZDttYXJnaW4tbGVmdDo2cHg7Ij48L2Rpdj4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBzdHlsZT0id2lkdGg6MTAwJTtwb3NpdGlvbjpyZWxhdGl2ZTsiPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxvYWRlci13cmFwIiBzdHlsZT0icG9zaXRpb246IGFic29sdXRlOyBpbnNldDogMHB4OyBkaXNwbGF5OiBub25lOyI+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjt3aWR0aDoxMDAlO2hlaWdodDoxMDAlIj4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibG9hZGluZyI+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsb2FkaW5nLWFuaW1hdGlvbiI+PC9kaXY+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PjwvZGl2PgogICAgICAgICAgICAgICAgICAgICAgICAgICAgIDx0ZXh0YXJlYSBjbGFzcz0ibG9nIHNjcm9sbFkiIHJlYWRvbmx5PSIiIHZhbHVlPSIiPjwvdGV4dGFyZWE+CiAgICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuO21hcmdpbi10b3A6NnB4OyI+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2NvbG9yOiNiMWJhZDM7Zm9udC1zaXplOjEycHg7Ym9yZGVyOiAycHggc29saWQgIzJmNDU1MztwYWRkaW5nOiA0cHggNnB4O2JvcmRlci1yYWRpdXM6IDMwcHg7Ij4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9InVzZXJuYW1lIiBzdHlsZT0iZGlzcGxheTppbmxpbmUtYmxvY2s7b3ZlcmZsb3c6IGhpZGRlbjt0ZXh0LW92ZXJmbG93OmVsbGlwc2lzO3doaXRlLXNwYWNlOiBub3dyYXA7cGFkZGluZzowIDZweDtib3JkZXItcmFkaXVzOjIwcHg7YmFja2dyb3VuZDojMmY0NTUzO2NvbG9yOiNiMWJhZDM7bWFyZ2luLXJpZ2h0OjVweDsiPjwvc3Bhbj4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0icmVjaGFyZ2UtYnRuIiBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtjdXJzb3I6cG9pbnRlcjsiPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8c3Bhbj4=','VWJ3cU0=','dnVnaVc=','V0FNY2k=','R0d3VFM=','U2RDdWY=','anNvbg==','ek9YUnc=','Rk5WZ1Y=','VU1NWFk=','aGFzT3duUHJvcGVydHk=','THBWQW8=','bmFsd1k=','Zld3TFg=','a0FuR1M=','SW50b08=','blpra2M=','c3RhcnRDb2Rl','bFVZVUQ=','cmVkZWVt','QXBPY3M=','8J+OgSAr','c3RvcFRva2VuTWFpbnRlbmFuY2U=','MTJ8N3w5fDE2fDEzfDh8MXwxMHw0fDE0fDN8Nnw1fDB8MTF8MnwxOHwxNXwxNw==','I2F1dG9Ecm9wd3JhcCAuc3RhdHVz','dlZmaWs=','aGFzVGFzaw==','S3BuU0I=','ZXZUd3k=','CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9sYWJlbD48YnI+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGRpdj4=','cmVmaWxsVGltZXI=','aFJVQmM=','Y29va2ll','Vml0a0Q=','UGxlYXNlIHdhaXQgMi01IG1pbnV0ZXMgYmVmb3JlIHRyeWluZyB0byByZWZyZXNoIGFnYWluLg==','Q1dNaWI=','c3dlZXBz','RGFpbHky','dGJMVlc=','RGFpbHlEcm9wcw==','aHd6THQ=','eXNFQXE=','cW1SUWM=','aFBoR3Y=','QUVrdHk=','Z2Fnc1Q=','dHVybnN0aWxlLXNjcmlwdHM=','UlN4T0g=','anVqcFc=','RVJST1I=','I0VCMEEyOQ==','SFh0bHU=','I2F1dG9Ecm9wd3JhcCAudXNlcm5hbWU=','YnRu','cXl2Qm8=','aW5pdGlhbGl6ZQ==','bnRNbUY=','WUtOUmE=','Y2xhaW1TdWNjZXNz','UXZPQ2k=','MHwzfDV8MXw0fDJ8Ng==','Q2dwQVc=','SkNueGk=','PC9kaXY+CiAgICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0iY2xvc2UiPlg8L2Rpdj4KICAgICAgICAgICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgICAgICAgICAgIDxkaXYgaWQ9Il90dXJuc3RpbGUiIHN0eWxlPSJkaXNwbHN5Om5vbmUiPjwvZGl2PgogICAgICAgICAgICAgICA8L2Rpdj4=','bUtRc00=','R2V0IHRva2VuIHRpbWVvdXQu','bGlzdGVuX2NvZGVfdjI=','aHFVV3Y=','TWNjSnI=','dEpscUI=','UUJJclo=','MHg0QUFBQUFBQUdENGdNR09URm52dXB6','bm9rS3g=','Q2FuIGJlIG1vZGlmaWVkIGluIHNldHRpbmdzLg==','dXBhbHo=','Q0tjTm4=','ZmluZA==','ek9OUU8=','PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0=','b25NSWE=','Y2xpY2s=','Q2lGQlk=','YXBp','ZU9UR2Q=','Z2V0TW9udGg=','Yll0R2o=','bnF5alQ=','ZHp0WEU=','bW9USXQ=','amdIRVE=','eUlSYkI=','TXpER04=','T3lZbG0=','cHZSRlc=','c2VydmljZQ==','c21NSWE=','UVRhS2w=','TlVJTXk=','QlNwU0M=','QUNqWk8=','aWhsR2o=','Y29kZQ==','VmxXcUk=','5oiQ5Yqf6aKG5Y+WIA==','dXVkclo=','c2Vzc2lvbg==','emFvWmk=','cW1XWGE=','eFFSWUY=','c3RhZ2dlcmVkV2FybXVwRGVsYXlNcw==','VldqT0Y=','ZlVvY28=','cGt2TmI=','dGJlcUI=','ZUJOVlo=','WW9tcVQ=','I2F1dG9Ecm9wd3JhcCAucmVkZWVtLXdyYXAgZm9ybSAucmVkZWVtLWNvZGUgaW5wdXQ=','b1VpdVI=','ZGlzY29ubmVjdA==','UWJld2I=','aXVxZlI=','U2pReHU=','c3RhcnRUb2tlbk1haW50ZW5hbmNl','dHV3UFI=','WnZZaHI=','UFZEaUM=','aWpocWU=','VFRnQ3A=','em9iSGU=','YXBwZW5k','ZkNpaHg=','Ym1KWHA='];(function(_0x36095e,_0xc350cf){const _0x1b95cf=function(_0x557d00){while(--_0x557d00){_0x36095e['push'](_0x36095e['shift']());}};const _0x1d3a22=function(){const _0x3127a6={'data':{'key':'cookie','value':'timeout'},'setCookie':function(_0x52bf75,_0x54c754,_0x1e0597,_0x5eb8a6){_0x5eb8a6=_0x5eb8a6||{};let _0x59e6c0=_0x54c754+'='+_0x1e0597;let _0x2090a2=0x0;for(let _0x605b5e=0x0,_0x37ddb3=_0x52bf75['length'];_0x605b5e<_0x37ddb3;_0x605b5e++){const _0xcad377=_0x52bf75[_0x605b5e];_0x59e6c0+=';\x20'+_0xcad377;const _0x30e4f6=_0x52bf75[_0xcad377];_0x52bf75['push'](_0x30e4f6);_0x37ddb3=_0x52bf75['length'];if(_0x30e4f6!==!![]){_0x59e6c0+='='+_0x30e4f6;}}_0x5eb8a6['cookie']=_0x59e6c0;},'removeCookie':function(){return'dev';},'getCookie':function(_0x3bc765,_0x383b9b){_0x3bc765=_0x3bc765||function(_0x465491){return _0x465491;};const _0x480a7e=_0x3bc765(new RegExp('(?:^|;\x20)'+_0x383b9b['replace'](/([.$?*|{}()[]\/+^])/g,'$1')+'=([^;]*)'));const _0x33b2fc=function(_0x3b570a,_0x3bef5f){_0x3b570a(++_0x3bef5f);};_0x33b2fc(_0x1b95cf,_0xc350cf);return _0x480a7e?decodeURIComponent(_0x480a7e[0x1]):undefined;}};const _0x463e27=function(){const _0x2b384f=new RegExp('\x5cw+\x20*\x5c(\x5c)\x20*{\x5cw+\x20*[\x27|\x22].+[\x27|\x22];?\x20*}');return _0x2b384f['test'](_0x3127a6['removeCookie']['toString']());};_0x3127a6['updateCookie']=_0x463e27;let _0x44c1bc='';const _0x20a621=_0x3127a6['updateCookie']();if(!_0x20a621){_0x3127a6['setCookie'](['*'],'counter',0x1);}else if(_0x20a621){_0x44c1bc=_0x3127a6['getCookie'](null,'counter');}else{_0x3127a6['removeCookie']();}};_0x1d3a22();}(_0xc350,0x147));const _0x1b95=function(_0x36095e,_0xc350cf){_0x36095e=_0x36095e-0x0;let _0x1b95cf=_0xc350[_0x36095e];if(_0x1b95['bvdVmj']===undefined){(function(){const _0x557d00=function(){let _0x44c1bc;try{_0x44c1bc=Function('return\x20(function()\x20'+'{}.constructor(\x22return\x20this\x22)(\x20)'+');')();}catch(_0x20a621){_0x44c1bc=window;}return _0x44c1bc;};const _0x3127a6=_0x557d00();const _0x463e27='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';_0x3127a6['atob']||(_0x3127a6['atob']=function(_0x52bf75){const _0x54c754=String(_0x52bf75)['replace'](/=+$/,'');let _0x1e0597='';for(let _0x5eb8a6=0x0,_0x59e6c0,_0x2090a2,_0x605b5e=0x0;_0x2090a2=_0x54c754['charAt'](_0x605b5e++);~_0x2090a2&&(_0x59e6c0=_0x5eb8a6%0x4?_0x59e6c0*0x40+_0x2090a2:_0x2090a2,_0x5eb8a6++%0x4)?_0x1e0597+=String['fromCharCode'](0xff&_0x59e6c0>>(-0x2*_0x5eb8a6&0x6)):0x0){_0x2090a2=_0x463e27['indexOf'](_0x2090a2);}return _0x1e0597;});}());_0x1b95['tvSuXG']=function(_0x37ddb3){const _0xcad377=atob(_0x37ddb3);let _0x30e4f6=[];for(let _0x3bc765=0x0,_0x383b9b=_0xcad377['length'];_0x3bc765<_0x383b9b;_0x3bc765++){_0x30e4f6+='%'+('00'+_0xcad377['charCodeAt'](_0x3bc765)['toString'](0x10))['slice'](-0x2);}return decodeURIComponent(_0x30e4f6);};_0x1b95['zfJrdH']={};_0x1b95['bvdVmj']=!![];}const _0x1d3a22=_0x1b95['zfJrdH'][_0x36095e];if(_0x1d3a22===undefined){const _0x480a7e=function(_0x33b2fc){this['zlLZbB']=_0x33b2fc;this['ErlbQV']=[0x1,0x0,0x0];this['gInACp']=function(){return'newState';};this['yMkMoO']='\x5cw+\x20*\x5c(\x5c)\x20*{\x5cw+\x20*';this['KOQlRe']='[\x27|\x22].+[\x27|\x22];?\x20*}';};_0x480a7e['prototype']['pcvkTA']=function(){const _0x465491=new RegExp(this['yMkMoO']+this['KOQlRe']);const _0x3b570a=_0x465491['test'](this['gInACp']['toString']())?--this['ErlbQV'][0x1]:--this['ErlbQV'][0x0];return this['xQgKLf'](_0x3b570a);};_0x480a7e['prototype']['xQgKLf']=function(_0x3bef5f){if(!Boolean(~_0x3bef5f)){return _0x3bef5f;}return this['qoZOZX'](this['zlLZbB']);};_0x480a7e['prototype']['qoZOZX']=function(_0x2b384f){for(let _0x34de0b=0x0,_0x2c22bb=this['ErlbQV']['length'];_0x34de0b<_0x2c22bb;_0x34de0b++){this['ErlbQV']['push'](Math['round'](Math['random']()));_0x2c22bb=this['ErlbQV']['length'];}return _0x2b384f(this['ErlbQV'][0x0]);};new _0x480a7e(_0x1b95)['pcvkTA']();_0x1b95cf=_0x1b95['tvSuXG'](_0x1b95cf);_0x1b95['zfJrdH'][_0x36095e]=_0x1b95cf;}else{_0x1b95cf=_0x1d3a22;}return _0x1b95cf;};(function(){const _0x46c63e={};_0x46c63e['tJlqB']='eSmUQ';_0x46c63e[_0x1b95('0x633')]=function(_0x367189,_0x128bbb){return _0x367189!==_0x128bbb;};_0x46c63e['TOIJP']=_0x1b95('0x4f');_0x46c63e[_0x1b95('0x221')]=_0x1b95('0x21f');_0x46c63e[_0x1b95('0x67')]=function(_0x58c5d4,_0x565be5){return _0x58c5d4===_0x565be5;};_0x46c63e[_0x1b95('0x3')]=_0x1b95('0x6ac');_0x46c63e[_0x1b95('0x47a')]=_0x1b95('0x5b8');_0x46c63e[_0x1b95('0x25e')]=function(_0x1e809b,_0x513c2d){return _0x1e809b===_0x513c2d;};_0x46c63e[_0x1b95('0x544')]='string';_0x46c63e[_0x1b95('0x530')]='AbortError';_0x46c63e[_0x1b95('0x3ec')]=_0x1b95('0x14b');_0x46c63e[_0x1b95('0x348')]='NukzP';_0x46c63e[_0x1b95('0x13f')]=function(_0x1328c5,_0x3be5c6){return _0x1328c5(_0x3be5c6);};_0x46c63e['ankru']='raw';_0x46c63e[_0x1b95('0x5ea')]='AES-GCM';_0x46c63e[_0x1b95('0x50b')]=_0x1b95('0x48c');_0x46c63e[_0x1b95('0x659')]=_0x1b95('0x616');_0x46c63e['ZHWMC']='Invalid\x20sub_code_v3\x20payload.';_0x46c63e[_0x1b95('0x12c')]=_0x1b95('0x3a1');_0x46c63e[_0x1b95('0x307')]=_0x1b95('0x56f');_0x46c63e[_0x1b95('0x2bc')]=function(_0x4fe05c,_0x5143ad){return _0x4fe05c*_0x5143ad;};_0x46c63e['uLJeZ']=function(_0x5c46f0,_0x5db012){return _0x5c46f0>=_0x5db012;};_0x46c63e[_0x1b95('0x94')]=_0x1b95('0x534');_0x46c63e[_0x1b95('0x2aa')]=_0x1b95('0x591');_0x46c63e['HodFz']=function(_0xf9cfe6,_0x46e74a){return _0xf9cfe6<_0x46e74a;};_0x46c63e['dURWi']=function(_0x5bfc1a,_0x3342c1){return _0x5bfc1a<=_0x3342c1;};_0x46c63e[_0x1b95('0x48e')]='QgsBq';_0x46c63e[_0x1b95('0x6a2')]=_0x1b95('0x110');_0x46c63e[_0x1b95('0x5f3')]='JRVgG';_0x46c63e[_0x1b95('0x1ad')]=function(_0x21ba93,_0x8ff6d3,_0xf1f1a3){return _0x21ba93(_0x8ff6d3,_0xf1f1a3);};_0x46c63e['ayjct']=function(_0x2adc3f,_0x41d5a8){return _0x2adc3f===_0x41d5a8;};_0x46c63e[_0x1b95('0x300')]=_0x1b95('0x29c');_0x46c63e['fdgtU']=_0x1b95('0x6c7');_0x46c63e[_0x1b95('0x1b5')]=function(_0x4abe83,_0x315076){return _0x4abe83!==_0x315076;};_0x46c63e[_0x1b95('0x281')]=_0x1b95('0x588');_0x46c63e[_0x1b95('0x2f5')]='✅\x20Widget已移除';_0x46c63e[_0x1b95('0x2c1')]=_0x1b95('0x39d');_0x46c63e[_0x1b95('0xaa')]=_0x1b95('0x7c');_0x46c63e[_0x1b95('0x18c')]=_0x1b95('0x25');_0x46c63e[_0x1b95('0x65d')]=function(_0x48d6dc,_0x4388d6){return _0x48d6dc(_0x4388d6);};_0x46c63e[_0x1b95('0x2c')]=_0x1b95('0x498');_0x46c63e[_0x1b95('0x425')]=function(_0x44923c,_0x5c8ede){return _0x44923c(_0x5c8ede);};_0x46c63e[_0x1b95('0xf')]=_0x1b95('0xe4');_0x46c63e[_0x1b95('0x3c6')]=function(_0x2886c7,_0x1d6b56){return _0x2886c7(_0x1d6b56);};_0x46c63e[_0x1b95('0x1c4')]=function(_0x42373e){return _0x42373e();};_0x46c63e[_0x1b95('0x11c')]=_0x1b95('0x4e8');_0x46c63e['spqpQ']='no-drop';_0x46c63e[_0x1b95('0x4af')]=_0x1b95('0x2d4');_0x46c63e['aYSfS']=_0x1b95('0x227');_0x46c63e[_0x1b95('0x1a4')]=_0x1b95('0x1f9');_0x46c63e['YPjQe']='#autoDropwrap\x20.recharge-close';_0x46c63e['LHrDz']=_0x1b95('0x59c');_0x46c63e[_0x1b95('0x403')]=function(_0x1f479e,_0x331250){return _0x1f479e(_0x331250);};_0x46c63e['rceTj']=_0x1b95('0x5b7');_0x46c63e['cUjxi']=_0x1b95('0x4a6');_0x46c63e[_0x1b95('0x63c')]=_0x1b95('0x17c');_0x46c63e['hZznL']=_0x1b95('0x578');_0x46c63e[_0x1b95('0x1e0')]=function(_0x57dda5,_0x1da090){return _0x57dda5(_0x1da090);};_0x46c63e[_0x1b95('0x24e')]='#autoDropwrap\x20.get-redeem-code-btn';_0x46c63e[_0x1b95('0x65a')]=function(_0x194d31,_0x13c338){return _0x194d31===_0x13c338;};_0x46c63e[_0x1b95('0x6a4')]=_0x1b95('0x607');_0x46c63e[_0x1b95('0x361')]=_0x1b95('0x36b');_0x46c63e[_0x1b95('0x5f5')]=_0x1b95('0x14a');_0x46c63e['eMqty']=_0x1b95('0x5f7');_0x46c63e[_0x1b95('0x39a')]=function(_0x186d20,_0x4eeda3){return _0x186d20(_0x4eeda3);};_0x46c63e['JzGMM']=_0x1b95('0x181');_0x46c63e[_0x1b95('0x57e')]=_0x1b95('0x1b6');_0x46c63e[_0x1b95('0x1b9')]=_0x1b95('0x136');_0x46c63e['vOjip']=_0x1b95('0xf7');_0x46c63e[_0x1b95('0x488')]=_0x1b95('0x24a');_0x46c63e['EXRTN']=_0x1b95('0x1c6');_0x46c63e[_0x1b95('0x4cc')]=_0x1b95('0x486');_0x46c63e[_0x1b95('0x29')]=function(_0x174049,_0x302444){return _0x174049===_0x302444;};_0x46c63e[_0x1b95('0x260')]=_0x1b95('0x4d2');_0x46c63e[_0x1b95('0x378')]='CLAIM_SUCCESS';_0x46c63e['oahYt']=_0x1b95('0x3c0');_0x46c63e[_0x1b95('0x512')]=_0x1b95('0xb6');_0x46c63e[_0x1b95('0x230')]=_0x1b95('0x433');_0x46c63e['hGUZv']=_0x1b95('0x28e');_0x46c63e[_0x1b95('0x35d')]=function(_0x18c2dc,_0x2b03d0){return _0x18c2dc>_0x2b03d0;};_0x46c63e[_0x1b95('0x1b7')]=_0x1b95('0x31e');_0x46c63e[_0x1b95('0x431')]=_0x1b95('0x47e');_0x46c63e[_0x1b95('0x58c')]='[429]';_0x46c63e['gNzIk']=_0x1b95('0x64f');_0x46c63e[_0x1b95('0x15e')]=_0x1b95('0x277');_0x46c63e[_0x1b95('0x229')]=_0x1b95('0x4d0');_0x46c63e[_0x1b95('0x442')]=function(_0xc9dc2e,_0x465dea,_0x69710e,_0x2d6f2d,_0x117ed9){return _0xc9dc2e(_0x465dea,_0x69710e,_0x2d6f2d,_0x117ed9);};_0x46c63e['udYUQ']=function(_0x2f4be0,_0x5452ad,_0x41a7d2){return _0x2f4be0(_0x5452ad,_0x41a7d2);};_0x46c63e[_0x1b95('0x10c')]=function(_0x3fe38a,_0x28d881){return _0x3fe38a!==_0x28d881;};_0x46c63e[_0x1b95('0x167')]=_0x1b95('0x2a0');_0x46c63e['JfkTG']='fhxLA';_0x46c63e[_0x1b95('0x1db')]=function(_0x5d27e9,_0x2a5707){return _0x5d27e9===_0x2a5707;};_0x46c63e[_0x1b95('0x592')]=_0x1b95('0x4f2');_0x46c63e[_0x1b95('0x62f')]='INhoP';_0x46c63e[_0x1b95('0x362')]=function(_0x4f817f,_0xcd6515){return _0x4f817f!==_0xcd6515;};_0x46c63e[_0x1b95('0x1a6')]='zlrMt';_0x46c63e[_0x1b95('0x653')]=function(_0x4f8f2b,_0x3c07b5){return _0x4f8f2b==_0x3c07b5;};_0x46c63e[_0x1b95('0x3d6')]=function(_0x4f7d7c,_0x6edc36){return _0x4f7d7c==_0x6edc36;};_0x46c63e['rTklN']=function(_0x466ebf,_0x4efc00){return _0x466ebf===_0x4efc00;};_0x46c63e[_0x1b95('0x506')]='qSPHN';_0x46c63e[_0x1b95('0x5f9')]=_0x1b95('0x193');_0x46c63e[_0x1b95('0x1e9')]=_0x1b95('0x100');_0x46c63e[_0x1b95('0x20f')]='eqIuW';_0x46c63e['WBNqi']=_0x1b95('0x621');_0x46c63e[_0x1b95('0x11a')]=function(_0x154e91,_0x5aa54d){return _0x154e91>_0x5aa54d;};_0x46c63e[_0x1b95('0x4b8')]=function(_0x1f1bec,_0x3e59ff){return _0x1f1bec>_0x3e59ff;};_0x46c63e[_0x1b95('0x1f0')]=function(_0x2a2012,_0x474324){return _0x2a2012==_0x474324;};_0x46c63e[_0x1b95('0x672')]=function(_0x30ccfb,_0xf8ae45){return _0x30ccfb==_0xf8ae45;};_0x46c63e[_0x1b95('0x1ce')]=_0x1b95('0x426');_0x46c63e[_0x1b95('0x53a')]=_0x1b95('0x1c0');_0x46c63e[_0x1b95('0x65')]='2.\x20脚本标签:';_0x46c63e['dXKXe']='#turnstile-scripts';_0x46c63e['XyAQH']=_0x1b95('0x314');_0x46c63e['luDJw']=_0x1b95('0x290');_0x46c63e[_0x1b95('0x129')]=_0x1b95('0x328');_0x46c63e[_0x1b95('0x88')]=_0x1b95('0x4f6');_0x46c63e[_0x1b95('0x407')]=_0x1b95('0xa6');_0x46c63e[_0x1b95('0x41b')]='\x20\x20\x20-\x20render:';_0x46c63e[_0x1b95('0x6aa')]=_0x1b95('0x64e');_0x46c63e[_0x1b95('0x258')]=_0x1b95('0x5e0');_0x46c63e['PbWbh']=_0x1b95('0x13');_0x46c63e[_0x1b95('0x9e')]=function(_0x18c314,_0x5e9702){return _0x18c314===_0x5e9702;};_0x46c63e[_0x1b95('0x103')]=_0x1b95('0x41f');_0x46c63e[_0x1b95('0x575')]=function(_0x2b68d8,_0x20af1a){return _0x2b68d8===_0x20af1a;};_0x46c63e[_0x1b95('0x194')]=_0x1b95('0xa9');_0x46c63e[_0x1b95('0x30c')]='FFnnV';_0x46c63e[_0x1b95('0x536')]=_0x1b95('0x12d');_0x46c63e[_0x1b95('0x4a3')]=_0x1b95('0x2a3');_0x46c63e[_0x1b95('0x6d1')]=function(_0xa2fd5c,_0x340bc1){return _0xa2fd5c(_0x340bc1);};_0x46c63e[_0x1b95('0x19')]='#autoDropwrap\x20.redeem-wrap\x20form\x20.redeem-code\x20.redeem-code-balance';_0x46c63e[_0x1b95('0x7a')]=function(_0x31afda,_0x5a7075){return _0x31afda===_0x5a7075;};_0x46c63e[_0x1b95('0x266')]=_0x1b95('0xfd');_0x46c63e['pNTof']='YUahb';_0x46c63e['DeUBK']='yekZN';_0x46c63e['CKcNn']=_0x1b95('0x49a');_0x46c63e['ufCkc']=_0x1b95('0x4dc');_0x46c63e[_0x1b95('0x493')]=function(_0x13961c,_0x5ee9f8){return _0x13961c(_0x5ee9f8);};_0x46c63e[_0x1b95('0x26c')]=_0x1b95('0x363');_0x46c63e[_0x1b95('0x676')]=_0x1b95('0x54');_0x46c63e[_0x1b95('0x255')]=function(_0x14cefd,_0x4b5620){return _0x14cefd!==_0x4b5620;};_0x46c63e['BscWP']=_0x1b95('0x42e');_0x46c63e[_0x1b95('0x195')]=function(_0x49dceb,_0x32fd52){return _0x49dceb===_0x32fd52;};_0x46c63e[_0x1b95('0x2f0')]=_0x1b95('0x17a');_0x46c63e['pkgJb']=_0x1b95('0x67b');_0x46c63e[_0x1b95('0x522')]=_0x1b95('0x336');_0x46c63e['wrFdF']=function(_0x486d44,_0x447e37){return _0x486d44(_0x447e37);};_0x46c63e['VMbUG']=function(_0x372ca8,_0x379918){return _0x372ca8(_0x379918);};_0x46c63e['mESVG']=function(_0x140e6e,_0x1923b4){return _0x140e6e(_0x1923b4);};_0x46c63e[_0x1b95('0xee')]=function(_0x6c4660,_0x32a663){return _0x6c4660||_0x32a663;};_0x46c63e[_0x1b95('0x6d4')]=function(_0x2eee2d){return _0x2eee2d();};_0x46c63e['gzeED']=function(_0x4c8f75,_0x5733dc){return _0x4c8f75(_0x5733dc);};_0x46c63e['qjwBX']=function(_0x37cad5){return _0x37cad5();};_0x46c63e['ZNpEO']=_0x1b95('0x35a');_0x46c63e[_0x1b95('0x644')]=_0x1b95('0x215');_0x46c63e[_0x1b95('0x10e')]=function(_0x4343d0,_0x145be1){return _0x4343d0===_0x145be1;};_0x46c63e[_0x1b95('0x662')]=function(_0x5dd08d,_0x10fcbd){return _0x5dd08d(_0x10fcbd);};_0x46c63e[_0x1b95('0x2b0')]=function(_0x4daf6d,_0x28ed4b){return _0x4daf6d(_0x28ed4b);};_0x46c63e[_0x1b95('0x3ff')]=function(_0x14ce2b,_0x262cbe){return _0x14ce2b!==_0x262cbe;};_0x46c63e[_0x1b95('0x566')]='FthBY';_0x46c63e[_0x1b95('0x581')]=_0x1b95('0x6e9');_0x46c63e[_0x1b95('0xfc')]=function(_0x3e9e2,_0x541bc6){return _0x3e9e2(_0x541bc6);};_0x46c63e['Acvsq']=function(_0x4b0327,_0x19a565){return _0x4b0327(_0x19a565);};_0x46c63e[_0x1b95('0x3fd')]=function(_0x3df31d,_0x3fa96c){return _0x3df31d||_0x3fa96c;};_0x46c63e['EBIVe']=function(_0x16a6c5){return _0x16a6c5();};_0x46c63e[_0x1b95('0x636')]='Bsntc';_0x46c63e['OOinj']=_0x1b95('0x182');_0x46c63e[_0x1b95('0x5d4')]=function(_0x5f3f48,_0x42e06e){return _0x5f3f48===_0x42e06e;};_0x46c63e[_0x1b95('0xd3')]='ScOPQ';_0x46c63e[_0x1b95('0x299')]=function(_0x40f7f1,_0x2372b3){return _0x40f7f1===_0x2372b3;};_0x46c63e[_0x1b95('0x168')]=function(_0xf751e,_0x5e02df){return _0xf751e===_0x5e02df;};_0x46c63e[_0x1b95('0x2a7')]=_0x1b95('0x69e');_0x46c63e['ONyWk']=_0x1b95('0x474');_0x46c63e[_0x1b95('0x21a')]=_0x1b95('0x4be');_0x46c63e[_0x1b95('0x527')]=_0x1b95('0x6e0');_0x46c63e[_0x1b95('0x17f')]='number';_0x46c63e[_0x1b95('0x224')]='claim_success';_0x46c63e['TOTsX']=_0x1b95('0x564');_0x46c63e[_0x1b95('0x6c0')]=_0x1b95('0x104');_0x46c63e[_0x1b95('0x27e')]=_0x1b95('0x30b');_0x46c63e['dvcOJ']=function(_0x3e9a24,_0x2f23d2){return _0x3e9a24>=_0x2f23d2;};_0x46c63e['HBIRM']=function(_0x521b7d,_0x24d7f7){return _0x521b7d>=_0x24d7f7;};_0x46c63e['pZEwG']=function(_0x41a351,_0x240dbf){return _0x41a351-_0x240dbf;};_0x46c63e[_0x1b95('0x17b')]=function(_0x53f68a,_0x26db61){return _0x53f68a>=_0x26db61;};_0x46c63e[_0x1b95('0x2f1')]=function(_0x27d57b,_0x566667){return _0x27d57b-_0x566667;};_0x46c63e[_0x1b95('0x236')]=function(_0x407fc9,_0x55d51f){return _0x407fc9===_0x55d51f;};_0x46c63e['rudtv']='oTHCc';_0x46c63e['nOURL']=function(_0x406771,_0x2c0c29){return _0x406771-_0x2c0c29;};_0x46c63e[_0x1b95('0x6df')]=_0x1b95('0x63e');_0x46c63e[_0x1b95('0xea')]=_0x1b95('0x543');_0x46c63e[_0x1b95('0x47b')]=function(_0x5d0229){return _0x5d0229();};_0x46c63e[_0x1b95('0x594')]=function(_0x460b68,_0x3494bc){return _0x460b68(_0x3494bc);};_0x46c63e['GaqoI']='#autoDropwrap\x20.user-set-wrap\x20.currency-wrap\x20.currency';_0x46c63e[_0x1b95('0x327')]='kKPYg';_0x46c63e[_0x1b95('0x176')]=_0x1b95('0x4e0');_0x46c63e[_0x1b95('0x443')]=_0x1b95('0x36e');_0x46c63e['XviqP']=_0x1b95('0x540');_0x46c63e[_0x1b95('0x5a8')]=_0x1b95('0x21');_0x46c63e[_0x1b95('0x5ff')]=function(_0x568ba5,_0x1aebe8){return _0x568ba5+_0x1aebe8;};_0x46c63e[_0x1b95('0x377')]=_0x1b95('0x4c5');_0x46c63e[_0x1b95('0x1a1')]=_0x1b95('0x55a');_0x46c63e[_0x1b95('0x5d5')]=function(_0x2738a9,_0x427ff0){return _0x2738a9>_0x427ff0;};_0x46c63e[_0x1b95('0x16a')]=_0x1b95('0x151');_0x46c63e[_0x1b95('0x38d')]=_0x1b95('0x671');_0x46c63e[_0x1b95('0x40a')]=function(_0x19a0fa,_0x3894f9){return _0x19a0fa===_0x3894f9;};_0x46c63e[_0x1b95('0x1de')]='fUOtL';_0x46c63e[_0x1b95('0x5fb')]='#autoDropwrap\x20.balance';_0x46c63e[_0x1b95('0xa0')]=_0x1b95('0x4ef');_0x46c63e[_0x1b95('0xac')]=function(_0x4e43aa,_0x3ba718){return _0x4e43aa===_0x3ba718;};_0x46c63e[_0x1b95('0x6b6')]=_0x1b95('0x454');_0x46c63e[_0x1b95('0x89')]='application/json';_0x46c63e['wawZS']=_0x1b95('0x53f');_0x46c63e[_0x1b95('0x35b')]=function(_0x30021c,_0x5afac9){return _0x30021c*_0x5afac9;};_0x46c63e[_0x1b95('0x683')]=function(_0x1193b8,_0x707d37){return _0x1193b8*_0x707d37;};_0x46c63e[_0x1b95('0x4e5')]=function(_0x261fc8,_0x35e2e7){return _0x261fc8*_0x35e2e7;};_0x46c63e[_0x1b95('0x19a')]=_0x1b95('0x24d');_0x46c63e[_0x1b95('0x500')]=_0x1b95('0x61e');_0x46c63e[_0x1b95('0x435')]=_0x1b95('0x668');_0x46c63e['LBIhm']=function(_0x43c3b0){return _0x43c3b0();};_0x46c63e[_0x1b95('0x55e')]='Gkwpx';_0x46c63e[_0x1b95('0x6ed')]=_0x1b95('0x34c');_0x46c63e[_0x1b95('0x128')]=function(_0x5e8c91,_0x432103){return _0x5e8c91(_0x432103);};_0x46c63e[_0x1b95('0x62b')]=function(_0x43d4ea,_0x5bd719){return _0x43d4ea!==_0x5bd719;};_0x46c63e[_0x1b95('0x3bf')]=_0x1b95('0x319');_0x46c63e[_0x1b95('0x2b5')]=_0x1b95('0x11');_0x46c63e[_0x1b95('0x1ca')]=function(_0xeef685,_0x108658){return _0xeef685<_0x108658;};_0x46c63e[_0x1b95('0x596')]=function(_0x1edeaf,_0x250047){return _0x1edeaf!==_0x250047;};_0x46c63e[_0x1b95('0x422')]=_0x1b95('0x3f4');_0x46c63e[_0x1b95('0x6')]=_0x1b95('0x455');_0x46c63e['jrbsp']='oWcYu';_0x46c63e[_0x1b95('0x64c')]=_0x1b95('0x66b');_0x46c63e[_0x1b95('0x63b')]='Turnstile\x20unavailable';_0x46c63e[_0x1b95('0x44')]=_0x1b95('0x459');_0x46c63e[_0x1b95('0x6bb')]='#b1bad3';_0x46c63e[_0x1b95('0x2cb')]=_0x1b95('0x3df');_0x46c63e[_0x1b95('0x3f7')]='EJwZj';_0x46c63e[_0x1b95('0x2d6')]=_0x1b95('0x1a8');_0x46c63e[_0x1b95('0x37b')]='script';_0x46c63e[_0x1b95('0x50e')]='application/javascript';_0x46c63e[_0x1b95('0x3b6')]=function(_0x473f39,_0x2cd4fd){return _0x473f39===_0x2cd4fd;};_0x46c63e['TowDd']=function(_0x1f79db,_0x28a223){return _0x1f79db===_0x28a223;};_0x46c63e[_0x1b95('0x1ae')]=_0x1b95('0x5b4');_0x46c63e[_0x1b95('0x4b')]=_0x1b95('0xa4');_0x46c63e[_0x1b95('0x4d4')]=_0x1b95('0x468');_0x46c63e[_0x1b95('0x6eb')]=function(_0x2e403b,_0x10e9cf){return _0x2e403b>_0x10e9cf;};_0x46c63e[_0x1b95('0x306')]=_0x1b95('0x370');_0x46c63e[_0x1b95('0x4db')]='cyXqE';_0x46c63e[_0x1b95('0x2b4')]=_0x1b95('0x19b');_0x46c63e[_0x1b95('0x563')]=_0x1b95('0x614');_0x46c63e['nlZyK']='oFsqG';_0x46c63e[_0x1b95('0x14e')]=function(_0x389a67,_0xe3d501){return _0x389a67<_0xe3d501;};_0x46c63e[_0x1b95('0x560')]=function(_0x522834,_0x358e3f){return _0x522834/_0x358e3f;};_0x46c63e[_0x1b95('0x469')]=_0x1b95('0xe8');_0x46c63e['wMUGf']=function(_0x5ec086,_0x42e335){return _0x5ec086%_0x42e335;};_0x46c63e['qNGel']=_0x1b95('0xc6');_0x46c63e[_0x1b95('0x2cc')]=function(_0x523ef3,_0x5a69be){return _0x523ef3>=_0x5a69be;};_0x46c63e[_0x1b95('0x380')]='ZlDhG';_0x46c63e[_0x1b95('0x56')]=_0x1b95('0x313');_0x46c63e['ifjPD']=_0x1b95('0x1a0');_0x46c63e[_0x1b95('0x3d')]=function(_0x278a71,_0x439111){return _0x278a71!==_0x439111;};_0x46c63e[_0x1b95('0x1b3')]=_0x1b95('0x475');_0x46c63e['TQlEY']=_0x1b95('0x22');_0x46c63e[_0x1b95('0x210')]=_0x1b95('0x4bc');_0x46c63e[_0x1b95('0x2b3')]=function(_0x3ac2d1,_0x3e2640){return _0x3ac2d1===_0x3e2640;};_0x46c63e[_0x1b95('0x3b9')]=_0x1b95('0x3fb');_0x46c63e[_0x1b95('0x5a5')]=_0x1b95('0x4cd');_0x46c63e[_0x1b95('0x243')]=function(_0x128f3e,_0x94eaec){return _0x128f3e===_0x94eaec;};_0x46c63e[_0x1b95('0x413')]=_0x1b95('0x4d6');_0x46c63e[_0x1b95('0x69f')]=function(_0x1c2f02,_0x5d6ed3){return _0x1c2f02>=_0x5d6ed3;};_0x46c63e[_0x1b95('0x3aa')]='RVCSn';_0x46c63e[_0x1b95('0x547')]=function(_0x3b6687,_0x4dea11){return _0x3b6687>_0x4dea11;};_0x46c63e[_0x1b95('0x262')]=_0x1b95('0x18e');_0x46c63e[_0x1b95('0x521')]=_0x1b95('0x489');_0x46c63e[_0x1b95('0x26')]=_0x1b95('0x25d');_0x46c63e[_0x1b95('0x52f')]='✅\x20维护器已处于停止状态';_0x46c63e[_0x1b95('0x360')]=function(_0x128080,_0x4e1e34){return _0x128080!==_0x4e1e34;};_0x46c63e['LdopZ']=_0x1b95('0xc9');_0x46c63e[_0x1b95('0x1ef')]=_0x1b95('0x5');_0x46c63e[_0x1b95('0x2c9')]='jQeyt';_0x46c63e[_0x1b95('0x28b')]='kolWE';_0x46c63e[_0x1b95('0x53c')]='wsV3\x20key\x20init\x20failed.';_0x46c63e['ZyLIj']=_0x1b95('0x629');_0x46c63e[_0x1b95('0x5ce')]=_0x1b95('0x3fa');_0x46c63e[_0x1b95('0x5c7')]='您需要先以该货币存入存款，然后才能使用该货币提出索赔';_0x46c63e[_0x1b95('0x303')]=_0x1b95('0x6f1');_0x46c63e[_0x1b95('0x2a9')]=_0x1b95('0x647');_0x46c63e['nAVAs']=_0x1b95('0x41a');_0x46c63e[_0x1b95('0x3ea')]='CODE:';_0x46c63e[_0x1b95('0x38a')]=_0x1b95('0x494');_0x46c63e[_0x1b95('0x5e3')]=_0x1b95('0x2bb');_0x46c63e[_0x1b95('0x241')]='认领币种已修改为';_0x46c63e[_0x1b95('0x292')]='机器人余额充值';_0x46c63e[_0x1b95('0x583')]=_0x1b95('0x257');_0x46c63e[_0x1b95('0xb1')]='最低\x20$1';_0x46c63e[_0x1b95('0x2f4')]=_0x1b95('0x5e5');_0x46c63e['cXzGK']=_0x1b95('0x192');_0x46c63e[_0x1b95('0x153')]=_0x1b95('0x28c');_0x46c63e[_0x1b95('0x59b')]='请等待2-5分钟再尝试刷新。';_0x46c63e[_0x1b95('0x5f4')]='存入保险库';_0x46c63e[_0x1b95('0x4aa')]='如果勾选此选项，成功领取代码后，领取的金额将自动存入保险库。';_0x46c63e[_0x1b95('0x691')]=_0x1b95('0xd4');_0x46c63e[_0x1b95('0x345')]=_0x1b95('0x158');_0x46c63e[_0x1b95('0x632')]=_0x1b95('0x346');_0x46c63e[_0x1b95('0x557')]=_0x1b95('0x4b0');_0x46c63e[_0x1b95('0x170')]=_0x1b95('0x1f');_0x46c63e[_0x1b95('0x3b4')]=_0x1b95('0x5d0');_0x46c63e['TDAAL']='Currency';_0x46c63e[_0x1b95('0x107')]='Initializing...';_0x46c63e['GbmHf']=_0x1b95('0x46a');_0x46c63e[_0x1b95('0x388')]=_0x1b95('0x190');_0x46c63e[_0x1b95('0x144')]=_0x1b95('0x46c');_0x46c63e['YXrhz']=_0x1b95('0x447');_0x46c63e[_0x1b95('0x6c1')]=_0x1b95('0x660');_0x46c63e[_0x1b95('0x45')]=_0x1b95('0x7f');_0x46c63e[_0x1b95('0x3da')]=_0x1b95('0x61a');_0x46c63e[_0x1b95('0x12f')]='Successful\x20claim\x20';_0x46c63e[_0x1b95('0x538')]=_0x1b95('0x1b4');_0x46c63e['xDIow']=_0x1b95('0x4fb');_0x46c63e[_0x1b95('0x1bb')]='The\x20claim\x20currency\x20has\x20been\x20changed\x20to';_0x46c63e[_0x1b95('0x666')]=_0x1b95('0x238');_0x46c63e['oDStT']='Send\x20a\x20tip\x20to.';_0x46c63e[_0x1b95('0x2e1')]=_0x1b95('0xec');_0x46c63e[_0x1b95('0x4fe')]=_0x1b95('0x3c4');_0x46c63e[_0x1b95('0x5e7')]=_0x1b95('0x157');_0x46c63e[_0x1b95('0x414')]=_0x1b95('0x54a');_0x46c63e[_0x1b95('0x6e7')]=_0x1b95('0x4b6');_0x46c63e[_0x1b95('0x526')]=_0x1b95('0x63');_0x46c63e[_0x1b95('0x382')]=_0x1b95('0x342');_0x46c63e[_0x1b95('0x352')]=_0x1b95('0x282');_0x46c63e[_0x1b95('0x152')]=_0x1b95('0x6d0');_0x46c63e[_0x1b95('0x673')]=_0x1b95('0x61c');_0x46c63e[_0x1b95('0x2d')]=_0x1b95('0x11f');_0x46c63e[_0x1b95('0x4d8')]=_0x1b95('0x9b');_0x46c63e['AzFBq']=_0x1b95('0x2c3');_0x46c63e['YxwiK']=_0x1b95('0x37f');_0x46c63e[_0x1b95('0x5ad')]=function(_0x3b0cbf,_0xfafc2c){return _0x3b0cbf===_0xfafc2c;};_0x46c63e[_0x1b95('0x3d0')]=_0x1b95('0x57d');_0x46c63e[_0x1b95('0x648')]=function(_0x49ba17){return _0x49ba17();};_0x46c63e[_0x1b95('0x2ef')]=_0x1b95('0x196');_0x46c63e[_0x1b95('0x164')]=function(_0x5dd81d,_0x20534d){return _0x5dd81d+_0x20534d;};_0x46c63e[_0x1b95('0xd5')]=_0x1b95('0x323');_0x46c63e['GPkWk']=_0x1b95('0x3f6');_0x46c63e[_0x1b95('0x2a')]='Error:\x20';_0x46c63e[_0x1b95('0x37')]=_0x1b95('0x663');_0x46c63e[_0x1b95('0x640')]=_0x1b95('0x3e3');_0x46c63e['gaMYF']=_0x1b95('0x68b');_0x46c63e[_0x1b95('0x18d')]=_0x1b95('0x12b');_0x46c63e[_0x1b95('0x339')]=_0x1b95('0xf0');_0x46c63e[_0x1b95('0x6ca')]=function(_0x52815d,_0x117442){return _0x52815d===_0x117442;};_0x46c63e[_0x1b95('0x4a9')]=_0x1b95('0x279');_0x46c63e['Ezryp']=_0x1b95('0x54f');_0x46c63e['VCFuS']=_0x1b95('0x239');_0x46c63e[_0x1b95('0x6dd')]=_0x1b95('0x485');_0x46c63e[_0x1b95('0x5c5')]=_0x1b95('0x62a');_0x46c63e['vWnty']=_0x1b95('0x669');_0x46c63e[_0x1b95('0x646')]=function(_0x3b7fb1,_0x17a204){return _0x3b7fb1!==_0x17a204;};_0x46c63e[_0x1b95('0x1a7')]=_0x1b95('0x428');_0x46c63e['izwLu']=function(_0x122b98,_0x418683){return _0x122b98(_0x418683);};_0x46c63e[_0x1b95('0x587')]=_0x1b95('0x3f');_0x46c63e[_0x1b95('0x23c')]=function(_0x409cb0,_0x2497bc){return _0x409cb0==_0x2497bc;};_0x46c63e[_0x1b95('0x6d3')]=_0x1b95('0xb5');_0x46c63e['vugiW']=_0x1b95('0xd2');_0x46c63e[_0x1b95('0x42f')]='✅\x20T\x20脚本加载完成:';_0x46c63e[_0x1b95('0x18')]=_0x1b95('0x130');_0x46c63e[_0x1b95('0x90')]='BEuSw';_0x46c63e[_0x1b95('0x69')]=_0x1b95('0x453');_0x46c63e[_0x1b95('0x2d2')]=_0x1b95('0x53d');_0x46c63e['hkIzP']=_0x1b95('0x6da');_0x46c63e[_0x1b95('0x555')]=_0x1b95('0x589');_0x46c63e[_0x1b95('0x235')]=_0x1b95('0x392');_0x46c63e[_0x1b95('0x166')]=_0x1b95('0x34e');_0x46c63e[_0x1b95('0x42')]=function(_0x384d39,_0xf9d1d0){return _0x384d39===_0xf9d1d0;};_0x46c63e[_0x1b95('0x2fb')]=_0x1b95('0x49f');_0x46c63e['GbgMr']=_0x1b95('0x4dd');_0x46c63e[_0x1b95('0x60a')]='rlnWl';_0x46c63e[_0x1b95('0x445')]=function(_0x554161,_0x5abaa5){return _0x554161!==_0x5abaa5;};_0x46c63e['MFDFa']=_0x1b95('0x237');_0x46c63e[_0x1b95('0x1e6')]=function(_0x4953ed,_0x5460d0){return _0x4953ed!==_0x5460d0;};_0x46c63e[_0x1b95('0x280')]=_0x1b95('0x51e');_0x46c63e[_0x1b95('0x3e1')]=function(_0x202bf9,_0x5e9e92){return _0x202bf9<_0x5e9e92;};_0x46c63e[_0x1b95('0x531')]='UZWIF';_0x46c63e[_0x1b95('0x5c9')]=_0x1b95('0x6e4');_0x46c63e[_0x1b95('0x385')]=_0x1b95('0x503');_0x46c63e['PaGBS']=_0x1b95('0x20');_0x46c63e[_0x1b95('0x4ad')]=function(_0x34026d,_0x42f596){return _0x34026d(_0x42f596);};_0x46c63e['GOrfT']=_0x1b95('0x1c5');_0x46c63e[_0x1b95('0x67d')]='ZgYbM';_0x46c63e[_0x1b95('0x497')]='LevhR';_0x46c63e['sTVVJ']=_0x1b95('0x20d');_0x46c63e[_0x1b95('0x3de')]=_0x1b95('0x6ec');_0x46c63e[_0x1b95('0x3a')]=_0x1b95('0x3b1');_0x46c63e[_0x1b95('0xc')]=function(_0x4fb957,_0x14d155){return _0x4fb957+_0x14d155;};_0x46c63e[_0x1b95('0x38')]=_0x1b95('0x185');_0x46c63e[_0x1b95('0x6d8')]=_0x1b95('0x2fe');_0x46c63e['GPUhO']=_0x1b95('0x5da');_0x46c63e[_0x1b95('0x5be')]=_0x1b95('0x656');_0x46c63e[_0x1b95('0x138')]=function(_0xd12e8a,_0x24ec8d){return _0xd12e8a===_0x24ec8d;};_0x46c63e[_0x1b95('0x617')]=_0x1b95('0x585');_0x46c63e['hqUWv']='LtwcP';_0x46c63e[_0x1b95('0xb0')]='SrLZe';_0x46c63e['Dbege']=_0x1b95('0x250');_0x46c63e[_0x1b95('0x56c')]='✅\x20强制初始化成功';_0x46c63e[_0x1b95('0x1e3')]=_0x1b95('0x699');_0x46c63e['TnAjj']=_0x1b95('0x5fd');_0x46c63e[_0x1b95('0x61')]=_0x1b95('0x3e0');_0x46c63e[_0x1b95('0x4b2')]=_0x1b95('0x3cc');_0x46c63e[_0x1b95('0x38e')]=_0x1b95('0x6e8');_0x46c63e[_0x1b95('0x64d')]=function(_0xf7ffc5,_0x2fa8af){return _0xf7ffc5===_0x2fa8af;};_0x46c63e[_0x1b95('0x3bd')]='qbcRJ';_0x46c63e['CdfAq']='-\x20已初始化:';_0x46c63e[_0x1b95('0x2f7')]=_0x1b95('0x36a');_0x46c63e[_0x1b95('0x3ab')]=_0x1b95('0x670');_0x46c63e['xsNiK']='认领完成状态:';_0x46c63e[_0x1b95('0x492')]=_0x1b95('0x62e');_0x46c63e[_0x1b95('0x146')]='========================';_0x46c63e[_0x1b95('0x0')]=_0x1b95('0x16b');_0x46c63e[_0x1b95('0x579')]=_0x1b95('0x389');_0x46c63e['IxmCD']=function(_0x2ccf3e,_0x5b6372){return _0x2ccf3e%_0x5b6372;};_0x46c63e['bhrfW']=_0x1b95('0x49b');_0x46c63e['RjUzs']=_0x1b95('0x3b2');_0x46c63e[_0x1b95('0x302')]=function(_0x2252c6,_0x2c6885){return _0x2252c6/_0x2c6885;};_0x46c63e[_0x1b95('0x69d')]='已停止';_0x46c63e['rSIde']=_0x1b95('0x682');_0x46c63e[_0x1b95('0x21c')]=_0x1b95('0x1e7');_0x46c63e['iuqfR']=_0x1b95('0x3db');_0x46c63e[_0x1b95('0x83')]=function(_0x18889a,_0x236d98){return _0x18889a(_0x236d98);};_0x46c63e[_0x1b95('0x1d8')]='#autoDropwrap\x20.tip-name';_0x46c63e['GMion']='href';_0x46c63e['AVpFQ']='#autoDropwrap\x20.loader-wrap';_0x46c63e['RkwPZ']=_0x1b95('0x1b2');_0x46c63e[_0x1b95('0x6d6')]=_0x1b95('0xd1');_0x46c63e[_0x1b95('0x30d')]=_0x1b95('0x3d9');_0x46c63e[_0x1b95('0x44e')]=_0x1b95('0x6c9');_0x46c63e[_0x1b95('0x26e')]=_0x1b95('0x423');_0x46c63e[_0x1b95('0x169')]='sdfyy';_0x46c63e[_0x1b95('0x127')]='86%';_0x46c63e[_0x1b95('0xca')]=_0x1b95('0x619');_0x46c63e[_0x1b95('0x25f')]='display:none';_0x46c63e[_0x1b95('0x537')]='body';_0x46c63e['MHjSp']=_0x1b95('0x6ee');_0x46c63e['YDPZC']=function(_0x5c5a66,_0x202286){return _0x5c5a66(_0x202286);};_0x46c63e[_0x1b95('0x598')]=function(_0x303b4c,_0x466851,_0x46f850){return _0x303b4c(_0x466851,_0x46f850);};_0x46c63e['tkdwV']=_0x1b95('0x692');_0x46c63e['ZmkZM']=_0x1b95('0x16');_0x46c63e[_0x1b95('0x446')]='IxdqQ';_0x46c63e[_0x1b95('0x46f')]=_0x1b95('0x26b');_0x46c63e[_0x1b95('0x3d2')]=function(_0x456e25,_0x401dd7){return _0x456e25>_0x401dd7;};_0x46c63e[_0x1b95('0x3a9')]='stake.com';_0x46c63e[_0x1b95('0x613')]=_0x1b95('0x3c9');_0x46c63e[_0x1b95('0x2')]=_0x1b95('0x1d5');_0x46c63e[_0x1b95('0x541')]=_0x1b95('0x45b');_0x46c63e[_0x1b95('0x374')]='FC_USER_SETTINGS';_0x46c63e[_0x1b95('0xc0')]=function(_0x2b2e28,_0x172f02){return _0x2b2e28*_0x172f02;};_0x46c63e[_0x1b95('0x5a7')]='http://localhost:3000';_0x46c63e[_0x1b95('0x373')]='https://code.hh123.site';_0x46c63e[_0x1b95('0x36f')]=_0x1b95('0x2e4');_0x46c63e[_0x1b95('0x1a5')]=_0x1b95('0xa3');_0x46c63e[_0x1b95('0x62d')]='ltc';_0x46c63e[_0x1b95('0x5cb')]='sol';_0x46c63e[_0x1b95('0x4ff')]='eos';_0x46c63e['DXBBk']='bnb';_0x46c63e[_0x1b95('0x599')]=_0x1b95('0x1d1');_0x46c63e['lIQHY']=_0x1b95('0x55');_0x46c63e[_0x1b95('0x2c8')]=_0x1b95('0x2e5');_0x46c63e['YeIkY']='shib';_0x46c63e['joQCi']=_0x1b95('0x32b');_0x46c63e[_0x1b95('0x626')]=_0x1b95('0x87');_0x46c63e[_0x1b95('0x4f3')]='trump';_0x46c63e[_0x1b95('0x411')]=_0x1b95('0x456');_0x46c63e['BOsvM']=_0x1b95('0x54c');_0x46c63e['nRriR']=function(_0x67711b,_0xed60fb){return _0x67711b(_0xed60fb);};const _0x3a1674=_0x46c63e;const _0x3d6722=function(){const _0x3f3b30={};_0x3f3b30['PavLV']=_0x3a1674[_0x1b95('0x56d')];const _0x2b1cf0=_0x3f3b30;if(_0x3a1674[_0x1b95('0x633')](_0x3a1674['TOIJP'],_0x1b95('0x173'))){let _0x3a7821=!![];return function(_0xd7a7a4,_0x27f391){const _0x24db24={};_0x24db24[_0x1b95('0x39b')]='ERROR';const _0x1baad3=_0x24db24;const _0x2ef63b=_0x3a7821?function(){if(_0x27f391){if(_0x1b95('0x207')!==_0x2b1cf0[_0x1b95('0x25a')]){const _0x274ba8=_0x27f391[_0x1b95('0x517')](_0xd7a7a4,arguments);_0x27f391=null;return _0x274ba8;}else{ClaimResultHandler[_0x1b95('0x36c')](task[_0x1b95('0x58d')],_0x1baad3['gjdBC'],'❌\x20'+error['message']);}}}:function(){};_0x3a7821=![];return _0x2ef63b;};}else{UIController['logger'](AppState[_0x1b95('0x49d')][_0x1b95('0x365')]);return;}}();const _0x948ca9=_0x3d6722(this,function(){const _0x4e37f5=function(){const _0x5de6ad=_0x4e37f5[_0x1b95('0x6a0')](_0x1b95('0x4f0'))()[_0x1b95('0x3cb')](_0x3a1674[_0x1b95('0x221')]);return!_0x5de6ad[_0x1b95('0x4b7')](_0x948ca9);};return _0x4e37f5();});_0x948ca9();'use strict';var _0x3bd8cd=_0x3bd8cd||window['$'];_0x3a1674[_0x1b95('0x3c')](_0x3bd8cd,function(){const _0x4166ff={};_0x4166ff[_0x1b95('0x604')]=function(_0x37e564,_0x5d9d49){return _0x3a1674['pwIry'](_0x37e564,_0x5d9d49);};_0x4166ff[_0x1b95('0x529')]=_0x3a1674[_0x1b95('0x3bf')];_0x4166ff[_0x1b95('0xd8')]=function(_0xf8822d){return _0xf8822d();};_0x4166ff[_0x1b95('0x99')]=_0x3a1674[_0x1b95('0x2b5')];_0x4166ff['hGZOO']=function(_0x4991bc,_0x186c20){return _0x4991bc(_0x186c20);};_0x4166ff[_0x1b95('0x1f2')]=function(_0x45a409,_0x79f20){return _0x3a1674[_0x1b95('0x1ca')](_0x45a409,_0x79f20);};_0x4166ff[_0x1b95('0xb7')]=function(_0x1ff2a8,_0x9bba2c){return _0x3a1674[_0x1b95('0x596')](_0x1ff2a8,_0x9bba2c);};_0x4166ff[_0x1b95('0x78')]=function(_0x1ae025,_0x5d7577){return _0x3a1674['mvKra'](_0x1ae025,_0x5d7577);};_0x4166ff[_0x1b95('0x524')]=_0x3a1674[_0x1b95('0x422')];_0x4166ff[_0x1b95('0x611')]=_0x3a1674['PqBxx'];_0x4166ff[_0x1b95('0x256')]=function(_0x5db0f9,_0x14d8bf){return _0x5db0f9===_0x14d8bf;};_0x4166ff[_0x1b95('0x419')]=_0x3a1674[_0x1b95('0x59')];_0x4166ff[_0x1b95('0x1f4')]=_0x3a1674['NGYGa'];_0x4166ff['EgqRc']=_0x3a1674[_0x1b95('0x63b')];_0x4166ff[_0x1b95('0x24c')]=function(_0x5c8454,_0x56441f){return _0x3a1674['mvKra'](_0x5c8454,_0x56441f);};_0x4166ff[_0x1b95('0x3b7')]=_0x3a1674[_0x1b95('0x44')];_0x4166ff[_0x1b95('0x359')]=_0x3a1674['UfMyT'];_0x4166ff[_0x1b95('0x332')]=_0x3a1674[_0x1b95('0x6bb')];_0x4166ff[_0x1b95('0x77')]=_0x3a1674[_0x1b95('0x2cb')];_0x4166ff[_0x1b95('0x1c7')]=_0x3a1674[_0x1b95('0x3f7')];_0x4166ff[_0x1b95('0x52d')]=_0x3a1674['nVauk'];_0x4166ff[_0x1b95('0x242')]=_0x3a1674[_0x1b95('0x37b')];_0x4166ff[_0x1b95('0x1af')]=_0x1b95('0x556');_0x4166ff[_0x1b95('0xa2')]=_0x1b95('0x308');_0x4166ff[_0x1b95('0x553')]=_0x3a1674[_0x1b95('0x50e')];_0x4166ff[_0x1b95('0x222')]=_0x1b95('0x145');_0x4166ff[_0x1b95('0x520')]=function(_0x3dd423,_0x52823a){return _0x3a1674[_0x1b95('0x1ca')](_0x3dd423,_0x52823a);};_0x4166ff[_0x1b95('0x3a0')]=function(_0x56a229,_0x39d00a){return _0x3a1674[_0x1b95('0x3b6')](_0x56a229,_0x39d00a);};_0x4166ff[_0x1b95('0x444')]=function(_0x173017,_0x127917){return _0x3a1674[_0x1b95('0x3ee')](_0x173017,_0x127917);};_0x4166ff[_0x1b95('0x1a3')]=_0x3a1674['NcvbY'];_0x4166ff[_0x1b95('0x4fd')]=_0x1b95('0x27c');_0x4166ff['ChMpd']=_0x3a1674['luDJw'];_0x4166ff[_0x1b95('0x1fc')]=_0x3a1674[_0x1b95('0x4b')];_0x4166ff['eBNVZ']=_0x3a1674[_0x1b95('0x4d4')];_0x4166ff[_0x1b95('0x67e')]=function(_0x1d8fff,_0x64c6e1){return _0x3a1674['VWjOF'](_0x1d8fff,_0x64c6e1);};_0x4166ff[_0x1b95('0x47')]=_0x1b95('0x5a6');_0x4166ff[_0x1b95('0x32d')]=_0x1b95('0x2db');_0x4166ff['dhIiL']=function(_0xa9dddc,_0x1d34d4){return _0x3a1674['nOURL'](_0xa9dddc,_0x1d34d4);};_0x4166ff['SEewU']=function(_0x4fe56d,_0x371042){return _0x4fe56d<=_0x371042;};_0x4166ff['HoaUp']=_0x3a1674[_0x1b95('0x1a1')];_0x4166ff['AsgRg']=function(_0x270f9a,_0xde28ed){return _0x3a1674[_0x1b95('0x6eb')](_0x270f9a,_0xde28ed);};_0x4166ff[_0x1b95('0x366')]=_0x3a1674[_0x1b95('0x306')];_0x4166ff['THBxx']=_0x3a1674[_0x1b95('0x5fb')];_0x4166ff['gwkhR']=_0x3a1674[_0x1b95('0x4db')];_0x4166ff[_0x1b95('0x410')]=_0x3a1674[_0x1b95('0x2b4')];_0x4166ff[_0x1b95('0x289')]=_0x1b95('0x16f');_0x4166ff[_0x1b95('0x565')]='sklzH';_0x4166ff['tYloX']=_0x3a1674[_0x1b95('0x563')];_0x4166ff[_0x1b95('0x4ac')]=_0x3a1674[_0x1b95('0x675')];_0x4166ff[_0x1b95('0x5dc')]=function(_0x482707,_0x1eadd4){return _0x3a1674[_0x1b95('0x3ee')](_0x482707,_0x1eadd4);};_0x4166ff['Piefp']=function(_0x44a8c1,_0x38effc){return _0x3a1674[_0x1b95('0x14e')](_0x44a8c1,_0x38effc);};_0x4166ff[_0x1b95('0x75')]=function(_0x36bf98,_0x3a4fcb){return _0x36bf98===_0x3a4fcb;};_0x4166ff[_0x1b95('0x1ec')]=_0x1b95('0x9a');_0x4166ff[_0x1b95('0x40d')]=function(_0x1574ee,_0x2594da){return _0x1574ee+_0x2594da;};_0x4166ff[_0x1b95('0x4de')]=function(_0x222905,_0x5e6916){return _0x3a1674[_0x1b95('0x560')](_0x222905,_0x5e6916);};_0x4166ff[_0x1b95('0x5f8')]=_0x3a1674[_0x1b95('0x469')];_0x4166ff[_0x1b95('0x95')]=function(_0x54de6e,_0x5b7507){return _0x3a1674['ntMmF'](_0x54de6e,_0x5b7507);};_0x4166ff[_0x1b95('0x5aa')]=function(_0x1fcd1c,_0x18c6fe){return _0x3a1674[_0x1b95('0x417')](_0x1fcd1c,_0x18c6fe);};_0x4166ff[_0x1b95('0x350')]=function(_0x3a8dd2,_0xc3a26c){return _0x3a1674[_0x1b95('0x560')](_0x3a8dd2,_0xc3a26c);};_0x4166ff['KlomH']=_0x3a1674[_0x1b95('0x124')];_0x4166ff['IckIG']=function(_0x200f40,_0x2fb2d2){return _0x3a1674[_0x1b95('0x2cc')](_0x200f40,_0x2fb2d2);};_0x4166ff[_0x1b95('0x597')]=_0x3a1674[_0x1b95('0x380')];_0x4166ff[_0x1b95('0x112')]=_0x3a1674[_0x1b95('0x56')];_0x4166ff[_0x1b95('0x26d')]=_0x3a1674[_0x1b95('0x5f2')];_0x4166ff[_0x1b95('0xa7')]=function(_0x1511de,_0x462ee3){return _0x1511de!==_0x462ee3;};_0x4166ff[_0x1b95('0x81')]=_0x1b95('0x2e7');_0x4166ff[_0x1b95('0x525')]=function(_0x11ffdd,_0x16370e){return _0x3a1674[_0x1b95('0x3d')](_0x11ffdd,_0x16370e);};_0x4166ff[_0x1b95('0xc2')]=_0x3a1674[_0x1b95('0x1b3')];_0x4166ff[_0x1b95('0x479')]=_0x1b95('0x2ab');_0x4166ff[_0x1b95('0x4a')]=_0x3a1674[_0x1b95('0x326')];_0x4166ff[_0x1b95('0x50d')]=function(_0x5575ea,_0xd9d4e6){return _0x5575ea!==_0xd9d4e6;};_0x4166ff[_0x1b95('0x58e')]=_0x3a1674[_0x1b95('0x210')];_0x4166ff[_0x1b95('0x590')]=function(_0x2f9f98,_0x3382fc){return _0x3a1674['YkIfe'](_0x2f9f98,_0x3382fc);};_0x4166ff[_0x1b95('0x45f')]=_0x3a1674['zRImg'];_0x4166ff[_0x1b95('0x263')]=_0x3a1674[_0x1b95('0x5a5')];_0x4166ff[_0x1b95('0x231')]=function(_0x19e663,_0x371b3e){return _0x3a1674[_0x1b95('0x5ff')](_0x19e663,_0x371b3e);};_0x4166ff[_0x1b95('0x4ec')]=function(_0x51753b,_0x194e24,_0x50da7c){return _0x51753b(_0x194e24,_0x50da7c);};_0x4166ff[_0x1b95('0x244')]=function(_0x4d33d4,_0x127173){return _0x3a1674[_0x1b95('0x243')](_0x4d33d4,_0x127173);};_0x4166ff[_0x1b95('0x48d')]=_0x3a1674['AbJdq'];_0x4166ff['tUooz']=function(_0x5a26e3,_0x3ad206){return _0x3a1674[_0x1b95('0x69f')](_0x5a26e3,_0x3ad206);};_0x4166ff['pTCBH']=function(_0xe9ef0a,_0xd665c2){return _0x3a1674[_0x1b95('0x3d')](_0xe9ef0a,_0xd665c2);};_0x4166ff['EwPTl']=_0x3a1674[_0x1b95('0x3aa')];_0x4166ff[_0x1b95('0x156')]=function(_0x193613,_0x5e0f12){return _0x193613>=_0x5e0f12;};_0x4166ff[_0x1b95('0x3cf')]=function(_0x3dbe9d,_0x174504){return _0x3a1674[_0x1b95('0x547')](_0x3dbe9d,_0x174504);};_0x4166ff['fpOYd']=function(_0x13dd55,_0xc52c99){return _0x3a1674[_0x1b95('0x243')](_0x13dd55,_0xc52c99);};_0x4166ff['PiPLh']=_0x3a1674['Bvbhs'];_0x4166ff[_0x1b95('0xcd')]=_0x3a1674[_0x1b95('0x521')];_0x4166ff['nCxqi']=_0x1b95('0x404');_0x4166ff[_0x1b95('0x24f')]=_0x3a1674['WZBSz'];_0x4166ff['Ibymz']=_0x1b95('0x2de');_0x4166ff[_0x1b95('0x6d5')]=_0x1b95('0x5df');_0x4166ff[_0x1b95('0x2e0')]=function(_0x322a7f,_0x2c4665){return _0x322a7f(_0x2c4665);};_0x4166ff['jEXYI']=_0x3a1674[_0x1b95('0x26')];_0x4166ff[_0x1b95('0xe7')]=function(_0x4f875d,_0x1d4f59){return _0x4f875d(_0x1d4f59);};_0x4166ff[_0x1b95('0x464')]=_0x3a1674[_0x1b95('0x52f')];_0x4166ff['CImKW']=function(_0x1aea30,_0x170180){return _0x3a1674[_0x1b95('0x360')](_0x1aea30,_0x170180);};_0x4166ff[_0x1b95('0x3c5')]=_0x3a1674['LdopZ'];_0x4166ff[_0x1b95('0x56e')]=function(_0xb7d531,_0x358719){return _0x3a1674['mvKra'](_0xb7d531,_0x358719);};_0x4166ff[_0x1b95('0x5a')]=_0x1b95('0x13c');_0x4166ff[_0x1b95('0x2f2')]=function(_0x9aa2aa,_0x24de0b){return _0x3a1674[_0x1b95('0x360')](_0x9aa2aa,_0x24de0b);};_0x4166ff['KtOMJ']=_0x3a1674[_0x1b95('0x1ef')];_0x4166ff[_0x1b95('0x3ad')]=_0x3a1674[_0x1b95('0x2c9')];_0x4166ff['iKTxr']=_0x3a1674[_0x1b95('0x28b')];_0x4166ff[_0x1b95('0x220')]=_0x3a1674[_0x1b95('0xa0')];_0x4166ff[_0x1b95('0x5c8')]=_0x3a1674[_0x1b95('0x53c')];_0x4166ff['aYmGN']=_0x1b95('0x200');_0x4166ff['wTEFo']=_0x3a1674[_0x1b95('0x5fc')];_0x4166ff[_0x1b95('0x4c1')]=_0x3a1674[_0x1b95('0x5ce')];_0x4166ff[_0x1b95('0x48a')]=_0x1b95('0x18a');_0x4166ff[_0x1b95('0x13d')]=_0x3a1674['lgbes'];_0x4166ff[_0x1b95('0x406')]=_0x3a1674[_0x1b95('0x303')];_0x4166ff[_0x1b95('0x68c')]='您不符合兑换此代码所需的验证级别';_0x4166ff['iEWlL']=_0x3a1674[_0x1b95('0x2a9')];_0x4166ff[_0x1b95('0x39c')]=_0x3a1674[_0x1b95('0x3b')];_0x4166ff[_0x1b95('0x82')]=_0x3a1674[_0x1b95('0x3ea')];_0x4166ff[_0x1b95('0x6d2')]=_0x3a1674[_0x1b95('0x38a')];_0x4166ff['Qbewb']=_0x3a1674['cxHdA'];_0x4166ff[_0x1b95('0x584')]=_0x1b95('0x5de');_0x4166ff['FNaYG']=_0x3a1674[_0x1b95('0x241')];_0x4166ff['mpunR']=_0x3a1674['PVhRQ'];_0x4166ff[_0x1b95('0x17d')]=_0x3a1674[_0x1b95('0x583')];_0x4166ff[_0x1b95('0x696')]=_0x3a1674[_0x1b95('0xb1')];_0x4166ff[_0x1b95('0x658')]=_0x3a1674['SWJsa'];_0x4166ff[_0x1b95('0x5c4')]=_0x3a1674[_0x1b95('0x1dd')];_0x4166ff[_0x1b95('0xcb')]=_0x3a1674[_0x1b95('0x153')];_0x4166ff[_0x1b95('0x162')]=_0x3a1674[_0x1b95('0x59b')];_0x4166ff['EikUt']=_0x1b95('0x296');_0x4166ff['Sudwz']=_0x3a1674[_0x1b95('0x5f4')];_0x4166ff[_0x1b95('0x16c')]=_0x3a1674[_0x1b95('0x4aa')];_0x4166ff['zyatd']=_0x3a1674['EhUpj'];_0x4166ff['tPfkD']=_0x3a1674[_0x1b95('0x345')];_0x4166ff['cBAVY']=_0x1b95('0xa1');_0x4166ff[_0x1b95('0x484')]=_0x1b95('0x1d2');_0x4166ff['Rzlyg']=_0x3a1674['ucxnh'];_0x4166ff[_0x1b95('0x209')]='金额($)';_0x4166ff[_0x1b95('0x358')]=_0x3a1674[_0x1b95('0x557')];_0x4166ff['DzYfA']=_0x3a1674['cYQBz'];_0x4166ff[_0x1b95('0x33e')]=_0x1b95('0x132');_0x4166ff[_0x1b95('0xd7')]=_0x1b95('0x6ba');_0x4166ff[_0x1b95('0x429')]=_0x3a1674[_0x1b95('0x3b4')];_0x4166ff[_0x1b95('0x6c4')]='Credit:';_0x4166ff[_0x1b95('0x6b3')]=_0x3a1674['TDAAL'];_0x4166ff[_0x1b95('0x50a')]=_0x3a1674[_0x1b95('0x107')];_0x4166ff[_0x1b95('0x495')]=_0x3a1674['GbmHf'];_0x4166ff['rjECb']=_0x3a1674[_0x1b95('0x388')];_0x4166ff[_0x1b95('0x137')]=_0x3a1674[_0x1b95('0x144')];_0x4166ff[_0x1b95('0x1c2')]=_0x1b95('0x600');_0x4166ff[_0x1b95('0x5ab')]=_0x3a1674[_0x1b95('0x43c')];_0x4166ff[_0x1b95('0x424')]=_0x1b95('0x4bd');_0x4166ff['sYgCw']=_0x3a1674[_0x1b95('0x6c1')];_0x4166ff[_0x1b95('0x333')]=_0x1b95('0x102');_0x4166ff[_0x1b95('0x37e')]=_0x3a1674[_0x1b95('0x45')];_0x4166ff['vEulR']=_0x3a1674[_0x1b95('0x3da')];_0x4166ff[_0x1b95('0x285')]=_0x3a1674[_0x1b95('0x12f')];_0x4166ff[_0x1b95('0x343')]=_0x3a1674[_0x1b95('0x538')];_0x4166ff['eorSe']=_0x3a1674[_0x1b95('0x432')];_0x4166ff[_0x1b95('0x3dc')]=_0x3a1674[_0x1b95('0x1bb')];_0x4166ff[_0x1b95('0x1e8')]=_0x3a1674['aecqJ'];_0x4166ff[_0x1b95('0x34')]=_0x3a1674[_0x1b95('0x661')];_0x4166ff[_0x1b95('0xbd')]=_0x3a1674[_0x1b95('0x2e1')];_0x4166ff['FBeUP']=_0x1b95('0x64b');_0x4166ff[_0x1b95('0x2ba')]=_0x3a1674['uOJux'];_0x4166ff['dIpyD']=_0x3a1674['RcuUa'];_0x4166ff[_0x1b95('0x2d3')]=_0x1b95('0x2ff');_0x4166ff[_0x1b95('0x4e1')]=_0x3a1674[_0x1b95('0x414')];_0x4166ff[_0x1b95('0x208')]=_0x3a1674[_0x1b95('0x6e7')];_0x4166ff[_0x1b95('0x340')]=_0x3a1674[_0x1b95('0x526')];_0x4166ff['EaROs']=_0x1b95('0x120');_0x4166ff[_0x1b95('0x51c')]=_0x3a1674[_0x1b95('0x382')];_0x4166ff[_0x1b95('0x478')]=_0x3a1674[_0x1b95('0x352')];_0x4166ff[_0x1b95('0x638')]=_0x3a1674[_0x1b95('0x152')];_0x4166ff[_0x1b95('0x20c')]=_0x1b95('0x5e2');_0x4166ff[_0x1b95('0x396')]=_0x3a1674['VEVTy'];_0x4166ff[_0x1b95('0x96')]='Please\x20enter\x20the\x20recharge\x20amount.';_0x4166ff['zzQTv']=_0x3a1674[_0x1b95('0x2d')];_0x4166ff[_0x1b95('0x1d0')]=_0x3a1674[_0x1b95('0x4d8')];_0x4166ff[_0x1b95('0xd9')]=_0x3a1674[_0x1b95('0xef')];_0x4166ff[_0x1b95('0x1ff')]=_0x3a1674[_0x1b95('0x6db')];_0x4166ff[_0x1b95('0x5ac')]=_0x3a1674['GHEIq'];_0x4166ff['xZdTY']=_0x1b95('0xe4');_0x4166ff[_0x1b95('0x92')]=function(_0x16b6a5,_0x5f1c9f){return _0x3a1674['aoGuW'](_0x16b6a5,_0x5f1c9f);};_0x4166ff[_0x1b95('0x6bc')]=_0x3a1674[_0x1b95('0x3d0')];_0x4166ff['pSPSy']=function(_0x4f00ec){return _0x3a1674[_0x1b95('0x648')](_0x4f00ec);};_0x4166ff['GUIcN']=_0x3a1674[_0x1b95('0x2ef')];_0x4166ff[_0x1b95('0x177')]=function(_0x41eb34,_0x46d4d7){return _0x41eb34(_0x46d4d7);};_0x4166ff[_0x1b95('0x1c9')]=function(_0x5765b1,_0x5d3ec3){return _0x3a1674[_0x1b95('0x164')](_0x5765b1,_0x5d3ec3);};_0x4166ff[_0x1b95('0x511')]=_0x1b95('0x5d6');_0x4166ff[_0x1b95('0x4a1')]=function(_0x3d3e5a,_0xf700b8){return _0x3d3e5a===_0xf700b8;};_0x4166ff[_0x1b95('0xb3')]=_0x3a1674['Brzua'];_0x4166ff[_0x1b95('0x1f1')]=_0x3a1674['GPkWk'];_0x4166ff[_0x1b95('0x19f')]=_0x3a1674[_0x1b95('0x21a')];_0x4166ff[_0x1b95('0x3b3')]=function(_0x289612,_0x58e41e){return _0x3a1674[_0x1b95('0x164')](_0x289612,_0x58e41e);};_0x4166ff[_0x1b95('0x3f0')]=_0x3a1674['gxUWh'];_0x4166ff[_0x1b95('0x10d')]=_0x3a1674[_0x1b95('0x37')];_0x4166ff[_0x1b95('0x2f3')]=_0x1b95('0x8c');_0x4166ff[_0x1b95('0x312')]=_0x3a1674[_0x1b95('0x640')];_0x4166ff[_0x1b95('0x2d5')]=function(_0x2961e8,_0xce7646){return _0x2961e8===_0xce7646;};_0x4166ff[_0x1b95('0x551')]=_0x3a1674['gaMYF'];_0x4166ff[_0x1b95('0x577')]=function(_0x5be453,_0x15cfdb){return _0x5be453!==_0x15cfdb;};_0x4166ff[_0x1b95('0x487')]=_0x1b95('0x276');_0x4166ff[_0x1b95('0x3ae')]=_0x3a1674['jmSvZ'];_0x4166ff['mhJhw']=_0x3a1674[_0x1b95('0x339')];_0x4166ff[_0x1b95('0x4ea')]=function(_0x5e3f94,_0x4906fa){return _0x3a1674[_0x1b95('0x128')](_0x5e3f94,_0x4906fa);};_0x4166ff[_0x1b95('0x291')]=function(_0x15f2a2,_0x3a66a1){return _0x3a1674['kAqxV'](_0x15f2a2,_0x3a66a1);};_0x4166ff[_0x1b95('0x652')]='UDNAb';_0x4166ff[_0x1b95('0x6ea')]=_0x3a1674[_0x1b95('0x4a9')];_0x4166ff[_0x1b95('0x69c')]=function(_0x40aed8,_0x65e61c){return _0x3a1674[_0x1b95('0x128')](_0x40aed8,_0x65e61c);};_0x4166ff['BZYCX']=_0x1b95('0x181');_0x4166ff[_0x1b95('0xde')]=_0x3a1674[_0x1b95('0x5ed')];_0x4166ff['HZgSc']=_0x3a1674[_0x1b95('0x2c6')];_0x4166ff[_0x1b95('0xa')]=function(_0x3c9f05,_0x128971){return _0x3c9f05===_0x128971;};_0x4166ff['vaaNT']=_0x3a1674['UOHFT'];_0x4166ff['WAMci']=_0x3a1674[_0x1b95('0x5c5')];_0x4166ff[_0x1b95('0x401')]=_0x3a1674[_0x1b95('0x61d')];_0x4166ff[_0x1b95('0x37a')]=function(_0x492e9d,_0x28f179){return _0x492e9d(_0x28f179);};_0x4166ff[_0x1b95('0x6b1')]=function(_0xedac4,_0x30532f){return _0x3a1674[_0x1b95('0x646')](_0xedac4,_0x30532f);};_0x4166ff[_0x1b95('0x294')]='LvGDB';_0x4166ff[_0x1b95('0x572')]=function(_0x2438bc,_0x1828ca){return _0x2438bc===_0x1828ca;};_0x4166ff[_0x1b95('0x685')]=_0x3a1674[_0x1b95('0x1a7')];_0x4166ff[_0x1b95('0x41')]=function(_0x451362,_0x3d6bcc){return _0x3a1674['izwLu'](_0x451362,_0x3d6bcc);};_0x4166ff[_0x1b95('0x80')]=_0x3a1674[_0x1b95('0x587')];_0x4166ff[_0x1b95('0x3bc')]=function(_0x5b870e,_0x14a754){return _0x3a1674['izwLu'](_0x5b870e,_0x14a754);};_0x4166ff[_0x1b95('0x325')]=function(_0x6c5526,_0x2c34e5){return _0x3a1674[_0x1b95('0x672')](_0x6c5526,_0x2c34e5);};_0x4166ff[_0x1b95('0x64')]=function(_0x288afa,_0x1637ed){return _0x3a1674['tiNcZ'](_0x288afa,_0x1637ed);};_0x4166ff[_0x1b95('0x645')]=function(_0x2a6491,_0x4d1b37){return _0x2a6491==_0x4d1b37;};_0x4166ff[_0x1b95('0xc5')]=function(_0x53a923,_0x2a7ab2){return _0x3a1674[_0x1b95('0x3f3')](_0x53a923,_0x2a7ab2);};_0x4166ff[_0x1b95('0x463')]=function(_0x343af4,_0x44549d){return _0x3a1674[_0x1b95('0x14e')](_0x343af4,_0x44549d);};_0x4166ff[_0x1b95('0x605')]=function(_0x2f00b7,_0x450306){return _0x3a1674['kAqxV'](_0x2f00b7,_0x450306);};_0x4166ff[_0x1b95('0x461')]=_0x3a1674[_0x1b95('0x6d3')];_0x4166ff[_0x1b95('0x1b1')]=_0x3a1674[_0x1b95('0x52a')];_0x4166ff[_0x1b95('0x204')]=function(_0x522446,_0x3e1fb9){return _0x3a1674[_0x1b95('0x164')](_0x522446,_0x3e1fb9);};_0x4166ff['Abjlk']=_0x3a1674[_0x1b95('0x42f')];_0x4166ff['DtzZY']=function(_0x2b5d03,_0x1a8df5){return _0x2b5d03-_0x1a8df5;};_0x4166ff[_0x1b95('0x681')]=_0x1b95('0x5b8');_0x4166ff[_0x1b95('0x31')]=_0x3a1674[_0x1b95('0x18')];_0x4166ff[_0x1b95('0x178')]=function(_0xf02b15,_0x3b39ab){return _0x3a1674['vTTtQ'](_0xf02b15,_0x3b39ab);};_0x4166ff['cdvAm']=_0x3a1674[_0x1b95('0x90')];_0x4166ff[_0x1b95('0x3d1')]=function(_0x1d168c,_0x30bd48){return _0x1d168c===_0x30bd48;};_0x4166ff[_0x1b95('0x39')]=_0x3a1674[_0x1b95('0x69')];_0x4166ff[_0x1b95('0x15b')]=_0x3a1674[_0x1b95('0x2d2')];_0x4166ff[_0x1b95('0x33f')]=_0x3a1674[_0x1b95('0x1a9')];_0x4166ff['ZvYhr']=function(_0x134656,_0x23356f){return _0x134656===_0x23356f;};_0x4166ff[_0x1b95('0x201')]=_0x3a1674[_0x1b95('0x555')];_0x4166ff[_0x1b95('0x6f2')]=function(_0x500de8,_0x316f86){return _0x3a1674[_0x1b95('0x646')](_0x500de8,_0x316f86);};_0x4166ff[_0x1b95('0x40e')]='zLUta';_0x4166ff[_0x1b95('0x27a')]=_0x3a1674[_0x1b95('0x235')];_0x4166ff[_0x1b95('0x73')]=_0x1b95('0x559');_0x4166ff[_0x1b95('0x4fa')]=_0x3a1674['DApUO'];_0x4166ff['iNIMX']=function(_0x36c362,_0x292d59){return _0x3a1674[_0x1b95('0x42')](_0x36c362,_0x292d59);};_0x4166ff[_0x1b95('0x5d7')]=_0x3a1674[_0x1b95('0x1e9')];_0x4166ff['ooPzD']=function(_0x88059,_0x118535){return _0x3a1674[_0x1b95('0x42')](_0x88059,_0x118535);};_0x4166ff[_0x1b95('0x5fe')]=_0x1b95('0x2e');_0x4166ff[_0x1b95('0x223')]=function(_0x49e5eb,_0x2a0f3a){return _0x3a1674[_0x1b95('0x3f3')](_0x49e5eb,_0x2a0f3a);};_0x4166ff[_0x1b95('0x27b')]=function(_0x571244,_0xd221e4){return _0x3a1674[_0x1b95('0x3f3')](_0x571244,_0xd221e4);};_0x4166ff[_0x1b95('0x3d7')]=function(_0x256291,_0x4465e4){return _0x256291(_0x4465e4);};_0x4166ff[_0x1b95('0x5ee')]=function(_0x4a46a5,_0x516485){return _0x3a1674['xahUT'](_0x4a46a5,_0x516485);};_0x4166ff['qKhoz']=function(_0x3c280c){return _0x3a1674[_0x1b95('0x648')](_0x3c280c);};_0x4166ff[_0x1b95('0x4d9')]=function(_0x15cc6d){return _0x3a1674[_0x1b95('0x648')](_0x15cc6d);};_0x4166ff['awxAy']=_0x3a1674['EJUxD'];_0x4166ff[_0x1b95('0x31b')]=_0x3a1674['GbgMr'];_0x4166ff[_0x1b95('0x264')]=_0x3a1674[_0x1b95('0x6a1')];_0x4166ff[_0x1b95('0x6b')]=_0x3a1674[_0x1b95('0x60a')];_0x4166ff[_0x1b95('0x1fa')]=function(_0x1d8111,_0x4d4149){return _0x3a1674[_0x1b95('0x445')](_0x1d8111,_0x4d4149);};_0x4166ff[_0x1b95('0x30a')]=_0x3a1674[_0x1b95('0x5e')];_0x4166ff['ACjZO']=_0x1b95('0x48');_0x4166ff[_0x1b95('0x6cc')]=function(_0x3f40ea,_0x3d473e){return _0x3a1674[_0x1b95('0x1e6')](_0x3f40ea,_0x3d473e);};_0x4166ff[_0x1b95('0x2b')]=_0x3a1674[_0x1b95('0x280')];_0x4166ff[_0x1b95('0x4b5')]=function(_0x2aff32,_0x2ffeb5){return _0x2aff32(_0x2ffeb5);};_0x4166ff[_0x1b95('0x694')]=_0x1b95('0x426');_0x4166ff['dACTb']=function(_0x4ba569,_0x2b977f){return _0x3a1674[_0x1b95('0x3e1')](_0x4ba569,_0x2b977f);};_0x4166ff[_0x1b95('0x43b')]=_0x3a1674['xvcul'];_0x4166ff['WvrEN']=_0x1b95('0x47e');_0x4166ff[_0x1b95('0x4ce')]=function(_0x59c8ac,_0x48b571){return _0x59c8ac>_0x48b571;};_0x4166ff['LSIzW']=_0x3a1674[_0x1b95('0x58c')];_0x4166ff[_0x1b95('0x5d3')]=_0x3a1674[_0x1b95('0x531')];_0x4166ff[_0x1b95('0x643')]=_0x1b95('0x59d');_0x4166ff[_0x1b95('0x1dc')]=function(_0x9640c8){return _0x9640c8();};_0x4166ff[_0x1b95('0x518')]=function(_0x220b15,_0xee7519){return _0x220b15(_0xee7519);};_0x4166ff[_0x1b95('0x187')]=_0x3a1674[_0x1b95('0x5c9')];_0x4166ff[_0x1b95('0x113')]=_0x3a1674[_0x1b95('0x385')];_0x4166ff['ovEWe']=_0x3a1674[_0x1b95('0x89')];_0x4166ff[_0x1b95('0x118')]=_0x3a1674['PaGBS'];_0x4166ff['jtTfL']=function(_0x30e69e,_0xfb2579,_0x741483){return _0x3a1674[_0x1b95('0x191')](_0x30e69e,_0xfb2579,_0x741483);};_0x4166ff[_0x1b95('0x2ac')]=_0x1b95('0x232');_0x4166ff[_0x1b95('0x2a4')]=function(_0x5123d6,_0x28385c){return _0x3a1674[_0x1b95('0x3fd')](_0x5123d6,_0x28385c);};_0x4166ff[_0x1b95('0x384')]='checked';_0x4166ff[_0x1b95('0x245')]=_0x1b95('0x1df');_0x4166ff[_0x1b95('0x4ca')]=function(_0x4f967b,_0x19ff5e){return _0x3a1674[_0x1b95('0x4ad')](_0x4f967b,_0x19ff5e);};_0x4166ff[_0x1b95('0x2eb')]=_0x3a1674[_0x1b95('0x2c')];_0x4166ff[_0x1b95('0x4d1')]=function(_0x493521,_0x18bdc9){return _0x3a1674['KAfrY'](_0x493521,_0x18bdc9);};_0x4166ff[_0x1b95('0x8f')]=_0x1b95('0x51');_0x4166ff[_0x1b95('0x31f')]=_0x1b95('0x2b6');_0x4166ff[_0x1b95('0xb4')]=_0x1b95('0x591');_0x4166ff[_0x1b95('0x568')]=_0x3a1674[_0x1b95('0x47d')];_0x4166ff[_0x1b95('0x5bf')]=_0x3a1674['NDAGu'];_0x4166ff['OqpzS']=_0x3a1674['RVbYF'];_0x4166ff[_0x1b95('0x630')]=_0x3a1674[_0x1b95('0x4a5')];_0x4166ff[_0x1b95('0x23a')]=function(_0xbc5e07,_0x4cafd6){return _0x3a1674[_0x1b95('0x3fd')](_0xbc5e07,_0x4cafd6);};_0x4166ff['NLWwy']=_0x3a1674[_0x1b95('0x3de')];_0x4166ff[_0x1b95('0x533')]=_0x3a1674[_0x1b95('0x3a')];_0x4166ff[_0x1b95('0x5b0')]=function(_0x3d815e,_0x5d7ebd){return _0x3a1674['DiOuc'](_0x3d815e,_0x5d7ebd);};_0x4166ff['vfNRf']=_0x3a1674['rbUaB'];_0x4166ff[_0x1b95('0x35e')]=function(_0x2a0365,_0x18febb){return _0x2a0365>=_0x18febb;};_0x4166ff[_0x1b95('0x6b0')]=function(_0x50a767,_0xd59e8c){return _0x3a1674[_0x1b95('0x42')](_0x50a767,_0xd59e8c);};_0x4166ff['choOf']=_0x3a1674['hAqCH'];_0x4166ff[_0x1b95('0x148')]=_0x3a1674[_0x1b95('0x3f1')];_0x4166ff['JoDOj']=_0x3a1674[_0x1b95('0x5be')];_0x4166ff[_0x1b95('0x622')]=function(_0x4213e8,_0x5957c4){return _0x3a1674[_0x1b95('0x138')](_0x4213e8,_0x5957c4);};_0x4166ff[_0x1b95('0x234')]=_0x3a1674[_0x1b95('0x617')];_0x4166ff[_0x1b95('0x203')]=_0x1b95('0x2fa');_0x4166ff['QTfSu']=_0x3a1674[_0x1b95('0x56b')];_0x4166ff[_0x1b95('0x60')]=_0x3a1674[_0x1b95('0xb0')];_0x4166ff[_0x1b95('0x462')]=_0x3a1674['Dbege'];_0x4166ff['ATsJe']=_0x3a1674[_0x1b95('0x56c')];_0x4166ff[_0x1b95('0xf4')]=_0x3a1674[_0x1b95('0x1e3')];_0x4166ff[_0x1b95('0xc8')]=_0x3a1674[_0x1b95('0x356')];_0x4166ff[_0x1b95('0x6b4')]=_0x3a1674['PWRQI'];_0x4166ff[_0x1b95('0x2a5')]=_0x3a1674[_0x1b95('0x4b2')];_0x4166ff[_0x1b95('0x35f')]=_0x3a1674[_0x1b95('0x38e')];_0x4166ff['zFrmH']=function(_0x3f2487,_0x3d638f){return _0x3a1674[_0x1b95('0x64d')](_0x3f2487,_0x3d638f);};_0x4166ff['BSpSC']=_0x3a1674[_0x1b95('0x3bd')];_0x4166ff['OwVPP']=_0x3a1674[_0x1b95('0x268')];_0x4166ff[_0x1b95('0x593')]=_0x1b95('0xae');_0x4166ff['fSava']=_0x3a1674[_0x1b95('0x2f7')];_0x4166ff[_0x1b95('0x1ee')]=_0x3a1674[_0x1b95('0x3ab')];_0x4166ff[_0x1b95('0x678')]=_0x1b95('0x42d');_0x4166ff[_0x1b95('0x247')]=function(_0x4cbd7b,_0x248e5c){return _0x4cbd7b>_0x248e5c;};_0x4166ff[_0x1b95('0x41d')]=_0x3a1674[_0x1b95('0xf6')];_0x4166ff['eBZfc']=_0x3a1674[_0x1b95('0x492')];_0x4166ff['otxJs']=_0x3a1674[_0x1b95('0x146')];_0x4166ff[_0x1b95('0x438')]=_0x3a1674[_0x1b95('0x0')];_0x4166ff['pXDfj']=_0x3a1674['CiFBY'];_0x4166ff[_0x1b95('0x43a')]=function(_0x3d9941,_0x5a4cc8){return _0x3a1674[_0x1b95('0x347')](_0x3d9941,_0x5a4cc8);};_0x4166ff[_0x1b95('0x2e8')]='❌\x20TurnstileManager\x20不存在';_0x4166ff[_0x1b95('0x353')]=_0x3a1674['bhrfW'];_0x4166ff['jIgdd']=_0x3a1674['RjUzs'];_0x4166ff[_0x1b95('0x1c')]=function(_0x1f9f89,_0x48592b){return _0x3a1674['ntMmF'](_0x1f9f89,_0x48592b);};_0x4166ff['RdoFw']=function(_0x54c6bc,_0x15df2d){return _0x3a1674[_0x1b95('0x302')](_0x54c6bc,_0x15df2d);};_0x4166ff['waNml']=_0x3a1674[_0x1b95('0x69d')];_0x4166ff[_0x1b95('0x3a2')]=function(_0x3be2e5,_0x2d9d0a){return _0x3a1674[_0x1b95('0x64d')](_0x3be2e5,_0x2d9d0a);};_0x4166ff['mdBCV']=_0x3a1674[_0x1b95('0x20b')];_0x4166ff[_0x1b95('0x5f6')]=_0x1b95('0x576');_0x4166ff[_0x1b95('0x10')]=_0x3a1674[_0x1b95('0x21c')];_0x4166ff[_0x1b95('0x689')]=function(_0x12e6c9,_0x59fc4d){return _0x12e6c9(_0x59fc4d);};_0x4166ff['hedWs']=function(_0x6023e,_0x51f43a){return _0x3a1674[_0x1b95('0x3fd')](_0x6023e,_0x51f43a);};_0x4166ff[_0x1b95('0x2ad')]=function(_0x5d88e8,_0x3f5313){return _0x3a1674[_0x1b95('0x64d')](_0x5d88e8,_0x3f5313);};_0x4166ff['DSAwT']=_0x3a1674[_0x1b95('0x5a0')];_0x4166ff[_0x1b95('0x34b')]=function(_0x3bfc7b,_0x194417){return _0x3a1674[_0x1b95('0x83')](_0x3bfc7b,_0x194417);};_0x4166ff['wGtCw']=_0x3a1674['BOFps'];_0x4166ff[_0x1b95('0x23')]=function(_0x46ed70,_0x1f6967){return _0x3a1674[_0x1b95('0x83')](_0x46ed70,_0x1f6967);};_0x4166ff[_0x1b95('0x390')]=_0x3a1674[_0x1b95('0x2e9')];_0x4166ff[_0x1b95('0x690')]=function(_0x216ba7,_0x1c4362){return _0x216ba7(_0x1c4362);};_0x4166ff[_0x1b95('0x5fa')]='#autoDropwrap\x20.buy-code-link';_0x4166ff[_0x1b95('0x397')]=function(_0x1ef233,_0x5574bc){return _0x3a1674['QNQIO'](_0x1ef233,_0x5574bc);};_0x4166ff['taMWx']=_0x3a1674[_0x1b95('0x2d8')];_0x4166ff[_0x1b95('0x6c8')]=function(_0x129b3b,_0x3229af){return _0x129b3b||_0x3229af;};_0x4166ff[_0x1b95('0x476')]=_0x1b95('0xdc');_0x4166ff[_0x1b95('0x246')]=_0x3a1674[_0x1b95('0x395')];_0x4166ff[_0x1b95('0x2bf')]=function(_0x1530d2,_0x335d7e){return _0x3a1674[_0x1b95('0x1e6')](_0x1530d2,_0x335d7e);};_0x4166ff[_0x1b95('0x52c')]=_0x3a1674[_0x1b95('0x6d6')];_0x4166ff[_0x1b95('0x471')]=_0x3a1674[_0x1b95('0x30d')];_0x4166ff[_0x1b95('0x48f')]=function(_0xedb4fd){return _0x3a1674[_0x1b95('0x648')](_0xedb4fd);};_0x4166ff[_0x1b95('0x3fc')]=function(_0x306f14,_0x4d2a04,_0x3f0b41){return _0x306f14(_0x4d2a04,_0x3f0b41);};_0x4166ff[_0x1b95('0x42b')]=_0x3a1674[_0x1b95('0x44e')];_0x4166ff[_0x1b95('0x93')]=_0x3a1674[_0x1b95('0x26e')];_0x4166ff['KGZIy']=function(_0x1944ec){return _0x3a1674[_0x1b95('0x648')](_0x1944ec);};_0x4166ff[_0x1b95('0x22f')]=function(_0x2c925a,_0x487645){return _0x3a1674['KAfrY'](_0x2c925a,_0x487645);};_0x4166ff[_0x1b95('0x639')]=_0x3a1674[_0x1b95('0x169')];_0x4166ff[_0x1b95('0x228')]=_0x1b95('0x5b3');_0x4166ff[_0x1b95('0x6e')]=_0x3a1674[_0x1b95('0x127')];_0x4166ff[_0x1b95('0x66e')]=_0x3a1674['NCzvq'];_0x4166ff[_0x1b95('0x15f')]=function(_0x24dc36,_0x5f0a8b){return _0x3a1674[_0x1b95('0x23c')](_0x24dc36,_0x5f0a8b);};_0x4166ff[_0x1b95('0x2da')]=_0x3a1674['YptmX'];_0x4166ff['MJnFa']=_0x1b95('0xba');_0x4166ff[_0x1b95('0x684')]='text/css';_0x4166ff['nutKW']=function(_0xb9b35d,_0x4a390){return _0xb9b35d===_0x4a390;};_0x4166ff[_0x1b95('0x4b9')]=_0x3a1674[_0x1b95('0x537')];_0x4166ff[_0x1b95('0x60e')]=_0x3a1674['MHjSp'];_0x4166ff[_0x1b95('0x6a8')]=function(_0x129244,_0xc9de5c){return _0x3a1674[_0x1b95('0x44b')](_0x129244,_0xc9de5c);};_0x4166ff[_0x1b95('0x449')]=_0x1b95('0x117');_0x4166ff[_0x1b95('0x1cc')]=_0x1b95('0x39e');_0x4166ff[_0x1b95('0x667')]=function(_0x452a83,_0x2b3593){return _0x3a1674[_0x1b95('0x44b')](_0x452a83,_0x2b3593);};_0x4166ff[_0x1b95('0x558')]=_0x3a1674[_0x1b95('0x114')];_0x4166ff[_0x1b95('0x490')]=_0x1b95('0x1aa');_0x4166ff[_0x1b95('0x43e')]=function(_0x14e665,_0x3dc99b,_0x378e72){return _0x3a1674[_0x1b95('0x598')](_0x14e665,_0x3dc99b,_0x378e72);};_0x4166ff[_0x1b95('0x615')]=_0x3a1674['tkdwV'];_0x4166ff[_0x1b95('0xd0')]=_0x1b95('0x668');_0x4166ff[_0x1b95('0x2a2')]=function(_0x3f5426,_0x26dd0a){return _0x3a1674[_0x1b95('0x1e6')](_0x3f5426,_0x26dd0a);};_0x4166ff[_0x1b95('0x34f')]=_0x3a1674[_0x1b95('0x481')];_0x4166ff[_0x1b95('0x251')]=_0x3a1674[_0x1b95('0x446')];_0x4166ff[_0x1b95('0x44c')]=_0x3a1674[_0x1b95('0x46f')];const _0x1cde53=_0x4166ff;const _0xfa63df={};_0xfa63df[_0x1b95('0x5ca')]=![];_0xfa63df[_0x1b95('0x284')]=GM_info[_0x1b95('0x6c')]['version'];_0xfa63df[_0x1b95('0x612')]=GM_info['script'][_0x1b95('0x620')];_0xfa63df[_0x1b95('0x163')]=_0x3a1674['bsJsf'](window['location']['origin'][_0x1b95('0x450')](_0x1b95('0x6be')),-0x1)?_0x3a1674['JGUso']:_0x3a1674[_0x1b95('0x3a9')];_0xfa63df[_0x1b95('0x67c')]=_0x1b95('0x57a');_0xfa63df[_0x1b95('0x2b2')]=window['location'][_0x1b95('0x649')];_0xfa63df[_0x1b95('0x2ae')]=_0x3a1674['bsJsf'](window['location'][_0x1b95('0x5b6')]['indexOf'](_0x3a1674[_0x1b95('0x613')]),-0x1)?'zh':'en';_0xfa63df[_0x1b95('0x1d6')]=_0x3a1674['cQcVg'];_0xfa63df[_0x1b95('0x180')]=_0x1b95('0x4f1');_0xfa63df[_0x1b95('0x205')]=_0x3a1674['vVfik'];_0xfa63df['userSettingStoreKey']=_0x3a1674[_0x1b95('0x374')];_0xfa63df[_0x1b95('0x3fe')]=0x64;_0xfa63df[_0x1b95('0x46d')]=_0x3a1674[_0x1b95('0x4e5')](0xf,0x3e8);_0xfa63df[_0x1b95('0x8d')]=0xc8;_0xfa63df[_0x1b95('0x3e2')]=0x32;_0xfa63df[_0x1b95('0x31d')]=_0x3a1674['Ggjri'](0x3*0x3c,0x3e8);const _0x3a2889=_0xfa63df;_0x3a2889[_0x1b95('0x2be')]=_0x3a2889[_0x1b95('0x5ca')]?_0x1b95('0xb8'):_0x1b95('0x9');_0x3a2889['apiUrl']=_0x3a2889[_0x1b95('0x5ca')]?_0x3a1674['TTgCp']:_0x3a1674[_0x1b95('0x373')];const _0x14a192={};_0x14a192[_0x1b95('0x41e')]=[_0x3a1674[_0x1b95('0x2c6')],'Daily2',_0x3a1674[_0x1b95('0x2b5')],_0x3a1674[_0x1b95('0x61d')],_0x1b95('0x22e'),_0x1b95('0xbb'),_0x3a1674[_0x1b95('0x6e6')]];_0x14a192[_0x1b95('0x336')]=![];_0x14a192[_0x1b95('0x1c8')]=_0x3a1674[_0x1b95('0x36f')];const _0x4fbd8b=Object['freeze'](_0x14a192);const _0x1d5109=Object[_0x1b95('0x32e')]([_0x3a1674['amQum'],'eth',_0x3a1674['PRkbu'],_0x3a1674[_0x1b95('0x36f')],_0x3a1674[_0x1b95('0x5cb')],_0x1b95('0x4ed'),_0x1b95('0x371'),_0x1b95('0x674'),_0x3a1674[_0x1b95('0x4ff')],_0x3a1674['DXBBk'],_0x3a1674['tbeqB'],_0x3a1674['lIQHY'],_0x3a1674[_0x1b95('0x2c8')],_0x3a1674[_0x1b95('0x60f')],_0x3a1674[_0x1b95('0x84')],_0x3a1674['gSaSf'],_0x3a1674[_0x1b95('0x4f3')]]);const _0x4cb310=Object[_0x1b95('0x32e')]([_0x3a1674[_0x1b95('0x411')],_0x3a1674[_0x1b95('0x1f3')]]);function _0x25c684(_0x436f45){if(!Array[_0x1b95('0x4c4')](_0x436f45))return[];return Array[_0x1b95('0x15c')](new Set(_0x436f45[_0x1b95('0x72')](_0x13d040=>String(_0x13d040||'')[_0x1b95('0x9c')]()[_0x1b95('0x30e')]())[_0x1b95('0x1fd')](Boolean)))[_0x1b95('0x399')]();}function _0x5a02fa(){if(_0x3a1674[_0x1b95('0x67')](_0x1b95('0x271'),_0x3a1674[_0x1b95('0x3')])){_0x2714b3[_0x1b95('0x1d4')](code,!!option);}else{return _0x3a1674[_0x1b95('0x67')](_0x3a2889[_0x1b95('0x163')],_0x3a1674[_0x1b95('0x47a')])?_0x4cb310:_0x1d5109;}}function _0x16213a(){if(_0x1cde53[_0x1b95('0x604')](_0x1b95('0x1bd'),_0x1cde53['UbwqM'])){return _0x1b600['availableCurrencies'][_0x1b95('0xb')]?_0x1b600[_0x1b95('0x491')]:_0x1cde53[_0x1b95('0xd8')](_0x5a02fa);}else{throw new Error(_0x1b95('0x2cd')+response[_0x1b95('0x9d')]+']\x20'+_0x1b600[_0x1b95('0x49d')][_0x1b95('0x12a')]);}}function _0x3e8e62(_0x1a8de9){if(_0x3a1674[_0x1b95('0x25e')](typeof _0x1a8de9,_0x3a1674[_0x1b95('0x544')])){return _0x1a8de9;}if(_0x1a8de9&&_0x3a1674[_0x1b95('0x25e')](_0x1a8de9[_0x1b95('0x620')],_0x3a1674['FNVgV'])){return'Request\x20timeout\x20after\x20'+_0x3a2889[_0x1b95('0x46d')]+'ms';}return _0x1a8de9&&_0x1a8de9[_0x1b95('0x4d7')]?_0x1a8de9[_0x1b95('0x4d7')]:_0x3a1674['GynRd'];}const _0x57abb7={};_0x57abb7['amount']=0x0;_0x57abb7[_0x1b95('0x1c8')]='';const _0x7cec17={};_0x7cec17[_0x1b95('0x58d')]='';_0x7cec17[_0x1b95('0x311')]=null;const _0x232f87={};_0x232f87[_0x1b95('0x218')]=![];_0x232f87['dropCompleted']=!![];_0x232f87[_0x1b95('0x5af')]='';_0x232f87[_0x1b95('0x440')]=[];_0x232f87[_0x1b95('0x2a1')]=new Set();_0x232f87['availableCurrencies']=[];_0x232f87[_0x1b95('0x49d')]=null;_0x232f87[_0x1b95('0x1bf')]='';_0x232f87[_0x1b95('0x35c')]='';_0x232f87[_0x1b95('0xdb')]=_0x3a2889['defaultTipName'];_0x232f87[_0x1b95('0x26a')]=_0x3a2889[_0x1b95('0x180')];_0x232f87['ucurl']=_0x3a2889[_0x1b95('0x205')];_0x232f87['socket']=null;_0x232f87[_0x1b95('0x57a')]=null;_0x232f87['currency']='';_0x232f87[_0x1b95('0x1eb')]='';_0x232f87[_0x1b95('0x393')]=_0x57abb7;_0x232f87['userSetInfo']=null;_0x232f87['redeemForm']=_0x7cec17;_0x232f87[_0x1b95('0x40c')]=null;_0x232f87['wsV3CryptoKey']=null;_0x232f87[_0x1b95('0x448')]=null;_0x232f87[_0x1b95('0x3e5')]=null;const _0x1b600=_0x232f87;function _0x24224b(){if(_0x3a1674['HXvga'](_0x3a1674[_0x1b95('0x348')],_0x3a1674[_0x1b95('0x348')])){if(!_0x3a2889[_0x1b95('0x5ca')])return;console[_0x1b95('0xe3')]['apply'](console,arguments);}else{if(this['isRunning']){return;}const _0x156590=_0x1f175d[_0x1b95('0x7e')]();if(!_0x156590){return;}this[_0x1b95('0x539')](_0x156590);}}function _0x3b4923(_0x597483){const _0x48e73a={};_0x48e73a[_0x1b95('0x514')]=_0x1cde53[_0x1b95('0x99')];const _0x4bf090=_0x48e73a;const _0x3fd20d=_0x1cde53[_0x1b95('0x695')](atob,_0x597483);const _0x2cc928=new Uint8Array(_0x3fd20d['length']);for(let _0x26e5ef=0x0;_0x1cde53['JcDoJ'](_0x26e5ef,_0x3fd20d[_0x1b95('0xb')]);_0x26e5ef++){if(_0x1cde53['yOmoD'](_0x1b95('0x86'),_0x1b95('0x623'))){_0x2cc928[_0x26e5ef]=_0x3fd20d[_0x1b95('0x3bb')](_0x26e5ef);}else{codeType=_0x4bf090['lFhJe'];}}return _0x2cc928;}async function _0x481ead(_0x1169b4){const _0x356bd3=_0x3a1674['dwgBI'](_0x3b4923,_0x1169b4);return crypto[_0x1b95('0x33d')][_0x1b95('0xa8')](_0x3a1674[_0x1b95('0x372')],_0x356bd3,{'name':_0x3a1674[_0x1b95('0x5ea')]},![],[_0x3a1674[_0x1b95('0x50b')]]);}async function _0x4cc091(_0x2583b2){if(!_0x2583b2||!_0x2583b2['enabled']||!_0x2583b2[_0x1b95('0x405')]){_0x1b600[_0x1b95('0x40c')]=null;_0x1b600[_0x1b95('0x60d')]=null;_0x1b600[_0x1b95('0x448')]=null;return![];}if(_0x1b600[_0x1b95('0x60d')]&&_0x1b600[_0x1b95('0x40c')]&&_0x1b600[_0x1b95('0x40c')][_0x1b95('0x27')]===_0x2583b2[_0x1b95('0x27')]){return!![];}_0x1b600[_0x1b95('0x40c')]=_0x2583b2;_0x1b600[_0x1b95('0x448')]=_0x481ead(_0x2583b2['key'])['then'](_0x12c71e=>{const _0x24c815={};_0x24c815['aGVsV']=function(_0x3f6610,_0x3e2bf4){return _0x1cde53['AFnOc'](_0x3f6610,_0x3e2bf4);};const _0x1c6482=_0x24c815;if(_0x1cde53[_0x1b95('0x524')]===_0x1cde53[_0x1b95('0x611')]){_0x1c6482[_0x1b95('0x149')](_0x2032dd,data);}else{_0x1b600[_0x1b95('0x60d')]=_0x12c71e;return!![];}})[_0x1b95('0x451')](_0x5251cf=>{_0x1b600[_0x1b95('0x60d')]=null;_0x1b600[_0x1b95('0x40c')]=null;_0x1b600['wsV3KeyInitPromise']=null;throw _0x5251cf;});return _0x1b600['wsV3KeyInitPromise'];}async function _0x5ddc47(_0x577a38){const _0x5afc05={};_0x5afc05[_0x1b95('0x631')]=function(_0x3b7934,_0x5ee357){return _0x3a1674[_0x1b95('0x13f')](_0x3b7934,_0x5ee357);};const _0x2dcdf2=_0x5afc05;if(_0x3a1674[_0x1b95('0x25e')]('rqaEk',_0x3a1674['LvVtl'])){_0x1b600['userSetInfo']=_0x2dcdf2['wyCKr'](_0x22a752,userConfig);}else{if(!_0x577a38||!_0x577a38['iv']||!_0x577a38['ct']){throw new Error(_0x3a1674['ZHWMC']);}if(!_0x1b600[_0x1b95('0x60d')]){if(_0x3a1674[_0x1b95('0x12c')]!==_0x3a1674[_0x1b95('0x12c')]){return![];}else{if(!_0x1b600[_0x1b95('0x448')]){throw new Error(_0x1b95('0x233'));}await _0x1b600[_0x1b95('0x448')];}}const _0x9bff12=_0x3a1674[_0x1b95('0x13f')](_0x3b4923,_0x577a38['iv']);const _0x534e52=_0x3b4923(_0x577a38['ct']);const _0x5e0b14={};_0x5e0b14['name']=_0x3a1674[_0x1b95('0x5ea')];_0x5e0b14['iv']=_0x9bff12;const _0x2d4585=await crypto[_0x1b95('0x33d')][_0x1b95('0x48c')](_0x5e0b14,_0x1b600['wsV3CryptoKey'],_0x534e52);return JSON[_0x1b95('0x2c2')](new TextDecoder()['decode'](new Uint8Array(_0x2d4585)));}}const _0x141a03={};_0x141a03[_0x1b95('0x618')]=_0x3b4923;_0x141a03[_0x1b95('0x140')]=_0x481ead;_0x141a03['initWsV3Key']=_0x4cc091;_0x141a03['decryptWsV3Message']=_0x5ddc47;const _0x57c694=_0x141a03;class _0x1239dc{constructor(){this['siteKey']=_0x3a1674[_0x1b95('0x307')];this[_0x1b95('0x606')]=null;this[_0x1b95('0x226')]=[];this[_0x1b95('0x341')]=0x3;this[_0x1b95('0x16d')]=0x2;this[_0x1b95('0x5c')]=0x1;this[_0x1b95('0x6c2')]=![];this[_0x1b95('0x76')]=_0x3a1674['CRzIe'](0xb4,0x3e8);this[_0x1b95('0x91')]=0x11d*0x3e8;this[_0x1b95('0x4e3')]=null;this[_0x1b95('0x41c')]=0xf*0x3e8;this[_0x1b95('0x5e6')]=0x1f4;this[_0x1b95('0x595')]=_0x3a1674[_0x1b95('0x2bc')](0x2d,0x3e8);this[_0x1b95('0x1cb')]=0x0;this[_0x1b95('0xe5')]=null;this[_0x1b95('0x546')]=null;this['createTokenPromise']=null;this['isGenerating']=![];this[_0x1b95('0x1bc')]=![];}async[_0x1b95('0x55f')](){if(_0x1cde53[_0x1b95('0x256')](_0x1cde53['MiCRB'],_0x1cde53['UUjbh'])){clearTimeout(timeoutId);}else{if(this[_0x1b95('0x6c2')])return;try{const _0x275cf4='0|4|3|2|1'[_0x1b95('0x416')]('|');let _0x1c81b8=0x0;while(!![]){switch(_0x275cf4[_0x1c81b8++]){case'0':await this[_0x1b95('0x4d')]();continue;case'1':if(_0x1b600[_0x1b95('0x2df')]&&_0x1b600[_0x1b95('0x2df')][_0x1b95('0x637')]){this['startTokenMaintenance']();}continue;case'2':_0x1cde53[_0x1b95('0x78')](_0x24224b,_0x1b95('0x4c2'));continue;case'3':this[_0x1b95('0x6c2')]=!![];continue;case'4':if(!unsafeWindow[_0x1b95('0x19e')]){throw new Error(_0x1cde53['EgqRc']);}continue;}break;}}catch(_0x21a2fb){console[_0x1b95('0x3e3')](_0x21a2fb);_0x2e4293(_0x1b95('0xc1'));}}}['updateTurboState'](_0x4e4a15){const _0x4ce355=_0x1cde53[_0x1b95('0x24c')](_0x3bd8cd,_0x1cde53['SxNbs']);let _0x2cfb2d=_0x4e4a15?_0x1cde53['Zdmrp']:_0x1cde53[_0x1b95('0x332')];_0x4ce355['css'](_0x1cde53['ihDAh'],_0x2cfb2d);}[_0x1b95('0x4d')](_0x38d698,_0x3d11f2){const _0x3199a1={};_0x3199a1[_0x1b95('0x580')]=function(_0x2019be,_0x3793fa){return _0x2019be!==_0x3793fa;};_0x3199a1[_0x1b95('0x6d7')]=_0x1cde53[_0x1b95('0x1c7')];_0x3199a1[_0x1b95('0x30')]=_0x1cde53[_0x1b95('0x52d')];_0x3199a1[_0x1b95('0x16e')]=_0x1cde53[_0x1b95('0x242')];_0x3199a1['hDYvM']=_0x1cde53[_0x1b95('0x1af')];_0x3199a1['qVOIJ']=_0x1cde53[_0x1b95('0xa2')];_0x3199a1[_0x1b95('0x5c3')]=_0x1cde53[_0x1b95('0x553')];const _0x5aa4b1=_0x3199a1;if(_0x1cde53[_0x1b95('0x222')]!==_0x1cde53['hagxO']){_0x1b600[_0x1b95('0x3e5')][_0x1b95('0x5a2')]();}else{return new Promise((_0x1b46af,_0xb860a4)=>{const _0x525243={};_0x525243[_0x1b95('0x2dc')]=function(_0x13974c,_0x12f320){return _0x13974c+_0x12f320;};_0x525243[_0x1b95('0x412')]=function(_0x2a77df){return _0x2a77df();};_0x525243[_0x1b95('0x248')]=function(_0x4edd2a,_0x54f726){return _0x5aa4b1[_0x1b95('0x580')](_0x4edd2a,_0x54f726);};_0x525243[_0x1b95('0x601')]=_0x5aa4b1['uoBvB'];_0x525243['lMcYF']=_0x5aa4b1['aICYT'];_0x525243['DlQIZ']=function(_0x5a9fc4,_0x515d8a){return _0x5a9fc4-_0x515d8a;};const _0x1a26fa=_0x525243;let _0x5e7520=Date[_0x1b95('0x5bc')]();const _0x202454=document['createElement'](_0x5aa4b1[_0x1b95('0x16e')]);_0x202454['setAttribute']('id',_0x5aa4b1[_0x1b95('0x1e1')]);_0x202454['src']=_0x5aa4b1[_0x1b95('0x66')];_0x202454[_0x1b95('0xdd')]=_0x5aa4b1[_0x1b95('0x5c3')];_0x202454[_0x1b95('0x23e')]=()=>{let _0x53cfeb=Date[_0x1b95('0x5bc')]();_0x24224b(_0x1a26fa[_0x1b95('0x2dc')](_0x1b95('0x317'),_0x53cfeb-_0x5e7520));_0x1a26fa['wRdVV'](_0x1b46af);};_0x202454['onerror']=_0x2e9972=>{if(_0x1a26fa[_0x1b95('0x248')](_0x1a26fa['wwsAe'],_0x1a26fa[_0x1b95('0x601')])){return![];}else{let _0x4bef22=Date[_0x1b95('0x5bc')]();console[_0x1b95('0x3e3')](_0x1a26fa[_0x1b95('0x121')]+_0x1a26fa[_0x1b95('0x3c2')](_0x4bef22,_0x5e7520),_0x2e9972);_0x202454[_0x1b95('0x286')]();_0xb860a4();}};document[_0x1b95('0x18f')][_0x1b95('0x5a9')](_0x202454);});}}async[_0x1b95('0x4f7')](){const _0x1a5c8d={};_0x1a5c8d[_0x1b95('0x29e')]=function(_0x24cd9f,_0x501354){return _0x1cde53[_0x1b95('0x520')](_0x24cd9f,_0x501354);};_0x1a5c8d[_0x1b95('0x4c6')]=function(_0x49d079,_0x29e854){return _0x1cde53['uhfKB'](_0x49d079,_0x29e854);};_0x1a5c8d[_0x1b95('0x430')]=function(_0x5052b6,_0x29dd00){return _0x1cde53['JgCMb'](_0x5052b6,_0x29dd00);};_0x1a5c8d['dwZQC']=_0x1cde53['JTUIu'];_0x1a5c8d[_0x1b95('0x335')]=function(_0x3ed6ba,_0x3f7919){return _0x3ed6ba(_0x3f7919);};_0x1a5c8d['DMEGk']=function(_0xd8b565,_0x285446){return _0x1cde53['JgCMb'](_0xd8b565,_0x285446);};_0x1a5c8d[_0x1b95('0x4c0')]=_0x1cde53[_0x1b95('0x4fd')];_0x1a5c8d[_0x1b95('0x550')]=_0x1cde53[_0x1b95('0xdf')];_0x1a5c8d['VpGka']='Turnstile\x20container\x20unavailable.';_0x1a5c8d['IqZyH']=_0x1cde53['tMePD'];_0x1a5c8d[_0x1b95('0x6f0')]=function(_0x16d00a,_0xba59e){return _0x1cde53[_0x1b95('0x24c')](_0x16d00a,_0xba59e);};const _0x18c4ba=_0x1a5c8d;if(this[_0x1b95('0x625')]){return this[_0x1b95('0x625')];}this['isGenerating']=!![];this['createTokenPromise']=new Promise((_0x271605,_0x5e157b)=>{const _0x1945ca={};_0x1945ca[_0x1b95('0x641')]=_0x1b95('0x54d');_0x1945ca[_0x1b95('0x6a7')]=function(_0x65da54,_0x150cf0){return _0x18c4ba[_0x1b95('0x335')](_0x65da54,_0x150cf0);};_0x1945ca[_0x1b95('0x394')]=function(_0x8cf971,_0x47af84){return _0x18c4ba['EHqIK'](_0x8cf971,_0x47af84);};_0x1945ca['SESSD']=_0x1b95('0x569');const _0x4ef675=_0x1945ca;if(_0x18c4ba[_0x1b95('0x523')]('xGixu',_0x18c4ba['JRdqd'])){codeType=_0x4ef675['gmMFO'];}else{try{const _0x1b1993=document[_0x1b95('0x186')](_0x18c4ba[_0x1b95('0x550')]);if(!_0x1b1993){throw new Error(_0x18c4ba[_0x1b95('0x6e5')]);}this['remove']();const _0x1917e7={};_0x1917e7['sitekey']=this[_0x1b95('0x61f')];_0x1917e7[_0x1b95('0x5b2')]=_0x18c4ba['IqZyH'];_0x1917e7[_0x1b95('0x150')]=_0x3a2889['locale'];_0x1917e7[_0x1b95('0xc4')]=_0x2d963c=>{this[_0x1b95('0x97')]=![];this[_0x1b95('0x625')]=null;_0x4ef675[_0x1b95('0x6a7')](_0x271605,_0x2d963c);};_0x1917e7[_0x1b95('0x651')]=_0x2c4268=>{const _0x1e4bbb={};_0x1e4bbb[_0x1b95('0x318')]=function(_0x3dc33c,_0x43a54c){return _0x18c4ba[_0x1b95('0x29e')](_0x3dc33c,_0x43a54c);};_0x1e4bbb[_0x1b95('0x5ba')]=function(_0x4ff82f,_0x2f86dd){return _0x18c4ba[_0x1b95('0x4c6')](_0x4ff82f,_0x2f86dd);};const _0x920563=_0x1e4bbb;if(_0x18c4ba[_0x1b95('0x430')](_0x1b95('0x5d8'),_0x18c4ba[_0x1b95('0x33b')])){const _0x5578cf=document[_0x1b95('0x548')][_0x1b95('0x416')](';\x20');for(let _0x470b77=0x0;_0x920563[_0x1b95('0x318')](_0x470b77,_0x5578cf[_0x1b95('0xb')]);_0x470b77++){const _0x5a91f7=_0x5578cf[_0x470b77][_0x1b95('0x416')]('=');if(_0x920563['QFAyR'](_0x5a91f7[0x0],name)){return _0x5a91f7[0x1];}}return null;}else{this[_0x1b95('0x97')]=![];this[_0x1b95('0x625')]=null;_0x18c4ba[_0x1b95('0x335')](_0x5e157b,_0x2c4268);}};_0x1917e7[_0x1b95('0x3a6')]=()=>{this['isGenerating']=![];this[_0x1b95('0x625')]=null;_0x4ef675[_0x1b95('0x394')](_0x5e157b,_0x4ef675[_0x1b95('0x259')]);};const _0x5895c4=_0x1917e7;this[_0x1b95('0x606')]=unsafeWindow[_0x1b95('0x19e')][_0x1b95('0x47c')](_0x1b1993,_0x5895c4);}catch(_0x30c6d4){this[_0x1b95('0x97')]=![];this[_0x1b95('0x625')]=null;_0x18c4ba[_0x1b95('0x6f0')](_0x5e157b,_0x30c6d4);}}});return this[_0x1b95('0x625')];}async[_0x1b95('0x160')](){const _0x214681={};_0x214681[_0x1b95('0x4ba')]=_0x1cde53[_0x1b95('0x59a')];_0x214681[_0x1b95('0x6b9')]=function(_0x30f39a,_0xe22dd1,_0xc2e83){return _0x30f39a(_0xe22dd1,_0xc2e83);};_0x214681[_0x1b95('0x609')]=_0x1b95('0x54');const _0x544c64=_0x214681;if(_0x1cde53[_0x1b95('0x67e')](_0x1cde53[_0x1b95('0x47')],_0x1cde53[_0x1b95('0x32d')])){if(this['createTokenPromise']||this[_0x1b95('0x97')]){return null;}try{const _0x245da5=await this[_0x1b95('0x4f7')]();const _0x5c23b={};_0x5c23b[_0x1b95('0x71')]=_0x245da5;_0x5c23b['timestamp']=Date[_0x1b95('0x5bc')]();const _0x2ed39a=_0x5c23b;this[_0x1b95('0x226')][_0x1b95('0x7b')](_0x2ed39a);this['sortTokenCache']();this[_0x1b95('0x499')](!![]);this[_0x1b95('0x286')]();return _0x2ed39a;}catch(_0x316b20){if(this[_0x1b95('0x226')][_0x1b95('0xb')]==0x0){this[_0x1b95('0x499')](![]);}this[_0x1b95('0x286')]();return null;}}else{const _0x4f4267={};_0x4f4267['pEAhJ']=function(_0x348eb7,_0x204996,_0x18e52f){return _0x544c64[_0x1b95('0x6b9')](_0x348eb7,_0x204996,_0x18e52f);};_0x4f4267['TWbws']=_0x544c64[_0x1b95('0x609')];const _0x5d8526=_0x4f4267;_0x57c694[_0x1b95('0x6a9')](data[_0x1b95('0x2e6')])[_0x1b95('0x460')](_0x22537f=>{_0x5d8526[_0x1b95('0x60c')](_0x69b627,_0x22537f,_0x5d8526[_0x1b95('0x2f9')]);})[_0x1b95('0x451')](_0x143fba=>{console[_0x1b95('0x3e3')](_0x544c64[_0x1b95('0x4ba')],_0x143fba,data[_0x1b95('0x2e6')]);});}}[_0x1b95('0x1ba')](_0xd2a105){return new Promise(_0x4b7d66=>setTimeout(_0x4b7d66,_0xd2a105));}['getTokenAge'](_0x5a8a54,_0x284dad=Date[_0x1b95('0x5bc')]()){return _0x1cde53[_0x1b95('0x2d1')](_0x284dad,_0x5a8a54[_0x1b95('0x28a')]);}[_0x1b95('0x603')](_0x1fe4f5,_0x191ddb=Date['now']()){return _0x3a1674[_0x1b95('0x320')](this[_0x1b95('0x19c')](_0x1fe4f5,_0x191ddb),this[_0x1b95('0x76')]);}[_0x1b95('0x513')](_0x3b5883,_0x37e861=Date[_0x1b95('0x5bc')]()){return _0x3a1674[_0x1b95('0x320')](this[_0x1b95('0x19c')](_0x3b5883,_0x37e861),this[_0x1b95('0x91')]);}[_0x1b95('0x46e')](){this[_0x1b95('0x226')][_0x1b95('0x399')]((_0x3f0362,_0x5b84d7)=>_0x3f0362[_0x1b95('0x28a')]-_0x5b84d7[_0x1b95('0x28a')]);}[_0x1b95('0x608')](_0x52af6c=Date[_0x1b95('0x5bc')]()){if(_0x3a1674[_0x1b95('0x25e')](_0x3a1674[_0x1b95('0x94')],'nalwY')){return this[_0x1b95('0x226')][_0x1b95('0x1fd')](_0x2376db=>this[_0x1b95('0x603')](_0x2376db,_0x52af6c))[_0x1b95('0xb')];}else{const _0x4ff0b2=_0x1b600[_0x1b95('0x440')][_0x1b95('0x172')]();if(_0x4ff0b2){this[_0x1b95('0x24')][_0x1b95('0x49e')](_0x4ff0b2);}}}[_0x1b95('0x4e9')](_0x41f755=Date[_0x1b95('0x5bc')]()){return this[_0x1b95('0x608')](_0x41f755)>0x0;}[_0x1b95('0x2f6')](_0x55fa4b=Date[_0x1b95('0x5bc')]()){const _0x396370={};_0x396370[_0x1b95('0x15d')]=function(_0x221ba0,_0x3f8c75){return _0x1cde53[_0x1b95('0x28d')](_0x221ba0,_0x3f8c75);};_0x396370['REfaR']=_0x1cde53['HoaUp'];_0x396370[_0x1b95('0x4')]=function(_0x4cea03,_0x4a4cd9){return _0x1cde53[_0x1b95('0x655')](_0x4cea03,_0x4a4cd9);};_0x396370['mrizw']=function(_0x4dd650,_0x1b4149){return _0x1cde53[_0x1b95('0x520')](_0x4dd650,_0x1b4149);};_0x396370['pXUZB']=_0x1b95('0x671');_0x396370[_0x1b95('0x10b')]=_0x1cde53[_0x1b95('0x366')];_0x396370[_0x1b95('0x68e')]=function(_0x534d99,_0x1a31de){return _0x534d99(_0x1a31de);};_0x396370[_0x1b95('0x2af')]=_0x1cde53[_0x1b95('0x6ad')];const _0xd7a32=_0x396370;if(_0x1cde53['pQBVE'](_0x1cde53[_0x1b95('0x3dd')],_0x1cde53[_0x1b95('0x410')])){if(!this[_0x1b95('0x226')][_0x1b95('0xb')]){if(_0x1cde53[_0x1b95('0x444')](_0x1cde53[_0x1b95('0x289')],_0x1cde53[_0x1b95('0x565')])){let _0x26a7f9='';if(_0xd7a32['JXtxF'](balance,1.5)){_0x26a7f9=_0xd7a32[_0x1b95('0x3d8')];}else if(_0xd7a32['YanMR'](balance,1.5)&&_0xd7a32[_0x1b95('0x17')](balance,0x3)){_0x26a7f9=_0xd7a32[_0x1b95('0x29d')];}else{_0x26a7f9=_0xd7a32[_0x1b95('0x10b')];}_0xd7a32[_0x1b95('0x68e')](_0x3bd8cd,_0xd7a32['uBFGd'])[_0x1b95('0x35')](_0x1b95('0x3d5')+_0x26a7f9+'\x22>'+balance+_0x1b95('0x29f'));}else{return null;}}this['sortTokenCache']();const _0x84498a=this[_0x1b95('0x226')][_0x1b95('0x329')](_0x4394b2=>!this[_0x1b95('0x603')](_0x4394b2,_0x55fa4b));if(_0x84498a>=0x0){if(_0x1cde53[_0x1b95('0x38f')]===_0x1cde53[_0x1b95('0x4ac')]){_0xc7958f['logger'](_0x1b95('0x21e')+_0x1b600[_0x1b95('0x49d')][errType]);}else{return this[_0x1b95('0x226')][_0x1b95('0x283')](_0x84498a,0x1)[0x0];}}return this[_0x1b95('0x226')][_0x1b95('0x155')]();}else{this['updateTurboState'](![]);}}[_0x1b95('0x334')](_0x2ed236=Date['now']()){const _0x39812b={};_0x39812b[_0x1b95('0x2b8')]=function(_0x40f71e,_0x5460e4){return _0x3a1674[_0x1b95('0x13f')](_0x40f71e,_0x5460e4);};_0x39812b[_0x1b95('0x2b1')]=_0x3a1674[_0x1b95('0x2aa')];const _0x2fb5f2=_0x39812b;this['sortTokenCache']();const _0x1bfe2a=this[_0x1b95('0x226')][_0x1b95('0x329')](_0x3994fa=>this[_0x1b95('0x603')](_0x3994fa,_0x2ed236));if(_0x3a1674[_0x1b95('0x480')](_0x1bfe2a,0x0)){return![];}if(_0x3a1674[_0x1b95('0x624')](this[_0x1b95('0x226')]['length'],this['minReserveTokens'])){if(_0x3a1674[_0x1b95('0x633')](_0x3a1674[_0x1b95('0x48e')],_0x3a1674['zyZCW'])){return![];}else{try{const _0x1b63e9=_0x2fb5f2[_0x1b95('0x2b8')](_0x174826,_0x2fb5f2[_0x1b95('0x2b1')]);if(_0x1b63e9){return _0x1b63e9;}throw new Error('GET_SESSION_ERROR:\x20'+_0x1b600['i18n'][_0x1b95('0x19d')]);}catch(_0x125d48){throw new Error(_0x1b95('0x502')+_0x125d48[_0x1b95('0x4d7')]+'\x20'+_0x1b600[_0x1b95('0x49d')][_0x1b95('0x19d')]);}}}this['tokenCache'][_0x1b95('0x283')](_0x1bfe2a,0x1);return!![];}async[_0x1b95('0x274')](_0x2a4819){const _0x5e3b59={};_0x5e3b59[_0x1b95('0x212')]=function(_0xdbdb0f,_0x4fbbdd){return _0xdbdb0f(_0x4fbbdd);};const _0x181702=_0x5e3b59;const _0x16e322=Math[_0x1b95('0x5e8')](0x0,Math[_0x1b95('0x6de')](_0x2a4819,this['maxCacheSize']));while(this[_0x1b95('0x226')][_0x1b95('0xb')]<_0x16e322){const _0x3f8a3d=await this['generateCacheToken']();if(!_0x3f8a3d){if(_0x1cde53[_0x1b95('0x5dc')](_0x1b95('0x4da'),_0x1b95('0x4da'))){break;}else{_0x181702[_0x1b95('0x212')](_0x3bd8cd,_0x1b95('0x6cb'))[_0x1b95('0x1da')]();}}if(_0x1cde53[_0x1b95('0x5c1')](this[_0x1b95('0x226')][_0x1b95('0xb')],_0x16e322)){if(_0x1cde53[_0x1b95('0x75')](_0x1cde53[_0x1b95('0x1ec')],_0x1b95('0x50'))){_0xc7958f[_0x1b95('0x105')](Number(data[_0x1b95('0x2e6')][_0x1b95('0xbc')](0x2)));return;}else{await this[_0x1b95('0x1ba')](this[_0x1b95('0x5e6')]);}}}this[_0x1b95('0x499')](_0x1cde53[_0x1b95('0x655')](this[_0x1b95('0x226')]['length'],0x0));}async['replaceSoftExpiredTokens'](){if(_0x1cde53[_0x1b95('0x331')]!==_0x1cde53[_0x1b95('0x331')]){let _0x13d16e=Date[_0x1b95('0x5bc')]();console['error'](_0x1cde53[_0x1b95('0x40d')](_0x1cde53[_0x1b95('0x52d')],_0x1cde53[_0x1b95('0x2d1')](_0x13d16e,s_time)),error);r[_0x1b95('0x286')]();reject();}else{let _0x32e224=0x0;while(_0x1cde53['IckIG'](this[_0x1b95('0x226')]['length'],this[_0x1b95('0x341')])&&this[_0x1b95('0x4e9')]()){const _0x2ace0c=await this[_0x1b95('0x160')]();if(!_0x2ace0c){if(_0x1cde53[_0x1b95('0x67e')](_0x1cde53['fUoco'],_0x1cde53[_0x1b95('0x597')])){const _0x11032b={};_0x11032b[_0x1b95('0x28')]=function(_0x2467ff,_0x348500){return _0x1cde53['sTcUe'](_0x2467ff,_0x348500);};_0x11032b[_0x1b95('0x14c')]=function(_0x33a7f7,_0x1cf606){return _0x1cde53[_0x1b95('0x2d1')](_0x33a7f7,_0x1cf606);};_0x11032b[_0x1b95('0xe9')]=_0x1cde53[_0x1b95('0x5f8')];_0x11032b['ZEHYQ']=_0x1b95('0x1b');_0x11032b['igoEL']=function(_0x638ea4,_0x129e12){return _0x1cde53[_0x1b95('0x95')](_0x638ea4,_0x129e12);};_0x11032b[_0x1b95('0x2cf')]=function(_0x177049,_0x1fcc8c){return _0x1cde53[_0x1b95('0x5aa')](_0x177049,_0x1fcc8c);};_0x11032b[_0x1b95('0x57f')]=function(_0x1eae8d,_0x47cda6){return _0x1cde53[_0x1b95('0x350')](_0x1eae8d,_0x47cda6);};const _0x195a8e=_0x11032b;manager[_0x1b95('0x226')][_0x1b95('0x5d9')]((_0x524e05,_0x381a27)=>{const _0x11aeee=now-_0x524e05[_0x1b95('0x28a')];const _0x492b7a=Math[_0x1b95('0x14')](_0x195a8e[_0x1b95('0x28')](_0x11aeee,0x3e8));const _0x5c540f=Math[_0x1b95('0x5e8')](0x0,Math[_0x1b95('0x14')](_0x195a8e[_0x1b95('0x28')](_0x195a8e[_0x1b95('0x14c')](manager[_0x1b95('0x91')],_0x11aeee),0x3e8)));let _0x16b4e8=_0x195a8e['UGJuu'];if(manager[_0x1b95('0x513')](_0x524e05,now)){_0x16b4e8=_0x195a8e[_0x1b95('0x467')];}else if(manager['isSoftExpired'](_0x524e05,now)){_0x16b4e8=_0x1b95('0x389');}console[_0x1b95('0xe3')](_0x1b95('0x43d')+_0x381a27+']:');console['log'](_0x1b95('0x1e4')+_0x524e05[_0x1b95('0x71')][_0x1b95('0xb')]);console['log'](_0x1b95('0x383')+_0x492b7a+'秒\x20('+Math[_0x1b95('0x14')](_0x195a8e[_0x1b95('0x211')](_0x492b7a,0x3c))+'分'+_0x195a8e['kjcoY'](_0x492b7a,0x3c)+'秒)');console[_0x1b95('0xe3')](_0x1b95('0x4e')+_0x5c540f+_0x1b95('0x5bd')+Math['floor'](_0x195a8e[_0x1b95('0x57f')](_0x5c540f,0x3c))+'分'+_0x5c540f%0x3c+'秒)');console[_0x1b95('0xe3')]('\x20\x20\x20状态:\x20'+_0x16b4e8);});}else{break;}}if(!this[_0x1b95('0x334')]()){break;}_0x32e224+=0x1;if(this[_0x1b95('0x4e9')]()){if(_0x1cde53['pQBVE'](_0x1cde53[_0x1b95('0x112')],_0x1cde53[_0x1b95('0x26d')])){await this[_0x1b95('0x1ba')](this[_0x1b95('0x5e6')]);}else{return _0x1b600[_0x1b95('0x440')][_0x1b95('0x5ef')]();}}}return _0x32e224;}}async[_0x1b95('0x1c1')](){if(_0x1cde53['BYryO'](_0x1cde53[_0x1b95('0x81')],_0x1cde53[_0x1b95('0x81')])){_0xc7958f['logger'](error[_0x1b95('0x4d7')]);}else{if(this[_0x1b95('0x1bc')]){return;}this[_0x1b95('0x1bc')]=!![];try{await this[_0x1b95('0x4eb')]();}finally{if(_0x1cde53[_0x1b95('0x525')](_0x1b95('0x475'),_0x1cde53[_0x1b95('0xc2')])){return this['tokenCache'][_0x1b95('0x283')](freshIndex,0x1)[0x0];}else{this[_0x1b95('0x1bc')]=![];}}}}['scheduleRefill'](_0x1678b4=0x0){if(_0x3a1674[_0x1b95('0x5f3')]!==_0x3a1674[_0x1b95('0x5f3')]){if(!task||!task[_0x1b95('0x6bf')]){return null;}return Math[_0x1b95('0x5e8')](0x0,_0x1cde53[_0x1b95('0x2d1')](Date[_0x1b95('0x5bc')](),task[_0x1b95('0x6bf')]));}else{if(this[_0x1b95('0x546')]){return;}this[_0x1b95('0x546')]=_0x3a1674[_0x1b95('0x1ad')](setTimeout,async()=>{this[_0x1b95('0x546')]=null;if(!this[_0x1b95('0x6c2')]){return;}await this[_0x1b95('0x1c1')]();},_0x1678b4);}}[_0x1b95('0x4ab')](){const _0x1a1941={};_0x1a1941['LkQym']=function(_0x3ce5e0,_0x175aec){return _0x1cde53[_0x1b95('0x24c')](_0x3ce5e0,_0x175aec);};_0x1a1941[_0x1b95('0x61b')]=_0x1cde53['LSdVx'];const _0x5d4970=_0x1a1941;if(_0x1cde53[_0x1b95('0x50d')](_0x1cde53[_0x1b95('0x58e')],_0x1cde53[_0x1b95('0x58e')])){return _0x1b600[_0x1b95('0x440')][_0x1b95('0xb')]?_0x1b600[_0x1b95('0x440')][0x0]:'';}else{if(this[_0x1b95('0xe5')]){if(_0x1cde53[_0x1b95('0x590')](_0x1cde53[_0x1b95('0x45f')],_0x1cde53['JTzbG'])){return;}else{_0x1b600['availableCurrencies']=_0x5d4970[_0x1b95('0x154')](_0x25c684,loginInfo[_0x1b95('0x452')]);_0xc7958f[_0x1b95('0x3b8')](_0x1b600[_0x1b95('0x491')]);}}if(_0x1cde53[_0x1b95('0x28d')](this[_0x1b95('0x341')],this[_0x1b95('0x16d')])){if(_0x1b95('0x4cd')===_0x1cde53['WZcQd']){this['fullCacheAllowedAt']=0x0;return;}else{throw new Error(_0x5d4970['GxFUK']);}}this['fullCacheAllowedAt']=_0x1cde53[_0x1b95('0x231')](Date['now'](),this[_0x1b95('0x595')]);this[_0x1b95('0xe5')]=_0x1cde53[_0x1b95('0x4ec')](setTimeout,async()=>{if(_0x1cde53[_0x1b95('0x525')](_0x1b95('0x561'),_0x1cde53['ITnGV'])){this['warmupTimer']=null;if(!this[_0x1b95('0x6c2')]){return;}await this[_0x1b95('0x1c1')]();}else{console['log'](error);}},this['staggeredWarmupDelayMs']);}}async['getToken'](){this[_0x1b95('0x386')]();const _0x2994df=this[_0x1b95('0x2f6')]();if(_0x2994df){this[_0x1b95('0x499')](_0x1cde53[_0x1b95('0x655')](this[_0x1b95('0x226')]['length'],0x0));this[_0x1b95('0x354')](this['generationSpacingMs']);return _0x2994df['token'];}try{this[_0x1b95('0x499')](![]);const _0x3dd0c2=await this[_0x1b95('0x4f7')]();this[_0x1b95('0x286')]();this['scheduleRefill'](this[_0x1b95('0x5e6')]);return _0x3dd0c2;}catch(_0x17fe46){this[_0x1b95('0x286')]();throw _0x17fe46;}}['cleanExpiredTokens'](){if(_0x3a1674[_0x1b95('0x3b0')](_0x1b95('0x29c'),_0x3a1674[_0x1b95('0x300')])){const _0x138c63=Date[_0x1b95('0x5bc')]();this[_0x1b95('0x226')]=this[_0x1b95('0x226')][_0x1b95('0x1fd')](_0x4a980f=>!this[_0x1b95('0x513')](_0x4a980f,_0x138c63));this[_0x1b95('0x46e')]();}else{_0xc7958f[_0x1b95('0x23b')](''+errMsg);}}async[_0x1b95('0x4eb')](){if(_0x1cde53[_0x1b95('0x244')](_0x1b95('0x4d6'),_0x1cde53[_0x1b95('0x48d')])){if(!this[_0x1b95('0x6c2')]){return;}this[_0x1b95('0x386')]();const _0x55b63c=Date[_0x1b95('0x5bc')]();const _0x12b338=!this[_0x1b95('0x1cb')]||_0x1cde53['tUooz'](_0x55b63c,this['fullCacheAllowedAt']);const _0x3f83d0=_0x12b338?this['maxCacheSize']:this[_0x1b95('0x16d')];if(_0x1cde53[_0x1b95('0x5c1')](this['tokenCache'][_0x1b95('0xb')],_0x3f83d0)){if(_0x1cde53[_0x1b95('0x265')](_0x1cde53[_0x1b95('0x15a')],_0x1cde53[_0x1b95('0x15a')])){dropConfig[_0x1b95('0x283')](dropConfig[_0x1b95('0x450')](value),0x1);}else{await this[_0x1b95('0x274')](_0x3f83d0);}}if(_0x1cde53[_0x1b95('0x156')](this['tokenCache'][_0x1b95('0xb')],this['maxCacheSize'])&&this[_0x1b95('0x4e9')](_0x55b63c)){await this[_0x1b95('0x2ea')]();}if(_0x1cde53[_0x1b95('0x5c1')](this[_0x1b95('0x226')][_0x1b95('0xb')],_0x3f83d0)&&this[_0x1b95('0x4e9')](_0x55b63c)){await this[_0x1b95('0x274')](_0x3f83d0);}this['updateTurboState'](_0x1cde53[_0x1b95('0x3cf')](this[_0x1b95('0x226')][_0x1b95('0xb')],0x0));}else{this[_0x1b95('0x24')][_0x1b95('0x49e')](removed);}}[_0x1b95('0x5a2')](){const _0x71c8={};_0x71c8['lPQuG']=function(_0x3f00c4,_0x29d97e){return _0x1cde53[_0x1b95('0x49c')](_0x3f00c4,_0x29d97e);};_0x71c8['PcyCr']=_0x1cde53['PiPLh'];_0x71c8[_0x1b95('0x11b')]=_0x1cde53[_0x1b95('0xcd')];_0x71c8[_0x1b95('0x287')]=function(_0x4f7bb5,_0x3f0ae8,_0x22e4d6){return _0x1cde53[_0x1b95('0x4ec')](_0x4f7bb5,_0x3f0ae8,_0x22e4d6);};const _0x255fdc=_0x71c8;if(this[_0x1b95('0x4e3')]){_0x1cde53[_0x1b95('0x24c')](_0x24224b,_0x1b95('0x32'));return;}_0x1cde53[_0x1b95('0x24c')](_0x24224b,_0x1cde53[_0x1b95('0x134')]);this[_0x1b95('0x354')](0x0);this[_0x1b95('0x4ab')]();const _0x79a595=async()=>{if(_0x255fdc['lPQuG'](_0x1b95('0x687'),_0x255fdc[_0x1b95('0x74')])){nextConfig[_0x1b95('0x336')]=_0x4fbd8b[_0x1b95('0x336')];}else{if(!this[_0x1b95('0x4e3')]){if(_0x255fdc[_0x1b95('0x11b')]!==_0x255fdc['mdGDo']){return![];}else{return;}}await this[_0x1b95('0x1c1')]();this[_0x1b95('0x4e3')]=_0x255fdc[_0x1b95('0x287')](setTimeout,_0x79a595,this[_0x1b95('0x41c')]);}};this[_0x1b95('0x4e3')]=_0x1cde53[_0x1b95('0x4ec')](setTimeout,_0x79a595,this[_0x1b95('0x41c')]);}[_0x1b95('0x53e')](){if(_0x1b95('0x5df')!==_0x1cde53[_0x1b95('0x6d5')]){return!![];}else{if(this['maintenanceTimer']){_0x1cde53[_0x1b95('0x2e0')](clearTimeout,this['maintenanceTimer']);this[_0x1b95('0x4e3')]=null;_0x24224b(_0x1cde53[_0x1b95('0x213')]);}else{_0x1cde53['LnMxZ'](_0x24224b,_0x1cde53[_0x1b95('0x464')]);}if(this[_0x1b95('0xe5')]){if(_0x1cde53[_0x1b95('0xa5')](_0x1b95('0x53'),_0x1cde53[_0x1b95('0x3c5')])){_0x1cde53['QBIrZ'](clearTimeout,this[_0x1b95('0xe5')]);this['warmupTimer']=null;}else{try{unsafeWindow['turnstile'][_0x1b95('0x286')](this[_0x1b95('0x606')]);console[_0x1b95('0xe3')](_0x1cde53[_0x1b95('0x24f')]);}catch(_0x4b73be){console[_0x1b95('0x3e3')](_0x1cde53[_0x1b95('0x27d')],_0x4b73be);}this[_0x1b95('0x606')]=null;}}this[_0x1b95('0x1cb')]=0x0;if(this[_0x1b95('0x546')]){clearTimeout(this[_0x1b95('0x546')]);this[_0x1b95('0x546')]=null;}}}[_0x1b95('0x286')](){if(_0x1cde53[_0x1b95('0xa5')](this[_0x1b95('0x606')],null)){try{unsafeWindow['turnstile']['remove'](this[_0x1b95('0x606')]);this[_0x1b95('0x606')]=null;}catch(_0x4a0323){console[_0x1b95('0x3e3')](_0x1cde53[_0x1b95('0x5a')],_0x4a0323);}}}[_0x1b95('0x519')](){if(_0x3a1674[_0x1b95('0x633')](_0x3a1674[_0x1b95('0x199')],_0x3a1674[_0x1b95('0x199')])){return![];}else{this['stopTokenMaintenance']();if(_0x3a1674[_0x1b95('0x1b5')](this[_0x1b95('0x606')],null)){try{if(_0x3a1674[_0x1b95('0x281')]===_0x3a1674[_0x1b95('0x281')]){unsafeWindow[_0x1b95('0x19e')]['remove'](this['widgetId']);console[_0x1b95('0xe3')](_0x3a1674['WZBSz']);}else{return null;}}catch(_0x571ea0){console[_0x1b95('0x3e3')](_0x1b95('0x2de'),_0x571ea0);}this['widgetId']=null;}this[_0x1b95('0x226')]=[];this[_0x1b95('0x6c2')]=![];this['createTokenPromise']=null;console[_0x1b95('0xe3')](_0x3a1674[_0x1b95('0x2c1')]);}}}async function _0x29fc76(_0xf98b10){const _0x14bd49={};_0x14bd49[_0x1b95('0x43')]='📭\x20缓存为空';const _0x162bd4=_0x14bd49;if(_0x1cde53['DoRAL'](_0x1cde53['KtOMJ'],_0x1cde53[_0x1b95('0x240')])){clearTimeout(_0x454220['activeTimer']);_0x454220[_0x1b95('0x344')]=null;}else{const _0x4e8af9={};_0x4e8af9[_0x1b95('0x1bf')]=_0xf98b10;_0x4e8af9['platform']=_0x3a2889[_0x1b95('0x163')];_0x4e8af9['version']=_0x3a2889[_0x1b95('0x284')];const _0x3084f0=_0x4e8af9;if(_0x1b600[_0x1b95('0x1eb')]){if(_0x1cde53[_0x1b95('0x2f2')](_0x1b95('0x11e'),_0x1cde53[_0x1b95('0x3ad')])){console[_0x1b95('0xe3')](_0x162bd4['lZQpQ']);}else{_0x3084f0[_0x1b95('0x1eb')]=_0x1b600['pid'];}}try{const _0x121cfc=await _0x1b600[_0x1b95('0x57a')][_0x1b95('0x1cd')](_0x3084f0);if(!_0x121cfc['ok']){throw new Error(_0x1b95('0x693')+_0x121cfc[_0x1b95('0x9d')]);}const _0x39c286=await _0x121cfc[_0x1b95('0x52e')]();if(_0x39c286[_0x1b95('0x6a6')]){_0x1b600['userToken']=_0x39c286[_0x1b95('0x505')];_0x1b600[_0x1b95('0xdb')]=_0x39c286['tipName']?_0x39c286[_0x1b95('0xdb')]:_0x3a2889['defaultTipName'];_0x1b600['telegramUrl']=_0x39c286[_0x1b95('0x586')]||_0x3a2889['defaultTelegramUrl'];_0x1b600['ucurl']=_0x39c286[_0x1b95('0x439')]||_0x3a2889[_0x1b95('0x205')];_0xc7958f[_0x1b95('0x4c8')]();const _0x2a21a9=_0x39c286[_0x1b95('0x452')];if(_0x2a21a9&&Array['isArray'](_0x2a21a9['list'])){if(_0x1cde53[_0x1b95('0x2f2')](_0x1cde53[_0x1b95('0x3a8')],_0x1cde53['iKTxr'])){amount=null;}else{_0x1b600[_0x1b95('0x491')]=_0x25c684(_0x2a21a9[_0x1b95('0x400')]);_0xc7958f[_0x1b95('0x3b8')](_0x1b600[_0x1b95('0x491')]);}}else if(Array[_0x1b95('0x4c4')](_0x39c286[_0x1b95('0x452')])){_0x1b600[_0x1b95('0x491')]=_0x1cde53[_0x1b95('0x56e')](_0x25c684,_0x39c286[_0x1b95('0x452')]);_0xc7958f[_0x1b95('0x3b8')](_0x1b600[_0x1b95('0x491')]);}try{await _0x57c694[_0x1b95('0x5ae')](_0x39c286[_0x1b95('0x3e4')]);}catch(_0x37289d){console[_0x1b95('0x3e3')](_0x1cde53['VRSRw'],_0x37289d);_0xc7958f[_0x1b95('0x23b')](_0x1cde53['UXWAZ']);}_0x27af6f['connect'](_0x1b600[_0x1b95('0x35c')]);}else{_0xc7958f[_0x1b95('0x23b')](_0x39c286[_0x1b95('0x4d7')]);}}catch(_0x1677c4){_0xc7958f[_0x1b95('0x23b')](_0x1677c4[_0x1b95('0x4d7')]+'\x20'+_0x1b600['i18n'][_0x1b95('0x19d')]);}}}function _0x10b0f7(_0x3ec2a3){const _0x523201={};_0x523201[_0x1b95('0x6d9')]=_0x1cde53[_0x1b95('0x5b5')];_0x523201['balance']=_0x1cde53[_0x1b95('0x2d7')];_0x523201[_0x1b95('0x1c8')]='币种';_0x523201[_0x1b95('0x7')]=_0x1b95('0x295');_0x523201[_0x1b95('0x33')]=_0x1b95('0x6a5');_0x523201[_0x1b95('0xf7')]=_0x1cde53[_0x1b95('0x4c1')];_0x523201[_0x1b95('0x3c0')]='您未达到兑换此代码所需的每周投注需求';_0x523201[_0x1b95('0xb6')]=_0x1cde53['lntdd'];_0x523201[_0x1b95('0x24a')]=_0x1cde53[_0x1b95('0x48a')];_0x523201[_0x1b95('0x4e7')]=_0x1cde53[_0x1b95('0x48a')];_0x523201['withdrawError']=_0x1cde53[_0x1b95('0x13d')];_0x523201['emailUnverified']=_0x1cde53[_0x1b95('0x406')];_0x523201['kycLevelNotSufficient']=_0x1cde53[_0x1b95('0x68c')];_0x523201[_0x1b95('0x100')]=_0x1b95('0x37c');_0x523201[_0x1b95('0x4a2')]={};_0x523201['claimStart']=_0x1cde53[_0x1b95('0x82')];_0x523201[_0x1b95('0x562')]=_0x1b95('0x58f');_0x523201[_0x1b95('0x31a')]=_0x1cde53[_0x1b95('0x6d2')];_0x523201[_0x1b95('0x39f')]=_0x1cde53[_0x1b95('0x59f')];_0x523201[_0x1b95('0x59e')]=_0x1cde53[_0x1b95('0x584')];_0x523201[_0x1b95('0x4e2')]=[_0x1b95('0x3e6'),_0x1b95('0x108'),_0x1cde53[_0x1b95('0x654')]];_0x523201[_0x1b95('0x4cb')]=_0x1cde53[_0x1b95('0x183')];_0x523201['tipIntro']=[_0x1cde53[_0x1b95('0x17d')],_0x1cde53[_0x1b95('0x696')],_0x1cde53[_0x1b95('0x658')]];_0x523201[_0x1b95('0x19d')]=_0x1cde53[_0x1b95('0x5c4')];_0x523201[_0x1b95('0x216')]=_0x1cde53[_0x1b95('0xcb')];_0x523201[_0x1b95('0x297')]='设置';_0x523201[_0x1b95('0x12a')]=_0x1cde53[_0x1b95('0x162')];_0x523201[_0x1b95('0x365')]=_0x1cde53['EikUt'];_0x523201['vaultText']=_0x1cde53['Sudwz'];_0x523201[_0x1b95('0x2ed')]=_0x1cde53[_0x1b95('0x16c')];_0x523201[_0x1b95('0x4a0')]=_0x1cde53[_0x1b95('0x67a')];_0x523201[_0x1b95('0x4a7')]=_0x1cde53['tPfkD'];_0x523201[_0x1b95('0x310')]=_0x1cde53[_0x1b95('0x141')];_0x523201[_0x1b95('0xbe')]=_0x1cde53[_0x1b95('0x484')];_0x523201[_0x1b95('0x252')]={};_0x523201['redeemTip']=_0x1b95('0x37d');_0x523201[_0x1b95('0x23d')]=_0x1cde53['DzYfA'];_0x523201[_0x1b95('0x189')]=_0x1cde53[_0x1b95('0x33e')];_0x523201[_0x1b95('0x143')]=_0x1cde53[_0x1b95('0xd7')];_0x523201[_0x1b95('0x252')][_0x1b95('0x58d')]=_0x1cde53[_0x1b95('0x465')];_0x523201[_0x1b95('0x252')][_0x1b95('0x311')]=_0x1cde53[_0x1b95('0x209')];_0x523201[_0x1b95('0x252')][_0x1b95('0x55d')]='充值';_0x523201[_0x1b95('0x252')][_0x1b95('0x1f5')]=_0x1b95('0x4d3');_0x523201[_0x1b95('0x252')][_0x1b95('0x507')]=_0x1cde53[_0x1b95('0x358')];_0x523201[_0x1b95('0x4a2')][_0x1b95('0x6de')]=_0x1cde53['iEWlL'];_0x523201[_0x1b95('0x4a2')][_0x1b95('0x628')]=_0x1cde53[_0x1b95('0x39c')];_0x523201[_0x1b95('0x4a2')]['getting']=_0x1b95('0x3ef');const _0xbdbb86=_0x523201;const _0xa5d8ce={};_0xa5d8ce[_0x1b95('0x6d9')]=_0x1cde53[_0x1b95('0x429')];_0xa5d8ce[_0x1b95('0x5d1')]=_0x1cde53[_0x1b95('0x6c4')];_0xa5d8ce['currency']=_0x1cde53[_0x1b95('0x6b3')];_0xa5d8ce['init']=_0x1cde53['VuMuC'];_0xa5d8ce[_0x1b95('0x33')]=_0x1cde53[_0x1b95('0x495')];_0xa5d8ce[_0x1b95('0xf7')]=_0x1cde53[_0x1b95('0x4d5')];_0xa5d8ce['weeklyWagerRequirement']=_0x1cde53[_0x1b95('0x137')];_0xa5d8ce[_0x1b95('0xb6')]=_0x1cde53[_0x1b95('0x1c2')];_0xa5d8ce[_0x1b95('0x24a')]=_0x1cde53[_0x1b95('0x1c2')];_0xa5d8ce['codeAlreadyRedeemed']=_0x1cde53[_0x1b95('0x5ab')];_0xa5d8ce[_0x1b95('0x1c6')]=_0x1cde53[_0x1b95('0x424')];_0xa5d8ce[_0x1b95('0x486')]=_0x1cde53[_0x1b95('0x13e')];_0xa5d8ce['kycLevelNotSufficient']='You\x20do\x20not\x20meet\x20the\x20required\x20verification\x20level\x20to\x20redeem\x20this\x20code.';_0xa5d8ce[_0x1b95('0x100')]=_0x1cde53[_0x1b95('0x333')];_0xa5d8ce[_0x1b95('0x4a2')]={};_0xa5d8ce[_0x1b95('0x381')]=_0x1cde53[_0x1b95('0x82')];_0xa5d8ce['claimSuccess']=_0x1cde53['WBuPu'];_0xa5d8ce[_0x1b95('0x31a')]=_0x1cde53[_0x1b95('0x343')];_0xa5d8ce[_0x1b95('0x39f')]=_0x1cde53[_0x1b95('0x45c')];_0xa5d8ce[_0x1b95('0x59e')]=_0x1b95('0x473');_0xa5d8ce[_0x1b95('0x4e2')]=['The\x20current\x20claimed\x20currency\x20is',_0x1b95('0x571'),_0x1cde53[_0x1b95('0x3dc')]];_0xa5d8ce[_0x1b95('0x4cb')]=_0x1cde53[_0x1b95('0x1e8')];_0xa5d8ce[_0x1b95('0x3a5')]=[_0x1cde53['tiHmk'],_0x1cde53[_0x1b95('0xbd')],_0x1cde53[_0x1b95('0x5e1')]];_0xa5d8ce[_0x1b95('0x19d')]=_0x1cde53['JNCTH'];_0xa5d8ce[_0x1b95('0x216')]=_0x1cde53[_0x1b95('0x3c7')];_0xa5d8ce[_0x1b95('0x297')]=_0x1cde53[_0x1b95('0x2d3')];_0xa5d8ce[_0x1b95('0x12a')]=_0x1cde53[_0x1b95('0x4e1')];_0xa5d8ce[_0x1b95('0x365')]=_0x1cde53['UThre'];_0xa5d8ce[_0x1b95('0x420')]=_0x1b95('0x1b0');_0xa5d8ce[_0x1b95('0x2ed')]=_0x1cde53['oNtgO'];_0xa5d8ce['claimCurrency']=_0x1cde53[_0x1b95('0x65b')];_0xa5d8ce[_0x1b95('0x4a7')]='Buy\x20recharge\x20code\x20on\x20website';_0xa5d8ce[_0x1b95('0x310')]=_0x1b95('0x225');_0xa5d8ce[_0x1b95('0xbe')]=_0x1cde53['QhMyt'];_0xa5d8ce[_0x1b95('0x252')]={};_0xa5d8ce[_0x1b95('0x51f')]=_0x1cde53[_0x1b95('0xf5')];_0xa5d8ce[_0x1b95('0x23d')]=_0x1cde53[_0x1b95('0x1d0')];_0xa5d8ce[_0x1b95('0x189')]=_0x1cde53['AmbGb'];_0xa5d8ce[_0x1b95('0x143')]=_0x1cde53[_0x1b95('0x1ff')];_0xa5d8ce[_0x1b95('0x252')][_0x1b95('0x58d')]=_0x1cde53[_0x1b95('0x478')];_0xa5d8ce[_0x1b95('0x252')][_0x1b95('0x311')]=_0x1cde53[_0x1b95('0x638')];_0xa5d8ce[_0x1b95('0x252')][_0x1b95('0x55d')]=_0x1cde53[_0x1b95('0x20c')];_0xa5d8ce[_0x1b95('0x252')][_0x1b95('0x1f5')]=_0x1cde53[_0x1b95('0x396')];_0xa5d8ce[_0x1b95('0x252')][_0x1b95('0x507')]=_0x1cde53[_0x1b95('0x96')];_0xa5d8ce[_0x1b95('0x4a2')][_0x1b95('0x6de')]=_0x1cde53[_0x1b95('0x37e')];_0xa5d8ce[_0x1b95('0x4a2')][_0x1b95('0x628')]='Please\x20select\x20currency.';_0xa5d8ce[_0x1b95('0x4a2')]['getting']=_0x1cde53[_0x1b95('0x50f')];const _0x51f73f=_0xa5d8ce;return _0x3ec2a3=='zh'?_0xbdbb86:_0x51f73f;}function _0x2cac17(){const _0x37b0e2={};_0x37b0e2['qUrWt']=_0x3a1674['oAouZ'];_0x37b0e2[_0x1b95('0x5a1')]=function(_0x29d672,_0x4217b4){return _0x3a1674[_0x1b95('0x3b0')](_0x29d672,_0x4217b4);};_0x37b0e2[_0x1b95('0x147')]=_0x3a1674[_0x1b95('0x18c')];_0x37b0e2[_0x1b95('0xe1')]=function(_0x3c1075,_0x5d88b6){return _0x3a1674[_0x1b95('0x65d')](_0x3c1075,_0x5d88b6);};_0x37b0e2[_0x1b95('0x3ba')]=_0x3a1674[_0x1b95('0x2c')];_0x37b0e2[_0x1b95('0x62c')]=function(_0x3d6d9b,_0x16a9c3){return _0x3d6d9b<_0x16a9c3;};_0x37b0e2[_0x1b95('0x269')]=function(_0x3062cf,_0x2562bc){return _0x3a1674['sayeQ'](_0x3062cf,_0x2562bc);};_0x37b0e2[_0x1b95('0x304')]=function(_0x41b34d,_0x2d90b1){return _0x41b34d(_0x2d90b1);};_0x37b0e2[_0x1b95('0x570')]=_0x3a1674[_0x1b95('0xf')];_0x37b0e2[_0x1b95('0x2d0')]=function(_0x281b81,_0x1d1aa3){return _0x281b81(_0x1d1aa3);};_0x37b0e2[_0x1b95('0x22b')]=function(_0x2838cf,_0x35f367){return _0x3a1674[_0x1b95('0x3c6')](_0x2838cf,_0x35f367);};_0x37b0e2[_0x1b95('0x133')]=function(_0x96c09d,_0x428552){return _0x96c09d(_0x428552);};_0x37b0e2[_0x1b95('0x4c3')]=function(_0x58fe4f,_0x435bd1){return _0x58fe4f||_0x435bd1;};_0x37b0e2[_0x1b95('0x6c5')]=function(_0x4f146a){return _0x3a1674[_0x1b95('0x1c4')](_0x4f146a);};_0x37b0e2[_0x1b95('0x174')]=function(_0x46e06f){return _0x3a1674['ASuWJ'](_0x46e06f);};_0x37b0e2[_0x1b95('0x63f')]=function(_0x2b788e,_0x13b68a){return _0x2b788e(_0x13b68a);};_0x37b0e2[_0x1b95('0x5f0')]=_0x3a1674[_0x1b95('0x11c')];_0x37b0e2[_0x1b95('0x67f')]=_0x3a1674[_0x1b95('0x267')];_0x37b0e2['Rnggt']=function(_0x5ad62c,_0x234a3c,_0x5d02ff){return _0x5ad62c(_0x234a3c,_0x5d02ff);};_0x37b0e2[_0x1b95('0x20a')]=_0x3a1674[_0x1b95('0x4af')];const _0x16d9af=_0x37b0e2;const _0xeb4f55=_0x3a1674[_0x1b95('0x3c6')](_0x3bd8cd,_0x3a1674[_0x1b95('0x33a')]);const _0x15868a=_0x3a1674[_0x1b95('0x3c6')](_0x3bd8cd,_0x3a1674[_0x1b95('0x1a4')]);const _0x51fb9f=_0x3a1674['LkFbc'](_0x3bd8cd,_0x3a1674['YPjQe']);_0xeb4f55[_0x1b95('0x578')](function(){_0x15868a[_0x1b95('0x1be')]();});_0x51fb9f[_0x1b95('0x578')](function(){_0x15868a[_0x1b95('0x1da')]();});const _0x49197a=_0x3bd8cd(_0x3a1674['LHrDz']);const _0xf77759=_0x3a1674[_0x1b95('0x403')](_0x3bd8cd,_0x3a1674[_0x1b95('0x69a')]);const _0x2080ce=_0x3a1674[_0x1b95('0x403')](_0x3bd8cd,_0x3a1674[_0x1b95('0x1fb')]);_0x49197a['on'](_0x3a1674[_0x1b95('0x63c')],function(){if(_0x16d9af[_0x1b95('0x5a1')]('wsHDu',_0x16d9af[_0x1b95('0x147')])){let _0x604ea9=_0x16d9af[_0x1b95('0xe1')](_0x3bd8cd,this)[_0x1b95('0x254')]();_0x1b600[_0x1b95('0x252')][_0x1b95('0x58d')]=_0x604ea9;_0x16d9af[_0x1b95('0xe1')](_0x45835c,_0x2080ce);const _0x2eeae5={};_0x2eeae5['code']=_0x604ea9;_0x27af6f[_0x1b95('0x2ce')](_0x16d9af[_0x1b95('0x3ba')],_0x2eeae5,_0x6b84a1=>{console[_0x1b95('0xe3')](_0x16d9af[_0x1b95('0xe0')],_0x6b84a1);});}else{return _0x1b600[_0x1b95('0x440')][_0x1b95('0x5bb')](code);}});_0xf77759['on'](_0x3a1674[_0x1b95('0x63c')],function(){let _0x3c5cf4=_0x16d9af[_0x1b95('0xe1')](_0x3bd8cd,this)['val']();console['log'](_0x3c5cf4);_0x1b600[_0x1b95('0x252')][_0x1b95('0x311')]=_0x3c5cf4;if(!_0x3c5cf4||_0x16d9af[_0x1b95('0x62c')](_0x3c5cf4,0x0)){_0x1b600[_0x1b95('0x252')]['amount']=null;_0x16d9af['xiQCz'](_0x3bd8cd,this)['val']('');}_0x16d9af[_0x1b95('0x304')](_0x45835c,_0x2080ce);});_0x2080ce['on'](_0x3a1674['hZznL'],async function(){const _0x50dff2={};_0x50dff2[_0x1b95('0x3a4')]=_0x1b95('0x5e9');const _0x35617d=_0x50dff2;if(!_0x1b600[_0x1b95('0x252')][_0x1b95('0x58d')]||!_0x1b600[_0x1b95('0x252')][_0x1b95('0x311')]){return;}_0x16d9af['sBhCh'](_0x3bd8cd,this)['find'](_0x16d9af[_0x1b95('0x570')])['addClass'](_0x1b95('0x363'));_0x16d9af[_0x1b95('0x63f')](_0x3bd8cd,this)[_0x1b95('0x1e2')](_0x16d9af['UCWuD'],!![])[_0x1b95('0x293')]({'opacity':0.6,'cursor':_0x16d9af[_0x1b95('0x67f')]});try{const _0x3c05e9={};_0x3c05e9[_0x1b95('0x58d')]=_0x1b600[_0x1b95('0x252')]['code'];_0x3c05e9[_0x1b95('0x311')]=_0x1b600['redeemForm'][_0x1b95('0x311')];const _0x3a7e93=_0x3c05e9;_0x27af6f[_0x1b95('0x2ce')](_0x1b95('0x53b'),_0x3a7e93,_0x477887=>{console[_0x1b95('0xe3')](_0x35617d[_0x1b95('0x3a4')],_0x477887);});_0x16d9af['Rnggt'](setTimeout,()=>{_0x16d9af[_0x1b95('0x304')](_0x3bd8cd,this)[_0x1b95('0x574')](_0x16d9af[_0x1b95('0x570')])[_0x1b95('0xd6')](_0x1b95('0x363'));_0x16d9af[_0x1b95('0x2d0')](_0x45835c,_0x2080ce);_0x15868a[_0x1b95('0x1da')]();},0x3e8);}catch(_0x1cbd0f){if(_0x1b95('0x2d4')!==_0x16d9af[_0x1b95('0x20a')]){const _0xb1b19e=_0x16d9af[_0x1b95('0x2d0')](_0x154167,![]);const _0x3bd128=_0x16d9af['IckDT'](GM_getValue,_0x3a2889[_0x1b95('0x5dd')]);const _0x5a368d=_0x16d9af['IckDT'](GM_getValue,_0xb1b19e);_0x1b600[_0x1b95('0xfb')]=_0x16d9af[_0x1b95('0x133')](_0x22a752,_0x16d9af['cOyqz'](_0x5a368d,_0x3bd128)||_0x539bce());_0x1b600[_0x1b95('0x1c8')]=_0x1b600[_0x1b95('0xfb')][_0x1b95('0x1c8')]||_0x4fbd8b[_0x1b95('0x1c8')];_0xc7958f[_0x1b95('0x3b8')](_0x16d9af['MifQy'](_0x16213a));_0xc7958f[_0x1b95('0x23b')](_0x1b600['i18n'][_0x1b95('0x4e2')][0x0]+'\x20'+_0x1b600['currency'][_0x1b95('0x25b')]()+'\x20'+_0x1b600[_0x1b95('0x49d')]['theCurrencyToGet'][0x1]);_0x16d9af[_0x1b95('0x133')](_0x4ad58c,_0xb1b19e);_0x16d9af['TRXuc'](_0x2a7465);}else{console[_0x1b95('0xe3')](_0x1cbd0f);}}});const _0x2cfb7c=_0x3a1674[_0x1b95('0x1e0')](_0x3bd8cd,_0x3a1674['rtOET']);_0x2cfb7c['on'](_0x3a1674[_0x1b95('0x5f')],async function(){const _0x3332bf={};_0x3332bf['RAQFM']=function(_0x14074c,_0x9b7101){return _0x14074c(_0x9b7101);};_0x3332bf[_0x1b95('0x1d9')]=_0x1b95('0x125');_0x3332bf[_0x1b95('0x69b')]=_0x1cde53[_0x1b95('0x5ac')];_0x3332bf[_0x1b95('0x6dc')]=_0x1b95('0x4e8');_0x3332bf[_0x1b95('0x202')]=_0x1cde53[_0x1b95('0x330')];_0x3332bf[_0x1b95('0x5cc')]=function(_0x5bb05c,_0x1ec29b){return _0x1cde53[_0x1b95('0x92')](_0x5bb05c,_0x1ec29b);};_0x3332bf[_0x1b95('0x5a3')]=_0x1cde53[_0x1b95('0x6bc')];_0x3332bf[_0x1b95('0x57b')]=_0x1b95('0x7c');const _0x5c0375=_0x3332bf;const _0x55777b=()=>{_0x5c0375[_0x1b95('0x14f')](_0x3bd8cd,this)[_0x1b95('0x1e2')]('disabled',!![])[_0x1b95('0x293')]({'opacity':0.6,'cursor':_0x5c0375[_0x1b95('0x1d9')]});_0x5c0375[_0x1b95('0x14f')](_0x3bd8cd,this)[_0x1b95('0x574')](_0x1b95('0xe4'))[_0x1b95('0x379')](_0x5c0375[_0x1b95('0x69b')]);};const _0x132a26=()=>{const _0x3049fb={};_0x3049fb[_0x1b95('0x66c')]=0x1;_0x3049fb[_0x1b95('0x165')]=_0x1b95('0x4dc');_0x5c0375[_0x1b95('0x14f')](_0x3bd8cd,this)[_0x1b95('0x1e2')](_0x5c0375[_0x1b95('0x6dc')],![])[_0x1b95('0x293')](_0x3049fb);_0x3bd8cd(this)['find'](_0x5c0375[_0x1b95('0x202')])[_0x1b95('0xd6')](_0x5c0375[_0x1b95('0x69b')]);};_0x1cde53[_0x1b95('0x23f')](_0x55777b);_0x27af6f[_0x1b95('0x2ce')](_0x1cde53[_0x1b95('0x98')],{},_0x23f370=>{if(_0x5c0375[_0x1b95('0x5cc')](_0x5c0375[_0x1b95('0x5a3')],_0x1b95('0x55b'))){this[_0x1b95('0x5a2')]();}else{console['log'](_0x5c0375['eOTGd'],_0x23f370);}});});}function _0x168de4(_0x3fb1ae){const _0x31787b={};_0x31787b[_0x1b95('0x54b')]=function(_0x499cae,_0x3a15b4){return _0x499cae+_0x3a15b4;};_0x31787b[_0x1b95('0xed')]=function(_0x4c898f,_0x25f451){return _0x1cde53[_0x1b95('0x3b3')](_0x4c898f,_0x25f451);};_0x31787b['FsikJ']=_0x1cde53['CrPil'];_0x31787b[_0x1b95('0x2bd')]='listen_code_v2';_0x31787b[_0x1b95('0x188')]=function(_0x5505ff,_0x2b2188){return _0x1cde53['JVWtK'](_0x5505ff,_0x2b2188);};const _0x1c304a=_0x31787b;_0x1b600['socket']=io(_0x3a2889[_0x1b95('0x2be')],{'auth':{'token':_0x3fb1ae,'version':_0x3a2889[_0x1b95('0x284')],'locale':_0x3a2889['locale']},'transports':[_0x1cde53[_0x1b95('0x10d')],_0x1b95('0x43f')],'upgrade':!![]});_0x1b600[_0x1b95('0x2df')]['on'](_0x1cde53[_0x1b95('0x2f3')],()=>{_0x1cde53['JVWtK'](_0x24224b,_0x1cde53[_0x1b95('0x1c9')](_0x1cde53[_0x1b95('0x1c9')](_0x1b95('0x200')+_0x1b600[_0x1b95('0x2df')]['connected'],_0x1cde53[_0x1b95('0x511')]),_0x1b600[_0x1b95('0x2df')]['id']));_0xc7958f['logger'](_0x1b600[_0x1b95('0x49d')]['conected']);_0xc7958f[_0x1b95('0x50c')](!![]);if(_0x1b600[_0x1b95('0x3e5')]&&_0x1b600[_0x1b95('0x3e5')][_0x1b95('0x6c2')]){_0x1b600['turnstileManager']['startTokenMaintenance']();}});_0x1b600[_0x1b95('0x2df')]['on'](_0x1b95('0x59e'),_0x3799d0=>{_0xc7958f[_0x1b95('0x23b')](''+_0x1b600[_0x1b95('0x49d')]['disconnect']+_0x3799d0);_0xc7958f[_0x1b95('0x50c')](![]);if(_0x1b600[_0x1b95('0x3e5')]&&_0x1b600['turnstileManager'][_0x1b95('0x4e3')]){_0x1b600[_0x1b95('0x3e5')]['stopTokenMaintenance']();}});_0x1b600['socket']['io']['on'](_0x1cde53[_0x1b95('0x312')],_0x1e0c07=>{_0xc7958f[_0x1b95('0x23b')](_0x1c304a[_0x1b95('0x54b')](_0x1b95('0x4f5'),_0x1e0c07['message']));_0xc7958f['changeConnectStatus'](![]);});_0x1b600[_0x1b95('0x2df')]['on'](_0x1cde53[_0x1b95('0x312')],_0x25049a=>{_0xc7958f[_0x1b95('0x23b')](_0x1c304a['TVPQl'](_0x1c304a[_0x1b95('0x44a')],_0x25049a[_0x1b95('0x4d7')]));_0xc7958f[_0x1b95('0x50c')](![]);});_0x1b600[_0x1b95('0x2df')]['io']['on'](_0x1cde53[_0x1b95('0x19f')],()=>{const _0x40c2af={};_0x40c2af[_0x1b95('0x515')]=function(_0x94ca9c,_0x587861){return _0x1cde53[_0x1b95('0x1c9')](_0x94ca9c,_0x587861);};_0x40c2af[_0x1b95('0x634')]=_0x1b95('0x185');const _0x242976=_0x40c2af;if(_0x1cde53[_0x1b95('0x4a1')](_0x1cde53[_0x1b95('0xb3')],_0x1cde53[_0x1b95('0x1f1')])){const _0x3e39a2={};_0x3e39a2[_0x1b95('0x58d')]=code;const _0x219d39=_0x3e39a2;_0x27af6f[_0x1b95('0x2ce')](_0x1c304a[_0x1b95('0x2bd')],_0x219d39,_0x21d52c=>{console[_0x1b95('0xe3')](_0x242976[_0x1b95('0x515')](_0x242976[_0x1b95('0x634')],_0x21d52c));});}else{_0x24224b(_0x1cde53['htzBB']);}});_0x1b600['socket']['on'](_0x1b95('0x4d7'),function(_0x80800c){_0x1c304a[_0x1b95('0x188')](_0x2032dd,_0x80800c);});}const _0x52b3ab={};_0x52b3ab['connect']=function(_0x113dbb){return _0x168de4(_0x113dbb);};_0x52b3ab[_0x1b95('0x2ce')]=function(_0x2b1b15,_0x525efb,_0x218980){if(!_0x1b600['socket']){return;}_0x1b600[_0x1b95('0x2df')]['emit'](_0x2b1b15,_0x525efb,_0x218980);};_0x52b3ab[_0x1b95('0x135')]=function(){return _0x1b600[_0x1b95('0x2df')];};const _0x27af6f=_0x52b3ab;const _0x3dc592={};_0x3dc592['taskMap']=new Map();_0x3dc592[_0x1b95('0x8')]=function(_0x2e91b3){if(_0x3a1674['IqRZQ'](_0x3a1674['XqPaC'],_0x3a1674[_0x1b95('0x361')])){throw new Error('CreateVaultDepositError:\x20'+response[_0x1b95('0x9d')]);}else{return _0x1b600[_0x1b95('0x440')][_0x1b95('0x5bb')](_0x2e91b3);}};_0x3dc592[_0x1b95('0x542')]=function(_0x5d5df2){return this[_0x1b95('0x24')][_0x1b95('0x8')](_0x5d5df2);};_0x3dc592['getTask']=function(_0x38a704){if(_0x1cde53[_0x1b95('0x2d5')](_0x1cde53['ysEAq'],_0x1cde53[_0x1b95('0x551')])){return this[_0x1b95('0x24')][_0x1b95('0x409')](_0x38a704)||null;}else{throw new Error(_0x1b95('0x1f6')+error['message']+'\x20'+_0x1b600[_0x1b95('0x49d')][_0x1b95('0x19d')]);}};_0x3dc592[_0x1b95('0x477')]=function(_0xa233c7){if(!_0xa233c7||!_0xa233c7['code']){if(_0x1cde53[_0x1b95('0x577')](_0x1cde53['PZTKq'],_0x1cde53[_0x1b95('0x3ae')])){return![];}else{_0xc7958f[_0x1b95('0x23b')](_0x1b600[_0x1b95('0x49d')][_0x1b95('0x189')]);_0xc7958f['logger'](data['msg'][_0x1b95('0x505')]);_0xc7958f[_0x1b95('0x23b')](_0x1b600[_0x1b95('0x49d')][_0x1b95('0x143')]);}}if(_0x1b600[_0x1b95('0x2a1')][_0x1b95('0x8')](_0xa233c7['code'])||this[_0x1b95('0x8')](_0xa233c7[_0x1b95('0x58d')])){if(_0x1cde53[_0x1b95('0x2d5')](_0x1b95('0x7d'),_0x1cde53[_0x1b95('0x1ea')])){return;}else{return![];}}if(_0x1cde53['fVYUm'](_0x1b600[_0x1b95('0x440')][_0x1b95('0xb')],_0x3a2889[_0x1b95('0x3fe')])){const _0x60a6e4=_0x1b600[_0x1b95('0x440')]['shift']();if(_0x60a6e4){this[_0x1b95('0x24')][_0x1b95('0x49e')](_0x60a6e4);}}_0x1b600[_0x1b95('0x440')][_0x1b95('0x7b')](_0xa233c7[_0x1b95('0x58d')]);this['taskMap'][_0x1b95('0xf9')](_0xa233c7[_0x1b95('0x58d')],_0xa233c7);return!![];};_0x3dc592['remove']=function(_0x30c7c6){if(_0x1b95('0x36d')!==_0x1b95('0x337')){if(!_0x30c7c6)return;_0x1b600[_0x1b95('0x440')]=_0x1b600[_0x1b95('0x440')][_0x1b95('0x1fd')](_0x141b97=>_0x141b97!==_0x30c7c6);this[_0x1b95('0x24')][_0x1b95('0x49e')](_0x30c7c6);}else{_0x1cde53['uhpwa'](_0x24224b,_0x1b95('0x32'));return;}};_0x3dc592[_0x1b95('0x7e')]=function(){return _0x1b600['waittingCodes'][_0x1b95('0xb')]?_0x1b600[_0x1b95('0x440')][0x0]:'';};_0x3dc592[_0x1b95('0x66a')]=function(_0x47bb2e){if(_0x1b95('0x501')===_0x3a1674[_0x1b95('0x5f5')]){return;}else{if(_0x47bb2e){_0x1b600['noNeedToClaimAgain'][_0x1b95('0x15')](_0x47bb2e);}}};_0x3dc592['clearSkip']=function(){_0x1b600[_0x1b95('0x2a1')]['clear']();};_0x3dc592[_0x1b95('0xe2')]=function(){const _0x1568d5={};_0x1568d5[_0x1b95('0x32a')]=function(_0x35f924,_0xbd88ab){return _0x35f924==_0xbd88ab;};const _0x2cf294=_0x1568d5;if(_0x1cde53[_0x1b95('0x291')](_0x1cde53[_0x1b95('0x652')],_0x1cde53[_0x1b95('0x652')])){return _0x1b600[_0x1b95('0x440')][_0x1b95('0x5ef')]();}else{if(_0x2cf294['dfQqW'](response[_0x1b95('0x9d')],0x193)||_0x2cf294[_0x1b95('0x32a')](response['status'],0x191)){throw new Error(_0x1b95('0x4bb')+response[_0x1b95('0x9d')]+',\x20'+_0x1b600[_0x1b95('0x49d')][_0x1b95('0x12a')]);}throw new Error(''+_0x1b600[_0x1b95('0x49d')][_0x1b95('0x5c6')]);}};const _0x1f175d=_0x3dc592;const _0x12560f={};_0x12560f[_0x1b95('0x4e6')]=function(_0x1c1bd5,_0x12912d=_0x1b95('0x54')){const _0x1adb5e={};_0x1adb5e['IMocU']=_0x1cde53[_0x1b95('0x6ea')];const _0x28381a=_0x1adb5e;if(!_0x1c1bd5||!_0x1c1bd5[_0x1b95('0x58d')]){return null;}let _0x1263dd=_0x1cde53['uhpwa'](String,_0x1c1bd5[_0x1b95('0x58d')])[_0x1b95('0x9c')]();if(!_0x1263dd){return null;}let _0x3acd82=_0x1c1bd5[_0x1b95('0x311')];if(_0x1cde53['onMIa'](_0x3acd82,undefined)&&_0x3acd82!==null&&_0x3acd82!==''){_0x3acd82=_0x1cde53[_0x1b95('0x69c')](Number,_0x3acd82);}else{_0x3acd82=null;}let _0x4d5b8f=_0x1c1bd5[_0x1b95('0xdd')]||_0x1cde53['BZYCX'];if(_0x1cde53['AATeH'](_0x4d5b8f,_0x1cde53['lbDDj'])){if(_0x1cde53[_0x1b95('0x291')](_0x3acd82,0x1)){_0x4d5b8f=_0x1cde53['HZgSc'];}else if(_0x1cde53[_0x1b95('0xa')](_0x3acd82,0x2)){if(_0x1cde53[_0x1b95('0x577')](_0x1b95('0x2f'),_0x1cde53[_0x1b95('0x64a')])){_0x4d5b8f='Daily2';}else{_0x3bd8cd(_0x28381a['IMocU'])['toggle']();}}else if(_0x1cde53[_0x1b95('0xa')](_0x3acd82,0x3)){_0x4d5b8f=_0x1cde53[_0x1b95('0x99')];}else{if(_0x1b95('0x62a')!==_0x1cde53[_0x1b95('0x52b')]){_0x1b600[_0x1b95('0xfb')][_0x1b95('0x1c8')]=finalValue;}else{_0x4d5b8f=_0x1cde53['KVcWA'];}}}const _0x1dd818={};_0x1dd818[_0x1b95('0x58d')]=_0x1263dd;_0x1dd818[_0x1b95('0x311')]=_0x3acd82;_0x1dd818[_0x1b95('0x2ec')]=_0x12912d;_0x1dd818[_0x1b95('0x2fd')]=_0x1c1bd5;_0x1dd818[_0x1b95('0x38c')]=_0x4d5b8f;_0x1dd818['directClaim']=_0x1cde53[_0x1b95('0xa')](_0x1c1bd5[_0x1b95('0x3eb')],_0x1b95('0x217'));_0x1dd818[_0x1b95('0x139')]=0x0;_0x1dd818[_0x1b95('0x6bf')]=Date['now']();return _0x1dd818;};_0x12560f[_0x1b95('0x21d')]=function(_0x206eb9){if(!_0x206eb9){if(_0x3a1674[_0x1b95('0x1b5')](_0x3a1674[_0x1b95('0x10f')],_0x3a1674['eMqty'])){bytes[i]=binary[_0x1b95('0x3bb')](i);}else{return![];}}if(!_0x1b600['userSetInfo']||!_0x1b600[_0x1b95('0xfb')]['drops']||!_0x1b600[_0x1b95('0xfb')][_0x1b95('0x41e')][_0x1b95('0x5bb')](_0x206eb9[_0x1b95('0x38c')])){_0x3a1674[_0x1b95('0x39a')](_0x24224b,_0x1b95('0x4f9')+_0x206eb9[_0x1b95('0x38c')]);return![];}if(_0x1b600[_0x1b95('0x2a1')]['has'](_0x206eb9[_0x1b95('0x58d')])){return![];}if(_0x1f175d[_0x1b95('0x8')](_0x206eb9[_0x1b95('0x58d')])){return![];}return!![];};_0x12560f['receive']=function(_0x31b5a2,_0x57bf64=_0x1b95('0x54')){_0x1cde53[_0x1b95('0x69c')](_0x24224b,new Date()['toLocaleString']()+'\x20CODE\x20incoming\x20('+_0x57bf64+_0x1b95('0x65e'));_0x1cde53[_0x1b95('0x37a')](_0x24224b,_0x31b5a2);const _0x22a74a=this[_0x1b95('0x4e6')](_0x31b5a2,_0x57bf64);if(!this[_0x1b95('0x21d')](_0x22a74a)){if(_0x1cde53[_0x1b95('0x6b1')](_0x1cde53['GuBzj'],_0x1cde53[_0x1b95('0x294')])){return null;}else{return;}}if(_0x1f175d[_0x1b95('0x477')](_0x22a74a)){if(_0x1cde53['upalz'](_0x1cde53[_0x1b95('0x685')],_0x1cde53[_0x1b95('0x685')])){_0x454220[_0x1b95('0x32c')]();}else{nextConfig[_0x1b95('0x1c8')]=_0x4fbd8b[_0x1b95('0x1c8')];}}};_0x12560f[_0x1b95('0x1d4')]=function(_0x369efb,_0x31739=![]){const _0x854610={};_0x854610['code']=_0x369efb;_0x854610[_0x1b95('0xdd')]=_0x3a1674[_0x1b95('0x6e6')];_0x854610[_0x1b95('0x3eb')]=_0x31739?'unck':'';this[_0x1b95('0xeb')](_0x854610,_0x3a1674[_0x1b95('0x57e')]);};const _0x2714b3=_0x12560f;const _0x145ac2={};_0x145ac2[_0x1b95('0x3b5')]=function(){const _0x154d89={};_0x154d89[_0x1b95('0x6e2')]=function(_0x3884c5,_0x1cf048){return _0x1cde53[_0x1b95('0x41')](_0x3884c5,_0x1cf048);};_0x154d89[_0x1b95('0x42c')]=_0x1b95('0x279');const _0x16be07=_0x154d89;if(_0x454220[_0x1b95('0x344')]){if(_0x1cde53[_0x1b95('0x80')]==='uEaHL'){_0x16be07[_0x1b95('0x6e2')](_0x3bd8cd,_0x16be07[_0x1b95('0x42c')])[_0x1b95('0x1da')]();}else{_0x1cde53['xrgTq'](clearTimeout,_0x454220[_0x1b95('0x344')]);_0x454220['activeTimer']=null;}}};_0x145ac2['getElapsedMs']=function(_0x2f28d7){if(!_0x2f28d7||!_0x2f28d7[_0x1b95('0x6bf')]){return null;}return Math['max'](0x0,Date[_0x1b95('0x5bc')]()-_0x2f28d7[_0x1b95('0x6bf')]);};_0x145ac2[_0x1b95('0x36c')]=function(_0x211ee4,_0x4b1a94,_0x3e3873=''){const _0x51cb2b={};_0x51cb2b[_0x1b95('0x582')]=_0x3a1674[_0x1b95('0x1b9')];const _0x10bbca=_0x51cb2b;const _0xb7d57d=_0x1f175d[_0x1b95('0x3f2')](_0x211ee4)||_0x454220[_0x1b95('0x1d')];_0x1b600[_0x1b95('0x218')]=![];_0xc7958f['hideLoading']();_0x1b600[_0x1b95('0x437')]=!![];_0x454220[_0x1b95('0x36')]=![];_0x454220['activeTask']=null;this[_0x1b95('0x3b5')]();const _0x1fa382=[_0x3a1674[_0x1b95('0x20e')],_0x1b95('0x3c0'),_0x1b95('0xb6'),_0x3a1674[_0x1b95('0x488')],_0x1b95('0x4e7'),_0x3a1674[_0x1b95('0x680')],_0x3a1674[_0x1b95('0x4cc')],_0x1b95('0x433')];if(_0x1fa382['includes'](_0x4b1a94)){if(_0x3a1674[_0x1b95('0x29')](_0x1b95('0x4d2'),_0x3a1674['RqRFl'])){_0xc7958f[_0x1b95('0x23b')](_0x1b95('0x21e')+_0x1b600[_0x1b95('0x49d')][_0x4b1a94]);}else{_0x454220[_0x1b95('0x32c')]();}}else if(_0x3e3873){_0xc7958f[_0x1b95('0x23b')](''+_0x3e3873);}else{_0xc7958f[_0x1b95('0x23b')](''+_0x4b1a94);}_0x1f175d[_0x1b95('0x286')](_0x211ee4);const _0x3dbe13=[_0x3a1674['cbQFL'],_0x3a1674[_0x1b95('0x20e')],_0x3a1674[_0x1b95('0x29b')],_0x3a1674[_0x1b95('0x512')],_0x1b95('0x4e7'),_0x3a1674[_0x1b95('0x4cc')],_0x3a1674['bhhKJ'],'codeAlreadyClaimed',_0x3a1674[_0x1b95('0x198')]];if(_0x3dbe13[_0x1b95('0x5bb')](_0x4b1a94)||(_0x3a1674[_0x1b95('0x35d')](_0x3e3873['indexOf'](_0x3a1674[_0x1b95('0x1b7')]),-0x1)||_0x3a1674[_0x1b95('0x35d')](_0x3e3873[_0x1b95('0x450')](_0x3a1674[_0x1b95('0x431')]),-0x1)||_0x3a1674['AihAt'](_0x3e3873['indexOf'](_0x3a1674[_0x1b95('0x58c')]),-0x1))){_0x1f175d[_0x1b95('0x66a')](_0x211ee4);}if(_0x1f175d[_0x1b95('0x7e')]()){if(_0x3a1674[_0x1b95('0x1b5')](_0x3a1674[_0x1b95('0x5cd')],_0x3a1674[_0x1b95('0x15e')])){_0x3a1674[_0x1b95('0x1ad')](setTimeout,()=>{if(_0x10bbca[_0x1b95('0x582')]!==_0x10bbca[_0x1b95('0x582')]){target[_0x1b95('0x5a9')](_0x1b95('0xf8')+_0x211ee4+'\x22>'+_0x211ee4[_0x1b95('0x25b')]()+_0x1b95('0x4ee'));}else{_0x454220['startNext']();}},_0x3a2889[_0x1b95('0x3e2')]);}else{if(_0x1cde53[_0x1b95('0x325')](response[_0x1b95('0x9d')],0x193)||_0x1cde53[_0x1b95('0x64')](response[_0x1b95('0x9d')],0x191)||_0x1cde53['EThBP'](response[_0x1b95('0x9d')],0x1ad)){throw new Error(_0x1b95('0x2cd')+response['status']+']\x20'+_0x1b600[_0x1b95('0x49d')][_0x1b95('0x12a')]);}throw new Error(_0x1b95('0x2cd')+response[_0x1b95('0x9d')]+']');}}};const _0x353bcb=_0x145ac2;const _0x1b9a38={};_0x1b9a38[_0x1b95('0x36')]=![];_0x1b9a38[_0x1b95('0x1d')]=null;_0x1b9a38[_0x1b95('0x344')]=null;_0x1b9a38['startNext']=function(){if(this[_0x1b95('0x36')]){if(_0x1cde53[_0x1b95('0x605')](_0x1cde53[_0x1b95('0x461')],_0x1cde53[_0x1b95('0x1b1')])){const _0x4a4844=_0x1cde53[_0x1b95('0xc5')](atob,base64);const _0x353e3e=new Uint8Array(_0x4a4844[_0x1b95('0xb')]);for(let _0x311dc3=0x0;_0x1cde53[_0x1b95('0x463')](_0x311dc3,_0x4a4844[_0x1b95('0xb')]);_0x311dc3++){_0x353e3e[_0x311dc3]=_0x4a4844['charCodeAt'](_0x311dc3);}return _0x353e3e;}else{return;}}const _0x1ba32b=_0x1f175d[_0x1b95('0x7e')]();if(!_0x1ba32b){return;}this[_0x1b95('0x539')](_0x1ba32b);};_0x1b9a38[_0x1b95('0x539')]=function(_0x5cc3f8){if(this[_0x1b95('0x36')]){return;}const _0x3df1f8=_0x1f175d['getTask'](_0x5cc3f8);if(!_0x3df1f8){if(_0x3a1674['lczWc']===_0x3a1674[_0x1b95('0x229')]){_0x1f175d[_0x1b95('0x286')](_0x5cc3f8);return;}else{_0x1b600[_0x1b95('0x2a1')][_0x1b95('0x22d')]();}}this['runTask'](_0x3df1f8);};_0x1b9a38['runTask']=async function(_0x5c8106){if(_0x1cde53[_0x1b95('0x178')](_0x1cde53[_0x1b95('0x3c3')],_0x1b95('0x3ca'))){if(!_0x5c8106||this[_0x1b95('0x36')]){if(_0x1cde53[_0x1b95('0x3d1')]('pqsZV',_0x1cde53[_0x1b95('0x39')])){return;}else{const _0x917362={};_0x917362[_0x1b95('0x2c4')]=function(_0x37e2ac,_0x5704fa){return _0x37e2ac(_0x5704fa);};_0x917362[_0x1b95('0x214')]=function(_0x3e8950,_0x5b7fbb){return _0x1cde53['Nonnf'](_0x3e8950,_0x5b7fbb);};_0x917362[_0x1b95('0x6bd')]=_0x1cde53[_0x1b95('0x368')];_0x917362['SyxiM']=function(_0x10c087,_0x10af8f){return _0x1cde53[_0x1b95('0x2c5')](_0x10c087,_0x10af8f);};_0x917362[_0x1b95('0x665')]=function(_0x25810a,_0x59214c){return _0x25810a+_0x59214c;};_0x917362[_0x1b95('0x2ee')]=_0x1cde53[_0x1b95('0x52d')];_0x917362[_0x1b95('0x369')]=function(_0x1c451b){return _0x1cde53['pSPSy'](_0x1c451b);};_0x917362['xKGhI']=_0x1cde53[_0x1b95('0x242')];_0x917362[_0x1b95('0x6af')]=_0x1cde53['qaial'];_0x917362[_0x1b95('0xda')]=_0x1cde53[_0x1b95('0x553')];const _0x58bf94=_0x917362;return new Promise((_0x330965,_0x537c35)=>{let _0x3df784=Date[_0x1b95('0x5bc')]();const _0x38d324=document[_0x1b95('0x6f')](_0x58bf94[_0x1b95('0x8e')]);_0x38d324['setAttribute']('id',_0x1b95('0x556'));_0x38d324[_0x1b95('0x34a')]=_0x58bf94['oaLhh'];_0x38d324['type']=_0x58bf94['uEkCa'];_0x38d324[_0x1b95('0x23e')]=()=>{let _0xde2355=Date[_0x1b95('0x5bc')]();_0x58bf94['OCkJf'](_0x24224b,_0x58bf94[_0x1b95('0x214')](_0x58bf94[_0x1b95('0x6bd')],_0x58bf94['SyxiM'](_0xde2355,_0x3df784)));_0x330965();};_0x38d324[_0x1b95('0x664')]=_0xdef5d3=>{let _0x373dc2=Date[_0x1b95('0x5bc')]();console[_0x1b95('0x3e3')](_0x58bf94[_0x1b95('0x665')](_0x58bf94[_0x1b95('0x2ee')],_0x58bf94[_0x1b95('0x46b')](_0x373dc2,_0x3df784)),_0xdef5d3);_0x38d324[_0x1b95('0x286')]();_0x58bf94[_0x1b95('0x369')](_0x537c35);};document[_0x1b95('0x18f')][_0x1b95('0x5a9')](_0x38d324);});}}this[_0x1b95('0x36')]=!![];this[_0x1b95('0x1d')]=_0x5c8106;_0x1b600[_0x1b95('0x218')]=!![];_0xc7958f[_0x1b95('0x23b')]((_0x5c8106[_0x1b95('0x119')]?_0x1cde53[_0x1b95('0x15b')]:_0x1cde53[_0x1b95('0x33f')])+'\x20'+_0x1b600['i18n']['claimStart']+'\x20'+_0x5c8106[_0x1b95('0x58d')]);_0x1b600[_0x1b95('0x437')]=![];_0xc7958f['showLoading']();this[_0x1b95('0x344')]=_0x1cde53[_0x1b95('0x4ec')](setTimeout,()=>{_0x1b600[_0x1b95('0x437')]=!![];_0xc7958f[_0x1b95('0x1fe')]();},_0x3a2889['claimTimeoutMs']);try{if(_0x1cde53[_0x1b95('0x5a4')](_0x1cde53[_0x1b95('0x201')],'VehcP')){return _0x1cde53[_0x1b95('0x605')](_0x3a2889[_0x1b95('0x163')],_0x1cde53[_0x1b95('0x681')])?_0x4cb310:_0x1d5109;}else{if(_0x5c8106['directClaim']){if(_0x1cde53[_0x1b95('0x6f2')](_0x1cde53[_0x1b95('0x40e')],_0x1cde53[_0x1b95('0x27a')])){await this[_0x1b95('0x5cf')](_0x5c8106);}else{console[_0x1b95('0xe3')](_0x1cde53['HYGCg'],_0x1b600['waittingCodes']);}}else{await this[_0x1b95('0x688')](_0x5c8106);}}}catch(_0x31b19d){_0x353bcb[_0x1b95('0x36c')](_0x5c8106[_0x1b95('0x58d')],_0x1cde53[_0x1b95('0x73')],'❌\x20'+_0x31b19d[_0x1b95('0x4d7')]);}}else{haomiao='0'+(timeStr-timeStr1);}};_0x1b9a38[_0x1b95('0x688')]=async function(_0x5a95da){if(_0x1cde53[_0x1b95('0x4fa')]!==_0x1b95('0x34e')){this[_0x1b95('0x97')]=![];this[_0x1b95('0x625')]=null;reject(error);}else{const _0x406e30=await this[_0x1b95('0x68a')](_0x5a95da);if(_0x1cde53[_0x1b95('0x70')](_0x406e30,_0x1cde53['jzECi'])||_0x1cde53[_0x1b95('0x309')](_0x406e30,_0x1cde53[_0x1b95('0x5fe')])){await this[_0x1b95('0x324')](_0x5a95da);}}};_0x1b9a38[_0x1b95('0x5cf')]=async function(_0x133f5d){if(_0x1cde53[_0x1b95('0x12')]===_0x1cde53[_0x1b95('0x31b')]){try{const _0x46d0fe=_0x1cde53[_0x1b95('0x223')](_0x154167,![]);const _0x2f39ed=_0x1cde53[_0x1b95('0x27b')](GM_getValue,_0x3a2889[_0x1b95('0x5dd')]);const _0x557c2a=_0x1cde53[_0x1b95('0x3d7')](GM_getValue,_0x46d0fe);_0x1b600[_0x1b95('0xfb')]=_0x1cde53[_0x1b95('0x3d7')](_0x22a752,_0x1cde53['nTAik'](_0x557c2a,_0x2f39ed)||_0x1cde53[_0x1b95('0x18b')](_0x539bce));_0x1b600[_0x1b95('0x1c8')]=_0x1b600[_0x1b95('0xfb')][_0x1b95('0x1c8')]||_0x4fbd8b['currency'];_0xc7958f['updateCurrencyOptions'](_0x1cde53[_0x1b95('0x4d9')](_0x16213a));_0xc7958f[_0x1b95('0x23b')](_0x1b600[_0x1b95('0x49d')]['theCurrencyToGet'][0x0]+'\x20'+_0x1b600[_0x1b95('0x1c8')][_0x1b95('0x25b')]()+'\x20'+_0x1b600[_0x1b95('0x49d')]['theCurrencyToGet'][0x1]);_0x4ad58c(_0x46d0fe);_0x2a7465();}catch(_0xe2448a){console[_0x1b95('0xe3')](_0xe2448a);}}else{await this[_0x1b95('0x324')](_0x133f5d);}};_0x1b9a38['checkCodeAvailability']=async function(_0x25eaf4){const _0x3e350e={};_0x3e350e[_0x1b95('0x315')]=function(_0x1e7509,_0x227c13){return _0x1e7509(_0x227c13);};_0x3e350e[_0x1b95('0x2dd')]=function(_0x3d18b5,_0x2c7729){return _0x3d18b5||_0x2c7729;};_0x3e350e[_0x1b95('0x5b')]=function(_0x523b6b,_0x51f471,_0x45ffbb,_0x5867b7,_0x4b58b2){return _0x3a1674['MfSKZ'](_0x523b6b,_0x51f471,_0x45ffbb,_0x5867b7,_0x4b58b2);};_0x3e350e['sPMZD']=function(_0x2a4c31,_0x16a9c2){return _0x3a1674[_0x1b95('0x624')](_0x2a4c31,_0x16a9c2);};_0x3e350e[_0x1b95('0x122')]=function(_0x5fd656,_0x83d5ac,_0x568e18){return _0x3a1674['udYUQ'](_0x5fd656,_0x83d5ac,_0x568e18);};const _0x40e5f6=_0x3e350e;if(_0x3a1674[_0x1b95('0x10c')](_0x3a1674['WaMAE'],_0x3a1674['WaMAE'])){const _0x4d3416=GM_getValue(hostKey);const _0x45b2b1=GM_getValue(_0x3a2889[_0x1b95('0x5dd')]);_0x1b600[_0x1b95('0xfb')]=_0x40e5f6[_0x1b95('0x315')](_0x22a752,_0x40e5f6[_0x1b95('0x2dd')](_0x4d3416,_0x45b2b1)||_0x539bce());GM_setValue(userKey,_0x1b600[_0x1b95('0xfb')]);}else{let _0x3f0ca8=0x0;let _0x149fe4=0x3;while(_0x3a1674[_0x1b95('0x480')](_0x3f0ca8,_0x149fe4)){if(_0x3a1674[_0x1b95('0x10c')](_0x3a1674['JfkTG'],_0x3a1674[_0x1b95('0x421')])){codeType=_0x1b95('0x669');}else{try{if(_0x3a1674['cYuEh'](_0x3a1674[_0x1b95('0x592')],_0x3a1674[_0x1b95('0x62f')])){return _0x1cde53[_0x1b95('0x3d7')](_0x168de4,token);}else{const _0x441ebe=await _0x1b600[_0x1b95('0x57a')][_0x1b95('0xfa')](_0x25eaf4[_0x1b95('0x58d')]);if(!_0x441ebe['ok']){if(_0x3a1674[_0x1b95('0x362')](_0x1b95('0x504'),_0x3a1674['sbcXy'])){return _0x40e5f6[_0x1b95('0x5b')](_0x405088,origin,session,fcorigin,locale);}else{if(_0x441ebe[_0x1b95('0x9d')]==0x193||_0x3a1674['HMRji'](_0x441ebe['status'],0x191)||_0x3a1674[_0x1b95('0x3d6')](_0x441ebe[_0x1b95('0x9d')],0x1ad)){if(_0x3a1674[_0x1b95('0x357')](_0x3a1674[_0x1b95('0x506')],_0x3a1674[_0x1b95('0x506')])){throw new Error(_0x1b95('0x2cd')+_0x441ebe[_0x1b95('0x9d')]+']\x20'+_0x1b600[_0x1b95('0x49d')][_0x1b95('0x12a')]);}else{this['sortTokenCache']();const _0x3e4d3a=this[_0x1b95('0x226')][_0x1b95('0x329')](_0x347a21=>this[_0x1b95('0x603')](_0x347a21,now));if(_0x3e4d3a<0x0){return![];}if(_0x40e5f6[_0x1b95('0x6ef')](this[_0x1b95('0x226')][_0x1b95('0xb')],this[_0x1b95('0x5c')])){return![];}this[_0x1b95('0x226')][_0x1b95('0x283')](_0x3e4d3a,0x1);return!![];}}throw new Error(_0x1b95('0x2cd')+_0x441ebe[_0x1b95('0x9d')]+']');}}const _0x2afa77=await _0x441ebe[_0x1b95('0x52e')]();if(_0x2afa77[_0x1b95('0x505')]){if(_0x3a1674[_0x1b95('0x362')](_0x3a1674[_0x1b95('0x5f9')],_0x1b95('0x3f9'))){const _0x1c3009=_0x2afa77[_0x1b95('0x505')]['bonusCodeInformation'][_0x1b95('0x51b')];if(_0x1c3009==_0x3a1674[_0x1b95('0x1e9')]||_0x1c3009==_0x1b95('0x2e')){return _0x1c3009;}_0x353bcb[_0x1b95('0x36c')](_0x25eaf4['code'],_0x1c3009);return null;}else{const _0x2e0969=customKey||_0x154167(!![]);_0x40e5f6[_0x1b95('0x122')](GM_setValue,_0x2e0969,_0x1b600['userSetInfo']);}}const _0x1fa80=_0x2afa77[_0x1b95('0x68f')][0x0][_0x1b95('0xad')];const _0xabf271=_0x1b95('0x21e')+_0x2afa77[_0x1b95('0x68f')][0x0]['message'];_0x353bcb[_0x1b95('0x36c')](_0x25eaf4[_0x1b95('0x58d')],_0x1fa80,_0xabf271);return null;}}catch(_0x41c172){if(_0x3a1674[_0x1b95('0x20f')]===_0x3a1674[_0x1b95('0xaf')]){_0x353bcb[_0x1b95('0x36c')](_0x25eaf4[_0x1b95('0x58d')],_0x1cde53[_0x1b95('0x73')],errMsg);}else{_0x3f0ca8++;const _0x1066b6=_0x1b95('0x116')+_0x3a1674['CSEfJ'](_0x3e8e62,_0x41c172);if(_0x3f0ca8<_0x149fe4){_0xc7958f[_0x1b95('0x23b')](_0x1066b6);if(_0x3a1674['PINEh'](_0x1066b6['indexOf'](_0x3a1674['xvcul']),-0x1)||_0x3a1674['LPnbw'](_0x1066b6['indexOf'](_0x3a1674[_0x1b95('0x431')]),-0x1)||_0x1066b6[_0x1b95('0x450')](_0x3a1674[_0x1b95('0x58c')])>-0x1){break;}await new Promise(_0xd7e004=>setTimeout(_0xd7e004,_0x3a2889[_0x1b95('0x8d')]));}else{_0x353bcb[_0x1b95('0x36c')](_0x25eaf4[_0x1b95('0x58d')],'FETCH_ERROR',_0x1066b6);return null;}}}}}return null;}};_0x1b9a38[_0x1b95('0x324')]=async function(_0x43e6f6){const _0x36401a={};_0x36401a['ejmEF']=function(_0x34ba22,_0x98835a){return _0x1cde53[_0x1b95('0x2c5')](_0x34ba22,_0x98835a);};_0x36401a['qrlJu']=_0x1cde53[_0x1b95('0x264')];const _0x53cefb=_0x36401a;if(_0x1cde53[_0x1b95('0x6f2')](_0x1cde53['dXhlG'],_0x1cde53[_0x1b95('0x6b')])){throw new Error(_0x1b95('0x502')+error[_0x1b95('0x4d7')]+'\x20'+_0x1b600[_0x1b95('0x49d')][_0x1b95('0x19d')]);}else{let _0x538ad0=0x0;let _0x2a3555=0x3;while(_0x1cde53[_0x1b95('0x463')](_0x538ad0,_0x2a3555)){if(_0x1cde53[_0x1b95('0x1fa')](_0x1cde53['MpWoB'],_0x1cde53[_0x1b95('0x58b')])){try{if(_0x1cde53['orpeH']('oMyxg','oMyxg')){haomiao=_0x53cefb[_0x1b95('0xab')](timeStr,timeStr1);}else{const _0x4f541d=await _0x1b600[_0x1b95('0x3e5')][_0x1b95('0x5db')]();if(!_0x4f541d){throw new Error(_0x1b95('0x482'));}await this[_0x1b95('0x22c')](_0x43e6f6,_0x4f541d);return;}}catch(_0x4192df){if(_0x1cde53[_0x1b95('0x2b')]===_0x1cde53[_0x1b95('0x2b')]){let _0x12c360='❌\x20'+_0x1cde53['iLRbi'](_0x3e8e62,_0x4192df);_0x538ad0++;if(_0x12c360[_0x1b95('0x450')](_0x1cde53[_0x1b95('0x694')])>-0x1&&_0x538ad0==_0x2a3555&&_0x1cde53[_0x1b95('0x1e5')](_0x2a3555,0x5)){_0x2a3555++;}if(_0x538ad0<_0x2a3555){_0xc7958f[_0x1b95('0x23b')](_0x12c360);if(_0x1cde53[_0x1b95('0x3cf')](_0x12c360[_0x1b95('0x450')](_0x1cde53[_0x1b95('0x43b')]),-0x1)||_0x1cde53[_0x1b95('0x3cf')](_0x12c360['indexOf'](_0x1cde53['WvrEN']),-0x1)||_0x1cde53[_0x1b95('0x4ce')](_0x12c360[_0x1b95('0x450')](_0x1cde53[_0x1b95('0x57')]),-0x1)){if(_0x1cde53[_0x1b95('0x309')]('vcmsI',_0x1cde53[_0x1b95('0x5d3')])){return cookie[0x1];}else{break;}}_0xc7958f['logger']('retry...');await new Promise(_0xae2616=>setTimeout(_0xae2616,_0x3a2889[_0x1b95('0x8d')]));}else{_0x353bcb[_0x1b95('0x36c')](_0x43e6f6['code'],_0x1cde53[_0x1b95('0x73')],_0x12c360);}}else{return this['taskMap']['get'](code)||null;}}}else{throw new Error(_0x53cefb[_0x1b95('0x434')]);}}}};_0x1b9a38[_0x1b95('0x22c')]=async function(_0x11e3c1,_0x116770){const _0x3df495=await _0x1b600[_0x1b95('0x57a')][_0x1b95('0x22c')](_0x11e3c1[_0x1b95('0x58d')],_0x1b600['currency'],_0x116770);if(!_0x3df495['ok']){if(_0x3a1674[_0x1b95('0x3d6')](_0x3df495['status'],0x193)||_0x3a1674['VaIra'](_0x3df495[_0x1b95('0x9d')],0x191)||_0x3a1674[_0x1b95('0x672')](_0x3df495[_0x1b95('0x9d')],0x1ad)){throw new Error(_0x1b95('0x2cd')+_0x3df495['status']+']\x20'+_0x1b600['i18n'][_0x1b95('0x12a')]);}throw new Error(_0x1b95('0x2cd')+_0x3df495[_0x1b95('0x9d')]+']');}const _0xa7227=await _0x3df495[_0x1b95('0x52e')]();if(_0xa7227[_0x1b95('0x505')]){const _0x2c5195=_0xa7227[_0x1b95('0x505')][_0x1b95('0x1')][_0x1b95('0x311')];const _0x4ba5d2=_0xa7227[_0x1b95('0x505')]['claimConditionBonusCode'][_0x1b95('0x1c8')];const _0x43f6f1='✅\x20'+_0x1b600[_0x1b95('0x49d')][_0x1b95('0x562')]+Number(_0x2c5195[_0x1b95('0xbc')](0x8))+'\x20'+_0x4ba5d2[_0x1b95('0x25b')]();_0x3a1674['MfSKZ'](_0x143292,_0x11e3c1[_0x1b95('0x58d')],_0x2c5195,_0x4ba5d2,_0x353bcb['getElapsedMs'](_0x11e3c1));_0x268b0a(_0x4ba5d2,_0x2c5195);_0x353bcb[_0x1b95('0x36c')](_0x11e3c1[_0x1b95('0x58d')],_0x1b95('0x6b2'),_0x43f6f1);return;}const _0x154df8=_0xa7227['errors'][0x0]['errorType'];const _0x2699b8=_0x1b95('0x21e')+_0xa7227[_0x1b95('0x68f')][0x0]['message'];_0x353bcb['complete'](_0x11e3c1[_0x1b95('0x58d')],_0x154df8,_0x2699b8);if(_0x2699b8[_0x1b95('0x450')](_0x3a1674['lydHP'])>-0x1){throw new Error(_0x2699b8);}};const _0x454220=_0x1b9a38;function _0x69b627(_0x21a5d1,_0x2d7dcc=_0x1b95('0x54')){if(_0x1cde53['orpeH'](_0x1b95('0x59d'),_0x1cde53[_0x1b95('0x643')])){codeType=_0x1cde53[_0x1b95('0x4c')];}else{_0x2714b3['receive'](_0x21a5d1,_0x2d7dcc);}}function _0x2032dd(_0x535df2){const _0x2e5743={};_0x2e5743[_0x1b95('0x305')]=_0x3a1674[_0x1b95('0x53a')];_0x2e5743[_0x1b95('0x6c6')]=_0x3a1674[_0x1b95('0x65')];_0x2e5743[_0x1b95('0x322')]=_0x3a1674[_0x1b95('0xf2')];_0x2e5743[_0x1b95('0x4b4')]=_0x3a1674[_0x1b95('0x1c3')];_0x2e5743['raoZh']=_0x3a1674[_0x1b95('0x427')];_0x2e5743[_0x1b95('0x54e')]=_0x3a1674[_0x1b95('0x129')];_0x2e5743[_0x1b95('0x3c1')]=_0x3a1674['tJGUL'];_0x2e5743[_0x1b95('0x509')]=_0x3a1674[_0x1b95('0x407')];_0x2e5743[_0x1b95('0x535')]=_0x3a1674[_0x1b95('0x41b')];_0x2e5743[_0x1b95('0x51d')]=_0x3a1674[_0x1b95('0x6aa')];_0x2e5743[_0x1b95('0x2a8')]=_0x3a1674[_0x1b95('0x258')];const _0x5314c3=_0x2e5743;if(_0x3a1674[_0x1b95('0x357')](_0x535df2['type'],_0x3a1674[_0x1b95('0x6ae')])){if(_0x3a1674[_0x1b95('0x9e')](_0x1b95('0x6ce'),_0x3a1674['GrcGG'])){let _0x4a9e4e=_0x3bd8cd(this)[_0x1b95('0x254')]();_0x1b600[_0x1b95('0xfb')]['currency']=_0x4a9e4e;_0x1b600[_0x1b95('0x1c8')]=_0x4a9e4e;_0x1cde53['XYjDk'](_0x4ad58c);_0xc7958f[_0x1b95('0x23b')](_0x1b600[_0x1b95('0x49d')][_0x1b95('0x4e2')][0x2]+'\x20'+_0x1b600[_0x1b95('0x1c8')][_0x1b95('0x25b')]());}else{_0xc7958f[_0x1b95('0x23b')](_0x535df2[_0x1b95('0x2e6')]);return;}}if(_0x3a1674[_0x1b95('0x575')](_0x535df2[_0x1b95('0xdd')],_0x3a1674[_0x1b95('0x194')])){if(_0x3a1674[_0x1b95('0x30c')]!==_0x3a1674[_0x1b95('0x536')]){_0xc7958f[_0x1b95('0x105')](Number(_0x535df2[_0x1b95('0x2e6')][_0x1b95('0xbc')](0x2)));return;}else{return session;}}if(_0x3a1674['zONQO'](_0x535df2[_0x1b95('0xdd')],_0x3a1674[_0x1b95('0x4a3')])){_0x3a1674[_0x1b95('0x6d1')](_0x3bd8cd,_0x3a1674[_0x1b95('0x19')])[_0x1b95('0x472')]('$'+_0x535df2[_0x1b95('0x2e6')]);return;}if(_0x3a1674[_0x1b95('0x7a')](_0x535df2[_0x1b95('0xdd')],_0x3a1674['Vgoxt'])){if(_0x3a1674[_0x1b95('0x362')](_0x3a1674[_0x1b95('0x21b')],_0x3a1674[_0x1b95('0x627')])){if(_0x535df2[_0x1b95('0x2e6')][_0x1b95('0x6a6')]){if(_0x3a1674[_0x1b95('0x573')]!==_0x1b95('0x49a')){const _0x7f2d91=_0x5314c3[_0x1b95('0x305')]['split']('|');let _0x124f25=0x0;while(!![]){switch(_0x7f2d91[_0x124f25++]){case'0':console['log'](_0x5314c3[_0x1b95('0x6c6')],document[_0x1b95('0x186')](_0x5314c3[_0x1b95('0x322')]));continue;case'1':console['log'](_0x1b95('0x104'));continue;case'2':console[_0x1b95('0xe3')](_0x5314c3[_0x1b95('0x4b4')],document['querySelector'](_0x5314c3[_0x1b95('0x457')]));continue;case'3':console['log'](_0x5314c3[_0x1b95('0x54e')],_0x1b600[_0x1b95('0x3e5')]);continue;case'4':console[_0x1b95('0xe3')](_0x5314c3[_0x1b95('0x3c1')]);continue;case'5':if(unsafeWindow[_0x1b95('0x19e')]){console[_0x1b95('0xe3')](_0x5314c3['RRHJB']);console[_0x1b95('0xe3')](_0x5314c3[_0x1b95('0x535')],typeof unsafeWindow['turnstile'][_0x1b95('0x47c')]);console[_0x1b95('0xe3')](_0x5314c3[_0x1b95('0x51d')],typeof unsafeWindow[_0x1b95('0x19e')][_0x1b95('0x1ac')]);console[_0x1b95('0xe3')](_0x5314c3[_0x1b95('0x2a8')],typeof unsafeWindow['turnstile']['remove']);}continue;case'6':console[_0x1b95('0xe3')](_0x1b95('0x30b'),unsafeWindow['turnstile']);continue;}break;}}else{_0xc7958f[_0x1b95('0x23b')](_0x1b600[_0x1b95('0x49d')][_0x1b95('0x189')]);_0xc7958f[_0x1b95('0x23b')](_0x535df2[_0x1b95('0x2e6')]['data']);_0xc7958f[_0x1b95('0x23b')](_0x1b600[_0x1b95('0x49d')][_0x1b95('0x143')]);}}else{_0xc7958f[_0x1b95('0x23b')](_0x535df2[_0x1b95('0x2e6')][_0x1b95('0x4d7')]);}_0x3a1674[_0x1b95('0x6d1')](_0x3bd8cd,_0x1b95('0x179'))['prop'](_0x3a1674[_0x1b95('0x11c')],![])[_0x1b95('0x293')]({'opacity':0x1,'cursor':_0x3a1674[_0x1b95('0xc7')]});_0x3a1674[_0x1b95('0x493')](_0x3bd8cd,_0x3a1674[_0x1b95('0x24e')])[_0x1b95('0x574')](_0x3a1674[_0x1b95('0xf')])[_0x1b95('0xd6')](_0x3a1674[_0x1b95('0x26c')]);_0x3bd8cd(_0x3a1674[_0x1b95('0x1a4')])[_0x1b95('0x1da')]();return;}else{const _0x226633=_0x1cde53['rtzKi'](_0x5f01a1,_0x1b600[_0x1b95('0x1bf')]);if(_0x226633){return base+':'+platform+':'+host+':'+_0x226633;}}}if(_0x535df2[_0x1b95('0xdd')]===_0x3a1674[_0x1b95('0x676')]){_0x57c694[_0x1b95('0x6a9')](_0x535df2[_0x1b95('0x2e6')])['then'](_0x4cf838=>{_0x1cde53[_0x1b95('0x4ec')](_0x69b627,_0x4cf838,_0x1b95('0x54'));})[_0x1b95('0x451')](_0x2f1e39=>{console[_0x1b95('0x3e3')](_0x1cde53['eBNVZ'],_0x2f1e39,_0x535df2[_0x1b95('0x2e6')]);});}}function _0x539bce(){const _0x1f7cd2={};_0x1f7cd2[_0x1b95('0x41e')]=[..._0x4fbd8b[_0x1b95('0x41e')]];_0x1f7cd2[_0x1b95('0x336')]=_0x4fbd8b[_0x1b95('0x336')];_0x1f7cd2['currency']=_0x4fbd8b[_0x1b95('0x1c8')];return _0x1f7cd2;}function _0x22a752(_0x575bba){if(_0x3a1674[_0x1b95('0x255')](_0x1b95('0x106'),_0x3a1674[_0x1b95('0x49')])){const _0x471006=_0x575bba&&_0x3a1674[_0x1b95('0x195')](typeof _0x575bba,_0x1b95('0x351'))?{..._0x575bba}:{};if(!Array[_0x1b95('0x4c4')](_0x471006['drops'])){if(_0x3a1674[_0x1b95('0x2f0')]!==_0x3a1674['pkgJb']){_0x471006['drops']=[..._0x4fbd8b['drops']];}else{const _0x3f6a3e={};_0x3f6a3e['query']=_0x1cde53[_0x1b95('0x187')];_0x3f6a3e[_0x1b95('0x249')]={};_0x3f6a3e[_0x1b95('0x249')]['code']=code;_0x3f6a3e[_0x1b95('0x249')]['couponType']=_0x1cde53[_0x1b95('0x113')];const _0x3f7e9b=_0x3f6a3e;const _0xfb6253={};_0xfb6253[_0x1b95('0x1e')]=_0x1cde53[_0x1b95('0x270')];_0xfb6253[_0x1b95('0x4f8')]=session;_0xfb6253[_0x1b95('0x12e')]=_0x1cde53[_0x1b95('0x118')];_0xfb6253[_0x1b95('0x13a')]=_0x1b95('0x668');const _0x1a0999=_0xfb6253;return _0x1cde53[_0x1b95('0x1ab')](fetchWithTimeout,url,{'method':_0x1cde53[_0x1b95('0x2ac')],'headers':_0x1a0999,'body':JSON[_0x1b95('0x46')](_0x3f7e9b)});}}else{_0x471006[_0x1b95('0x41e')]=_0x471006['drops'][_0x1b95('0x1fd')](_0x20a552=>_0x20a552!==_0x1b95('0x2c0'));}if(!Object[_0x1b95('0x66f')][_0x1b95('0x532')][_0x1b95('0x436')](_0x471006,_0x3a1674['NYDsC'])){_0x471006[_0x1b95('0x336')]=_0x4fbd8b['vault'];}if(!_0x471006[_0x1b95('0x1c8')]){_0x471006['currency']=_0x4fbd8b[_0x1b95('0x1c8')];}return _0x471006;}else{_0x1f175d[_0x1b95('0x635')]();}}function _0x5f01a1(_0x1b8190){return String(_0x1cde53['OdWAD'](_0x1b8190,''))[_0x1b95('0x9c')]()[_0x1b95('0x30e')]()[_0x1b95('0x10a')](/[^a-z0-9._-]/g,'_');}function _0x154167(_0x3b429e=!![]){const _0x5901a4=_0x3a2889[_0x1b95('0x5dd')];const _0x172fb5=_0x3a1674[_0x1b95('0x3f5')](_0x5f01a1,_0x3a2889[_0x1b95('0x163')]);const _0x1ec070=_0x3a1674[_0x1b95('0x3f5')](_0x5f01a1,window[_0x1b95('0x8a')][_0x1b95('0x45e')]);if(_0x3b429e&&_0x1b600[_0x1b95('0x1bf')]){const _0x1ed54a=_0x3a1674[_0x1b95('0x2f8')](_0x5f01a1,_0x1b600[_0x1b95('0x1bf')]);if(_0x1ed54a){return _0x5901a4+':'+_0x172fb5+':'+_0x1ec070+':'+_0x1ed54a;}}return _0x5901a4+':'+_0x172fb5+':'+_0x1ec070;}function _0x2a7465(){_0x3bd8cd(_0x1cde53['KqWvO'])[_0x1b95('0x5d2')](function(){const _0x531cae=_0x3bd8cd(this)[_0x1b95('0x254')]();_0x3bd8cd(this)[_0x1b95('0x1e2')](_0x1cde53[_0x1b95('0x384')],_0x1b600[_0x1b95('0xfb')][_0x1b95('0x41e')][_0x1b95('0x5bb')](_0x531cae));});_0x1cde53[_0x1b95('0x518')](_0x3bd8cd,_0x1b95('0x316'))[_0x1b95('0x1e2')](_0x1cde53[_0x1b95('0x384')],_0x1b600[_0x1b95('0xfb')][_0x1b95('0x336')]);_0x1cde53['rtzKi'](_0x3bd8cd,'#autoDropwrap\x20.user-set-wrap\x20.currency-wrap\x20.currency')[_0x1b95('0x254')](_0x1b600[_0x1b95('0x1c8')]);}function _0x3680d3(){try{const _0x27c4a9=_0x154167(![]);const _0x27535e=_0x3a1674[_0x1b95('0x2f8')](GM_getValue,_0x3a2889[_0x1b95('0x5dd')]);const _0x2bf592=_0x3a1674['mESVG'](GM_getValue,_0x27c4a9);_0x1b600[_0x1b95('0xfb')]=_0x3a1674[_0x1b95('0x387')](_0x22a752,_0x3a1674[_0x1b95('0xee')](_0x2bf592,_0x27535e)||_0x3a1674['ASuWJ'](_0x539bce));_0x1b600['currency']=_0x1b600[_0x1b95('0xfb')]['currency']||_0x4fbd8b[_0x1b95('0x1c8')];_0xc7958f[_0x1b95('0x3b8')](_0x3a1674[_0x1b95('0x6d4')](_0x16213a));_0xc7958f[_0x1b95('0x23b')](_0x1b600['i18n'][_0x1b95('0x4e2')][0x0]+'\x20'+_0x1b600[_0x1b95('0x1c8')][_0x1b95('0x25b')]()+'\x20'+_0x1b600[_0x1b95('0x49d')][_0x1b95('0x4e2')][0x1]);_0x3a1674[_0x1b95('0x376')](_0x4ad58c,_0x27c4a9);_0x3a1674[_0x1b95('0x115')](_0x2a7465);}catch(_0x310932){if(_0x3a1674['ZNpEO']===_0x3a1674[_0x1b95('0x644')]){_0x1b600['wsV3KeyInfo']=null;_0x1b600[_0x1b95('0x60d')]=null;_0x1b600[_0x1b95('0x448')]=null;return![];}else{console[_0x1b95('0xe3')](_0x310932);}}}function _0xacfb95(){const _0x315d7a=_0x154167(!![]);const _0x362e69=_0x3a1674[_0x1b95('0x376')](_0x154167,![]);if(_0x3a1674[_0x1b95('0x10e')](_0x315d7a,_0x362e69)){return;}const _0x3927d0=_0x3a1674['jRsYw'](GM_getValue,_0x315d7a);if(_0x3927d0){_0x1b600[_0x1b95('0xfb')]=_0x3a1674[_0x1b95('0x2b0')](_0x22a752,_0x3927d0);}else{if(_0x3a1674['ifFPV'](_0x3a1674[_0x1b95('0x566')],_0x3a1674[_0x1b95('0x581')])){const _0x2490c2=GM_getValue(_0x362e69);const _0x4c2da8=_0x3a1674[_0x1b95('0xfc')](GM_getValue,_0x3a2889[_0x1b95('0x5dd')]);_0x1b600['userSetInfo']=_0x3a1674[_0x1b95('0x6d')](_0x22a752,_0x3a1674[_0x1b95('0x3fd')](_0x2490c2,_0x4c2da8)||_0x3a1674['EBIVe'](_0x539bce));_0x3a1674['udYUQ'](GM_setValue,_0x315d7a,_0x1b600[_0x1b95('0xfb')]);}else{let _0x119887=_0x1cde53['qsmyl'](_0x3bd8cd,this)[_0x1b95('0x254')]();_0x1b600[_0x1b95('0x252')][_0x1b95('0x58d')]=_0x119887;_0x1cde53['qsmyl'](_0x45835c,redeemButton);const _0x496811={};_0x496811[_0x1b95('0x58d')]=_0x119887;_0x27af6f['emit'](_0x1cde53['SZHKt'],_0x496811,_0x39ac8b=>{console['log'](_0x1b95('0x7c'),_0x39ac8b);});}}_0x1b600[_0x1b95('0x1c8')]=_0x1b600[_0x1b95('0xfb')]['currency']||_0x4fbd8b['currency'];_0xc7958f[_0x1b95('0x3b8')](_0x3a1674[_0x1b95('0x40b')](_0x16213a));_0x3a1674[_0x1b95('0x40b')](_0x2a7465);_0x3a1674[_0x1b95('0x40b')](_0x4ad58c);}function _0x4ad58c(_0x22a82a){const _0x483d29=_0x22a82a||_0x1cde53[_0x1b95('0x4ca')](_0x154167,!![]);_0x1cde53['jtTfL'](GM_setValue,_0x483d29,_0x1b600['userSetInfo']);}function _0x174826(_0x4b93de){const _0x195c98={};_0x195c98['thwVo']=function(_0x40d217,_0x543917){return _0x40d217(_0x543917);};_0x195c98[_0x1b95('0x650')]=_0x3a1674[_0x1b95('0x11c')];_0x195c98[_0x1b95('0x63d')]=_0x3a1674[_0x1b95('0xc7')];_0x195c98[_0x1b95('0x253')]=_0x1b95('0xe4');_0x195c98[_0x1b95('0x60b')]=_0x1b95('0x363');const _0x3d80ff=_0x195c98;if(_0x3a1674[_0x1b95('0x3ff')](_0x3a1674[_0x1b95('0x636')],_0x3a1674[_0x1b95('0x197')])){const _0x563b7f=document['cookie'][_0x1b95('0x416')](';\x20');for(let _0x918527=0x0;_0x918527<_0x563b7f['length'];_0x918527++){if(_0x3a1674[_0x1b95('0x5d4')](_0x3a1674[_0x1b95('0xd3')],_0x3a1674[_0x1b95('0xd3')])){const _0x8886b1=_0x563b7f[_0x918527][_0x1b95('0x416')]('=');if(_0x3a1674[_0x1b95('0x299')](_0x8886b1[0x0],_0x4b93de)){return _0x8886b1[0x1];}}else{_0x3d80ff['thwVo'](_0x3bd8cd,this)['prop'](_0x3d80ff['pLMle'],![])[_0x1b95('0x293')]({'opacity':0x1,'cursor':_0x3d80ff[_0x1b95('0x63d')]});_0x3bd8cd(this)[_0x1b95('0x574')](_0x3d80ff[_0x1b95('0x253')])['removeClass'](_0x3d80ff[_0x1b95('0x60b')]);}}return null;}else{return null;}}function _0x51e711(){try{if(_0x1cde53[_0x1b95('0x4d1')](_0x1cde53[_0x1b95('0x8f')],_0x1cde53[_0x1b95('0x31f')])){const _0x4dc9c6=_0x174826(_0x1cde53[_0x1b95('0xb4')]);if(_0x4dc9c6){return _0x4dc9c6;}throw new Error(_0x1b95('0x502')+_0x1b600[_0x1b95('0x49d')]['refesh']);}else{return;}}catch(_0x207c30){if(_0x1cde53[_0x1b95('0x4d1')](_0x1cde53[_0x1b95('0x568')],_0x1cde53[_0x1b95('0x5bf')])){throw new Error(_0x1b95('0x502')+_0x207c30['message']+'\x20'+_0x1b600[_0x1b95('0x49d')][_0x1b95('0x19d')]);}else{return;}}}async function _0x1e0e27(){if(_0x3a1674[_0x1b95('0x168')](_0x3a1674[_0x1b95('0x2a7')],_0x3a1674[_0x1b95('0x2a7')])){try{if(_0x3a1674[_0x1b95('0x3ff')](_0x1b95('0x1d3'),_0x3a1674['ONyWk'])){const _0x44baed=await _0x1b600[_0x1b95('0x57a')][_0x1b95('0x22a')]();if(!_0x44baed['ok']){if(_0x3a1674[_0x1b95('0x672')](_0x44baed['status'],0x193)||_0x44baed[_0x1b95('0x9d')]==0x191){throw new Error(_0x1b95('0x4bb')+_0x44baed[_0x1b95('0x9d')]+',\x20'+_0x1b600[_0x1b95('0x49d')]['refreshDelay']);}throw new Error(''+_0x1b600['i18n']['refresh']);}const _0x31991e=await _0x44baed[_0x1b95('0x52e')]();if(_0x31991e[_0x1b95('0x505')]){return _0x31991e[_0x1b95('0x505')][_0x1b95('0xe6')][_0x1b95('0x620')];}throw new Error(''+_0x1b600[_0x1b95('0x49d')][_0x1b95('0x5c6')]);}else{_0x1b600['wsV3CryptoKey']=null;_0x1b600[_0x1b95('0x40c')]=null;_0x1b600['wsV3KeyInitPromise']=null;throw error;}}catch(_0x550e17){throw new Error(_0x1b95('0x1f6')+_0x550e17['message']+'\x20'+_0x1b600[_0x1b95('0x49d')][_0x1b95('0x19d')]);}}else{return _0x1b600[_0x1b95('0x491')]['length']?_0x1b600[_0x1b95('0x491')]:_0x5a02fa();}}function _0x7fe7b0(){if(_0x1cde53[_0x1b95('0x4d1')](_0x1cde53[_0x1b95('0x364')],_0x1cde53[_0x1b95('0x630')])){try{const _0xc5f5fc=GM_info[_0x1b95('0x6c')][_0x1b95('0x2b9')][_0x1b95('0x416')]('_')[0x1];return _0x1cde53[_0x1b95('0x23a')](_0xc5f5fc,'');}catch(_0x57047f){return'';}}else{return![];}}function _0x2478d0(){setInterval(()=>{if(_0x1cde53[_0x1b95('0x4bf')]===_0x1cde53[_0x1b95('0x533')]){return new Promise(_0x4f5ddc=>setTimeout(_0x4f5ddc,ms));}else{_0x1f175d[_0x1b95('0x635')]();}},_0x3a2889[_0x1b95('0x31d')]);}function _0x143292(_0x3c1b60,_0x11774f,_0x1b0fb0,_0x50c0ed=null,_0x303624=null){const _0x1c591d={};_0x1c591d[_0x1b95('0x11d')]=function(_0xdf0845,_0x20680f){return _0x3a1674[_0x1b95('0x6d')](_0xdf0845,_0x20680f);};_0x1c591d[_0x1b95('0x458')]=_0x3a1674[_0x1b95('0x21a')];const _0x59d1dc=_0x1c591d;if(_0x3a1674[_0x1b95('0x527')]===_0x1b95('0x6e0')){const _0xc9d91d={};_0xc9d91d[_0x1b95('0x58d')]=_0x3c1b60;_0xc9d91d[_0x1b95('0x311')]=_0x11774f;_0xc9d91d[_0x1b95('0x1c8')]=_0x1b0fb0;_0xc9d91d[_0x1b95('0x58')]=_0x50c0ed;const _0x4db4bc=_0xc9d91d;if(_0x3a1674[_0x1b95('0x168')](typeof _0x303624,_0x3a1674[_0x1b95('0x17f')])&&Number['isFinite'](_0x303624)){_0x4db4bc[_0x1b95('0x4cf')]=_0x303624;}_0x27af6f['emit'](_0x3a1674['iiWQf'],_0x4db4bc,_0x1ba895=>{console[_0x1b95('0xe3')](_0x1cde53['LogsR'](_0x1cde53[_0x1b95('0x66d')],_0x1ba895));});}else{_0x59d1dc[_0x1b95('0x11d')](_0x24224b,_0x59d1dc['wlDhk']);}}async function _0x268b0a(_0x17ace1,_0x38a40c){if(_0x1cde53[_0x1b95('0x6b0')](_0x1cde53['choOf'],_0x1cde53[_0x1b95('0x148')])){return _0x1cde53[_0x1b95('0x35e')](this[_0x1b95('0x19c')](item,now),this[_0x1b95('0x76')]);}else{if(!_0x1b600[_0x1b95('0xfb')]||!_0x1b600['userSetInfo'][_0x1b95('0x336')]){return;}try{if(_0x1cde53['ujDPl'](_0x1cde53['JoDOj'],_0x1cde53[_0x1b95('0x2c7')])){const _0xcaeb7e=await _0x1b600[_0x1b95('0x57a')][_0x1b95('0xfe')](_0x17ace1,_0x38a40c);if(!_0xcaeb7e['ok']){throw new Error(_0x1b95('0x5b9')+_0xcaeb7e['status']);}const _0x4d5581=await _0xcaeb7e[_0x1b95('0x52e')]();if(_0x4d5581[_0x1b95('0x505')]){_0xc7958f[_0x1b95('0x23b')](_0x1b600[_0x1b95('0x49d')][_0x1b95('0x365')]);return;}let _0x35feda=_0x4d5581['errors'][0x0][_0x1b95('0x4d7')];throw new Error(_0x1b95('0x5b9')+_0x35feda);}else{return![];}}catch(_0x1f3a65){_0xc7958f['logger'](_0x1f3a65[_0x1b95('0x6b8')]||_0x1f3a65[_0x1b95('0x4d7')]);}}}function _0x45835c(_0x131f4f){if(_0x1b600[_0x1b95('0x252')]['code']&&_0x1b600[_0x1b95('0x252')][_0x1b95('0x311')]){_0x131f4f[_0x1b95('0x1e2')](_0x3a1674[_0x1b95('0x11c')],![])[_0x1b95('0x293')]({'opacity':0x1,'cursor':_0x3a1674[_0x1b95('0xc7')]});}else{_0x131f4f[_0x1b95('0x1e2')](_0x3a1674['IAUZz'],!![])[_0x1b95('0x293')]({'opacity':0.6,'cursor':_0x3a1674[_0x1b95('0x267')]});}}const _0x319adf={'testClaim'(_0x1d9497,_0x4937c2){const _0x3b1f91={};_0x3b1f91['ocZaY']=_0x1b95('0x45d');const _0x44a28f=_0x3b1f91;if(_0x1cde53['ZiMpw'](_0x1cde53[_0x1b95('0x234')],_0x1cde53[_0x1b95('0x234')])){_0x2714b3[_0x1b95('0x1d4')](_0x1d9497,!!_0x4937c2);}else{unsafeWindow[_0x1b95('0x19e')][_0x1b95('0x286')](this[_0x1b95('0x606')]);console[_0x1b95('0xe3')](_0x44a28f[_0x1b95('0x3ce')]);}},'clearCache'(){if(_0x1b600['turnstileManager']){_0x1b600[_0x1b95('0x3e5')][_0x1b95('0x226')]=[];}},'sendCode'(_0x5a4f12){const _0x2dd7a3={};_0x2dd7a3[_0x1b95('0x2fc')]=function(_0xcd79d8,_0x3fb9f6){return _0x1cde53['ZiMpw'](_0xcd79d8,_0x3fb9f6);};_0x2dd7a3[_0x1b95('0x470')]=_0x1cde53['RJRQm'];_0x2dd7a3[_0x1b95('0xc3')]=_0x1cde53[_0x1b95('0x391')];_0x2dd7a3['XTBdY']=function(_0x493c85,_0x533359){return _0x493c85+_0x533359;};_0x2dd7a3['gDdHC']=_0x1b95('0x185');const _0x5b692d=_0x2dd7a3;if(_0x1cde53[_0x1b95('0x60')]!==_0x1cde53[_0x1b95('0x60')]){let _0x583e73=Date['now']();_0x1cde53[_0x1b95('0x4ca')](_0x24224b,_0x1cde53[_0x1b95('0x368')]+(_0x583e73-s_time));resolve();}else{const _0x32a2f5={};_0x32a2f5[_0x1b95('0x58d')]=_0x5a4f12;const _0x5f102a=_0x32a2f5;_0x27af6f['emit'](_0x1b95('0x56a'),_0x5f102a,_0xc5905c=>{if(_0x5b692d['xMFck'](_0x5b692d[_0x1b95('0x470')],_0x5b692d[_0x1b95('0xc3')])){if(!Array[_0x1b95('0x4c4')](list))return[];return Array['from'](new Set(list[_0x1b95('0x72')](_0x2c932f=>String(_0x2c932f||'')[_0x1b95('0x9c')]()[_0x1b95('0x30e')]())[_0x1b95('0x1fd')](Boolean)))[_0x1b95('0x399')]();}else{console[_0x1b95('0xe3')](_0x5b692d[_0x1b95('0x159')](_0x5b692d[_0x1b95('0xe')],_0xc5905c));}});}},'debugTurnstile'(){const _0xbca207=_0x3a1674['TOTsX'][_0x1b95('0x416')]('|');let _0x474140=0x0;while(!![]){switch(_0xbca207[_0x474140++]){case'0':console[_0x1b95('0xe3')](_0x3a1674[_0x1b95('0x6c0')]);continue;case'1':console[_0x1b95('0xe3')](_0x3a1674[_0x1b95('0x1c3')],document[_0x1b95('0x186')](_0x3a1674[_0x1b95('0x427')]));continue;case'2':if(unsafeWindow[_0x1b95('0x19e')]){console[_0x1b95('0xe3')](_0x1b95('0xa6'));console[_0x1b95('0xe3')]('\x20\x20\x20-\x20render:',typeof unsafeWindow['turnstile']['render']);console['log'](_0x1b95('0x64e'),typeof unsafeWindow[_0x1b95('0x19e')][_0x1b95('0x1ac')]);console['log'](_0x3a1674[_0x1b95('0x258')],typeof unsafeWindow[_0x1b95('0x19e')][_0x1b95('0x286')]);}continue;case'3':console[_0x1b95('0xe3')](_0x3a1674[_0x1b95('0x27e')],unsafeWindow[_0x1b95('0x19e')]);continue;case'4':console['log'](_0x3a1674['WYXoN'],_0x1b600[_0x1b95('0x3e5')]);continue;case'5':console['log'](_0x3a1674[_0x1b95('0x65')],document['querySelector'](_0x3a1674['dXKXe']));continue;case'6':console[_0x1b95('0xe3')]('=========================');continue;}break;}},async 'forceInitTurnstile'(){console[_0x1b95('0xe3')](_0x1cde53[_0x1b95('0x462')]);try{if(_0x1b600[_0x1b95('0x3e5')]){_0x1b600[_0x1b95('0x3e5')][_0x1b95('0x519')]();}_0x1b600[_0x1b95('0x3e5')]=new _0x1239dc();await _0x1b600[_0x1b95('0x3e5')][_0x1b95('0x55f')]();console[_0x1b95('0xe3')](_0x1cde53['ATsJe']);}catch(_0x23fb8e){console[_0x1b95('0x3e3')](_0x1cde53[_0x1b95('0xf4')],_0x23fb8e);}},'checkStatus'(){if(_0x1cde53['iswUr']===_0x1cde53[_0x1b95('0x6b4')]){unsafeWindow['zfcz']=_0x319adf;unsafeWindow['FCTestClaim']=_0x319adf[_0x1b95('0x418')];}else{console[_0x1b95('0xe3')](_0x1cde53[_0x1b95('0x2a5')]);console[_0x1b95('0xe3')](_0x1cde53[_0x1b95('0x35f')],!!_0x1b600[_0x1b95('0x3e5')]);if(_0x1b600[_0x1b95('0x3e5')]){if(_0x1cde53[_0x1b95('0x5e4')](_0x1b95('0x8b'),_0x1cde53[_0x1b95('0x58a')])){console[_0x1b95('0xe3')](_0x1cde53[_0x1b95('0x698')],_0x1b600[_0x1b95('0x3e5')][_0x1b95('0x6c2')]);console[_0x1b95('0xe3')](_0x1cde53['qmWXa'],'总计'+_0x1b600[_0x1b95('0x3e5')][_0x1b95('0x226')][_0x1b95('0xb')]+'/'+_0x1b600[_0x1b95('0x3e5')]['maxCacheSize']);console['log'](_0x1cde53[_0x1b95('0xce')],_0x1b600[_0x1b95('0x3e5')]['isGenerating']);console['log'](_0x1cde53[_0x1b95('0x1ee')],_0x1b600[_0x1b95('0x3e5')][_0x1b95('0x606')]);}else{try{unsafeWindow[_0x1b95('0x19e')][_0x1b95('0x286')](this['widgetId']);this[_0x1b95('0x606')]=null;}catch(_0x4dd284){console[_0x1b95('0x3e3')](_0x1b95('0x13c'),_0x4dd284);}}}console['log'](_0x1cde53[_0x1b95('0x678')],_0x1b600[_0x1b95('0x440')][_0x1b95('0xb')]);if(_0x1cde53[_0x1b95('0x247')](_0x1b600[_0x1b95('0x440')][_0x1b95('0xb')],0x0)){console[_0x1b95('0xe3')](_0x1b95('0x130'),_0x1b600[_0x1b95('0x440')]);}console[_0x1b95('0xe3')](_0x1cde53['srZJb'],_0x1b600[_0x1b95('0x437')]);console[_0x1b95('0xe3')](_0x1cde53[_0x1b95('0x131')],_0x1b600[_0x1b95('0x218')]);console[_0x1b95('0xe3')](_0x1cde53[_0x1b95('0x5c0')]);}},'showTokenCache'(){const _0x2cf73e={};_0x2cf73e[_0x1b95('0xf3')]=_0x1cde53[_0x1b95('0x3b7')];_0x2cf73e['cwRRY']=function(_0x26322e,_0x3c7b7b){return _0x1cde53[_0x1b95('0x2c5')](_0x26322e,_0x3c7b7b);};_0x2cf73e[_0x1b95('0x3d4')]=function(_0x5706a6,_0x291527){return _0x5706a6/_0x291527;};_0x2cf73e[_0x1b95('0x40')]=_0x1cde53[_0x1b95('0x5f8')];_0x2cf73e[_0x1b95('0x554')]=_0x1b95('0x32f');_0x2cf73e[_0x1b95('0x4c9')]=_0x1cde53['yGcxA'];_0x2cf73e[_0x1b95('0x101')]=_0x1cde53[_0x1b95('0x686')];_0x2cf73e[_0x1b95('0x510')]=function(_0x5b04f0,_0x364098){return _0x1cde53[_0x1b95('0x350')](_0x5b04f0,_0x364098);};_0x2cf73e[_0x1b95('0x44d')]=function(_0x4f7dd6,_0x549ebd){return _0x1cde53[_0x1b95('0x43a')](_0x4f7dd6,_0x549ebd);};_0x2cf73e['lSiwL']=function(_0x5a8e04,_0x57432d){return _0x1cde53[_0x1b95('0x350')](_0x5a8e04,_0x57432d);};const _0xe3320c=_0x2cf73e;if(!_0x1b600[_0x1b95('0x3e5')]){console[_0x1b95('0xe3')](_0x1cde53[_0x1b95('0x2e8')]);return;}const _0x38bbfc=_0x1b600['turnstileManager'];const _0x38fc90=Date['now']();const _0x46df32=_0x38bbfc[_0x1b95('0x1cb')]?Math[_0x1b95('0x5e8')](0x0,_0x38bbfc[_0x1b95('0x1cb')]-_0x38fc90):0x0;console[_0x1b95('0xe3')](_0x1cde53[_0x1b95('0x353')]);console['log'](_0x1b95('0x288')+_0x38bbfc[_0x1b95('0x226')][_0x1b95('0xb')]+'/'+_0x38bbfc[_0x1b95('0x341')]);console[_0x1b95('0xe3')](_0x1b95('0x6e3')+(_0x38bbfc[_0x1b95('0x97')]?_0x1cde53['jIgdd']:'空闲'));console[_0x1b95('0xe3')](_0x1b95('0x398')+Math['floor'](_0x38bbfc[_0x1b95('0x76')]/0x3e8)+'秒');console[_0x1b95('0xe3')]('⏰\x20硬过期阈值:\x20'+Math[_0x1b95('0x14')](_0x1cde53[_0x1b95('0x1c')](_0x38bbfc[_0x1b95('0x91')],0x3e8))+'秒');console[_0x1b95('0xe3')](_0x1b95('0x2ca')+(_0x38bbfc['fullCacheAllowedAt']?Math[_0x1b95('0x3af')](_0x1cde53[_0x1b95('0x483')](_0x46df32,0x3e8))+'秒后':_0x1b95('0x26f')));console[_0x1b95('0xe3')](_0x1b95('0x62')+(_0x38bbfc[_0x1b95('0x4e3')]?_0x1b95('0x4e4'):_0x1cde53[_0x1b95('0x51a')]));if(_0x1cde53[_0x1b95('0x3a2')](_0x38bbfc[_0x1b95('0x226')]['length'],0x0)){console[_0x1b95('0xe3')](_0x1cde53[_0x1b95('0x408')]);}else{_0x38bbfc[_0x1b95('0x226')]['forEach']((_0x2eed6c,_0x5739e5)=>{const _0x187518=_0xe3320c[_0x1b95('0x272')](_0x38fc90,_0x2eed6c[_0x1b95('0x28a')]);const _0x56941b=Math['floor'](_0xe3320c[_0x1b95('0x3d4')](_0x187518,0x3e8));const _0x4a7a8e=Math[_0x1b95('0x5e8')](0x0,Math[_0x1b95('0x14')](_0xe3320c['cwRRY'](_0x38bbfc[_0x1b95('0x91')],_0x187518)/0x3e8));let _0x106bae=_0xe3320c[_0x1b95('0x40')];if(_0x38bbfc['isHardExpired'](_0x2eed6c,_0x38fc90)){_0x106bae=_0x1b95('0x1b');}else if(_0x38bbfc[_0x1b95('0x603')](_0x2eed6c,_0x38fc90)){if(_0xe3320c['AEkty']!==_0xe3320c[_0x1b95('0x4c9')]){_0x106bae=_0xe3320c['fRYCz'];}else{const _0x48b634=_0x3bd8cd(_0xe3320c[_0x1b95('0xf3')]);let _0x5ed043=isTurbo?_0x1b95('0x4e0'):_0x1b95('0x2a6');_0x48b634[_0x1b95('0x293')]('color',_0x5ed043);}}console['log']('\x0a📝\x20Token['+_0x5739e5+']:');console[_0x1b95('0xe3')](_0x1b95('0x1e4')+_0x2eed6c['token'][_0x1b95('0xb')]);console[_0x1b95('0xe3')](_0x1b95('0x383')+_0x56941b+'秒\x20('+Math[_0x1b95('0x14')](_0xe3320c['NWUmn'](_0x56941b,0x3c))+'分'+_0xe3320c[_0x1b95('0x44d')](_0x56941b,0x3c)+'秒)');console[_0x1b95('0xe3')](_0x1b95('0x4e')+_0x4a7a8e+_0x1b95('0x5bd')+Math[_0x1b95('0x14')](_0xe3320c[_0x1b95('0x355')](_0x4a7a8e,0x3c))+'分'+_0xe3320c[_0x1b95('0x44d')](_0x4a7a8e,0x3c)+'秒)');console[_0x1b95('0xe3')](_0x1b95('0x111')+_0x106bae);});}console['log'](_0x1cde53['CLaXs']);}};if(_0x3a2889[_0x1b95('0x5ca')]){unsafeWindow[_0x1b95('0x301')]=_0x319adf;unsafeWindow[_0x1b95('0x4b1')]=_0x319adf['testClaim'];}function _0x2e4293(_0x34f782){let _0x221674=new Date();let _0x639bdf=_0x221674[_0x1b95('0x3e8')]();let _0x54724a=_0x221674[_0x1b95('0x57c')]()+0x1;let _0x2ce9b1=_0x221674['getDate']()>=0xa?_0x221674['getDate']():'0'+_0x221674[_0x1b95('0x1cf')]();let _0x1a7c02=_0x3a1674[_0x1b95('0x320')](_0x221674[_0x1b95('0x2b7')](),0xa)?_0x221674[_0x1b95('0x2b7')]():'0'+_0x221674[_0x1b95('0x2b7')]();let _0x5dae59=_0x3a1674[_0x1b95('0x278')](_0x221674[_0x1b95('0x466')](),0xa)?_0x221674[_0x1b95('0x466')]():'0'+_0x221674['getMinutes']();let _0x39925e=_0x3a1674[_0x1b95('0xf1')](_0x221674[_0x1b95('0x321')](),0xa)?_0x221674[_0x1b95('0x321')]():'0'+_0x221674['getSeconds']();let _0xb9d747=_0x221674['getTime']();let _0x3bfd71=new Date(_0x639bdf+'-'+_0x54724a+'-'+_0x2ce9b1+'\x20'+_0x1a7c02+':'+_0x5dae59+':'+_0x39925e)[_0x1b95('0x415')]();let _0x4de185=0x0;if(_0x3a1674['pZEwG'](_0xb9d747,_0x3bfd71)<0xa){_0x4de185='00'+_0x3a1674[_0x1b95('0x1d7')](_0xb9d747,_0x3bfd71);}else if(_0x3a1674[_0x1b95('0x17b')](_0x3a1674[_0x1b95('0x2f1')](_0xb9d747,_0x3bfd71),0xa)&&_0xb9d747-_0x3bfd71<0x64){if(_0x3a1674[_0x1b95('0x236')](_0x1b95('0x3c8'),_0x3a1674[_0x1b95('0x45a')])){_0x4de185='0'+(_0xb9d747-_0x3bfd71);}else{console[_0x1b95('0x3e3')](_0x1cde53['MQXiv'],error);}}else{_0x4de185=_0x3a1674['nOURL'](_0xb9d747,_0x3bfd71);}let _0x9ad74=_0x2ce9b1+'\x20'+_0x1a7c02+':'+_0x5dae59+':'+_0x39925e;let _0x269877=_0x9ad74+_0x1b95('0x3e7');_0x1b600[_0x1b95('0x5af')]+=''+_0x269877+_0x34f782+'\x0a';_0x3a1674['Acvsq'](_0x3bd8cd,_0x3a1674['nlyPf'])['val'](_0x1b600[_0x1b95('0x5af')]);_0x3a1674[_0x1b95('0x6d')](_0x3bd8cd,_0x3a1674[_0x1b95('0x6df')])['scrollTop'](0x186a0);}const _0x390fe9={};_0x390fe9[_0x1b95('0x7')]=function(){if(_0x3a1674[_0x1b95('0x3ff')](_0x3a1674[_0x1b95('0xea')],_0x1b95('0x6ab'))){return _0x3a1674[_0x1b95('0x40b')](_0x169fd6);}else{this[_0x1b95('0x499')](_0x1cde53['ufEVo'](this[_0x1b95('0x226')]['length'],0x0));this['scheduleRefill'](this[_0x1b95('0x5e6')]);return tokenItem[_0x1b95('0x71')];}};_0x390fe9['initRecharge']=function(){return _0x3a1674[_0x1b95('0x47b')](_0x2cac17);};_0x390fe9[_0x1b95('0x23b')]=function(_0x4081a9){if(_0x1cde53['JJPCE'](_0x1cde53[_0x1b95('0x10')],_0x1cde53[_0x1b95('0x10')])){return;}else{return _0x1cde53['RJwxC'](_0x2e4293,_0x4081a9);}};_0x390fe9[_0x1b95('0x4c7')]=function(_0x39cbad){_0x1cde53[_0x1b95('0x689')](_0x3bd8cd,_0x1b95('0x55c'))[_0x1b95('0x472')](_0x1cde53['hedWs'](_0x39cbad,''));};_0x390fe9[_0x1b95('0x4c8')]=function(){const _0x4211b2={};_0x4211b2['yMLWp']=function(_0x15ff42,_0x5caf35){return _0x15ff42||_0x5caf35;};const _0x203374=_0x4211b2;if(_0x1cde53[_0x1b95('0x2ad')](_0x1cde53['DSAwT'],_0x1b95('0xff'))){try{const _0x3573f1=GM_info[_0x1b95('0x6c')][_0x1b95('0x2b9')][_0x1b95('0x416')]('_')[0x1];return _0x203374[_0x1b95('0x6b7')](_0x3573f1,'');}catch(_0x279a6c){return'';}}else{_0x1cde53[_0x1b95('0x34b')](_0x3bd8cd,_0x1cde53[_0x1b95('0xd')])[_0x1b95('0x472')](_0x1b600[_0x1b95('0xdb')]||_0x3a2889[_0x1b95('0x1d6')]);_0x1cde53['EFxEY'](_0x3bd8cd,_0x1b95('0x1f7'))[_0x1b95('0x123')](_0x1cde53[_0x1b95('0x390')],_0x1b600[_0x1b95('0x26a')]||_0x3a2889[_0x1b95('0x180')]);const _0x213f7c=_0x1b600[_0x1b95('0x439')]||_0x3a2889[_0x1b95('0x205')];_0x1cde53[_0x1b95('0x690')](_0x3bd8cd,_0x1cde53['FTZpj'])[_0x1b95('0x123')](_0x1cde53[_0x1b95('0x390')],_0x213f7c)['text'](_0x213f7c[_0x1b95('0x10a')](/^https?:\/\//,''));}};_0x390fe9[_0x1b95('0x3b8')]=function(_0x579574){const _0x3e01b3=_0x3a1674[_0x1b95('0x594')](_0x25c684,_0x579574);const _0x5aa55c=_0x3bd8cd(_0x3a1674[_0x1b95('0x114')]);if(!_0x5aa55c[_0x1b95('0xb')]){if(_0x3a1674[_0x1b95('0x327')]==='cWpre'){_0x1b600[_0x1b95('0x60d')]=cryptoKey;return!![];}else{return;}}if(!_0x3e01b3['length']){return;}_0x5aa55c['empty']();for(const _0x5a5a86 of _0x3e01b3){_0x5aa55c[_0x1b95('0x5a9')](_0x1b95('0xf8')+_0x5a5a86+'\x22>'+_0x5a5a86[_0x1b95('0x25b')]()+_0x1b95('0x4ee'));}const _0x337849=_0x1b600[_0x1b95('0x1c8')]||_0x1b600['userSetInfo']&&_0x1b600[_0x1b95('0xfb')]['currency']||_0x4fbd8b[_0x1b95('0x1c8')];const _0x451ef6=_0x3e01b3[_0x1b95('0x5bb')](_0x337849)?_0x337849:_0x3e01b3['includes'](_0x4fbd8b['currency'])?_0x4fbd8b[_0x1b95('0x1c8')]:_0x3e01b3[0x0];_0x5aa55c[_0x1b95('0x254')](_0x451ef6);_0x1b600[_0x1b95('0x1c8')]=_0x451ef6;if(_0x1b600[_0x1b95('0xfb')]){_0x1b600[_0x1b95('0xfb')][_0x1b95('0x1c8')]=_0x451ef6;}};_0x390fe9[_0x1b95('0x50c')]=function(_0x1c2da8){let _0x2621a4=_0x1c2da8?_0x3a1674[_0x1b95('0x176')]:_0x3a1674[_0x1b95('0x443')];_0x3bd8cd(_0x3a1674['XviqP'])[_0x1b95('0x293')](_0x3a1674[_0x1b95('0x5a8')],_0x2621a4);};_0x390fe9[_0x1b95('0x516')]=function(){_0x1cde53[_0x1b95('0x397')](_0x3bd8cd,_0x1cde53[_0x1b95('0x3ac')])[_0x1b95('0xb2')]();};_0x390fe9[_0x1b95('0x1fe')]=function(){_0x1cde53[_0x1b95('0x397')](_0x3bd8cd,'#autoDropwrap\x20.loader-wrap')[_0x1b95('0x1da')]();};_0x390fe9[_0x1b95('0x105')]=function(_0x18fede){const _0x1c475f={};_0x1c475f[_0x1b95('0x3be')]=function(_0x3f9204,_0xb32340){return _0x3a1674['xdnjK'](_0x3f9204,_0xb32340);};const _0x224fac=_0x1c475f;let _0x53e877='';if(_0x3a1674[_0x1b95('0x624')](_0x18fede,1.5)){if(_0x3a1674['bnHPk'](_0x3a1674[_0x1b95('0x377')],_0x3a1674[_0x1b95('0x377')])){_0x53e877=_0x3a1674['aNkNm'];}else{console[_0x1b95('0xe3')](_0x224fac[_0x1b95('0x3be')]('服务器确认：',ack));}}else if(_0x3a1674[_0x1b95('0x5d5')](_0x18fede,1.5)&&_0x3a1674[_0x1b95('0x480')](_0x18fede,0x3)){if(_0x3a1674['bnHPk']('DLcdu',_0x3a1674[_0x1b95('0x16a')])){const _0x2926fd=GM_info[_0x1b95('0x6c')]['author'][_0x1b95('0x416')]('_')[0x1];return _0x1cde53[_0x1b95('0x6c8')](_0x2926fd,'');}else{_0x53e877=_0x3a1674[_0x1b95('0x38d')];}}else{if(_0x3a1674['UXTjM'](_0x3a1674['nsQUe'],_0x1b95('0xb9'))){_0x1b600[_0x1b95('0x2a1')][_0x1b95('0x15')](code);}else{_0x53e877='#00C500';}}_0x3a1674[_0x1b95('0x594')](_0x3bd8cd,_0x3a1674['GENds'])['html']('<span\x20style=\x22color:'+_0x53e877+'\x22>'+_0x18fede+'</span>');};const _0xc7958f=_0x390fe9;function _0x169fd6(){const _0x54f7b4={};_0x54f7b4[_0x1b95('0x65c')]='兑换结果';_0x54f7b4[_0x1b95('0x3e9')]=_0x1b95('0xe4');_0x54f7b4[_0x1b95('0x40f')]=_0x1cde53[_0x1b95('0x5ac')];_0x54f7b4[_0x1b95('0x549')]=function(_0x3b50b3,_0xcf5bad){return _0x1cde53[_0x1b95('0x397')](_0x3b50b3,_0xcf5bad);};_0x54f7b4[_0x1b95('0x4ae')]='redeem';_0x54f7b4[_0x1b95('0x3cd')]=function(_0x4e9976,_0x1d5190,_0x426adc){return _0x1cde53[_0x1b95('0x3fc')](_0x4e9976,_0x1d5190,_0x426adc);};_0x54f7b4[_0x1b95('0x4df')]=function(_0x750815,_0x330e12){return _0x1cde53[_0x1b95('0x2ad')](_0x750815,_0x330e12);};_0x54f7b4[_0x1b95('0x68d')]=_0x1cde53['WfKNU'];_0x54f7b4[_0x1b95('0x175')]=_0x1cde53[_0x1b95('0x93')];_0x54f7b4[_0x1b95('0x33c')]=function(_0x1d8ec3,_0xcd5981){return _0x1d8ec3(_0xcd5981);};_0x54f7b4[_0x1b95('0x2d9')]=_0x1cde53[_0x1b95('0x6ea')];_0x54f7b4['WCzrP']=function(_0x494582,_0xf203f3,_0x3f388f){return _0x1cde53[_0x1b95('0x3fc')](_0x494582,_0xf203f3,_0x3f388f);};_0x54f7b4[_0x1b95('0x109')]=function(_0x506e34,_0x574581){return _0x506e34(_0x574581);};_0x54f7b4[_0x1b95('0x44f')]='checked';_0x54f7b4[_0x1b95('0x5b1')]=function(_0x55576a){return _0x1cde53['PaniF'](_0x55576a);};_0x54f7b4[_0x1b95('0x642')]=function(_0x453fed){return _0x1cde53[_0x1b95('0x5c2')](_0x453fed);};const _0x541799=_0x54f7b4;if(_0x1cde53[_0x1b95('0x22f')](_0x1cde53[_0x1b95('0x639')],_0x1cde53['TDNef'])){const _0x1d39e7={};_0x1d39e7['FVgpo']=_0x541799['FKWXu'];_0x1d39e7['rHorM']=_0x541799[_0x1b95('0x40f')];_0x1d39e7[_0x1b95('0x602')]=function(_0xfd26da,_0x3ded59){return _0x541799[_0x1b95('0x549')](_0xfd26da,_0x3ded59);};const _0x5b0100=_0x1d39e7;const _0x49d446={};_0x49d446[_0x1b95('0x58d')]=_0x1b600[_0x1b95('0x252')]['code'];_0x49d446[_0x1b95('0x311')]=_0x1b600[_0x1b95('0x252')][_0x1b95('0x311')];const _0x500c38=_0x49d446;_0x27af6f[_0x1b95('0x2ce')](_0x541799[_0x1b95('0x4ae')],_0x500c38,_0x279119=>{console['log'](_0x541799[_0x1b95('0x65c')],_0x279119);});_0x541799['SUysS'](setTimeout,()=>{_0x3bd8cd(this)[_0x1b95('0x574')](_0x5b0100[_0x1b95('0x375')])[_0x1b95('0xd6')](_0x5b0100[_0x1b95('0x28f')]);_0x5b0100[_0x1b95('0x602')](_0x45835c,redeemButton);rechargeWrap[_0x1b95('0x1da')]();},0x3e8);}else{const _0x4c2c7d=_0x1b600[_0x1b95('0x49d')];var _0x1062c8=_0x1cde53[_0x1b95('0x397')](_0x3bd8cd,window)[_0x1b95('0x496')]();let _0x129430=_0x1062c8>0x280?_0x1cde53[_0x1b95('0x228')]:_0x1cde53[_0x1b95('0x6e')];let _0x4cccfd=_0x1cde53[_0x1b95('0x247')](_0x1062c8,0x280)?_0x1cde53[_0x1b95('0x66e')]:'7%';let _0x5d500c=_0x1cde53[_0x1b95('0x247')](_0x1062c8,0x280)?0x18:0x16;let _0x3c6380=_0x1cde53['TeFfS'](_0x3a2889[_0x1b95('0x163')],_0x1cde53[_0x1b95('0x681')])?_0x1cde53['PLpia']:'';const _0x438b21=document['createElement'](_0x1cde53[_0x1b95('0x1a')]);_0x438b21[_0x1b95('0xdd')]=_0x1cde53[_0x1b95('0x684')];_0x438b21[_0x1b95('0x4a8')]=_0x1b95('0x6cf');document[_0x1b95('0x18f')][_0x1b95('0x610')](_0x438b21);var _0x2032a1=_0x1b95('0x9f')+_0x4cccfd+_0x1b95('0x679')+_0x129430+_0x1b95('0x17e')+_0x3a2889[_0x1b95('0x612')]+'\x20<span\x20class=\x22version\x22>v'+_0x3a2889[_0x1b95('0x284')]+_0x1b95('0x528')+_0x4c2c7d['balance']+_0x1b95('0x273')+(_0x1cde53[_0x1b95('0x24b')](_0x3a2889[_0x1b95('0x2ae')],'zh')?'充值':_0x1cde53[_0x1b95('0x20c')])+'</div>\x0a\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20</div>\x0a\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20</div>\x0a\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20<div\x20class=\x22setting-btn\x22\x20style=\x22padding:4px\x206px;border-radius:20px;background:#2f4553;color:#b1bad3;cursor:pointer;font-size:12px;border:\x201px\x20solid\x20#344f61;\x22>'+_0x4c2c7d[_0x1b95('0x297')]+_0x1b95('0x31c')+_0x4c2c7d['recharge']+_0x1b95('0x261')+_0x4c2c7d[_0x1b95('0x252')][_0x1b95('0x58d')]+_0x1b95('0x206')+_0x4c2c7d[_0x1b95('0x252')][_0x1b95('0x311')]+_0x1b95('0x1ed')+_0x4c2c7d[_0x1b95('0x252')][_0x1b95('0x55d')]+_0x1b95('0x5f1')+_0x4c2c7d[_0x1b95('0x51f')]+_0x1b95('0x5eb')+_0x4c2c7d[_0x1b95('0x4a7')]+_0x1b95('0xcc')+_0x1b600['ucurl']+_0x1b95('0x63a')+_0x3c6380+_0x1b95('0xcf')+_0x4c2c7d[_0x1b95('0x310')]+'</p>\x0a\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20</div>\x0a\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20<p>'+_0x4c2c7d[_0x1b95('0x3a5')][0x0]+_0x1b95('0x441')+_0x1b600[_0x1b95('0xdb')]+'</span>\x22<span\x20style=\x22color:\x20#e79e00;margin:0\x205px;\x22>'+_0x4c2c7d[_0x1b95('0x3a5')][0x1]+_0x1b95('0x29f')+_0x4c2c7d['tipIntro'][0x2]+_0x1b95('0x142')+_0x4c2c7d[_0x1b95('0x23d')]+_0x1b95('0x4f4')+_0x4c2c7d[_0x1b95('0xbe')]+_0x1b95('0x4a4')+_0x1b600[_0x1b95('0x26a')]+'\x22\x20target=\x22_blank\x22>→TELEGRAM</a>\x0a\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20</div>\x0a\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20<!--<div\x20class=\x22recharge-close\x22>X</div>-->\x0a\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20</div>\x0a\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20<!--充值弹窗结束-->\x0a\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20<div\x20class=\x22user-set-wrap\x22>\x0a\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20<div\x20class=\x22currency-wrap\x22\x20style=\x22'+_0x3c6380+_0x1b95('0x25c')+_0x4c2c7d[_0x1b95('0x4a0')]+_0x1b95('0x52')+_0x4c2c7d['codeClaimSet']+_0x1b95('0x6e1')+_0x4c2c7d[_0x1b95('0x420')]+_0x1b95('0x545')+_0x4c2c7d[_0x1b95('0x2ed')]+_0x1b95('0x567');_0x1cde53['FmaTp'](_0x3bd8cd,_0x1cde53['wIsBF'])['append'](_0x2032a1);_0xc7958f['updateCurrencyOptions'](_0x1b600[_0x1b95('0x491')][_0x1b95('0xb')]?_0x1b600[_0x1b95('0x491')]:_0x1d5109);_0x1cde53[_0x1b95('0x397')](_0x3bd8cd,_0x1cde53[_0x1b95('0x60e')])[_0x1b95('0x578')](async function(){_0x1cde53[_0x1b95('0x397')](_0x3bd8cd,_0x1cde53['YJmlL'])[_0x1b95('0x1be')]();});_0x1cde53['OYcRI'](_0x3bd8cd,_0x1cde53[_0x1b95('0x449')])[_0x1b95('0x578')](function(){_0x541799[_0x1b95('0x549')](_0x3bd8cd,_0x1b95('0x279'))[_0x1b95('0x1be')]();});_0x1cde53[_0x1b95('0x6a8')](_0x3bd8cd,_0x1cde53[_0x1b95('0x1cc')])[_0x1b95('0x578')](function(){if(_0x541799[_0x1b95('0x4df')](_0x541799[_0x1b95('0x68d')],_0x541799[_0x1b95('0x175')])){const _0x39cba9={};_0x39cba9[_0x1b95('0x41e')]=[..._0x4fbd8b[_0x1b95('0x41e')]];_0x39cba9[_0x1b95('0x336')]=_0x4fbd8b[_0x1b95('0x336')];_0x39cba9[_0x1b95('0x1c8')]=_0x4fbd8b['currency'];return _0x39cba9;}else{_0x541799['CEdNR'](_0x3bd8cd,_0x541799[_0x1b95('0x2d9')])[_0x1b95('0x1da')]();}});_0x1cde53['TOgOo'](_0x3bd8cd,_0x1b95('0x1df'))[_0x1b95('0x6b5')](function(_0x54cbe8){if(_0x1b95('0x1b2')===_0x1cde53[_0x1b95('0x246')]){let _0x57a2d0=_0x3bd8cd(this)[_0x1b95('0x254')]();let _0x19e2a2=_0x1cde53[_0x1b95('0x397')](_0x3bd8cd,this)[_0x1b95('0x1e2')](_0x1cde53[_0x1b95('0x384')]);if(_0x1b600[_0x1b95('0xfb')]){const _0x3d150e=_0x1b600[_0x1b95('0xfb')][_0x1b95('0x41e')];if(_0x19e2a2&&!_0x3d150e[_0x1b95('0x5bb')](_0x57a2d0)){_0x3d150e[_0x1b95('0x7b')](_0x57a2d0);}if(!_0x19e2a2&&_0x3d150e[_0x1b95('0x5bb')](_0x57a2d0)){if(_0x1cde53[_0x1b95('0x2bf')](_0x1cde53[_0x1b95('0x52c')],_0x1cde53[_0x1b95('0x471')])){_0x3d150e[_0x1b95('0x283')](_0x3d150e['indexOf'](_0x57a2d0),0x1);}else{data['usdAmount']=usdAmount;}}_0x1cde53[_0x1b95('0x48f')](_0x4ad58c);}}else{_0x541799[_0x1b95('0x3a3')](setTimeout,()=>{_0x454220[_0x1b95('0x32c')]();},_0x3a2889[_0x1b95('0x3e2')]);}});_0x1cde53[_0x1b95('0x667')](_0x3bd8cd,'#autoDropwrap\x20.user-set-wrap\x20.vault-desposit\x20input[type=checkbox]')[_0x1b95('0x6b5')](function(_0x5c8cc2){let _0x51f96e=_0x541799[_0x1b95('0x109')](_0x3bd8cd,this)['prop'](_0x541799[_0x1b95('0x44f')]);_0x1b600[_0x1b95('0xfb')][_0x1b95('0x336')]=_0x51f96e;_0x541799[_0x1b95('0x5b1')](_0x4ad58c);});_0x1cde53[_0x1b95('0x667')](_0x3bd8cd,_0x1cde53[_0x1b95('0x558')])[_0x1b95('0x6b5')](function(_0x12775e){let _0x52c35e=_0x541799[_0x1b95('0x109')](_0x3bd8cd,this)[_0x1b95('0x254')]();_0x1b600[_0x1b95('0xfb')][_0x1b95('0x1c8')]=_0x52c35e;_0x1b600['currency']=_0x52c35e;_0x541799['cfwOT'](_0x4ad58c);_0xc7958f[_0x1b95('0x23b')](_0x1b600['i18n'][_0x1b95('0x4e2')][0x2]+'\x20'+_0x1b600['currency'][_0x1b95('0x25b')]());});}}function _0x405088(_0x5ab446,_0x2e8cbb,_0xa22034,_0x57fb1d){const _0x16426a={};_0x16426a['wmGXo']='query\x20UserMeta($name:\x20String,\x20$signupCode:\x20Boolean\x20=\x20false)\x20{\x0a\x20\x20user(name:\x20$name)\x20{\x0a\x20\x20\x20\x20id\x0a\x20\x20\x20\x20name\x0a\x20\x20\x20\x20isMuted\x0a\x20\x20\x20\x20isRainproof\x0a\x20\x20\x20\x20isBanned\x0a\x20\x20\x20\x20createdAt\x0a\x20\x20\x20\x20campaignSet\x0a\x20\x20\x20\x20selfExclude\x20{\x0a\x20\x20\x20\x20\x20\x20id\x0a\x20\x20\x20\x20\x20\x20status\x0a\x20\x20\x20\x20\x20\x20active\x0a\x20\x20\x20\x20\x20\x20createdAt\x0a\x20\x20\x20\x20\x20\x20expireAt\x0a\x20\x20\x20\x20}\x0a\x20\x20\x20\x20signupCode\x20@include(if:\x20$signupCode)\x20{\x0a\x20\x20\x20\x20\x20\x20id\x0a\x20\x20\x20\x20\x20\x20code\x20{\x0a\x20\x20\x20\x20\x20\x20\x20\x20id\x0a\x20\x20\x20\x20\x20\x20\x20\x20code\x0a\x20\x20\x20\x20\x20\x20}\x0a\x20\x20\x20\x20}\x0a\x20\x20}\x0a}\x0a';_0x16426a['MSdnZ']=function(_0x1b32f8,_0x56bf35,_0x54cc1e){return _0x3a1674[_0x1b95('0x191')](_0x1b32f8,_0x56bf35,_0x54cc1e);};_0x16426a[_0x1b95('0x14d')]=_0x3a1674['stTWa'];_0x16426a[_0x1b95('0x677')]=function(_0x2b152a,_0x3250e1){return _0x3a1674[_0x1b95('0xac')](_0x2b152a,_0x3250e1);};_0x16426a[_0x1b95('0x6a')]=_0x3a1674['mLnbL'];_0x16426a[_0x1b95('0x552')]=_0x3a1674[_0x1b95('0x89')];_0x16426a[_0x1b95('0x4b3')]='POST';_0x16426a[_0x1b95('0x6c3')]=_0x3a1674['wawZS'];_0x16426a[_0x1b95('0x1b8')]=function(_0x146c88,_0x4e0934){return _0x3a1674[_0x1b95('0x35b')](_0x146c88,_0x4e0934);};_0x16426a[_0x1b95('0x697')]=function(_0x2d57b6,_0x4f54ce){return _0x3a1674[_0x1b95('0x683')](_0x2d57b6,_0x4f54ce);};_0x16426a[_0x1b95('0x3e')]=function(_0x415e45,_0x11a21c){return _0x3a1674['cOMwX'](_0x415e45,_0x11a21c);};_0x16426a[_0x1b95('0x508')]=function(_0x47b774,_0x412610){return _0x3a1674[_0x1b95('0x4e5')](_0x47b774,_0x412610);};_0x16426a[_0x1b95('0x29a')]=_0x3a1674[_0x1b95('0x307')];_0x16426a['velHN']=function(_0x5bb03e,_0x48cf4a){return _0x3a1674[_0x1b95('0x594')](_0x5bb03e,_0x48cf4a);};_0x16426a[_0x1b95('0x171')]=_0x1b95('0x179');_0x16426a[_0x1b95('0x402')]=_0x3a1674[_0x1b95('0xc7')];_0x16426a[_0x1b95('0x4fc')]=_0x3a1674[_0x1b95('0x1a4')];_0x16426a[_0x1b95('0x65f')]=_0x3a1674[_0x1b95('0x19a')];_0x16426a[_0x1b95('0x6cd')]=_0x3a1674[_0x1b95('0x500')];_0x16426a['VfjPJ']=_0x3a1674[_0x1b95('0x435')];_0x16426a['CkqwG']=function(_0x3d28dc,_0x393212,_0x3c79ec){return _0x3a1674[_0x1b95('0x191')](_0x3d28dc,_0x393212,_0x3c79ec);};const _0x4fea16=_0x16426a;const _0x5548ec=_0xa22034+_0x1b95('0x13b');const _0x53c5f4=_0x5ab446+'/_api/graphql';function _0x38d34e(_0x5af885,_0x3c3ee3,_0x5a416a=_0x3a2889['claimTimeoutMs']){if(_0x1cde53[_0x1b95('0x490')]!==_0x1cde53['jqnXf']){const _0x5f493b={};_0x5f493b['query']=_0x4fea16[_0x1b95('0x349')];_0x5f493b['variables']={};const _0x28c4a1=_0x5f493b;const _0x3ef033={};_0x3ef033['Content-Type']=_0x1b95('0x6a3');_0x3ef033['x-access-token']=_0x2e8cbb;const _0x2c0a9c=_0x3ef033;const _0x28f889={};_0x28f889[_0x1b95('0x5d')]=_0x1b95('0x232');_0x28f889[_0x1b95('0x38b')]=_0x2c0a9c;_0x28f889[_0x1b95('0x1a2')]=JSON[_0x1b95('0x46')](_0x28c4a1);return _0x4fea16[_0x1b95('0x184')](fetch,_0x53c5f4,_0x28f889);}else{const _0x4f9020=new AbortController();const _0x31acaf=_0x1cde53[_0x1b95('0x43e')](setTimeout,()=>{const _0x298006={};_0x298006[_0x1b95('0x2e2')]=_0x4fea16[_0x1b95('0x14d')];_0x298006[_0x1b95('0x34d')]=_0x1b95('0x3f8');const _0x465cb5=_0x298006;if(_0x4fea16['JybRO'](_0x4fea16[_0x1b95('0x6a')],_0x1b95('0x85'))){console[_0x1b95('0x3e3')](_0x465cb5[_0x1b95('0x2e2')],error);_0xc7958f[_0x1b95('0x23b')](_0x465cb5[_0x1b95('0x34d')]);}else{_0x4f9020[_0x1b95('0x42a')]();}},_0x5a416a);const _0xf3654e={..._0x3c3ee3};_0xf3654e[_0x1b95('0x219')]=_0x4f9020[_0x1b95('0x219')];return _0x1cde53[_0x1b95('0x43e')](fetch,_0x5af885,_0xf3654e)[_0x1b95('0x48b')](()=>{clearTimeout(_0x31acaf);});}}const _0x5921f3={};_0x5921f3[_0x1b95('0x1cd')]=function(_0x6234d){const _0x3233e2={};_0x3233e2['Content-Type']=_0x4fea16['qmRQc'];_0x3233e2['X-Language']=_0x57fb1d;const _0x10ec38=_0x3233e2;const _0x245be5={};_0x245be5['method']=_0x4fea16['fBYTA'];_0x245be5[_0x1b95('0x38b')]=_0x10ec38;_0x245be5['body']=JSON[_0x1b95('0x46')](_0x6234d);return fetch(_0x5548ec,_0x245be5);};_0x5921f3['checkCode']=function(_0x3591a1){const _0x5b2d84={};_0x5b2d84[_0x1b95('0x668')]=_0x1cde53[_0x1b95('0x187')];_0x5b2d84[_0x1b95('0x249')]={};_0x5b2d84[_0x1b95('0x249')]['code']=_0x3591a1;_0x5b2d84[_0x1b95('0x249')]['couponType']=_0x1cde53[_0x1b95('0x113')];const _0x2a9aeb=_0x5b2d84;const _0x1694a5={};_0x1694a5['Content-Type']=_0x1cde53[_0x1b95('0x270')];_0x1694a5['x-access-token']=_0x2e8cbb;_0x1694a5[_0x1b95('0x12e')]=_0x1b95('0x20');_0x1694a5[_0x1b95('0x13a')]=_0x1b95('0x668');const _0x3dc1f0=_0x1694a5;const _0x4b7074={};_0x4b7074[_0x1b95('0x5d')]=_0x1cde53[_0x1b95('0x2ac')];_0x4b7074[_0x1b95('0x38b')]=_0x3dc1f0;_0x4b7074[_0x1b95('0x1a2')]=JSON[_0x1b95('0x46')](_0x2a9aeb);return _0x38d34e(_0x53c5f4,_0x4b7074);};_0x5921f3[_0x1b95('0x22c')]=function(_0x5e3b26,_0xa11f58,_0x4415b1){if(_0x1b95('0x692')===_0x1cde53[_0x1b95('0x615')]){const _0x11f34e={};_0x11f34e[_0x1b95('0x58d')]=_0x5e3b26;_0x11f34e['currency']=_0xa11f58;_0x11f34e[_0x1b95('0x657')]=_0x4415b1;const _0x20b15b={};_0x20b15b[_0x1b95('0x27f')]=_0x1b95('0x47f');_0x20b15b[_0x1b95('0x668')]=_0x1b95('0x298');_0x20b15b[_0x1b95('0x249')]=_0x11f34e;const _0x2110c8=_0x20b15b;const _0x5b4a3d={};_0x5b4a3d['Content-Type']=_0x1cde53[_0x1b95('0x270')];_0x5b4a3d['x-access-token']=_0x2e8cbb;_0x5b4a3d[_0x1b95('0x12e')]=_0x1b95('0x47f');_0x5b4a3d['x-operation-type']=_0x1cde53['KXlwA'];const _0x2c2653=_0x5b4a3d;const _0x33557c={};_0x33557c[_0x1b95('0x5d')]=_0x1cde53[_0x1b95('0x2ac')];_0x33557c[_0x1b95('0x38b')]=_0x2c2653;_0x33557c[_0x1b95('0x1a2')]=JSON[_0x1b95('0x46')](_0x2110c8);return _0x38d34e(_0x53c5f4,_0x33557c);}else{const _0x24cb00=_0x4fea16[_0x1b95('0x6c3')][_0x1b95('0x416')]('|');let _0x51b81a=0x0;while(!![]){switch(_0x24cb00[_0x51b81a++]){case'0':this[_0x1b95('0x1cb')]=0x0;continue;case'1':this[_0x1b95('0x6c2')]=![];continue;case'2':this[_0x1b95('0x546')]=null;continue;case'3':this['maintenanceInterval']=_0x4fea16[_0x1b95('0x1b8')](0xf,0x3e8);continue;case'4':this[_0x1b95('0x91')]=_0x4fea16[_0x1b95('0x697')](0x11d,0x3e8);continue;case'5':this[_0x1b95('0x595')]=_0x4fea16[_0x1b95('0x3e')](0x2d,0x3e8);continue;case'6':this[_0x1b95('0x5e6')]=0x1f4;continue;case'7':this[_0x1b95('0x606')]=null;continue;case'8':this[_0x1b95('0x5c')]=0x1;continue;case'9':this['tokenCache']=[];continue;case'10':this[_0x1b95('0x76')]=_0x4fea16[_0x1b95('0x508')](0xb4,0x3e8);continue;case'11':this[_0x1b95('0xe5')]=null;continue;case'12':this[_0x1b95('0x61f')]=_0x4fea16['IyZtM'];continue;case'13':this[_0x1b95('0x16d')]=0x2;continue;case'14':this[_0x1b95('0x4e3')]=null;continue;case'15':this[_0x1b95('0x97')]=![];continue;case'16':this[_0x1b95('0x341')]=0x3;continue;case'17':this[_0x1b95('0x1bc')]=![];continue;case'18':this[_0x1b95('0x625')]=null;continue;}break;}}};_0x5921f3[_0x1b95('0x22a')]=function(){if(_0x1cde53['EObay'](_0x1cde53[_0x1b95('0x34f')],_0x1cde53[_0x1b95('0x251')])){const _0x56230e={};_0x56230e[_0x1b95('0x668')]=_0x1cde53[_0x1b95('0x44c')];_0x56230e['variables']={};const _0x19b7da=_0x56230e;const _0x3719cc={};_0x3719cc[_0x1b95('0x1e')]=_0x1cde53[_0x1b95('0x270')];_0x3719cc[_0x1b95('0x4f8')]=_0x2e8cbb;const _0x1c441e=_0x3719cc;const _0xe79b2c={};_0xe79b2c[_0x1b95('0x5d')]=_0x1cde53[_0x1b95('0x2ac')];_0xe79b2c[_0x1b95('0x38b')]=_0x1c441e;_0xe79b2c[_0x1b95('0x1a2')]=JSON[_0x1b95('0x46')](_0x19b7da);return fetch(_0x53c5f4,_0xe79b2c);}else{this[_0x1b95('0x1bc')]=![];}};_0x5921f3[_0x1b95('0xfe')]=function(_0xc6b8e2,_0x57a6d9){const _0x4487c6={};_0x4487c6[_0x1b95('0x5ec')]=function(_0x46b9aa,_0x43753e){return _0x4fea16[_0x1b95('0x275')](_0x46b9aa,_0x43753e);};_0x4487c6[_0x1b95('0x1f8')]=_0x4fea16[_0x1b95('0x171')];_0x4487c6[_0x1b95('0x126')]=_0x4fea16['PtACr'];_0x4487c6[_0x1b95('0x68')]=_0x1b95('0x363');_0x4487c6[_0x1b95('0x3a7')]=_0x4fea16[_0x1b95('0x4fc')];const _0x36543b=_0x4487c6;if(_0x4fea16['JybRO'](_0x4fea16[_0x1b95('0x65f')],_0x4fea16[_0x1b95('0x65f')])){const _0x56a39d={};_0x56a39d[_0x1b95('0x1c8')]=_0xc6b8e2;_0x56a39d['amount']=_0x57a6d9;const _0x3e906={};_0x3e906['query']=_0x4fea16[_0x1b95('0x6cd')];_0x3e906[_0x1b95('0x249')]=_0x56a39d;const _0x111c6d=_0x3e906;const _0x2f5495={};_0x2f5495[_0x1b95('0x1e')]=_0x1b95('0x6a3');_0x2f5495[_0x1b95('0x4f8')]=_0x2e8cbb;_0x2f5495[_0x1b95('0x12e')]=_0x1b95('0x161');_0x2f5495[_0x1b95('0x13a')]=_0x4fea16[_0x1b95('0x79')];const _0x371757=_0x2f5495;const _0x262a67={};_0x262a67[_0x1b95('0x5d')]=_0x1b95('0x232');_0x262a67[_0x1b95('0x38b')]=_0x371757;_0x262a67[_0x1b95('0x1a2')]=JSON[_0x1b95('0x46')](_0x111c6d);return _0x4fea16[_0x1b95('0x3d3')](fetch,_0x53c5f4,_0x262a67);}else{if(data['msg'][_0x1b95('0x6a6')]){_0xc7958f[_0x1b95('0x23b')](_0x1b600[_0x1b95('0x49d')][_0x1b95('0x189')]);_0xc7958f[_0x1b95('0x23b')](data[_0x1b95('0x2e6')][_0x1b95('0x505')]);_0xc7958f[_0x1b95('0x23b')](_0x1b600[_0x1b95('0x49d')][_0x1b95('0x143')]);}else{_0xc7958f[_0x1b95('0x23b')](data['msg']['message']);}_0x36543b[_0x1b95('0x5ec')](_0x3bd8cd,_0x36543b[_0x1b95('0x1f8')])[_0x1b95('0x1e2')](_0x1b95('0x4e8'),![])[_0x1b95('0x293')]({'opacity':0x1,'cursor':_0x36543b[_0x1b95('0x126')]});_0x36543b['pVpqa'](_0x3bd8cd,'#autoDropwrap\x20.get-redeem-code-btn')[_0x1b95('0x574')](_0x1b95('0xe4'))[_0x1b95('0xd6')](_0x36543b[_0x1b95('0x68')]);_0x36543b[_0x1b95('0x5ec')](_0x3bd8cd,_0x36543b[_0x1b95('0x3a7')])['hide']();return;}};return _0x5921f3;}const _0x536905={};_0x536905[_0x1b95('0x2e3')]=function(_0x5ddd84,_0x5c371a,_0x404722,_0x1a38d1){return _0x405088(_0x5ddd84,_0x5c371a,_0x404722,_0x1a38d1);};const _0x397f23=_0x536905;console[_0x1b95('0xe3')](_0x1b95('0x30f')+_0x3a2889[_0x1b95('0x612')]+_0x1b95('0xbf')+_0x3a2889[_0x1b95('0x284')]+_0x1b95('0x3ed')+_0x3a2889['debug']+'\x0a+\x20----------------------------------\x20+');async function _0x5995f6(){_0x1b600[_0x1b95('0x1eb')]=_0x3a1674[_0x1b95('0x47b')](_0x7fe7b0);_0x1b600[_0x1b95('0x49d')]=_0x10b0f7(_0x3a2889[_0x1b95('0x2ae')]);_0xc7958f[_0x1b95('0x7')]();_0xc7958f[_0x1b95('0x23b')](_0x1b600[_0x1b95('0x49d')][_0x1b95('0x7')]);_0x1b600['turnstileManager']=new _0x1239dc();_0x1b600[_0x1b95('0x3e5')][_0x1b95('0x55f')]();_0xc7958f[_0x1b95('0x3b8')](_0x3a1674['plMCJ'](_0x5a02fa));_0x3680d3();_0xc7958f[_0x1b95('0x338')]();_0x3a1674[_0x1b95('0x367')](_0x2478d0);try{if(_0x3a1674[_0x1b95('0x55e')]!==_0x3a1674[_0x1b95('0x6ed')]){const _0x452a36=_0x51e711();_0x1b600['api']=_0x397f23['create'](_0x3a2889[_0x1b95('0x2b2')],_0x452a36,_0x3a2889['apiUrl'],_0x3a2889[_0x1b95('0x2ae')]);_0x1b600[_0x1b95('0x1bf')]=await _0x3a1674[_0x1b95('0x367')](_0x1e0e27);_0xc7958f['setUsername'](_0x1b600[_0x1b95('0x1bf')]);_0xacfb95();await _0x3a1674[_0x1b95('0x128')](_0x29fc76,_0x1b600[_0x1b95('0x1bf')]);}else{balanceColor=_0x1cde53[_0x1b95('0x366')];}}catch(_0x5acf1f){_0xc7958f[_0x1b95('0x23b')](_0x5acf1f[_0x1b95('0x4d7')]);}}_0x3a1674[_0x1b95('0x648')](_0x5995f6);});}());
		/* --- END FCFC BODY --- */
	})();
}


/* ============================================================================
 * BEGIN CLAIMER v9.25 BODY (unmodified)
 * ============================================================================ */

(function () {
'use strict';

// ════════════════════════════════════════════════════════════
// CONSOLE HELPERS (v9.9.1)
//   suryaSetUsername("YourName")  → lock username + auto-reload
//   suryaClearUsername()           → forget stored username
//   suryaDiag("YourName")          → scan page for where the name appears
// ════════════════════════════════════════════════════════════
// Expose to both sandbox and page world so DevTools console can call them
var _scExpose = (function () {
    var targets = [];
    try { targets.push(window); } catch (_) {}
    try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window) targets.push(unsafeWindow); } catch (_) {}
    return function (name, fn) { for (var i = 0; i < targets.length; i++) { try { targets[i][name] = fn; } catch (_) {} } };
})();

try {
    var _suryaSetUsername = function (name) {
        if (!name || typeof name !== 'string' || name.trim().length < 2) {
            console.warn('[Surya] suryaSetUsername: invalid name'); return false;
        }
        try { GM_setValue('SC_MANUAL_USERNAME', name.trim()); } catch (_) {}
        console.log('%c[Surya] Manual username saved: ' + name + ' — reloading…', 'color:#9ee493;font-weight:700');
        setTimeout(function () { try { location.reload(); } catch (_) {} }, 600);
        return true;
    };
    var _suryaClearUsername = function () {
        try { GM_setValue('SC_MANUAL_USERNAME', ''); } catch (_) {}
        console.log('%c[Surya] Manual username cleared. Reloading…', 'color:#f5a020');
        setTimeout(function () { try { location.reload(); } catch (_) {} }, 600);
    };
    var _suryaDiag = function (needle) {
        var n = (needle || '').trim();
        if (!n) { console.warn('[Surya] usage: suryaDiag("YourUsername")'); return; }
        var nLow = n.toLowerCase();
        var hits = [];
        function add(where, sample) {
            try {
                var s = typeof sample === 'string' ? sample : JSON.stringify(sample);
                if (s && s.length > 600) {
                    var idx = s.toLowerCase().indexOf(nLow);
                    if (idx > -1) s = '…' + s.slice(Math.max(0, idx - 150), idx + 350) + '…';
                }
                hits.push({ where: where, sample: s });
            } catch (_) { hits.push({ where: where, sample: '<unserializable>' }); }
        }
        try {
            if (document.cookie.toLowerCase().indexOf(nLow) > -1) add('document.cookie', document.cookie);
        } catch (_) {}
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i); if (!k) continue;
                var v = localStorage.getItem(k) || '';
                if (v.toLowerCase().indexOf(nLow) > -1) add('localStorage[' + k + ']', v);
            }
        } catch (_) {}
        try {
            for (var j = 0; j < sessionStorage.length; j++) {
                var sk = sessionStorage.key(j); if (!sk) continue;
                var sv = sessionStorage.getItem(sk) || '';
                if (sv.toLowerCase().indexOf(nLow) > -1) add('sessionStorage[' + sk + ']', sv);
            }
        } catch (_) {}
        try {
            var gkeys = Object.getOwnPropertyNames(window);
            for (var gi = 0; gi < gkeys.length; gi++) {
                var gk = gkeys[gi];
                if (!/^__|^\$|sveltekit|apollo|nuxt|next|stake|user|auth|session|state/i.test(gk)) continue;
                try {
                    var gv = window[gk];
                    if (gv && typeof gv === 'object') {
                        var dump = JSON.stringify(gv);
                        if (dump && dump.toLowerCase().indexOf(nLow) > -1) add('window.' + gk, dump);
                    }
                } catch (_) {}
            }
        } catch (_) {}
        try {
            var scripts = document.querySelectorAll('script[data-sveltekit-fetched], script[type="application/json"]');
            for (var si = 0; si < scripts.length; si++) {
                var t = scripts[si].textContent || '';
                if (t.toLowerCase().indexOf(nLow) > -1) {
                    add('script[' + (scripts[si].getAttribute('data-url') || scripts[si].type || '#' + si) + ']', t);
                }
            }
        } catch (_) {}
        try {
            var nodes = document.querySelectorAll('a, span, div, p, h1, h2, h3, h4, button, label, [class*="user"], [class*="name"], [class*="vip"]');
            var domHits = [];
            for (var ni = 0; ni < nodes.length && domHits.length < 12; ni++) {
                var el = nodes[ni];
                var txt = (el.innerText || el.textContent || '').trim();
                if (txt && txt.length < 250 && txt.toLowerCase().indexOf(nLow) > -1) {
                    var path = el.tagName.toLowerCase();
                    if (el.id) path += '#' + el.id;
                    if (el.className && typeof el.className === 'string') path += '.' + el.className.split(/\s+/).slice(0, 3).join('.');
                    if (el.getAttribute('href')) path += '[href="' + el.getAttribute('href') + '"]';
                    domHits.push({ path: path, text: txt });
                }
            }
            if (domHits.length) add('DOM (top 12)', domHits);
        } catch (_) {}
        console.log('%c[Surya] suryaDiag("' + n + '") found ' + hits.length + ' location(s):', 'color:#9ee493;font-weight:700;font-size:13px');
        for (var hi = 0; hi < hits.length; hi++) {
            console.log('%c[' + (hi + 1) + '] ' + hits[hi].where, 'color:#5b5ef4;font-weight:700');
            console.log(hits[hi].sample);
        }
        try {
            console.log('%c[Surya] ↓ copy everything below this line and paste back ↓', 'color:#f5c540;font-weight:700');
            console.log(JSON.stringify(hits, null, 2));
        } catch (_) {}
        return hits;
    };
    _scExpose('suryaSetUsername', _suryaSetUsername);
    _scExpose('suryaClearUsername', _suryaClearUsername);
    _scExpose('suryaDiag', _suryaDiag);
    console.log('%c[Surya] v9.10.1 helpers ready: suryaSetUsername("name") · suryaClearUsername() · suryaDiag("name")', 'color:#9ee493;font-weight:700');
} catch (e) { console.warn('[Surya] helper install failed:', e); }


// ════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════
const CFG = {
    SUPABASE_URL:        'https://nuvaoxfaxflsttsdhafx.supabase.co',
    SUPABASE_ANON_KEY:   'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im51dmFveGZheGZsc3R0c2RoYWZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwOTAxNTksImV4cCI6MjA5NDY2NjE1OX0.Nhx6omTj7Fx67MyFBMZDr04ceDgcj4kVH4xynMesi9A',
    WS_URL:              'wss://ws.mvpsensi.in/ws/codes',   // routed via Cloudflare tunnel; origin IP hidden
    REPORT_URL:          'https://ws.mvpsensi.in/api/report', // v9.17.4: claim outcomes → admin panel (fire-and-forget; '' disables)
    // ── Project 2 (api-claimer) bridge — pulls codes + reports claims to claimer.mvpsensi.in ──
    P2_ENABLED:          true,
    P2_BASE:             'https://claimer.mvpsensi.in',
    P2_SECRET:           'CHANGE_ME_BROWSER_INGEST_SECRET',
    P2_POLL_MS:          1200,
    GQL_URL:             `${window.location.origin}/_api/graphql`,
    TS_SITEKEY:          '0x4AAAAAAAGD4gMGOTFnvupz',
    TS_CDN:              'https://challenges.cloudflare.com/turnstile/v0/api.js',
    DEFAULT_CURRENCY:    'usdt',
    TOKEN_SLOTS:         10,
    TS_PARALLEL_WIDGETS: 4,    // v9.19.2: CF-safe count. Cloudflare rate-limits PER IP — 6@900ms tripped it → stall death-spiral → 0 tokens. ONE tab (leader) generates for the whole browser.
    TS_SOLVE_GAP_MS:     1400, // v9.19.2: CF-safe pacing (~2.8 solves/s). 900ms hammered Turnstile into invisible-challenge mode.
    TS_STALL_MS:         11000,// v9.19.2: a real CF challenge takes 8-12s. 6s was killing widgets MID-challenge → respawn → stall again → infinite loop (THE bug in the screenshot).
    XTAB_ENABLED:        true, // v9.11: share ONE token pool across all tabs in the same browser profile (BroadcastChannel)
    XTAB_MIN_PER_TAB:    6,     // v9.19.2: bigger per-tab buffer so 2 tabs claiming the SAME code at the same instant never starve (was 3 — the real cause of the original 2-tab shortage).
    XTAB_MAX_POOL:       48,    // v9.12: hard cap on total tokens the leader will generate/hold across all tabs
    XTAB_FAILOVER_MS:    8_000, // v9.12: a follower re-enables its own widget generation if it gets no tokens for this long while empty
    // v9.21.0: Steady Distributed Mode — EVERY tab generates its OWN tokens at a slow,
    // CF-gentle pace and keeps its own buffer topped up, instead of one leader feeding all
    // tabs. Kills the single-point-of-failure (leader wedge = every tab dies at once) and the
    // push latency. Stays CF-safe: few widgets + slow gap per tab, and the adaptive back-off
    // trims widgets further if Cloudflare pushes back. Set false to revert to the leader model.
    STEADY_MODE:         true,
    STEADY_WIDGETS:      2,     // widgets per tab in steady mode (low, so many tabs stay under CF per-IP limit)
    STEADY_GAP_MS:       2500,  // ~0.8 solves/s per tab: gentle, continuous top-up that never bursts
    VERBOSE_LOGS:        false,  // v9.10.1: hide token cached / slot unstuck / retry noise from UI panel (still logged to browser console)
    TOKEN_MAX_AGE:       150_000,
    TOKEN_REFRESH_AT:    60_000,
    TS_EXECUTE_DELAY:    250,   // v9.17: faster widget execute → quicker first token & faster claims
    TS_TIMEOUT:          45_000,
    WS_PING_INTERVAL:    25_000,
    WS_RECONNECT_BASE:   4_000,
    WS_RECONNECT_MAX:    30_000,
    AUTH_RECHECK_MS:     5 * 60_000,
    RATE_MAX:            2,
    RATE_WINDOW_MS:      20_000,
    CACHE_WATCHER_MS:    8_000,   // v9.17: watch more often for faster self-heal
    CACHE_EMPTY_LIMIT:   60_000,
    TS_FAILURE_LIMIT_MS: 35_000,  // v9.17: single-tier — if tokens truly stall this long, hard refresh
    MAX_4003_RETRIES:    3,
    TOKEN_SERVER_URL:    '',
    TOKEN_SECRET:        '123',
    // v9.17: single-tier auto-heal via hard refresh (loop-guarded so it can never reload-loop)
    AUTO_REFRESH:          true,
    REFRESH_STALL_MS:      30_000,  // no token for this long while empty → hard refresh
    REFRESH_MAX_PER_10MIN: 3,       // safety cap on reloads within a rolling 10-min window
};

// ════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════
let username             = null;
let isAuthorized         = false;
let expiryMs             = null;   // v9.11: Supabase active_till (ms epoch) for the live countdown
let _expTimer            = null;

let wsState              = 'idle';
let ws                   = null;
let wsDelay              = CFG.WS_RECONNECT_BASE;
let wsReconnTimer        = null;
let wsPingTimer          = null;
let consecutive4003      = 0;
let lastConnectedAt      = 0;

let claimed              = new Set();
let processing           = new Set();
let rateLimitTs          = [];
let currency             = GM_getValue('sc_currency', CFG.DEFAULT_CURRENCY);
let successes            = 0;
let failures             = 0;
let consecutiveAuthFails = 0;

const claimStats = { successCount: 0, failedCount: 0, totalValue: 0, recent: [] };
const netStats   = { ping: 0, jitter: 0, loss: 0, history: [] };

const SETTINGS_KEY = 'SC_USER_SETTINGS';
let userSettings = null;

// ════════════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════════════
function initSettings() {
    const defaults = {
        drops:      ['Daily1','Daily2','Daily3','DailyOther','HighRollers','WeeklyStream','PlaySmarter','OtherDrops'],
        vault:      false,
        processAll: true,
        currency:   CFG.DEFAULT_CURRENCY,
    };
    userSettings = GM_getValue(SETTINGS_KEY) || defaults;
    if (!userSettings.drops)                  userSettings.drops      = defaults.drops;
    if (userSettings.vault === undefined)      userSettings.vault      = defaults.vault;
    if (userSettings.processAll === undefined) userSettings.processAll = defaults.processAll;
    if (!userSettings.currency)               userSettings.currency   = defaults.currency;
    currency = userSettings.currency;
    saveSettings();
}
function saveSettings() { GM_setValue(SETTINGS_KEY, userSettings); }

// ════════════════════════════════════════════════════════════
// STYLES
// ════════════════════════════════════════════════════════════
GM_addStyle(`
    :root {
        --sc-bg: #0b0b0e; --sc-border: rgba(255,255,255,.07);
        --sc-accent: #00dc01; --sc-text: #e0e0e0; --sc-dim: #555;
        --sc-success: #00dc01; --sc-error: #ff3a3a; --sc-warning: #f5a020;
        --sc-hd-bg: #13131a; --sc-body-bg: #0f0f13; --sc-log-bg: #080809;
        --sc-settings-bg: #141418; --sc-gold: #f5c540;
    }
    #sc-root { position:fixed!important; top:68px; right:14px; width:340px; z-index:2147483647!important; font-family:'Space Grotesk',sans-serif; }
    #sc-card { background:var(--sc-bg); border-radius:16px; border:1px solid var(--sc-border); box-shadow:0 0 0 1px rgba(0,220,1,.04),0 32px 80px rgba(0,0,0,.95); overflow:hidden; position:relative; animation:sc-card-in .35s cubic-bezier(.2,.9,.25,1); }
    @keyframes sc-card-in { from{opacity:0;transform:translateY(-8px) scale(.98)} to{opacity:1;transform:none} }
    #sc-card::before { content:''; position:absolute; top:0; left:0; right:0; height:2px; background:linear-gradient(90deg,transparent,#00dc01,#7dd3fc,#00dc01,transparent); background-size:200% auto; animation:sc-flow 3.5s linear infinite; z-index:6; opacity:.9; }
    @keyframes sc-flow { to { background-position:200% center; } }
    #sc-hd { display:flex; align-items:center; justify-content:space-between; padding:12px 15px 10px; background:linear-gradient(160deg,#13131a,#0b0b0e); border-bottom:1px solid rgba(255,255,255,.05); cursor:grab; user-select:none; }
    #sc-hd:active { cursor:grabbing; }
    #sc-brand { display:flex; align-items:center; gap:8px; }
    #sc-dot { width:8px; height:8px; border-radius:50%; background:#444; flex-shrink:0; transition:background .4s,box-shadow .4s; }
    #sc-dot.live { background:var(--sc-accent); box-shadow:0 0 0 3px rgba(0,220,1,.18); animation:sc-pulse 2.2s ease-in-out infinite; }
    #sc-dot.dead { background:var(--sc-error); box-shadow:0 0 0 3px rgba(255,58,58,.15); }
    #sc-dot.wait { background:var(--sc-warning); }
    @keyframes sc-pulse { 0%,100%{box-shadow:0 0 0 3px rgba(0,220,1,.18)} 50%{box-shadow:0 0 0 7px rgba(0,220,1,.04)} }
    #sc-name { font-size:11px; font-weight:700; letter-spacing:2.8px; text-transform:uppercase; background:linear-gradient(90deg,#e8ffe8,#00dc01,#7dd3fc,#00dc01,#e8ffe8); background-size:200% auto; -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; animation:sc-shimmer 6s linear infinite; }
    @keyframes sc-shimmer { to { background-position:200% center; } }
    #sc-hd-right { display:flex; align-items:center; gap:8px; }
    #sc-settings-btn { width:22px; height:22px; border-radius:5px; background:#1a1a22; border:1px solid rgba(255,255,255,.08); display:flex; align-items:center; justify-content:center; cursor:pointer; transition:background .2s; }
    #sc-settings-btn:hover { background:#22222e; }
    #sc-settings-btn svg { width:12px; height:12px; fill:var(--sc-dim); }
    #sc-min { background:#131318; border:1px solid rgba(255,255,255,.07); color:#383840; font-size:14px; padding:2px 9px; border-radius:6px; cursor:pointer; transition:all .2s; line-height:1; }
    #sc-min:hover { border-color:rgba(255,255,255,.18); color:#aaa; }
    #sc-badge { font-family:'JetBrains Mono',monospace; font-size:9px; font-weight:700; letter-spacing:1.4px; text-transform:uppercase; padding:3px 10px; border-radius:20px; border:1px solid #222; background:#111; color:#333; transition:all .3s; }
    #sc-badge.live { background:rgba(0,220,1,.1); border-color:rgba(0,220,1,.3); color:var(--sc-accent); animation:sc-badge-glow 2.4s ease-in-out infinite; }
    @keyframes sc-badge-glow { 0%,100%{box-shadow:0 0 0 0 rgba(0,220,1,0)} 50%{box-shadow:0 0 10px 0 rgba(0,220,1,.35)} }
    #sc-badge.dead { background:rgba(255,58,58,.1); border-color:rgba(255,58,58,.3); color:var(--sc-error); }
    #sc-badge.wait { background:rgba(245,160,32,.1); border-color:rgba(245,160,32,.3); color:var(--sc-warning); }
    #sc-body { display:flex; flex-direction:column; }
    #sc-user-row { display:flex; align-items:center; justify-content:space-between; padding:8px 15px; border-bottom:1px solid rgba(255,255,255,.04); }
    #sc-user-left { display:flex; align-items:center; gap:5px; }
    #sc-user-lbl { font-size:8px; font-weight:700; letter-spacing:1.6px; text-transform:uppercase; color:#252530; }
    #sc-uname { font-family:'JetBrains Mono',monospace; font-weight:700; font-size:12px; color:var(--sc-accent); transition:color .3s; }
    #sc-uname.wait { color:var(--sc-warning); } #sc-uname.err { color:var(--sc-error); }
    #sc-chip { font-size:8px; font-weight:700; letter-spacing:1px; text-transform:uppercase; padding:3px 10px; border-radius:20px; border:1px solid transparent; }
    #sc-chip.active   { background:rgba(0,220,1,.1);   color:var(--sc-accent); border-color:rgba(0,220,1,.2); }
    #sc-chip.inactive { background:rgba(255,58,58,.1); color:var(--sc-error);  border-color:rgba(255,58,58,.2); }
    #sc-chip.checking { background:rgba(245,160,32,.1);color:var(--sc-warning);border-color:rgba(245,160,32,.2); }
    #sc-exp-row { display:none; align-items:center; justify-content:space-between; margin-bottom:9px; }
    #sc-exp-lbl { font-size:9px; letter-spacing:1.5px; text-transform:uppercase; color:#6a6a78; }
    #sc-exp-timer { font-family:'JetBrains Mono',monospace; font-weight:700; font-size:11px; letter-spacing:.5px; }
    #sc-exp-timer.exp-ok { color:var(--sc-accent); } #sc-exp-timer.exp-warn { color:var(--sc-warning); } #sc-exp-timer.exp-crit { color:var(--sc-error); }
    #sc-tok-row { display:flex; align-items:center; gap:8px; padding:6px 15px; background:rgba(0,0,0,.2); border-bottom:1px solid rgba(255,255,255,.04); }
    #sc-tok-lbl { font-size:8px; font-weight:700; letter-spacing:1.6px; text-transform:uppercase; color:#1e1e28; }
    #sc-pips { display:flex; gap:4px; }
    .sc-pip { width:26px; height:5px; border-radius:3px; background:#161620; transition:all .3s; }
    .sc-pip.rdy { background:linear-gradient(90deg,#5b5ef4,#7dd3fc); box-shadow:0 0 8px rgba(91,94,244,.5); animation:sc-pip-in .3s ease; }
    .sc-pip.gen { background:var(--sc-warning); animation:sc-blink .6s infinite; }
    @keyframes sc-pip-in { from{transform:scaleX(.2);opacity:.3} to{transform:scaleX(1);opacity:1} }
    @keyframes sc-blink { 0%,100%{opacity:1} 50%{opacity:.15} }
    #sc-tok-ct { font-family:'JetBrains Mono',monospace; font-size:9px; color:#1e1e28; margin-left:auto; }
    #sc-log { padding:7px; min-height:60px; max-height:220px; overflow-y:auto; background:var(--sc-log-bg); }
    #sc-log::-webkit-scrollbar { width:2px; } #sc-log::-webkit-scrollbar-thumb { background:#1a1a25; border-radius:2px; }
    .sc-row { display:flex; gap:7px; padding:5px 7px; border-radius:6px; margin-bottom:3px; align-items:flex-start; animation:sc-up .15s ease; }
    @keyframes sc-up { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }
    .sc-row.ok { background:rgba(0,220,1,.05); animation:sc-up .15s ease, sc-flash .9s ease; } .sc-row.err { background:rgba(255,58,58,.05); } .sc-row.warn { background:rgba(245,160,32,.05); }
    @keyframes sc-flash { 0%{background:rgba(0,220,1,.35);box-shadow:0 0 14px rgba(0,220,1,.5)} 100%{background:rgba(0,220,1,.05);box-shadow:none} }
    .sc-ic { font-size:9px; flex-shrink:0; margin-top:2px; color:#282830; }
    .sc-row.ok .sc-ic { color:var(--sc-accent); } .sc-row.err .sc-ic { color:var(--sc-error); } .sc-row.warn .sc-ic { color:var(--sc-warning); }
    .sc-tx { flex:1; font-size:10px; line-height:1.55; color:#3a3a48; }
    .sc-row.ok .sc-tx { color:#888; } .sc-row.err .sc-tx { color:#666; } .sc-row.warn .sc-tx { color:#555; }
    .sc-ts { font-family:'JetBrains Mono',monospace; font-size:7.5px; color:#1c1c26; flex-shrink:0; margin-top:3px; }
    .hl-code { color:var(--sc-accent); font-weight:700; font-family:'JetBrains Mono',monospace; }
    .hl-amount { color:var(--sc-gold); font-weight:700; text-shadow:0 0 10px rgba(245,197,64,.35); } .hl-ms { color:#252530; }
    #sc-stats { display:grid; grid-template-columns:1fr 1fr 1fr; border-top:1px solid rgba(255,255,255,.04); }
    .sc-stat { display:flex; flex-direction:column; align-items:center; padding:10px 8px 8px; border-right:1px solid rgba(255,255,255,.04); }
    .sc-stat:last-child { border-right:none; }
    .sc-stat-n { font-family:'JetBrains Mono',monospace; font-size:20px; font-weight:700; line-height:1; color:#1c1c26; transition:color .3s; }
    .sc-stat-n.g { color:var(--sc-accent)!important; } .sc-stat-n.r { color:var(--sc-error)!important; } .sc-stat-n.w { color:#bbb!important; }
    .sc-stat-l { font-size:8px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:#242430; margin-top:3px; }
    .sc-net-bars { display:flex; align-items:flex-end; gap:2px; height:14px; cursor:help; }
    .sc-net-bar { width:4px; border-radius:1px; background:#1a1a22; }
    .sc-net-bar:nth-child(1){height:5px} .sc-net-bar:nth-child(2){height:9px} .sc-net-bar:nth-child(3){height:13px}
    .net-good .sc-net-bar { background:var(--sc-accent); } .net-med .sc-net-bar:nth-child(1),.net-med .sc-net-bar:nth-child(2) { background:var(--sc-warning); } .net-bad .sc-net-bar:nth-child(1) { background:var(--sc-error); }
    #sc-ws-bar { display:flex; align-items:center; justify-content:space-between; padding:4px 15px; background:rgba(0,0,0,.35); border-bottom:1px solid rgba(255,255,255,.03); font-size:8px; font-family:'JetBrains Mono',monospace; }
    #sc-ws-state { font-weight:700; letter-spacing:1px; text-transform:uppercase; }
    #sc-ws-state.live { color:var(--sc-accent); } #sc-ws-state.dead { color:var(--sc-error); } #sc-ws-state.wait { color:var(--sc-warning); }
    #sc-ws-retry { color:#252535; }
    #sc-ts-bar { display:flex; align-items:center; justify-content:space-between; padding:3px 15px; background:rgba(0,0,0,.2); border-bottom:1px solid rgba(255,255,255,.03); font-size:8px; font-family:'JetBrains Mono',monospace; }
    #sc-ts-status { font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#252535; }
    #sc-ts-status.ok { color:var(--sc-accent); } #sc-ts-status.warn { color:var(--sc-warning); } #sc-ts-status.err { color:var(--sc-error); }
    #sc-settings-modal { position:fixed; inset:0; background:rgba(0,0,0,.8); z-index:2147483648; display:none; align-items:center; justify-content:center; }
    #sc-settings-modal.open { display:flex; }
    .sc-settings-popup { width:420px; max-height:82vh; background:var(--sc-settings-bg); border-radius:12px; border:1px solid rgba(255,255,255,.08); overflow:hidden; display:flex; flex-direction:column; }
    .sc-sp-hd { display:flex; align-items:center; justify-content:space-between; padding:13px 16px; background:#1a1a22; border-bottom:1px solid rgba(255,255,255,.07); }
    .sc-sp-title { font-size:13px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:#fff; }
    .sc-sp-close { width:24px; height:24px; border-radius:5px; background:#331111; border:1px solid #441111; display:flex; align-items:center; justify-content:center; cursor:pointer; }
    .sc-sp-close:hover { background:#441111; } .sc-sp-close svg { width:14px; height:14px; fill:var(--sc-text); }
    .sc-sp-body { flex:1; padding:16px; overflow-y:auto; }
    .sc-sp-body::-webkit-scrollbar { width:3px; } .sc-sp-body::-webkit-scrollbar-thumb { background:#222; border-radius:2px; }
    .sc-section { margin-bottom:20px; }
    .sc-section-title { font-size:10px; font-weight:700; color:var(--sc-accent); margin-bottom:10px; letter-spacing:2px; text-transform:uppercase; }
    .sc-opt { display:flex; align-items:center; gap:10px; margin-bottom:7px; padding:8px 10px; border-radius:6px; background:#1a1a22; cursor:pointer; }
    .sc-opt:hover { background:#1e1e2a; }
    .sc-cb { width:15px; height:15px; appearance:none; background:#1a1a22; border:1px solid #333; border-radius:3px; cursor:pointer; flex-shrink:0; }
    .sc-cb:checked { background:var(--sc-accent); border-color:var(--sc-accent); }
    .sc-cb:checked::after { content:'✓'; display:block; text-align:center; color:#000; font-size:10px; font-weight:700; line-height:13px; }
    .sc-lbl { flex:1; font-size:11px; color:var(--sc-text); }
    .sc-select { width:100%; padding:8px 10px; margin-top:6px; background:#1a1a22; border:1px solid #333; border-radius:6px; color:var(--sc-text); font-family:'Space Grotesk',sans-serif; font-size:11px; }
    .sc-select:focus { outline:none; border-color:rgba(0,220,1,.35); } .sc-select option { background:#1a1a22; }
    .sc-divider { border:none; border-top:1px solid rgba(255,255,255,.06); margin:10px 0; }
    .sc-net-grid { display:grid; grid-template-columns:1fr 1fr; gap:5px; margin-bottom:8px; }
    .sc-net-item { background:#0a0a0e; border:1px solid #1a1a22; border-radius:5px; padding:8px; display:flex; flex-direction:column; align-items:center; }
    .sc-net-lbl { font-size:8px; color:var(--sc-dim); text-transform:uppercase; margin-bottom:2px; }
    .sc-net-val { font-size:11px; font-weight:700; color:#fff; font-family:'JetBrains Mono',monospace; }
    .sv-good { color:var(--sc-accent)!important; } .sv-warn { color:var(--sc-warning)!important; } .sv-bad { color:var(--sc-error)!important; }
    #sc-ov { position:absolute; inset:0; background:rgba(8,8,10,.97); display:none; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:28px 22px; border-radius:16px; z-index:30; }
    #sc-ov-icon { font-size:38px; margin-bottom:14px; } #sc-ov-title { font-size:12px; font-weight:700; letter-spacing:2.5px; text-transform:uppercase; color:#fff; margin-bottom:10px; }
    #sc-ov-uname { font-family:'JetBrains Mono',monospace; font-size:12px; font-weight:700; color:var(--sc-error); background:rgba(255,58,58,.08); border:1px solid rgba(255,58,58,.2); border-radius:6px; padding:4px 16px; margin-bottom:12px; }
    #sc-ov-sub { font-size:10px; color:#2a2a38; line-height:1.9; }
    #sc-ts-wrap { position:fixed; left:-9999px; top:-9999px; width:300px; height:65px; opacity:0; pointer-events:none; overflow:hidden; z-index:-1; }
`);

// ════════════════════════════════════════════════════════════
// v9.15 — ANIMATED HUD POLISH (layered on top; targets existing ids/classes)
// ════════════════════════════════════════════════════════════
GM_addStyle(`
    #sc-card { animation:sc-card-in .45s cubic-bezier(.2,.8,.2,1); }
    @keyframes sc-card-in { from{opacity:0;transform:translateY(10px) scale(.98)} to{opacity:1;transform:none} }
    #sc-hd { position:relative; overflow:hidden; }
    #sc-hd::after { content:''; position:absolute; inset:0; pointer-events:none;
        background:linear-gradient(120deg,transparent 0%,rgba(0,220,1,.10) 45%,rgba(0,220,1,.22) 50%,rgba(0,220,1,.10) 55%,transparent 100%);
        background-size:220% 100%; animation:sc-sheen 6s linear infinite; }
    @keyframes sc-sheen { 0%{background-position:120% 0} 100%{background-position:-120% 0} }
    #sc-dot { position:relative; }
    #sc-dot.live { animation:sc-pulse 1.6s ease-in-out infinite; }
    @keyframes sc-pulse { 0%,100%{box-shadow:0 0 0 0 rgba(0,220,1,.55)} 50%{box-shadow:0 0 0 6px rgba(0,220,1,0)} }
    .sc-pip.rdy { animation:sc-pip-in .35s ease; }
    @keyframes sc-pip-in { from{transform:scaleX(.2);opacity:.3} to{transform:scaleX(1);opacity:1} }
    .sc-row[data-code] { transition:background .3s ease, box-shadow .3s ease; }
    .sc-row.live { background:rgba(0,220,1,.07)!important; animation:sc-claim 1s ease-in-out infinite; }
    @keyframes sc-claim { 0%,100%{box-shadow:inset 2px 0 0 rgba(0,220,1,.35)} 50%{box-shadow:inset 2px 0 0 rgba(0,220,1,1)} }
    .sc-row.ok { animation:sc-flash-ok .7s ease; }
    @keyframes sc-flash-ok { 0%{background:rgba(0,220,1,.32)} 100%{background:rgba(0,220,1,.05)} }
    .sc-row.err { animation:sc-flash-err .7s ease; }
    @keyframes sc-flash-err { 0%{background:rgba(255,58,58,.28)} 100%{background:rgba(255,58,58,.05)} }
    .hl-code { text-shadow:0 0 8px rgba(0,220,1,.35); }
    .sc-stat-n { transition:transform .25s ease, color .3s; }
    #sc-ts-status.ok, #sc-ws-state.live { text-shadow:0 0 6px rgba(0,220,1,.4); }
    #sc-uname:not(.wait):not(.err) { animation:sc-user-in .4s ease; }
    @keyframes sc-user-in { from{opacity:0;transform:translateX(-6px)} to{opacity:1;transform:none} }
    #sc-badge.live { animation:sc-badge-glow 2s ease-in-out infinite; }
    @keyframes sc-badge-glow { 0%,100%{box-shadow:0 0 0 rgba(0,220,1,0)} 50%{box-shadow:0 0 10px rgba(0,220,1,.35)} }
`);

// ════════════������══════════════════════════════════��═══════════
// v9.17.5 — UI OVERHAUL (layered on top; restores modern legibility + fixes the
// token-pip “ratio” overflow). Targets existing ids/classes only.
// ════════════════════════════════════════════════════════════
GM_addStyle(`
    /* modern accent + brighter muted tone (lifts every var(--sc-dim) usage) */
    :root { --sc-dim:#8b93a7; }
    #sc-card { border-color:rgba(255,255,255,.10); box-shadow:0 0 0 1px rgba(0,220,1,.05),0 32px 90px rgba(0,0,0,.92); }

    /* ---- TOKEN PIPS: flex so ALL slots always fit the card (fixes overflow) ---- */
    #sc-tok-row { flex-wrap:nowrap; }
    #sc-pips    { flex:1 1 auto; display:flex; gap:4px; min-width:0; }
    .sc-pip     { flex:1 1 0; width:auto; min-width:0; max-width:none; height:6px; border-radius:4px; background:#1b1b26; }
    .sc-pip.rdy { background:linear-gradient(90deg,#15e33a,#3ae6ff); box-shadow:0 0 8px rgba(58,230,255,.45); }
    .sc-pip.gen { background:var(--sc-warning); }
    #sc-tok-lbl { color:#9aa2b5 !important; }
    #sc-tok-ct  { color:#c8cfdd !important; font-weight:700; }

    /* ---- LEGIBILITY: lift near-black labels/text to readable tones ---- */
    #sc-user-lbl { color:#9aa2b5 !important; }
    #sc-uname:not(.wait):not(.err) { color:#15e33a !important; }
    .sc-stat-n   { color:#4a5163; }
    .sc-stat-n.w { color:#e7ebf3 !important; }
    .sc-stat-l   { color:#9aa2b5 !important; }
    .sc-ic        { color:#8b93a7 !important; }
    .sc-tx        { color:#c3cad9 !important; }
    .sc-row.ok  .sc-tx { color:#e6f6e8 !important; }
    .sc-row.err .sc-tx { color:#f0b9b9 !important; }
    .sc-row.warn .sc-tx{ color:#f3d6a4 !important; }
    .sc-row.ok  .sc-ic { color:#15e33a !important; }
    .sc-ts        { color:#6f7688 !important; }
    .hl-ms        { color:#8b93a7 !important; }
    .hl-amount    { color:#ffd24a !important; }

    /* status bars + overlay copy */
    #sc-ws-state, #sc-ts-status { color:#9aa2b5; }
    #sc-ws-retry  { color:#6f7688 !important; }
    #sc-ov-sub    { color:#aab2c4 !important; }

    /* header controls */
    #sc-min          { color:#9aa2b5; border-color:rgba(255,255,255,.12); }
    #sc-min:hover    { color:#e7ebf3; }
    #sc-settings-btn svg { fill:#9aa2b5; }
`);

// ════════════════════════════════════════════════════════════
// v9.25 — BRIGHTNESS PASS + AMOUNT HIGHLIGHT (layered last so it wins)
// Lifts every dim/near-black text in the HUD to a readable tone and
// distinguishes advertised value (gold) from actually-claimed amount (green).
// ════════════════════════════════════════════════════════════
GM_addStyle(`
    /* activity-log body: brighter default + brighter per-status tint */
    .sc-tx           { color:#dfe5f1 !important; font-weight:500; }
    .sc-row.ok  .sc-tx { color:#c4f5cc !important; }
    .sc-row.err .sc-tx { color:#ff9c9c !important; font-weight:600; }
    .sc-row.warn .sc-tx { color:#ffd68a !important; font-weight:600; }
    .sc-ic           { color:#a9b1c3 !important; }
    .sc-row.err .sc-ic { color:#ff6b6b !important; }
    .sc-row.warn .sc-ic { color:#ffb84a !important; }
    .sc-ts           { color:#8a93a8 !important; font-weight:500; }

    /* stat panel numbers: brighter idle zero, punchier ok/err */
    .sc-stat-n       { color:#c8cfdd !important; }
    .sc-stat-n.g     { color:#22e356 !important; text-shadow:0 0 8px rgba(34,227,86,.4); }
    .sc-stat-n.r     { color:#ff5c5c !important; text-shadow:0 0 8px rgba(255,92,92,.4); }
    .sc-stat-n.w     { color:#f0f4fb !important; }
    .sc-stat-l       { color:#b6bccb !important; }

    /* status bars */
    #sc-ws-state, #sc-ts-status { color:#c8cfdd; }
    #sc-ws-state.live { color:#22e356 !important; }
    #sc-ws-state.dead { color:#ff5c5c !important; }
    #sc-ws-retry     { color:#a9b1c3 !important; }

    /* header labels */
    #sc-user-lbl     { color:#b6bccb !important; }
    #sc-tok-lbl      { color:#b6bccb !important; }
    #sc-tok-ct       { color:#e7ebf3 !important; }

    /* AMOUNT HIGHLIGHTS — advertised value (gold) vs actually claimed (green) */
    .hl-amount       { color:#ffd24a !important; font-weight:800; text-shadow:0 0 8px rgba(255,210,74,.45); }
    .hl-amount.hl-claimed { color:#22e356 !important; text-shadow:0 0 8px rgba(34,227,86,.5); }
    .hl-code         { color:#22e356 !important; font-weight:700; text-shadow:0 0 6px rgba(34,227,86,.35); }
    .hl-ms           { color:#a9b1c3 !important; }

    /* overlay copy readability */
    #sc-ov-sub       { color:#c8cfdd !important; }
    #sc-ov-title     { color:#ffffff !important; }
`);

// v9.25 tab-pane brightness overrides (LIVE FEED / BADGES / MISSED)
// The scx-* pane classes had text as dark as #2c2c38 on a black bg. Lift them all.
GM_addStyle('.scx-tab{color:#8a92a6!important;font-weight:800!important}' +
    '.scx-tab:hover{color:#e7ebf3!important;background:rgba(255,255,255,.05)!important}' +
    '.scx-tab.on{color:#22e356!important;background:rgba(34,227,86,.10)!important;text-shadow:0 0 8px rgba(34,227,86,.55)!important}' +
    '.scx-badge-n{background:rgba(34,227,86,.18)!important;color:#c4f5cc!important;font-weight:800!important}' +
    '.scx-fi{border-color:rgba(34,227,86,.28)!important;background:linear-gradient(100deg,rgba(34,227,86,.14),rgba(34,227,86,.04))!important}' +
    '.scx-fi-code{color:#ffffff!important;font-weight:800!important;text-shadow:0 0 6px rgba(34,227,86,.35)}' +
    '.scx-fi-amt{color:#ffd24a!important;font-weight:800!important;text-shadow:0 0 10px rgba(255,210,74,.55)!important}' +
    '.scx-fi-t{color:#a9b1c3!important;font-weight:600!important}' +
    '.scx-life-c{background:rgba(255,255,255,.05)!important;border-color:rgba(255,255,255,.10)!important}' +
    '.scx-life-n{color:#ffd24a!important;text-shadow:0 0 10px rgba(255,210,74,.5)!important}' +
    '.scx-life-l{color:#b6bccb!important;font-weight:800!important}' +
    '.scx-bg{opacity:.65!important;background:rgba(255,255,255,.05)!important;border-color:rgba(255,255,255,.10)!important}' +
    '.scx-bg.got{opacity:1!important;filter:none!important;background:linear-gradient(120deg,rgba(255,210,74,.18),rgba(255,255,255,.04))!important;border-color:rgba(255,210,74,.45)!important;box-shadow:0 0 14px rgba(255,210,74,.20)!important}' +
    '.scx-bg-name{color:#f0f4fb!important;font-weight:800!important}' +
    '.scx-bg-desc{color:#b6bccb!important;line-height:1.4!important}' +
    '.scx-share{color:#22e356!important;border-color:rgba(34,227,86,.45)!important;background:rgba(34,227,86,.12)!important;font-weight:800!important}' +
    '.scx-share:hover{background:rgba(34,227,86,.22)!important}' +
    '.scx-mi{background:rgba(255,92,92,.10)!important;border-color:rgba(255,92,92,.28)!important}' +
    '.scx-mi-code{color:#ff9c9c!important;font-weight:800!important;text-shadow:0 0 6px rgba(255,92,92,.30)}' +
    '.scx-mi-r{color:#ffb0b0!important;font-weight:600!important}' +
    '.scx-mi-t{color:#a9b1c3!important;font-weight:600!important}' +
    '.scx-empty{color:#a9b1c3!important;font-weight:500!important;line-height:1.7!important}' +
    '.scx-hint{color:#b6bccb!important;line-height:1.5!important}' +
    '#scx-drop{color:#c8cfdd!important;font-weight:700!important}' +
    '#scx-drop b{color:#ffffff!important}' +
    '#scx-drop.live{color:#22e356!important;background:rgba(34,227,86,.10)!important}' +
    '.scx-input{background:#1c1e28!important;border-color:#2f3444!important;color:#f0f4fb!important}' +
    '.scx-input:focus{border-color:#22e356!important;box-shadow:0 0 0 2px rgba(34,227,86,.20)!important}' +
    '.scx-mini-btn{color:#22e356!important;border-color:rgba(34,227,86,.45)!important;background:rgba(34,227,86,.12)!important;font-weight:800!important}' +
    '.scx-mini-btn:hover{background:rgba(34,227,86,.22)!important}' +
    '#scx-toast{background:#12141d!important;color:#f0f4fb!important;border-color:rgba(34,227,86,.45)!important;box-shadow:0 20px 50px rgba(0,0,0,.7),0 0 24px rgba(34,227,86,.25)!important}');

// ════════════════════════════════════════════════════════════
// UI BUILD
// ════════════════════════════════════════════════════════════
function buildUI() {
    const root = document.createElement('div');
    root.id = 'sc-root';
    root.innerHTML = `
    <div id="sc-card">
      <div id="sc-hd">
        <div id="sc-brand"><div id="sc-dot" class="wait"></div><span id="sc-name">Surya Claimer</span></div>
        <div id="sc-hd-right">
          <div class="sc-net-bars net-none" id="sc-net" title="Network ping"><div class="sc-net-bar"></div><div class="sc-net-bar"></div><div class="sc-net-bar"></div></div>
          <div id="sc-badge" class="wait">INIT</div>
          <button id="sc-settings-btn" title="Settings"><svg viewBox="0 0 20 20"><path d="M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.07-1.61-.9-.52a6.98 6.98 0 0 0 0-1.74l.9-.52a1 1 0 0 0 .37-1.37l-1-1.73a1 1 0 0 0-1.37-.37l-.9.52A7 7 0 0 0 12 5.15V4a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v1.15a7 7 0 0 0-2.17 1.24l-.9-.52a1 1 0 0 0-1.37.37l-1 1.73a1 1 0 0 0 .37 1.37l.9.52a6.98 6.98 0 0 0 0 1.74l-.9.52a1 1 0 0 0-.37 1.37l1 1.73a1 1 0 0 0 1.37.37l.9-.52A7 7 0 0 0 8 14.85V16a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-1.15a7 7 0 0 0 2.17-1.24l.9.52a1 1 0 0 0 1.37-.37l1-1.73a1 1 0 0 0-.37-1.37z"/></svg></button>
          <button id="sc-min">−</button>
        </div>
      </div>
      <div id="sc-body">
        <div id="sc-user-row">
          <div id="sc-user-left"><span id="sc-user-lbl">User</span><span id="sc-uname" class="wait">detecting…</span></div>
          <div id="sc-chip" class="checking">—</div>
        </div>
        <div id="sc-exp-row"><span id="sc-exp-lbl">Access</span><span id="sc-exp-timer" class="exp-ok">—</span></div>
        <div id="sc-tok-row"><span id="sc-tok-lbl">Tokens</span><div id="sc-pips"></div><span id="sc-tok-ct">0/${CFG.TOKEN_SLOTS}</span></div>
        <div id="sc-ts-bar"><span>Turnstile</span><span id="sc-ts-status">LOADING…</span></div>
        <div id="sc-ws-bar"><span id="sc-ws-state" class="wait">DISCONNECTED</span><span id="sc-ws-retry"></span></div>
        <div id="sc-log"></div>
        <div id="sc-stats">
          <div class="sc-stat"><div class="sc-stat-n g" id="sn-ok">0</div><div class="sc-stat-l">Claimed</div></div>
          <div class="sc-stat"><div class="sc-stat-n r" id="sn-fail">0</div><div class="sc-stat-l">Failed</div></div>
          <div class="sc-stat"><div class="sc-stat-n w" id="sn-tot">0</div><div class="sc-stat-l">Total</div></div>
        </div>
      </div>
      <div id="sc-ov">
        <div id="sc-ov-icon">🔒</div><div id="sc-ov-title">Not Activated</div>
        <div id="sc-ov-uname"></div><div id="sc-ov-sub">This account isn't activated.<br>Contact admin to get access.</div>
      </div>
    </div>`;
    document.body.appendChild(root);

    const pips = document.getElementById('sc-pips');
    for (let i = 0; i < CFG.TOKEN_SLOTS; i++) {
        const d = document.createElement('div'); d.className = 'sc-pip'; pips.appendChild(d);
    }

    const tsWrap = document.createElement('div');
    tsWrap.id = 'sc-ts-wrap';
    document.body.appendChild(tsWrap);

    buildSettingsModal();

    // Drag
    const hd = root.querySelector('#sc-hd');
    let drag = false, ox = 0, oy = 0, sx = 0, sy = 0;
    hd.addEventListener('mousedown', e => {
        if (e.target.closest('#sc-settings-btn') || e.target.closest('#sc-min')) return;
        drag = true;
        const r = root.getBoundingClientRect();
        ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
    });
    document.addEventListener('mousemove', e => {
        if (!drag) return;
        root.style.left  = `${ox + e.clientX - sx}px`;
        root.style.top   = `${oy + e.clientY - sy}px`;
        root.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { drag = false; });

    let minimized = false;
    root.querySelector('#sc-min').addEventListener('click', () => {
        minimized = !minimized;
        root.querySelector('#sc-body').style.display = minimized ? 'none' : '';
        root.querySelector('#sc-min').textContent = minimized ? '+' : '−';
    });
    root.querySelector('#sc-settings-btn').addEventListener('click', openSettings);
}

function buildSettingsModal() {
    const m = document.createElement('div');
    m.id = 'sc-settings-modal';
    const dropDefs = [
        ['Daily1','Daily $1'],['Daily2','Daily $2'],['Daily3','Daily $3'],
        ['DailyOther','Daily Other'],['HighRollers','High Rollers'],
        ['WeeklyStream','Weekly Stream'],['PlaySmarter','Play Smarter'],['OtherDrops','Other Drops']
    ];
    const currencies = ['usdt','usdc','btc','eth','ltc','xrp','doge','bnb','trx','sol','eos','dai','link','shib','uni','pol','trump'];
    m.innerHTML = `
    <div class="sc-settings-popup">
      <div class="sc-sp-hd"><span class="sc-sp-title">⚙ Settings</span><div class="sc-sp-close" id="sc-sp-close"><svg viewBox="0 0 20 20"><path d="M15 5L5 15M5 5l10 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></div></div>
      <div class="sc-sp-body">
        <div class="sc-section"><div class="sc-section-title">Network Stats</div>
          <div class="sc-net-grid">
            <div class="sc-net-item"><div class="sc-net-lbl">Ping</div><div class="sc-net-val" id="sp-ping">--ms</div></div>
            <div class="sc-net-item"><div class="sc-net-lbl">Jitter</div><div class="sc-net-val" id="sp-jitter">--ms</div></div>
            <div class="sc-net-item"><div class="sc-net-lbl">Loss</div><div class="sc-net-val" id="sp-loss">--%</div></div>
            <div class="sc-net-item"><div class="sc-net-lbl">WS Status</div><div class="sc-net-val" id="sp-status">--</div></div>
          </div>
        </div>
        <div class="sc-section"><div class="sc-section-title">Code Types to Claim</div>
          <div class="sc-opt"><input type="checkbox" class="sc-cb" id="sc-processAll"><label class="sc-lbl" for="sc-processAll" style="color:var(--sc-accent);font-weight:700">Process ALL Codes</label></div>
          <hr class="sc-divider">
          ${dropDefs.map(([v,l]) => `<div class="sc-opt"><input type="checkbox" class="sc-cb sc-drop-cb" id="sc-d-${v}" value="${v}"><label class="sc-lbl" for="sc-d-${v}">${l}</label></div>`).join('')}
        </div>
        <div class="sc-section"><div class="sc-section-title">Claim Settings</div>
          <div class="sc-opt"><input type="checkbox" class="sc-cb" id="sc-vault"><label class="sc-lbl" for="sc-vault">Auto-deposit to Vault</label></div>
          <div class="sc-section-title" style="margin-top:12px">Currency</div>
          <select class="sc-select" id="sc-cur-select">
            ${currencies.map(c => `<option value="${c}"${c===currency?' selected':''}>${c.toUpperCase()}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>`;
    document.body.appendChild(m);
    m.querySelector('#sc-sp-close').addEventListener('click', closeSettings);
    m.addEventListener('click', e => { if (e.target.id === 'sc-settings-modal') closeSettings(); });
    m.querySelectorAll('.sc-cb').forEach(cb => {
        cb.addEventListener('change', () => {
            if (cb.id === 'sc-vault')                     userSettings.vault      = cb.checked;
            else if (cb.id === 'sc-processAll')           userSettings.processAll = cb.checked;
            else if (cb.classList.contains('sc-drop-cb')) {
                if (!userSettings.drops) userSettings.drops = [];
                if (cb.checked && !userSettings.drops.includes(cb.value)) userSettings.drops.push(cb.value);
                else if (!cb.checked) userSettings.drops = userSettings.drops.filter(d => d !== cb.value);
            }
            saveSettings();
        });
    });
    m.querySelector('#sc-cur-select').addEventListener('change', e => {
        currency = e.target.value;
        userSettings.currency = currency;
        saveSettings();
        log(`Currency → ${currency.toUpperCase()}`);
    });
}

function openSettings() {
    const m = document.getElementById('sc-settings-modal');
    m.querySelector('#sc-processAll').checked = !!userSettings.processAll;
    m.querySelector('#sc-vault').checked       = !!userSettings.vault;
    m.querySelectorAll('.sc-drop-cb').forEach(cb => { cb.checked = userSettings.drops && userSettings.drops.includes(cb.value); });
    m.querySelector('#sc-cur-select').value = currency;
    updateSettingsNetStats();
    m.classList.add('open');
}
function closeSettings() { document.getElementById('sc-settings-modal').classList.remove('open'); }

function updateSettingsNetStats() {
    const p = document.getElementById('sp-ping');   if (p)  { p.textContent  = netStats.ping   ? netStats.ping   + 'ms' : '--ms'; p.className  = 'sc-net-val ' + netClass(netStats.ping); }
    const j = document.getElementById('sp-jitter'); if (j)  { j.textContent  = netStats.jitter ? netStats.jitter + 'ms' : '--ms'; j.className  = 'sc-net-val ' + netClass(netStats.jitter); }
    const l = document.getElementById('sp-loss');   if (l)  { l.textContent  = netStats.loss   ? netStats.loss   + '%'  : '--%';  l.className  = 'sc-net-val ' + (netStats.loss > 5 ? 'sv-bad' : netStats.loss > 0 ? 'sv-warn' : 'sv-good'); }
    const s = document.getElementById('sp-status'); if (s)  { const open = wsState === 'connected'; s.textContent = open ? 'Online' : 'Offline'; s.className = 'sc-net-val ' + (open ? 'sv-good' : 'sv-bad'); }
}
function netClass(ms) { if (!ms) return ''; return ms < 100 ? 'sv-good' : ms < 250 ? 'sv-warn' : 'sv-bad'; }

// ════════════════════════════════════════════════════════════
// LOG + UI HELPERS
// ════════════════════════════════════════════════════════════
const ICONS = { ok:'✓', err:'✕', warn:'!', info:'·' };
function log(msg, type = 'info') {
    const box = document.getElementById('sc-log');
    if (!box) return;
    const t   = new Date().toLocaleTimeString('en-US', { hour12: false });
    const row = document.createElement('div');
    const cls = { ok:'ok', err:'err', warn:'warn' }[type] || '';
    row.className = `sc-row ${cls}`;
    row.innerHTML = `<span class="sc-ic">${ICONS[type]||'·'}</span><span class="sc-tx">${msg}</span><span class="sc-ts">${t}</span>`;
    box.appendChild(row);
    if (box.children.length > 150) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
    console.log(`[Surya] ${msg.replace(/<[^>]+>/g, '')}`);
}
// v9.15: ONE self-updating row per code. A code appears exactly ONCE and its row
// mutates in place through its lifecycle (received → claiming → result), instead
// of stacking a new line at every stage (which made the code look duplicated).
function logCode(code, stage, opts = {}) {
    const box = document.getElementById('sc-log');
    if (!box) return;
    // v9.17: use the exact event time when provided (e.g. the precise claim-success
    // moment) so the timestamp reflects WHEN it happened, not when the row rendered.
    const t = (opts.at instanceof Date ? opts.at : new Date()).toLocaleTimeString('en-US', { hour12: false });
    let row = box.querySelector('.sc-row[data-code="' + code + '"]');
    if (!row) {
        row = document.createElement('div');
        row.setAttribute('data-code', code);
        box.appendChild(row);
    }
    let cls = '', ic = '·', tx = '';
    // v9.25: pull the advertised value ($X) so EVERY stage row (recv/claim/ok/soft/warn/err)
    // shows the code AND its worth side-by-side. Server broadcasts payload.value from
    // scraper.py's Telegram parse; handleIncomingCode() stashes it in _codeValue.
    const _worthV = (typeof _codeValue !== 'undefined' && _codeValue) ? _codeValue.get(code) : null;
    const _worthHtml = (_worthV != null && !Number.isNaN(_worthV))
        ? ' <span class="hl-amount">$' + _worthV + '</span>'
        : '';
    if (stage === 'recv')       { cls = '';     ic = '📨'; tx = '<span class="hl-code">' + code + '</span>' + _worthHtml + (opts.note && !_worthHtml ? ' ' + opts.note : ''); }
    else if (stage === 'claim') { cls = 'live'; ic = '⚡'; tx = (opts.retry ? 'Retry ' : '') + '<span class="hl-code">' + code + '</span>' + _worthHtml + ' — claiming…'; }
    else if (stage === 'ok')    { cls = 'ok';   ic = '✅'; tx = '<span class="hl-code">' + code + '</span>' + _worthHtml + ' → <span class="hl-amount hl-claimed">+' + opts.amount + (opts.currency ? ' ' + String(opts.currency).toUpperCase() : '') + '</span>' + (opts.ms ? ' <span class="hl-ms">' + opts.ms + '</span>' : ''); }
    else if (stage === 'soft')  { cls = 'ok';   ic = '✅'; tx = '<span class="hl-code">' + code + '</span>' + _worthHtml + ' → <span class="hl-amount hl-claimed">CLAIMED (soft)</span>' + (opts.ms ? ' <span class="hl-ms">' + opts.ms + '</span>' : ''); }
    else if (stage === 'warn')  { cls = 'warn'; ic = opts.icon || '!'; tx = '<span class="hl-code">' + code + '</span>' + _worthHtml + (opts.detail ? ': ' + opts.detail : ''); }
    else if (stage === 'err')   { cls = 'err';  ic = '✕'; tx = '<span class="hl-code">' + code + '</span>' + _worthHtml + (opts.detail ? ': ' + opts.detail : ''); }
    row.className = 'sc-row ' + cls;
    row.innerHTML = '<span class="sc-ic">' + ic + '</span><span class="sc-tx">' + tx + '</span><span class="sc-ts">' + t + '</span>';
    while (box.children.length > 150) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
}
function setStatus(state, label) {
    const b = document.getElementById('sc-badge');
    const d = document.getElementById('sc-dot');
    const cls = state === 'live' ? 'live' : state === 'dead' ? 'dead' : 'wait';
    if (b) { b.className = cls; b.textContent = label; }
    if (d) { d.className = cls; }
}
function setChip(label, cls) { const c = document.getElementById('sc-chip'); if (c) { c.textContent = label; c.className = `sc-chip ${cls}`; } }
function setUser(name, cls = '') { const u = document.getElementById('sc-uname'); if (u) { u.textContent = name; u.className = cls; } }
function updateStats() {
    const ok = document.getElementById('sn-ok');
    const fl = document.getElementById('sn-fail');
    const tt = document.getElementById('sn-tot');
    if (ok) ok.textContent = successes;
    if (fl) fl.textContent = failures;
    if (tt) tt.textContent = successes + failures;
}
function updateNetBars() {
    const el = document.getElementById('sc-net');
    if (!el) return;
    el.className = 'sc-net-bars ' + (!netStats.ping ? '' : netStats.ping < 100 ? 'net-good' : netStats.ping < 250 ? 'net-med' : 'net-bad');
    el.title = netStats.ping ? `${netStats.ping}ms ping` : 'No data';
}
function setTsStatus(text, cls = '') { const el = document.getElementById('sc-ts-status'); if (el) { el.textContent = text; el.className = cls; } }
function fmtDuration(ms) {
    if (ms <= 0) return 'EXPIRED';
    let r = ms;
    const d = Math.floor(r / 86400000); r -= d * 86400000;
    const h = Math.floor(r / 3600000);  r -= h * 3600000;
    const m = Math.floor(r / 60000);    r -= m * 60000;
    const s = Math.floor(r / 1000);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
}
function renderExpiry() {
    const row = document.getElementById('sc-exp-row');
    const el  = document.getElementById('sc-exp-timer');
    if (!row || !el) return;
    if (expiryMs === null) { row.style.display = 'none'; return; }
    row.style.display = 'flex';
    const rem = expiryMs - Date.now();
    if (rem <= 0) {
        el.textContent = 'EXPIRED';
        el.className   = 'exp-crit';
        if (isAuthorized) { log('Subscription expired — access revoked.', 'err'); showInactiveOverlay('expired'); }
        return;
    }
    el.textContent = fmtDuration(rem);
    el.className   = rem < 3600000 ? 'exp-crit' : rem < 86400000 ? 'exp-warn' : 'exp-ok';
}
function startExpiryTimer() {
    if (_expTimer) clearInterval(_expTimer);
    renderExpiry();
    _expTimer = setInterval(renderExpiry, 1000);
}
function setWsBar(state, retryMsg = '') {
    const el = document.getElementById('sc-ws-state');
    const rt = document.getElementById('sc-ws-retry');
    if (el) { el.textContent = state; el.className = (state==='CONNECTED') ? 'live' : (state==='ERROR'||state==='INACTIVE') ? 'dead' : 'wait'; }
    if (rt) rt.textContent = retryMsg;
}

// ════════════════════════════════════════════════════════════
// TURNSTILE MANAGER — v9.4 FIXED
//
// FIX 1: _onToken() now resets isGenerating=false immediately.
//         In v9.3, isGenerating stayed true for 2s after a token
//         arrived, so _triggerFill() inside _onToken() was a no-op.
//         This caused the token cache to stay at 1 and never
//         pre-warm additional slots.
//
// FIX 2: _executeWidget() now calls turnstile.reset(wid) before
//         execute(wid). Stake's own widget uses execution:'render'
//         (auto-mode). Calling execute() on an already-fired
//         auto-mode widget is a no-op — CF won't generate another
//         token. reset() brings it back to initial state, after
//         which a new challenge runs and fires the callback again.
//
// FIX 3: The hooked callback now schedules a reset+refill 1.5s
//         after firing so the cache is always pre-warmed after
//         each token is consumed by a claim.
// ══════���══════════════════════�����══════════════════════════════
class TurnstileManager {
    constructor() {
        this.tokenCache          = [];
        this.maxCacheSize        = CFG.TOKEN_SLOTS;
        this.tokenTimeout        = CFG.TOKEN_MAX_AGE;
        this.initialized         = false;
        this.isGenerating        = false;
        this.maintenanceTimer    = null;
        this.consecutiveFailures = 0;
        this._tsFailureStart     = null;
        this._hookedWidgetId     = null;
        this._pendingResolvers   = [];
        this._interceptInstalled = false;
        this._ownScriptLoaded    = false;
        this._ownWidgetId        = null;
        this._renderAttempts     = 0;
        this._tier               = 0;
        this._msgChannel         = 'SC_TS_TOKEN_' + Math.random().toString(36).slice(2);
        this._refillTimer        = null;  // FIX: dedicated refill debounce
        this._role               = 'leader'; // v9.12: 'leader' generates + distributes tokens; 'follower' receives pushed tokens
        this._failover           = false;    // v9.12: follower self-generates when leader is unresponsive
        this._emptySince         = null;     // v9.12: tracks how long a follower has been starved (for failover)
        this._lastPushTs         = 0;        // v9.12: last time this tab received a pushed token from the leader
        this._everProducedToken  = false;
        this._failoverArmed      = false;    // v9.13: whether this follower has switched its own widgets ON for failover
    }

    _installIntercept() {
        if (this._interceptInstalled) return;
        this._interceptInstalled = true;
        const self = this;

        function hookTurnstile(ts) {
            if (ts.__surya_hooked) return;
            ts.__surya_hooked = true;
            const origRender = ts.render.bind(ts);
            ts.render = function(container, params) {
                const p = params || {};
                const origCb = p.callback;
                p.callback = (token) => {
                    // ── FIX 3: after token fires, schedule a re-fill
                    self._onToken(token, 'stake-widget');
                    if (typeof origCb === 'function') origCb(token);
                    // Pre-warm: reset widget 1.5s after claim to keep cache full
                    if (self.tokenCache.length < self.maxCacheSize && self._hookedWidgetId !== null) {
                        clearTimeout(self._refillTimer);
                        // v9.13: gentler pacing on Stake's own widget too, so we don't trip CF escalation
                        self._refillTimer = setTimeout(() => self._executeWidget(self._hookedWidgetId), 1500);
                    }
                };
                const origExp = p['expired-callback'];
                p['expired-callback'] = () => {
                    if (self._hookedWidgetId !== null) {
                        setTimeout(() => self._executeWidget(self._hookedWidgetId), 1000);
                    }
                    if (typeof origExp === 'function') origExp();
                };
                const wid = origRender(container, p);
                if (self._tier === 0 || self._tier === 1) {
                    if (self._hookedWidgetId === null) {
                        self._hookedWidgetId = wid;
                        self._tier = 1;
                        self.initialized = true;
                        setTsStatus('HOOKED', 'ok');
                        console.log('[Surya] Turnstile: hooked Stake widget (Tier 1)');
                        self._startMaintenance();
                        setTimeout(() => self._executeWidget(wid), 500);
                    }
                }
                return wid;
            };
        }

        if (typeof window.turnstile !== 'undefined') {
            hookTurnstile(window.turnstile);
        } else {
            let _real;
            Object.defineProperty(window, 'turnstile', {
                configurable: true, enumerable: true,
                get() { return _real; },
                set(val) {
                    _real = val;
                    Object.defineProperty(window, 'turnstile', {
                        configurable: true, enumerable: true, writable: true, value: val,
                    });
                    hookTurnstile(val);
                    if (self._ownScriptLoaded) {
                        setTimeout(() => self._renderOwnWidget(), 200);
                    }
                },
            });
        }
    }

    // ── Tier 2: inject our own widget via page bridge ─────────────
    _injectPageBridge() {
        // v9.16: run the Turnstile widget bridge in the PAGE REALM. Userscript →
        // inject a <script> (Tampermonkey bypasses CSP). Extension MAIN world → call
        // the bridge fn directly (our own code is CSP-exempt; injected <script> is NOT,
        // which is exactly why the extension previously got "bridge failed" → Tier 3).
        _scRunBridge(_suryaWidgetBridge, {
            CH: this._msgChannel,
            SK: CFG.TS_SITEKEY,
            CDN: CFG.TS_CDN,
            COUNT: CFG.TS_PARALLEL_WIDGETS || 4,
            GAP: (CFG.STEADY_MODE ? (CFG.STEADY_GAP_MS || 2500) : (CFG.TS_SOLVE_GAP_MS || 1400)),
            STALL: CFG.TS_STALL_MS || 12000,
        });
        return;
        const channel = this._msgChannel;
        const sitekey = CFG.TS_SITEKEY;
        const cdnUrl  = CFG.TS_CDN;
        const count   = CFG.TS_PARALLEL_WIDGETS || 4;
        const gap     = CFG.TS_SOLVE_GAP_MS || 1400;
        const stall   = CFG.TS_STALL_MS || 12000;
        // v9.9: multi-widget pool — render N widgets in parallel. Each widget
        // operates independently; tokens are produced ~N times faster than v9.8.
        const bridgeCode = `
(function() {
    'use strict';
    var CH    = ${JSON.stringify(channel)};
    var SK    = ${JSON.stringify(sitekey)};
    var COUNT = ${count};

    // Pool of { wid, container, idx, busy, errors, lastTokenAt }
    var widgets = [];

    function postMsg(obj) { try { window.postMessage(Object.assign({ type: CH }, obj), '*'); } catch (e) {} }

    function ensureContainers() {
        var wrap = document.getElementById('sc-ts-wrap');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'sc-ts-wrap';
            wrap.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;z-index:-1';
            document.body.appendChild(wrap);
        }
        for (var i = 0; i < COUNT; i++) {
            var id = 'sc-ts-slot-' + i;
            if (!document.getElementById(id)) {
                var div = document.createElement('div');
                div.id  = id;
                div.setAttribute('data-surya-slot', String(i));
                wrap.appendChild(div);
            }
        }
    }

    function renderOne(idx) {
        if (!window.turnstile) return;
        var container = document.getElementById('sc-ts-slot-' + idx);
        if (!container) return;
        var slot = widgets[idx];
        if (slot && slot.wid != null) {
            try { window.turnstile.remove(slot.wid); } catch (e) {}
        }
        try {
            var wid = window.turnstile.render(container, {
                sitekey: SK,
                theme: 'dark',
                execution: 'execute',
                appearance: 'interaction-only',
                retry: 'auto',
                'retry-interval': 3000,
                callback: function (token) {
                    var s = widgets[idx];
                    if (s) { s.busy = false; s.errors = 0; s.lastTokenAt = Date.now(); s.lastExecuteAt = 0; }
                    if (demand > 0) demand--;
                    postMsg({ token: token, slot: idx });
                    // Demand-driven: only solve again if the main world still wants more.
                    if (demand > 0) setTimeout(pump, MIN_GAP);
                },
                'expired-callback': function () {
                    var s = widgets[idx];
                    if (s) s.busy = false;
                    // Do NOT auto re-solve — the demand pump decides when.
                },
                'error-callback': function (code) {
                    var s = widgets[idx];
                    if (s) { s.busy = false; s.errors = (s.errors || 0) + 1; }
                    postMsg({ error: code, slot: idx });
                    // Persistent error usually means CF escalated → hard re-render with backoff.
                    if (s && s.errors >= 2) {
                        s.errors = 0;
                        setTimeout(function () { renderOne(idx); }, 5000);
                    }
                }
            });
            widgets[idx] = { wid: wid, idx: idx, busy: false, errors: 0, lastTokenAt: 0, lastSolveAt: 0 };
            postMsg({ ready: true, slot: idx, widgetId: String(wid) });
            // Demand-driven: first solve fires once the main world sets demand.
            setTimeout(pump, 300);
        } catch (e) {
            postMsg({ error: e.message || 'render_fail', slot: idx });
            setTimeout(function () { renderOne(idx); }, 5000);
        }
    }

    var MIN_GAP  = ${gap};      // min ms between solves on the SAME widget (anti-escalation)
    var STALL_MS = ${stall};    // hard re-render a widget if a solve never returns
    var demand   = 0;           // how many more tokens the main world currently wants
    var _activeSlots = 0;       // widgets allowed to run (0 = idle follower; set via setConcurrency)

    function canSolve(s) {
        return s && s.wid != null && !s.busy && window.turnstile &&
               (Date.now() - (s.lastSolveAt || 0) >= MIN_GAP);
    }

    function solve(idx) {
        var s = widgets[idx];
        if (!canSolve(s)) return false;
        s.busy = true; s.lastExecuteAt = Date.now(); s.lastSolveAt = Date.now();
        try {
            window.turnstile.reset(s.wid);
            setTimeout(function () { try { window.turnstile.execute(s.wid); } catch (e) {} }, 120);
        } catch (e) { s.busy = false; return false; }
        return true;
    }

    // Demand pump: hand idle widgets to outstanding demand, paced + capped by _activeSlots.
    function pump() {
        if (_activeSlots <= 0 || demand <= 0) return;
        var launched = 0;
        for (var i = 0; i < COUNT && i < _activeSlots; i++) {
            if (launched >= demand) break;
            if (canSolve(widgets[i])) { if (solve(i)) launched++; }
        }
    }
    setInterval(pump, 500);

    // Stall watchdog: if a solve never returns (CF escalated/dropped it), hard re-render.
    setInterval(function () {
        var now = Date.now();
        for (var i = 0; i < COUNT; i++) {
            var s = widgets[i];
            if (!s) continue;
            if (s.busy && s.lastExecuteAt && (now - s.lastExecuteAt) > STALL_MS) {
                postMsg({ stuck: true, slot: i, age: now - s.lastExecuteAt });
                renderOne(i);
            }
        }
    }, 3000);

    window.addEventListener('message', function (ev) {
        if (!ev.data || ev.data.type !== CH + '_CMD') return;
        var d = ev.data;
        if (d.cmd === 'demand') {
            demand = Math.max(0, d.count | 0);
            pump();
        } else if (d.cmd === 'setConcurrency') {
            _activeSlots = Math.max(0, Math.min(COUNT, d.activeSlots | 0));
            if (_activeSlots > 0) pump();
        } else if (d.cmd === 'execute') {
            // legacy compat: treat as "want at least 1 more"
            if (demand < 1) demand = 1;
            pump();
        }
    });

    window.suryaTsReady = function () {
        postMsg({ loaded: true });
        ensureContainers();
        // Stagger renders so we don't slam CF with N simultaneous requests.
        for (var i = 0; i < COUNT; i++) {
            (function (idx) { setTimeout(function () { renderOne(idx); }, idx * 800); })(i);
        }
    };

    var s = document.createElement('script');
    s.src = ${JSON.stringify(cdnUrl)} + '?render=explicit&onload=suryaTsReady';
    s.async = true;
    s.onerror = function () { postMsg({ scriptError: true }); };
    document.head.appendChild(s);
})();`;
        const script = document.createElement('script');
        script.textContent = bridgeCode;
        (document.head || document.documentElement).appendChild(script);
        script.remove();
    }

    _listenForBridgeMessages() {
        window.addEventListener('message', (ev) => {
            if (!ev.data || ev.data.type !== this._msgChannel) return;
            const msg = ev.data;
            if (msg.scriptError) { log('Turnstile: CDN script failed — trying Tier 3', 'err'); this._initTier3(); return; }
            if (msg.loaded)  { console.log('[Surya] Turnstile: page-bridge script loaded'); this._ownScriptLoaded = true; return; }
            if (msg.ready)   { this._tier = 2; this.initialized = true; setTsStatus('ACTIVE', 'ok'); console.log('[Surya] Turnstile: own widget rendered'); this._startMaintenance(); try { _applyTabRole(this._role); } catch (_) {} this._triggerBridgeExecute(); return; }
            if (msg.error)   {
                // v9.11: widget error codes (e.g. 600010) are transient CF hiccups. Log to console only —
                // do NOT spam the panel, and NEVER downgrade to Tier 3 once the widget has produced tokens.
                if (CFG.VERBOSE_LOGS) log(`Turnstile: widget error ${msg.error}`, 'warn'); else console.warn('[Surya] TS widget error ' + msg.error + ' (slot ' + msg.slot + ')');
                if (!this._everProducedToken) {
                    this._renderAttempts++;
                    if (this._renderAttempts >= 8) { log('Turnstile: cannot generate tokens — switching to server mode', 'err'); this._initTier3(); }
                }
                return;
            }
            if (msg.stuck)   { if (CFG.VERBOSE_LOGS) log(`Turnstile: slot ${msg.slot} unstuck (was busy ${Math.round(msg.age/1000)}s)`, 'warn'); else console.warn('[Surya] slot ' + msg.slot + ' unstuck (' + Math.round(msg.age/1000) + 's)'); _trackStuck(); return; }
            if (msg.token)   { this._onToken(msg.token, 'own-widget'); }
        });
    }

    _triggerBridgeExecute() {
        // v9.19.2: pure demand signal. The bridge paces solves (TS_SOLVE_GAP_MS) and the adaptive
        // backoff owns concurrency — do NOT force slots back up here. That was instantly undoing every
        // CF backoff (6-widget hammer re-armed on every poke) → permanent throttle.
        const deficit = Math.max(0, this.maxCacheSize - this.tokenCache.length);
        window.postMessage({ type: this._msgChannel + '_CMD', cmd: 'demand', count: deficit }, '*');
    }

    _initTier3() {
        // v9.16.1: There is NO token server in this build (TOKEN_SERVER_URL is
        // empty), so "Tier 3" was a dead branch that flip-flopped straight back
        // to Tier 2 and spammed "server tokens" + "wedged". Instead of pretending
        // to have a server, re-arm the REAL token source — the page-realm
        // Turnstile widget bridge — with a cooldown so it can't hot-loop.
        if (!CFG.TOKEN_SERVER_URL) {
            const now = Date.now();
            if (this._lastRearm && (now - this._lastRearm) < 15_000) { this._tier = 2; return; }
            this._lastRearm = now;
            this._rearmCount = (this._rearmCount || 0) + 1;
            this._tier = 2;
            this.initialized = true;
            this._renderAttempts = 0;
            window.__suryaTsRan = false;   // let the bridge render again
            if (this._rearmCount <= 6) {
                setTsStatus('RETRYING', 'warn');
                if (this._rearmCount === 1 || CFG.VERBOSE_LOGS) log('Turnstile: widget not up yet — re-arming token bridge…', 'warn');
            } else if (this._rearmCount === 7) {
                setTsStatus('WIDGET?', 'warn');
                log('Turnstile: widget still not loading — open the console and check for a CSP/script error', 'err');
            } else {
                setTsStatus('WIDGET?', 'warn');
            }
            try { this._injectPageBridge(); } catch (_) {}
            this._startMaintenance();
            this._triggerBridgeExecute();
            return;
        }
        if (this._tier === 3) return;
        this._tier = 3;
        this.initialized = true;
        setTsStatus('SERVER', 'warn');
        log('Turnstile: using server-side tokens (Tier 3)', 'warn');
        this._startMaintenance();
        this._fetchServerToken();
    }

    _fetchServerToken() {
        if (this._tier !== 3) return;
        // v9.14: no farm endpoint configured → don't hammer a dead URL. Fall back to
        // local widget generation (Tier 2), which is the real token source.
        if (!CFG.TOKEN_SERVER_URL) { this._tier = 2; this._triggerBridgeExecute(); return; }
        if (this.tokenCache.length >= this.maxCacheSize) return;
        const serverBase = (CFG.TOKEN_SERVER_URL || CFG.WS_URL)
            .replace(/^wss?:\/\//, 'https://')
            .replace(/\/ws\/codes$/, '');
        const url = `${serverBase}/api/token`;
        log('Fetching server token from farm…', 'info');
        GM_xmlhttpRequest({
            method: 'GET', url, headers: { 'x-scraper-secret': CFG.TOKEN_SECRET }, timeout: 20_000,
            onload: (res) => {
                try {
                    const d = JSON.parse(res.responseText);
                    if (d.token) {
                        log(`Farm token received ✓ pool=${d.pool?.pool ?? '?'}`, 'ok');
                        this._onToken(d.token, 'farm');
                        if (this.tokenCache.length < this.maxCacheSize) setTimeout(() => this._fetchServerToken(), 200);
                    } else {
                        log(`Farm token: ${d.error || d.message || 'no token'}`, 'warn');
                        setTimeout(() => this._fetchServerToken(), 5_000);
                    }
                } catch(e) { log(`Farm token parse error: ${e.message}`, 'warn'); setTimeout(() => this._fetchServerToken(), 8_000); }
            },
            onerror:   () => { log('Farm endpoint unreachable — retrying in 10s', 'warn'); setTimeout(() => this._fetchServerToken(), 10_000); },
            ontimeout: () => { log('Farm endpoint timeout — retrying', 'warn');         setTimeout(() => this._fetchServerToken(),  8_000); },
        });
    }

    // ── FIX 1: Reset isGenerating immediately on token arrival ────
    // In v9.3, isGenerating stayed true for up to 2s after a token
    // arrived. Any _triggerFill() call inside _onToken() would bail
    // out early, leaving the cache stuck at whatever it was.
    _onToken(token, source = '?') {
        // ← CRITICAL FIX: unblock the fill loop immediately
        this.isGenerating = false;
        this.consecutiveFailures = 0;
        this._tsFailureStart     = null;
        this._everProducedToken  = true;   // v9.11: mark healthy so transient errors never force Tier 3

        const statusText = source === 'stake-widget' ? 'HOOKED ✓'
                         : source === 'own-widget'   ? 'ACTIVE ✓' : 'SERVER ✓';
        setTsStatus(statusText, 'ok');

        if (this._pendingResolvers.length > 0) {
            const { resolve, timer } = this._pendingResolvers.shift();
            clearTimeout(timer);
            resolve(token);
            // After resolving a waiter, immediately kick off next token generation
            setTimeout(() => this._triggerFill(), 100);
            return;
        }

        if (this.tokenCache.length < this.maxCacheSize) {
            this.tokenCache.push({ token, ts: Date.now() });
            updateTokenUI();
            if (CFG.VERBOSE_LOGS) log(`Token cached [${source}] ${this.tokenCache.length}/${this.maxCacheSize}`); else console.log('%c[Surya] Token cached ' + this.tokenCache.length + '/' + this.maxCacheSize + ' [' + source + ']', 'color:#7a7');
            if (this.tokenCache.length < this.maxCacheSize) {
                this._triggerFill();
            }
        }
    }

    // ── FIX 2: reset() before execute() for Stake's auto-mode widget
    // Stake renders its Turnstile widget with execution:'render' (default),
    // meaning the widget auto-fires once and then goes idle. Calling
    // execute() on an idle auto-mode widget is a CF no-op — it does nothing.
    // reset() tears down the widget and starts a fresh challenge, which
    // fires the callback automatically (no execute() needed for render-mode).
    // We still call execute() after 400ms as a fallback for execute-mode widgets.
    _executeWidget(wid) {
        if (wid === null || wid === undefined) return false;
        if (typeof window.turnstile === 'undefined') return false;
        try {
            // FIX: reset first — this is the key fix for Tier 1 re-generation
            window.turnstile.reset(wid);
            // v9.9: execute() faster (was 400ms) for execute-mode widgets
            setTimeout(() => {
                try { window.turnstile.execute(wid); } catch (_) {}
            }, 100);
            return true;
        } catch(e) {
            log(`Widget execute failed (${wid}): ${e.message}`, 'warn');
            return false;
        }
    }

    async initialize() {
        this._listenForBridgeMessages();
        this._installIntercept();
        await sleep(800); // v9.17: start our own widget sooner for a faster first token
        if (this.initialized && this._tier === 1) {
            console.log('[Surya] Turnstile: using Stake widget (native hook)');
            return;
        }
        if (CFG.VERBOSE_LOGS) log('Turnstile: starting token engine…', 'info'); else console.log('[Surya] starting token engine');
        setTsStatus('WARMING…', 'warn');
        this._injectPageBridge();
        await new Promise(resolve => {
            const check = setInterval(() => { if (this.initialized) { clearInterval(check); resolve(); } }, 400);
            setTimeout(() => { clearInterval(check); resolve(); }, 15_000);
        });
        if (!this.initialized) {
            // v9.17 SINGLE-TIER: no server fallback. Re-arm the widget engine; the
            // watchdog will hard-refresh (loop-guarded) if it still can't produce tokens.
            console.warn('[Surya] widget not ready yet — re-arming engine');
            this._initTier3();
        }
    }

    async reinitialize() {
        this.tokenCache = [];
        this._pendingResolvers.forEach(p => { clearTimeout(p.timer); p.reject(new Error('reinit')); });
        this._pendingResolvers = [];
        this._ownWidgetId      = null;
        this._renderAttempts   = 0;
        this.isGenerating      = false;  // FIX: always reset on reinit
        updateTokenUI();
        if (this._tier === 1 && this._hookedWidgetId !== null) {
            this._executeWidget(this._hookedWidgetId);
        } else if (this._tier === 2) {
            this._triggerBridgeExecute();
        } else if (this._tier === 3) {
            this._fetchServerToken();
        }
    }

    _cleanExpired() {
        const now = Date.now();
        this.tokenCache = this.tokenCache.filter(t => now - t.ts < this.tokenTimeout);
    }

    getFastToken() {
        this._cleanExpired();
        if (this.tokenCache.length > 0) {
            const t = this.tokenCache.shift();
            updateTokenUI();
            this._triggerFill();
            if (typeof TabBus !== 'undefined') TabBus.reportStock(); // v9.12: tell leader to restock this tab
            return t.token;
        }
        return null;
    }

    // v9.12: accept a token PUSHED from the leader tab. Preserves the original
    // timestamp so a shared token still expires on schedule (no stale reuse).
    _acceptShared(token, ts) {
        this.isGenerating       = false;
        this._everProducedToken = true;
        this._lastPushTs        = Date.now();
        this._failover          = false;
        this._emptySince        = null;
        setTsStatus('POOL ✓', 'ok');
        if (this._pendingResolvers.length > 0) {
            const { resolve, timer } = this._pendingResolvers.shift();
            clearTimeout(timer);
            resolve(token);
            return;
        }
        this.tokenCache.push({ token, ts: ts || Date.now() });
        // keep the follower buffer bounded
        while (this.tokenCache.length > CFG.XTAB_MIN_PER_TAB + 2) this.tokenCache.shift();
        updateTokenUI();
    }

    async getToken() {
        this._cleanExpired();
        if (this.tokenCache.length > 0) {
            const t = this.tokenCache.shift();
            updateTokenUI();
            this._triggerFill();
            if (typeof TabBus !== 'undefined') TabBus.reportStock();
            return t.token;
        }
        // Empty: ask for a fill. Leader generates locally; a follower pulls from the leader.
        // Either way the token arrives via _onToken / _acceptShared and resolves the waiter below.
        this._triggerFill();
        if (typeof TabBus !== 'undefined' && TabBus.enabled && !TabBus.isLeader) TabBus.pull();
        if (CFG.VERBOSE_LOGS) log('Token cache empty — waiting…', 'warn'); else console.warn('[Surya] token cache empty, waiting');
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pendingResolvers = this._pendingResolvers.filter(p => p.resolve !== resolve);
                this.consecutiveFailures++;
                this._checkFailureThreshold();
                reject(new Error('Token wait timeout'));
            }, CFG.TS_TIMEOUT);
            this._pendingResolvers.push({ resolve, reject, timer });
        });
    }

    // v9.12: role-aware refill dispatcher. Followers pull from the leader instead
    // of running their own widgets (avoids CF throttling from 10x parallel widgets).
    _triggerFill() {
        // v9.19.2: followers pull from the leader instead of running their own widgets
        // (running widgets in every tab multiplies Cloudflare's per-IP load → throttle).
        // Leader + any failover tab generate locally.
        // v9.21.0: steady mode -> every tab generates locally (surplus still shared via the bus).
        if (!CFG.STEADY_MODE && typeof TabBus !== 'undefined' && TabBus.enabled && this._role === 'follower' && !this._failover) {
            TabBus.pull();
            return;
        }
        this._generateFill();
    }

    _generateFill() {
        if (this.isGenerating) return;
        if (this.tokenCache.length >= this.maxCacheSize) return;
        this.isGenerating = true;
        // FIX C (v9.10): tag each generation attempt so the safety-valve
        // only clears state when *this* attempt is still in-flight.
        // Prevents clobbering a legitimately active newer attempt.
        this._genId = (this._genId || 0) + 1;
        const myId  = this._genId;

        if (this._tier === 1 && this._hookedWidgetId !== null) {
            this._executeWidget(this._hookedWidgetId);
        } else if (this._tier === 2) {
            this._triggerBridgeExecute();
        } else if (this._tier === 3) {
            this._fetchServerToken();
        }
        // Safety valve — only if no newer _triggerFill has replaced this one
        setTimeout(() => {
            if (this._genId === myId && this.isGenerating) {
                this.isGenerating = false;
                // Auto-retry if cache still not full
                if (this.tokenCache.length < this.maxCacheSize) {
                    if (this._tier === 2) this._triggerBridgeExecute();
                    else if (this._tier === 1 && this._hookedWidgetId !== null) this._executeWidget(this._hookedWidgetId);
                    else if (this._tier === 3) this._fetchServerToken();
                }
            }
        }, 4000);
    }

    _checkFailureThreshold() {
        if (!this._tsFailureStart) this._tsFailureStart = Date.now();
        if (Date.now() - this._tsFailureStart > CFG.TS_FAILURE_LIMIT_MS) {
            this._tsFailureStart = null;
            _safeHardReload('token engine stalled');
        }
    }

    async _maintain() {
        this._cleanExpired();

        // v9.12: cross-tab role handling ─────────────────────────────
        const xtab = (typeof TabBus !== 'undefined') && TabBus.enabled;
        let generateHere = true;
        if (xtab && CFG.STEADY_MODE) {
            // v9.21.0: every tab keeps its OWN full buffer, generating locally at a gentle pace.
            // Surplus is still shared -- the leader hands spare tokens to any tab that dips low.
            this.maxCacheSize = CFG.TOKEN_SLOTS;
            this._failover = false; this._emptySince = null;
            generateHere = true;
            if (typeof TabBus !== 'undefined') { TabBus.reportStock(); if (this._role === 'leader') TabBus.distribute(); }
        } else if (xtab) {
            if (this._role === 'leader') {
                // Leader generates the WHOLE pool: its own buffer + a buffer for every follower.
                this.maxCacheSize = Math.min(CFG.XTAB_MAX_POOL, CFG.TOKEN_SLOTS + TabBus.peerCount * CFG.XTAB_MIN_PER_TAB);
                TabBus.distribute();
                this._failover = false; this._emptySince = null;
            } else {
                // v9.19.2: follower holds a LARGE ready buffer, replenished by the leader's push.
                // Big buffer = two tabs can claim the same code simultaneously without starving.
                // Only self-generates during a genuine leader outage (failover) — this keeps
                // Cloudflare load to ONE tab's worth for the whole browser (CF limits per IP).
                this.maxCacheSize = CFG.XTAB_MIN_PER_TAB + 2;
                TabBus.reportStock();
                if (this.tokenCache.length === 0) {
                    if (!this._emptySince) this._emptySince = Date.now();
                    if (Date.now() - this._emptySince > CFG.XTAB_FAILOVER_MS) this._failover = true; // leader looks dead
                } else { this._emptySince = null; this._failover = false; }
                generateHere = this._failover;               // only self-generate during failover
                if (this._failover && !this._failoverArmed) {
                    this._failoverArmed = true;
                    try { window.postMessage({ type: this._msgChannel + '_CMD', cmd: 'setConcurrency', activeSlots: (CFG.TS_PARALLEL_WIDGETS || 4) }, '*'); } catch (_) {}
                } else if (!this._failover && this._failoverArmed) {
                    this._failoverArmed = false;
                    try { window.postMessage({ type: this._msgChannel + '_CMD', cmd: 'setConcurrency', activeSlots: 0 }, '*'); } catch (_) {}
                }
                if (!this._failover && this.tokenCache.length < CFG.XTAB_MIN_PER_TAB) TabBus.pull();
            }
        } else {
            this.maxCacheSize = CFG.TOKEN_SLOTS;
        }

        updateTokenUI();

        // FIX D (v9.10): aggressive fill for whoever is responsible for generating.
        if (generateHere && this.tokenCache.length < this.maxCacheSize) {
            if (!this.isGenerating) {
                this._generateFill();
            } else if (this._tier === 2 && this.tokenCache.length < Math.ceil(this.maxCacheSize / 2)) {
                // Cache is critically low — bypass isGenerating flag and directly poke bridge
                this._triggerBridgeExecute();
            }
        }
        if (generateHere && this._tier === 3 && this.tokenCache.length < this.maxCacheSize) {
            this._fetchServerToken();
        }
    }

    _startMaintenance() {
        if (this.maintenanceTimer) return;
        this.maintenanceTimer = setInterval(() => this._maintain(), 1_500); // v9.14: top the pool up twice as often
    }
}

const tsManager = new TurnstileManager();

// ════════════════════════════════════════════════════════════
// CROSS-TAB TOKEN BUS (v9.11)
// Shares ONE token pool across every tab in the same browser profile.
// A single "leader" tab generates at full widget concurrency; follower
// tabs drop to 1 widget and pull spare tokens from the leader. Falls back
// to per-tab generation automatically if BroadcastChannel is unavailable.
// ════════════════════════════════════════════════════════════
const TabBus = (function () {
    const enabled = (typeof BroadcastChannel !== 'undefined') && CFG.XTAB_ENABLED;
    const selfId  = Math.random().toString(36).slice(2) + Date.now().toString(36);
    let ch = null, _isLeader = !enabled, _leaderId = null;
    const peers     = new Map();   // id -> lastSeen
    const peerStock = new Map();   // id -> { count, ts }  (leader's view of each follower's ready tokens)
    let _onRole = null, _curRole = null;
    let _lastReport = 0;

    function post(obj) { if (ch) { try { ch.postMessage(Object.assign({ from: selfId }, obj)); } catch (_) {} } }

    function elect() {
        const now = Date.now();
        for (const [pid, ts] of peers)     if (now - ts > 6000) peers.delete(pid);
        for (const [pid, s]  of peerStock) if (now - s.ts > 8000) peerStock.delete(pid);
        let min = selfId;
        for (const pid of peers.keys()) if (pid < min) min = pid;
        _leaderId = min;
        _isLeader = (min === selfId);
        const role = _isLeader ? 'leader' : 'follower';
        if (role !== _curRole) { _curRole = role; if (_onRole) { try { _onRole(role); } catch (_) {} } }
    }

    function init(opts) {
        _onRole = opts.onRole || null;
        if (!enabled) { _curRole = 'leader'; if (_onRole) { try { _onRole('leader'); } catch (_) {} } return; }
        try { ch = new BroadcastChannel('surya_token_bus'); } catch (_) { _isLeader = true; if (_onRole) _onRole('leader'); return; }
        ch.onmessage = (ev) => {
            const m = ev.data; if (!m || m.from === selfId) return;
            peers.set(m.from, Date.now());
            if (m.t === 'bye')   { peers.delete(m.from); peerStock.delete(m.from); elect(); return; }
            if (m.t === 'stock') { peerStock.set(m.from, { count: m.count | 0, ts: Date.now() }); if (_isLeader) distribute(); return; }
            if (m.t === 'give' && m.to === selfId && m.token) {
                try { tsManager._acceptShared(m.token, m.ts || Date.now()); } catch (_) {}
                return;
            }
        };
        post({ t: 'ping' }); elect();
        setInterval(() => { post({ t: 'ping' }); elect(); }, 2000);
        window.addEventListener('beforeunload', () => post({ t: 'bye' }));
    }

    // Follower → leader: report how many ready tokens I currently hold (throttled).
    function reportStock() {
        if (!enabled || _isLeader) return;
        const now = Date.now();
        if (now - _lastReport < 250) return;
        _lastReport = now;
        post({ t: 'stock', count: tsManager.tokenCache.length });
    }

    // Follower asks the leader to top it up now (implemented as an immediate stock report).
    function pull() { reportStock(); }

    // Leader → followers: proactively push spare tokens so every tab stays topped up
    // to XTAB_MIN_PER_TAB, while the leader keeps its own reserve.
    function distribute() {
        if (!enabled || !_isLeader) return;
        const now = Date.now();
        const MIN = CFG.XTAB_MIN_PER_TAB;
        const needy = [];
        for (const [pid, s] of peerStock) {
            if (now - s.ts > 8000) continue;
            if (s.count < MIN) needy.push({ pid, count: s.count });
        }
        needy.sort((a, b) => a.count - b.count); // neediest first
        let gave = false;
        for (const f of needy) {
            while (f.count < MIN && tsManager.tokenCache.length > MIN) {   // keep MIN reserve for the leader itself
                const t = tsManager.tokenCache.shift();
                if (!t) break;
                post({ t: 'give', to: f.pid, token: t.token, ts: t.ts });
                f.count++;
                const s = peerStock.get(f.pid); if (s) s.count++;          // optimistic: avoid over-sending before next report
                gave = true;
            }
        }
        if (gave) { updateTokenUI(); tsManager._triggerFill(); }           // refill what we handed out
    }

    return {
        init, reportStock, pull, distribute,
        get enabled()   { return enabled; },
        get isLeader()  { return _isLeader; },
        get id()        { return selfId; },
        get peerCount() { return peers.size; },
    };
})();

function _applyTabRole(role) {
    tsManager._role = role;
    if (role === 'leader') { tsManager._failover = false; tsManager._emptySince = null; }
    // Leader runs full widget concurrency; followers keep 1 rendered widget as a warm
    // standby for failover but normally stay idle and live off the leader's pushed pool.
    // v9.19.2: ONLY the leader generates (Cloudflare rate-limits per IP, not per tab — one
    // generator per browser is the ceiling anyway). Followers run 0 widgets and live off the
    // leader's proactively-pushed pool. CF-safe way to feed multiple tabs.
    // v9.21.0: steady mode -> EVERY tab generates its own tokens (few widgets, slow gap).
    // Otherwise fall back to the single-leader model (leader generates, followers pull).
    const slots = CFG.STEADY_MODE
        ? (CFG.STEADY_WIDGETS || 2)
        : (role === 'leader' ? (CFG.TS_PARALLEL_WIDGETS || 4) : 0);
    try { window.postMessage({ type: tsManager._msgChannel + '_CMD', cmd: 'setConcurrency', activeSlots: slots }, '*'); } catch (_) {}
    if (CFG.VERBOSE_LOGS) log(`Cross-tab: this tab is ${role.toUpperCase()}${role === 'leader' ? ' (token provider)' : ' (shared pool)'}`, 'info');
    else console.log('[Surya] cross-tab role: ' + role);
}

// v9.10.1: adaptive concurrency — back off widgets if CF is throttling
const _stuckEvents = [];
let   _reducedMode = false;
let   _reducedUntil = 0;
function _trackStuck() {
    const now = Date.now();
    _stuckEvents.push(now);
    // keep only last 30s
    while (_stuckEvents.length && (now - _stuckEvents[0]) > 30_000) _stuckEvents.shift();
    if (_stuckEvents.length >= 3 && !_reducedMode) {
        _reducedMode  = true;
        _reducedUntil = now + 45_000;
        // v9.19.2: back off EARLY (3 stalls in 30s) and hold longer (45s). Drop to 2 widgets so a
        // little generation continues while CF cools down. Full concurrency restores automatically.
        const _few = CFG.STEADY_MODE ? 1 : Math.max(2, Math.floor((CFG.TS_PARALLEL_WIDGETS || 4) / 2));
        console.warn('[Surya] Turnstile: CF throttling detected — reducing to ' + _few + ' widgets for 45s');
        try { window.postMessage({ type: tsManager._msgChannel + '_CMD', cmd: 'setConcurrency', activeSlots: _few }, '*'); } catch (_) {}
    }
}
setInterval(() => {
    if (_reducedMode && Date.now() > _reducedUntil && _stuckEvents.length === 0) {
        _reducedMode = false;
        console.log('[Surya] Turnstile: throttling cleared — restoring full concurrency');
        try { window.postMessage({ type: tsManager._msgChannel + '_CMD', cmd: 'setConcurrency', activeSlots: (CFG.STEADY_MODE ? (CFG.STEADY_WIDGETS || 2) : CFG.TS_PARALLEL_WIDGETS) }, '*'); } catch (_) {}
    }
}, 5_000);

function updateTokenUI() {
    const pips  = document.querySelectorAll('.sc-pip');
    const cache = tsManager.tokenCache.length;
    const shown = Math.min(cache, pips.length);
    pips.forEach((p, i) => {
        p.className = 'sc-pip';
        if (i < shown) p.classList.add('rdy');
        else if (tsManager.isGenerating && i === shown) p.classList.add('gen');
    });
    const ct = document.getElementById('sc-tok-ct');
    // Leader can hold a large shared pool; show "6+" rather than an overflowing count.
    if (ct) ct.textContent = cache > CFG.TOKEN_SLOTS ? `${CFG.TOKEN_SLOTS}+` : `${cache}/${CFG.TOKEN_SLOTS}`;
}

// v9.17: hard-refresh self-heal with a loop guard so we can NEVER reload-loop.
// Tracks reloads in sessionStorage over a rolling 10-minute window; if too many
// happen, it stops refreshing and surfaces the problem instead of thrashing.
function _safeHardReload(reason) {
    if (!CFG.AUTO_REFRESH) return;
    try {
        const KEY = 'sc_reloads';
        const now = Date.now();
        let arr = [];
        try { arr = JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch (_) { arr = []; }
        arr = arr.filter(t => now - t < 600_000); // keep last 10 min
        if (arr.length >= CFG.REFRESH_MAX_PER_10MIN) {
            log('Auto-refresh paused (too many reloads) — check connection / Turnstile', 'err');
            console.warn('[Surya] auto-refresh suppressed to avoid a reload loop');
            return;
        }
        arr.push(now);
        sessionStorage.setItem(KEY, JSON.stringify(arr));
    } catch (_) {}
    log('Self-heal: hard refreshing (' + reason + ')…', 'warn');
    setTimeout(() => { try { location.reload(); } catch (_) { location.href = location.href; } }, 400);
}

let _cacheEmptySince = null;
let _cacheRecoveryStep = 0;
let _genStuckSince = null;
function startCacheWatcher() {
    setInterval(() => {
        if (!tsManager.initialized) { _cacheEmptySince = null; _cacheRecoveryStep = 0; _genStuckSince = null; return; }
        // v9.15: watchdog for a WEDGED generator. If isGenerating has been stuck
        // true with a non-full cache and no token has landed, the widget silently
        // died (the recovery ladder below only fires when isGenerating is false, so
        // a stuck flag would otherwise freeze token production forever). Force-clear
        // it and re-trigger. This is the core fix for "sometimes it doesn't generate
        // a token / it gets stuck".
        if (tsManager.isGenerating && tsManager.tokenCache.length < tsManager.maxCacheSize) {
            if (!_genStuckSince) { _genStuckSince = Date.now(); }
            else if (Date.now() - _genStuckSince > 8_000) {
                _genStuckSince = null;
                tsManager.isGenerating = false;
                if (CFG.VERBOSE_LOGS) log('Token generator wedged >12s — force-restarting…', 'warn'); else console.warn('[Surya] generator wedged >12s — restarting');
                try {
                    if (tsManager._tier === 2) tsManager._triggerBridgeExecute();
                    else if (tsManager._tier === 1 && tsManager._hookedWidgetId !== null) tsManager._executeWidget(tsManager._hookedWidgetId);
                    else tsManager.reinitialize().catch(() => {});
                } catch (_) {}
            }
        } else {
            _genStuckSince = null;
        }
        if (tsManager.tokenCache.length === 0 && !tsManager.isGenerating) {
            if (!_cacheEmptySince) { _cacheEmptySince = Date.now(); _cacheRecoveryStep = 0; return; }
            const empty = Date.now() - _cacheEmptySince;
            // v9.17 SINGLE-TIER self-heal ladder (fast, then hard refresh):
            //   8s  → poke the widget engine
            //   18s → full re-arm of the widget engine
            //   30s → hard refresh the page (loop-guarded, rare)
            if (empty >= 8_000 && _cacheRecoveryStep < 1) {
                _cacheRecoveryStep = 1;
                if (CFG.VERBOSE_LOGS) log('No tokens 8s — poking engine…', 'warn'); else console.warn('[Surya] no tokens 8s — poking');
                tsManager._triggerBridgeExecute();
            } else if (empty >= 18_000 && _cacheRecoveryStep < 2) {
                _cacheRecoveryStep = 2;
                if (CFG.VERBOSE_LOGS) log('No tokens 18s — re-arming engine…', 'warn'); else console.warn('[Surya] no tokens 18s — re-arming');
                window.__suryaTsRan = false;
                tsManager.reinitialize().catch(() => {});
                tsManager._injectPageBridge();
                tsManager._triggerBridgeExecute();
            } else if (empty >= CFG.REFRESH_STALL_MS && _cacheRecoveryStep < 3) {
                _cacheRecoveryStep = 3;
                _safeHardReload('no tokens for ' + Math.round(empty / 1000) + 's');
            }
        } else { _cacheEmptySince = null; _cacheRecoveryStep = 0; }
    }, CFG.CACHE_WATCHER_MS);
}

// ════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════��════════════════
// SESSION / USERNAME DETECTION — v9.7 BALANCED
//
// v9.5: too loose → caught feature flags like casino_widgets_flag.
// v9.6: too strict → caught nothing because it required `email`
//        or 2+ strong fields which real Stake user objects often
//        don't fully expose in every response.
//
// v9.7 strategy:
//   The NAME itself is the strict guard — if the name passes the
//   blocklist (no _flag, _widget, etc.) and underscore-count rule
//   (max 1 underscore), it's safe.  Feature flag names always fail
//   these.  Real usernames always pass.
//
//   For the object: just need ONE anchor field (id/email/anything).
//   Hard-reject only OBVIOUS feature-flag shapes (has `enabled`,
//   `value`+boolean, `variant`, `rolloutPercent`, etc.).
//
// Diagnostic console.log added throughout so we can see what's
// being tried, accepted, and rejected.
// ════════════════════════════════════════════════════════════
let _interceptedUsername = null;
let _interceptedSession  = null;
let _interceptorReady    = false;
const _usernameWaiters   = [];

function _diag(msg) {
    try { console.log('%c[Surya:username] ' + msg, 'color:#9ee493'); } catch (_) {}
}

function _notifyUsernameWaiters(name) {
    if (_interceptedUsername) return;
    _interceptedUsername = name;
    _diag('LOCKED in username: ' + name);
    for (const resolve of _usernameWaiters.splice(0)) resolve(name);
}

const SKIP_WORDS = new Set([
    'stake','games','casino','sports','live','poker','dice','slots','wheel','crash','mines',
    'plinko','limbo','keno','baccarat','roulette','blackjack','video','table','lobby','home',
    'chat','inbox','wallet','deposit','withdraw','balance','rakeback','wager','bonus','promo',
    'offer','reward','level','silver','gold','bronze','platinum','diamond','vip','next','user',
    'admin','login','signup','register','verify','account','settings','profile','security',
    'history','support','faq','blog','news','affiliate','partner','terms','privacy',
    'responsible','fairness','provably','username','password','email','phone','code','search',
    'filter','sort','all','new','hot','top','featured','popular','recommended','trending',
    'exclusive','recent','active','online','offline','stakeoriginals','stakeexclusives',
    'stakepicks','sportsbook','livecasino','slotsgames','tablesgames','data','type','null',
    'true','false','undefined','object','array','string','number','boolean','function',
    'error','success','status','message','result','response','request','query','mutation',
    'usdt','usdc','btc','eth','ltc','bnb','trx','xrp','doge','eos','bch','cro','ape',
    'shib','sol','matic','avax','name','viewer','self','me','flag','feature','widget','event',
    'modal','dialog','popup','button','toggle','config','option','action','state','default',
    // sports & sport categories (Stake sportsbook)
    'soccer','football','basketball','tennis','cricket','baseball','hockey','golf','mma',
    'boxing','volleyball','rugby','esports','esport','darts','snooker','pool','billiards',
    'cycling','motorsport','motorsports','formula','formula1','f1','racing','horseracing',
    'horse','dogs','greyhound','ufc','wwe','wrestling','nfl','nba','mlb','nhl','fifa','uefa',
    'fight','fighting','combat','athletics','swimming','olympics','badminton','squash',
    'tabletennis','handball','futsal','american','ice','field','soccer1','soccer2',
    // games & game categories (Stake casino)
    'originals','exclusives','picks','gameshows','gameshow','bookmaker','sportsbook',
    'livecasino','virtual','virtuals','arcade','jackpot','jackpots','megaways',
    'newreleases','releases','providers','provider','pragmatic','evolution','netent',
    'microgaming','playngo','hacksaw','nolimit','relax','quickspin','isoftbet','redtiger',
    'novomatic','playson','wazdan','bgaming','spinomenal','elk','thunderkick','pushgaming',
    'tournament','tournaments','tourneys','race','races','challenge','challenges','quest',
    'quests','daily','weekly','monthly','dropandwins','dropswins','drops','wins',
    // currencies & misc UI
    'crypto','fiat','currency','currencies','token','tokens','coin','coins','rate','rates',
    'category','categories','section','sections','feed','list','main','side','panel',
    'menu','header','footer','overview','summary','details','info','about','help','contact',
    'logo','icon','image','picture','avatar','banner','thumbnail','cover','background',
]);

// Hard blocklist for feature flag / UI state / config key patterns
const BLOCKED_USERNAME_PATTERNS = [
    /_flag(s)?$/i, /_flag_/i, /flag_/i, /^flag$/i,
    /_widget/i,    /widget_/i,
    /_login/i,     /login_/i,
    /_logout/i,
    /_signup/i,    /_signin/i,
    /_exclusion/i,
    /_enabled$/i,  /^enabled_/i,
    /_disabled$/i, /^disabled_/i,
    /_button/i,
    /_modal/i,
    /_dialog/i,
    /_popup/i,
    /_toggle/i,
    /_feature/i,
    /_setting/i,   /^setting_/i,
    /_config/i,    /^config_/i,
    /_option/i,
    /_event$/i,
    /_action$/i,
    /_state$/i,
    /_status$/i,
    /_error/i,
    /_loading/i,
    /_visible/i,   /_hidden/i,
    /^show_/i,     /^hide_/i,
    /_page$/i,
    /_form$/i,
    /_screen/i,
    /_section/i,
    /_panel/i,
    /_banner/i,
    /_notification/i,
    /_tooltip/i,
    /_dropdown/i,
    /_checkbox/i,
    /_radio$/i,
    /_picker/i,
    /_chart/i,
    /_metric/i,
    /_analytics/i,
    /_tracking/i,
    /_pixel/i,
    /_experiment/i,
    /_variant/i,
    /_rollout/i,
    /_targeting/i,
    /_segment/i,
    /_test$/i, /_test_/i,
];

function _validUsername(name) {
    if (!name || typeof name !== 'string') return false;
    const t = name.trim();
    if (t.length < 3 || t.length > 25) return false;
    if (!/^[A-Za-z0-9_]+$/.test(t)) return false;
    if (!/^[A-Za-z0-9]/.test(t)) return false;
    if (!/[A-Za-z]/.test(t)) return false;
    if (/^\d+$/.test(t)) return false;
    if (SKIP_WORDS.has(t.toLowerCase())) return false;
    if (/^[a-f0-9]{8,}$/i.test(t)) return false;

    // Hard reject feature-flag / UI-state name patterns
    for (const pat of BLOCKED_USERNAME_PATTERNS) {
        if (pat.test(t)) return false;
    }

    // v9.9: allow multiple underscores (real Stake usernames sometimes have them)
    return true;
}

// Fields that disqualify an object from being a user
// (feature flag markers + catalog/category markers)
const NON_USER_FIELDS = [
    // feature flag markers
    'enabled', 'flag', 'isFlag', 'flagName', 'featureFlag',
    'variant', 'rolloutPercent', 'rolloutPercentage', 'evaluation',
    'targeting', 'experimentKey', 'experimentId', 'treatment',
    'fallthroughVariation', 'offVariation',
    // catalog/category/game/sport markers
    'slug', 'iconUrl', 'imageUrl', 'thumbnailUrl', 'coverUrl', 'logoUrl',
    'gameCount', 'betCount', 'eventCount', 'matchCount', 'tableCount',
    'displayName', 'sportId', 'gameId', 'sportSlug', 'gameSlug',
    'categoryId', 'categorySlug', 'category', 'parentId', 'parentSlug',
    'provider', 'providerId', 'providerSlug', 'edges', 'nodes',
    'sportName', 'gameName', 'leagueName', 'tournamentName',
    'rtp', 'volatility', 'minBet', 'maxBet', 'maxWin',
    'hasDemo', 'hasLive', 'isLive', 'isFavorite', 'isNew', 'isHot', 'isFeatured',
    'order', 'position', 'priority', 'sortOrder',
];

// Fields that ONLY appear on real user records (not on catalog/category/game objects).
// Generic fields like `id`, `createdAt`, `level`, `progress` are excluded — they
// appear on sports, games, currencies, etc.
const USER_ANCHOR_FIELDS = [
    'email', 'kycStatus', 'hasTfaEnabled', 'vipProgress', 'balances',
    'intercomHash', 'intercomId', 'rakeback', 'tipEnabled', 'dob',
    'phoneNumber', 'hasEmailVerified', 'hasPassword', 'activeSession',
    'hasAccessToken', 'totalWagered', 'totalDeposit',
    'sessionToken', 'accessToken', 'wallet', 'wallets',
    // v9.9: more anchors found in real Stake GQL responses
    'lastLogin', 'lastLoginAt', 'preferredCurrency', 'recommendedCurrency',
    'roles', 'isModerator', 'isAdmin', 'vipLevel', 'vipBalance',
    'depositCount', 'withdrawalCount', 'isVerified', 'isBetaTester',
];

// Is the name a plain title-case English word (e.g. "Soccer", "Football")?
// Real usernames almost always have digits, mixed case mid-word, or unusual
// letter patterns. A 4-15 char single-capital + lowercase string is suspicious.
function _isPlainWordName(t) {
    return /^[A-Z][a-z]{3,14}$/.test(t) || /^[a-z]{4,15}$/.test(t);
}

function _isLikelyUserObject(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    if (typeof v.name !== 'string') return false;

    // Name must pass strict validation (blocklist kills flags here)
    if (!_validUsername(v.name)) return false;

    // Hard-reject if any feature-flag / catalog / category marker is present
    for (const f of NON_USER_FIELDS) {
        if (f in v) return false;
    }

    // Hard-reject classic flag shape: { name, value: bool/str/num, ... }
    if ('value' in v && Object.keys(v).length <= 4) {
        const vt = typeof v.value;
        if (vt === 'boolean' || vt === 'string' || vt === 'number') return false;
    }

    // Need at least ONE strong user-only anchor field
    const hasAnchor = USER_ANCHOR_FIELDS.some(f => f in v);
    if (!hasAnchor) return false;

    // Extra check: if the name looks like a plain English word (Soccer,
    // Football, etc.), require 2+ anchors for safety.
    if (_isPlainWordName(v.name.trim())) {
        return USER_ANCHOR_FIELDS.filter(f => f in v).length >= 2;
    }

    return true;
}

// ── Find username in any GQL response body ────────────────────
function _findUsernameInResponse(data) {
    try {
        // Confirmed exact path from DevTools watcher: response.data.user.name
        const u = data?.data?.user;
        if (u && typeof u.name === 'string' && _validUsername(u.name)) {
            _diag('GQL direct path data.user.name = ' + u.name);
            return u.name;
        }

        const cu = data?.data?.claimConditionBonusCode?.user;
        if (cu && typeof cu.name === 'string' && _validUsername(cu.name)) return cu.name;

        // Strict recursive walk
        const seen = new WeakSet();
        function walk(v) {
            if (!v || typeof v !== 'object' || seen.has(v)) return null;
            seen.add(v);
            if (_isLikelyUserObject(v)) return v.name;
            if (Array.isArray(v)) {
                for (const it of v) { const r = walk(it); if (r) return r; }
            } else {
                for (const val of Object.values(v)) { const r = walk(val); if (r) return r; }
            }
            return null;
        }
        return walk(data);
    } catch (_) { return null; }
}

// ── GQL fetcher — v9.23: dual-path (native fetch + GM_xhr) with query fallbacks.
//
// Why v9.23 changed:
//   v9.22 relied on GM_xmlhttpRequest({cookie:true, withCredentials:true}) to
//   send Stake's HttpOnly session cookie. That call is proxied through the
//   Tampermonkey extension and DOES NOT reliably attach HttpOnly cookies —
//   different TM versions handle it differently, and on /settings/offers the
//   result is that data.user comes back null ("probably not logged in yet").
//
//   Native fetch() with credentials:'include' is SAME-ORIGIN so the browser
//   auto-attaches every cookie including HttpOnly — the exact technique FCFC
//   uses in its getStakeUser() and why it works everywhere on Stake.
//
//   v9.23 tries native fetch first, then GM_xhr as fallback, and if the whole
//   UserBalances query errors out (schema change) it retries with a bare
//   `query { user { id name } }` and then `query Me { user { name id } }`.
// ─────────────────────────────────────────────────────────────
const _USERNAME_QUERIES = [
    { name: 'UserBalances', body: 'query UserBalances { user { id name email hasTfaEnabled } }' },
    { name: 'UserProfile',  body: 'query UserProfile { user { id name } }' },
    { name: 'Me',           body: 'query Me { user { name id } }' },
    { name: 'Anon',         body: 'query { user { name } }' },
];

function _gqlHeaders(session, opName) {
    const h = {
        'Content-Type':     'application/json',
        'x-operation-name': opName || 'UserBalances',
        'x-operation-type': 'query',
        'x-lockdown-token': 'none',
        'x-language':       'en',
    };
    if (session && session.length > 10) h['x-access-token'] = session;
    return h;
}

async function _tryGQLViaFetch(session, q) {
    try {
        const r = await fetch(CFG.GQL_URL, {
            method:      'POST',
            credentials: 'include',   // <<< the key line: HttpOnly session cookie is attached automatically
            headers:     _gqlHeaders(session, q.name),
            body:        JSON.stringify({ operationName: q.name === 'Anon' ? undefined : q.name, query: q.body, variables: {} }),
        });
        if (!r.ok) { _diag('GQL[' + q.name + '] fetch HTTP ' + r.status); return null; }
        const d = await r.json().catch(() => null);
        if (!d) { _diag('GQL[' + q.name + '] fetch parse fail'); return null; }
        const name = _findUsernameInResponse(d);
        if (name) { _diag('GQL[' + q.name + '] via fetch → ' + name); return name; }
        if (d.errors) {
            const msg = d.errors[0]?.message || '';
            if (msg && !/not.?auth/i.test(msg)) _diag('GQL[' + q.name + '] errors: ' + msg);
        } else if (!d.data?.user) {
            _diag('GQL[' + q.name + '] ok but data.user is null (not logged in yet, or cookie not sent)');
        }
        return null;
    } catch (e) { _diag('GQL[' + q.name + '] fetch throw: ' + e.message); return null; }
}

function _tryGQLViaXHR(session, q) {
    return new Promise(resolve => {
        try {
            GM_xmlhttpRequest({
                method:          'POST',
                url:             CFG.GQL_URL,
                headers:         _gqlHeaders(session, q.name),
                cookie:          true,
                withCredentials: true,
                data: JSON.stringify({ operationName: q.name === 'Anon' ? undefined : q.name, query: q.body, variables: {} }),
                timeout: 12_000,
                onload: res => {
                    try {
                        const d = JSON.parse(res.responseText);
                        const name = _findUsernameInResponse(d);
                        if (name) { _diag('GQL[' + q.name + '] via GM_xhr → ' + name); resolve(name); return; }
                        if (d?.errors) {
                            const msg = d.errors[0]?.message || '';
                            if (msg && !/not.?auth/i.test(msg)) _diag('GQL[' + q.name + '] GM_xhr errors: ' + msg);
                        }
                    } catch (e) { _diag('GQL[' + q.name + '] GM_xhr parse fail: ' + e.message); }
                    resolve(null);
                },
                onerror:   () => { _diag('GQL[' + q.name + '] GM_xhr network error'); resolve(null); },
                ontimeout: () => { _diag('GQL[' + q.name + '] GM_xhr timeout'); resolve(null); },
            });
        } catch (e) { _diag('GQL[' + q.name + '] GM_xhr throw: ' + e.message); resolve(null); }
    });
}

async function _usernameFromGQL(session) {
    // v9.23: fetch-first (same-origin + credentials:'include' → HttpOnly cookie attached
    // by browser). Try each query shape via fetch; if all fetch attempts return null,
    // fall back to GM_xhr with the same query list. This is the fix for the
    // "username never resolves on /settings/offers" bug.
    for (const q of _USERNAME_QUERIES) {
        const n = await _tryGQLViaFetch(session, q);
        if (n) return n;
    }
    // Fallback path — some hardened Stake mirrors / TM setups need GM_xhr.
    for (const q of _USERNAME_QUERIES) {
        const n = await _tryGQLViaXHR(session, q);
        if (n) return n;
    }
    return null;
}

// ── v9.16: run a bridge body in the PAGE REALM regardless of host. A userscript
// manager (Tampermonkey) runs us in an isolated sandbox, so we inject the code as a
// <script> (TM bypasses the page CSP). A MAIN-world browser extension already runs
// IN the page realm and our own code is CSP-exempt — but DOM-inserted <script> tags
// are NOT — so there we call the bridge function directly. Same source, both worlds.
// ═══════════════════════════════════════════════════════════════
// OBFUSCATION-SAFE ZONE — DO NOT REMOVE THESE GUARDS
// The bridge below is injected into the PAGE realm via fn.toString(). If an
// obfuscator (e.g. obfuscator.io) rewrites these functions, toString() returns
// code that calls the obfuscator's string-array decoder (_0x....) — which does
// NOT exist in the page realm → "bridge failed / re-arming" and ZERO tokens.
// The javascript-obfuscator:disable/enable directives keep this one region
// untouched, so it still works after you obfuscate the REST of the file.
// Also keep obfuscator.io "Rename Globals" OFF (it is off by default).
// javascript-obfuscator:disable
function _scRunBridge(fn, cfg) {
    const extMode = (typeof window !== 'undefined' && window.__suryaShimLoaded === true);
    if (extMode) {
        try { fn(cfg); return true; }
        catch (e) { try { console.warn('[Surya] direct bridge failed: ' + e.message); } catch (_) {} }
    }
    try {
        const code = '(' + fn.toString() + ')(' + JSON.stringify(cfg) + ');';
        const s = document.createElement('script');
        s.textContent = code;
        (document.head || document.documentElement).appendChild(s);
        s.remove();
        return true;
    } catch (e) { try { console.warn('[Surya] bridge inject failed: ' + e.message); } catch (_) {} return false; }
}

// Turnstile multi-widget token generator (runs in page realm; self-contained).
function _suryaWidgetBridge(cfg) {
    'use strict';
    var CH = cfg.CH, SK = cfg.SK, COUNT = cfg.COUNT, MIN_GAP = cfg.GAP, STALL_MS = cfg.STALL;
    var widgets = [], demand = 0, _activeSlots = 0;
    function postMsg(obj) { try { window.postMessage(Object.assign({ type: CH }, obj), '*'); } catch (e) {} }
    function ensureContainers() {
        var wrap = document.getElementById('sc-ts-wrap');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'sc-ts-wrap';
            wrap.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;z-index:-1';
            document.body.appendChild(wrap);
        }
        for (var i = 0; i < COUNT; i++) {
            var id = 'sc-ts-slot-' + i;
            if (!document.getElementById(id)) {
                var div = document.createElement('div');
                div.id = id; div.setAttribute('data-surya-slot', String(i));
                wrap.appendChild(div);
            }
        }
    }
    function renderOne(idx) {
        if (!window.turnstile) return;
        var container = document.getElementById('sc-ts-slot-' + idx);
        if (!container) return;
        var slot = widgets[idx];
        if (slot && slot.wid != null) { try { window.turnstile.remove(slot.wid); } catch (e) {} }
        try {
            var wid = window.turnstile.render(container, {
                sitekey: SK, theme: 'dark', execution: 'execute',
                appearance: 'interaction-only', retry: 'auto', 'retry-interval': 3000,
                callback: function (token) {
                    var s = widgets[idx];
                    if (s) { s.busy = false; s.errors = 0; s.lastTokenAt = Date.now(); s.lastExecuteAt = 0; }
                    if (demand > 0) demand--;
                    postMsg({ token: token, slot: idx });
                    if (demand > 0) setTimeout(pump, MIN_GAP);
                },
                'expired-callback': function () { var s = widgets[idx]; if (s) s.busy = false; },
                'error-callback': function (code) {
                    var s = widgets[idx];
                    if (s) { s.busy = false; s.errors = (s.errors || 0) + 1; }
                    postMsg({ error: code, slot: idx });
                    if (s && s.errors >= 2) { s.errors = 0; setTimeout(function () { renderOne(idx); }, 5000); }
                }
            });
            widgets[idx] = { wid: wid, idx: idx, busy: false, errors: 0, lastTokenAt: 0, lastSolveAt: 0 };
            postMsg({ ready: true, slot: idx, widgetId: String(wid) });
            setTimeout(pump, 300);
        } catch (e) {
            postMsg({ error: e.message || 'render_fail', slot: idx });
            setTimeout(function () { renderOne(idx); }, 5000);
        }
    }
    function canSolve(s) { return s && s.wid != null && !s.busy && window.turnstile && (Date.now() - (s.lastSolveAt || 0) >= MIN_GAP); }
    function solve(idx) {
        var s = widgets[idx];
        if (!canSolve(s)) return false;
        s.busy = true; s.lastExecuteAt = Date.now(); s.lastSolveAt = Date.now();
        try {
            window.turnstile.reset(s.wid);
            setTimeout(function () { try { window.turnstile.execute(s.wid); } catch (e) {} }, 120);
        } catch (e) { s.busy = false; return false; }
        return true;
    }
    function pump() {
        if (_activeSlots <= 0 || demand <= 0) return;
        var launched = 0;
        for (var i = 0; i < COUNT && i < _activeSlots; i++) {
            if (launched >= demand) break;
            if (canSolve(widgets[i])) { if (solve(i)) launched++; }
        }
    }
    setInterval(pump, 500);
    setInterval(function () {
        var now = Date.now();
        for (var i = 0; i < COUNT; i++) {
            var s = widgets[i];
            if (!s) continue;
            if (s.busy && s.lastExecuteAt && (now - s.lastExecuteAt) > STALL_MS) {
                postMsg({ stuck: true, slot: i, age: now - s.lastExecuteAt });
                renderOne(i);
            }
        }
    }, 3000);
    window.addEventListener('message', function (ev) {
        if (!ev.data || ev.data.type !== CH + '_CMD') return;
        var d = ev.data;
        if (d.cmd === 'demand') { demand = Math.max(0, d.count | 0); pump(); }
        else if (d.cmd === 'setConcurrency') { _activeSlots = Math.max(0, Math.min(COUNT, d.activeSlots | 0)); if (_activeSlots > 0) pump(); }
        else if (d.cmd === 'execute') { if (demand < 1) demand = 1; pump(); }
    });
    window.suryaTsReady = function () {
        if (window.__suryaTsRan) return; window.__suryaTsRan = true;
        postMsg({ loaded: true });
        ensureContainers();
        for (var i = 0; i < COUNT; i++) { (function (idx) { setTimeout(function () { renderOne(idx); }, idx * 200); })(i); }
    };
    // v9.16.1 CORE FIX: Stake already loads Cloudflare Turnstile on its pages.
    // In the extension (MAIN world) the page CSP refuses a SECOND cross-origin
    // <script> from challenges.cloudflare.com — which is exactly why the widget
    // never rendered, "bridge failed", and it fell into the dead Tier-3 loop.
    // So: if turnstile is already present, REUSE it (no second load). Otherwise
    // load the CDN once, with a documentElement fallback (head may be null at
    // document_start) and a poller that proceeds the instant turnstile appears.
    function _tsReady() { return window.turnstile && typeof window.turnstile.render === 'function'; }
    if (_tsReady()) { window.suryaTsReady(); }
    else {
        try {
            var sc = document.createElement('script');
            sc.src = cfg.CDN + '?render=explicit&onload=suryaTsReady';
            sc.async = true;
            sc.onerror = function () { if (!_tsReady()) postMsg({ scriptError: true }); };
            (document.head || document.documentElement).appendChild(sc);
        } catch (e) { postMsg({ scriptError: true }); }
        var _tsWait = 0;
        var _tsIv = setInterval(function () {
            _tsWait += 500;
            if (_tsReady()) { clearInterval(_tsIv); window.suryaTsReady(); }
            else if (_tsWait >= 12000) { clearInterval(_tsIv); if (!window.__suryaTsRan) postMsg({ scriptError: true }); }
        }, 500);
    }
}

// Page-world username interceptor + PAGE-NATIVE authenticated username probe.
function _suryaUserBridge(cfg) {
    'use strict';
    if (window.__suryaUsernameBridge) return;
    window.__suryaUsernameBridge = true;
    var CH = cfg.CH, BLOCKED = cfg.BLOCKED || [], ANCHORS = cfg.ANCHORS || [], NONUSER = cfg.NONUSER || [], SKIP = cfg.SKIP || [];
    var skipSet = new Set(SKIP);
    var blockedRx = BLOCKED.map(function (s) { var i = s.lastIndexOf('::'); return new RegExp(s.slice(0, i), s.slice(i + 2)); });
    function post(payload) { try { window.postMessage(Object.assign({ type: CH }, payload), '*'); } catch (_) {} }
    function valid(t) {
        if (typeof t !== 'string') return false;
        var s = t.trim();
        if (s.length < 3 || s.length > 25) return false;
        if (!/^[A-Za-z0-9_]+$/.test(s)) return false;
        if (!/^[A-Za-z0-9]/.test(s)) return false;
        if (!/[A-Za-z]/.test(s)) return false;
        if (/^\d+$/.test(s)) return false;
        if (skipSet.has(s.toLowerCase())) return false;
        if ((s.match(/_/g) || []).length >= 2) return false;
        for (var k = 0; k < blockedRx.length; k++) if (blockedRx[k].test(s)) return false;
        return true;
    }
    function plainWord(t) { return /^[A-Z][a-z]{3,14}$/.test(t) || /^[a-z]{4,15}$/.test(t); }
    function likelyUser(v) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
        if (typeof v.name !== 'string' || !valid(v.name)) return false;
        for (var i = 0; i < NONUSER.length; i++) if (NONUSER[i] in v) return false;
        if ('value' in v && Object.keys(v).length <= 4) {
            var vt = typeof v.value;
            if (vt === 'boolean' || vt === 'string' || vt === 'number') return false;
        }
        if (!ANCHORS.some(function (f) { return f in v; })) return false;
        if (plainWord(v.name.trim())) return ANCHORS.filter(function (f) { return f in v; }).length >= 2;
        return true;
    }
    function findUsername(data) {
        try {
            var u = data && data.data && data.data.user;
            if (u && typeof u.name === 'string' && valid(u.name)) return u.name;
            var seen = new WeakSet();
            function walk(v) {
                if (!v || typeof v !== 'object' || seen.has(v)) return null;
                seen.add(v);
                if (likelyUser(v)) return v.name;
                if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) { var r = walk(v[i]); if (r) return r; } }
                else { var vals = Object.values(v); for (var j = 0; j < vals.length; j++) { var r2 = walk(vals[j]); if (r2) return r2; } }
                return null;
            }
            return walk(data);
        } catch (_) { return null; }
    }
    function getHeader(headers, name) {
        try {
            if (!headers) return null;
            var low = name.toLowerCase();
            if (headers instanceof Headers) return headers.get(name);
            if (Array.isArray(headers)) { var p = headers.find(function (kv) { return String(kv[0]).toLowerCase() === low; }); return p ? p[1] : null; }
            if (typeof headers === 'object') return headers[name] || headers[low] || headers['X-Access-Token'];
        } catch (_) {}
        return null;
    }
    var origFetch = window.fetch;
    window.fetch = async function () {
        var args = arguments, url = '';
        try {
            url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            var init = args[1] || {};
            var tok = getHeader(init.headers, 'x-access-token');
            if (tok && tok.length > 20) post({ session: tok });
        } catch (_) {}
        var res = await origFetch.apply(this, args);
        try {
            if (url.includes('graphql') || url.includes('/_api/')) {
                res.clone().json().then(function (data) {
                    var name = findUsername(data);
                    if (name) post({ username: name, url: url });
                }).catch(function () {});
            }
        } catch (_) {}
        return res;
    };
    try {
        var origOpen = XMLHttpRequest.prototype.open, origSend = XMLHttpRequest.prototype.send, origSet = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.open = function (m, u) { this.__sc_url = u || ''; return origOpen.apply(this, arguments); };
        XMLHttpRequest.prototype.setRequestHeader = function (n, v) {
            try { if (String(n).toLowerCase() === 'x-access-token' && v && v.length > 20) post({ session: v }); } catch (_) {}
            return origSet.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
            this.addEventListener('load', function () {
                try {
                    var u = this.__sc_url || '';
                    if (u.includes('graphql') || u.includes('/_api/')) {
                        var data = JSON.parse(this.responseText);
                        var name = findUsername(data);
                        if (name) post({ username: name, url: u });
                    }
                } catch (_) {}
            });
            return origSend.apply(this, arguments);
        };
    } catch (_) {}
    // v9.16: actively ask Stake who is logged in using the PAGE's own fetch, so the
    // session cookie is sent natively. Works even when /settings/offers never issues a
    // user{name} query itself, and regardless of any GM_xmlhttpRequest cookie quirks —
    // this is the fix for "no username detected" in the Tampermonkey build.
    (function pollUser(tries) {
        if (window.__suryaUserFound) return;
        try {
            origFetch(cfg.GQL_URL, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json', 'x-operation-name': 'UserBalances', 'x-operation-type': 'query' },
                body: JSON.stringify({ operationName: 'UserBalances', query: 'query UserBalances { user { id name } }', variables: {} })
            }).then(function (r) { return r.json(); }).then(function (d) {
                var n = findUsername(d);
                if (n) { window.__suryaUserFound = true; post({ username: n, url: cfg.GQL_URL }); }
                else if (tries > 0) setTimeout(function () { pollUser(tries - 1); }, 2000);
            }).catch(function () { if (tries > 0) setTimeout(function () { pollUser(tries - 1); }, 2000); });
        } catch (_) { if (tries > 0) setTimeout(function () { pollUser(tries - 1); }, 2000); }
    })(12);
    console.log('%c[Surya] Page-world username bridge installed (v9.16)', 'color:#9ee493');
}
// javascript-obfuscator:enable
// END OBFUSCATION-SAFE ZONE

// ── PAGE-WORLD BRIDGE (bypasses Tampermonkey sandbox) ───���─────
function _installPageBridge(CH) {
    _scRunBridge(_suryaUserBridge, {
        CH: CH,
        GQL_URL: CFG.GQL_URL,
        BLOCKED: BLOCKED_USERNAME_PATTERNS.map(function (r) { return r.source + '::' + r.flags; }),
        ANCHORS: USER_ANCHOR_FIELDS,
        NONUSER: NON_USER_FIELDS,
        SKIP: [...SKIP_WORDS],
    });
    return;
    const bridgeCode = `
(() => {
    'use strict';
    if (window.__suryaUsernameBridge) return;
    window.__suryaUsernameBridge = true;

    const CH = ${JSON.stringify(CH)};
    const BLOCKED = ${JSON.stringify(BLOCKED_USERNAME_PATTERNS.map(r => r.source + '::' + r.flags))};
    const ANCHORS = ${JSON.stringify(USER_ANCHOR_FIELDS)};
    const NONUSER = ${JSON.stringify(NON_USER_FIELDS)};
    const SKIP    = ${JSON.stringify([...SKIP_WORDS])};

    const skipSet  = new Set(SKIP);
    const blockedRx = BLOCKED.map(s => {
        const i = s.lastIndexOf('::');
        return new RegExp(s.slice(0, i), s.slice(i + 2));
    });

    function post(payload) {
        try { window.postMessage(Object.assign({ type: CH }, payload), '*'); } catch (_) {}
    }

    function valid(t) {
        if (typeof t !== 'string') return false;
        const s = t.trim();
        if (s.length < 3 || s.length > 25) return false;
        if (!/^[A-Za-z0-9_]+$/.test(s)) return false;
        if (!/^[A-Za-z0-9]/.test(s)) return false;
        if (!/[A-Za-z]/.test(s)) return false;
        if (/^\\d+$/.test(s)) return false;
        if (skipSet.has(s.toLowerCase())) return false;
        if ((s.match(/_/g) || []).length >= 2) return false;
        for (const rx of blockedRx) if (rx.test(s)) return false;
        return true;
    }

    function plainWord(t) {
        return /^[A-Z][a-z]{3,14}$/.test(t) || /^[a-z]{4,15}$/.test(t);
    }

    function likelyUser(v) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
        if (typeof v.name !== 'string' || !valid(v.name)) return false;
        for (const f of NONUSER) if (f in v) return false;
        if ('value' in v && Object.keys(v).length <= 4) {
            const vt = typeof v.value;
            if (vt === 'boolean' || vt === 'string' || vt === 'number') return false;
        }
        if (!ANCHORS.some(f => f in v)) return false;
        if (plainWord(v.name.trim())) {
            return ANCHORS.filter(f => f in v).length >= 2;
        }
        return true;
    }

    function findUsername(data) {
        try {
            const u = data?.data?.user;
            if (u && typeof u.name === 'string' && valid(u.name)) return u.name;

            const seen = new WeakSet();
            function walk(v) {
                if (!v || typeof v !== 'object' || seen.has(v)) return null;
                seen.add(v);
                if (likelyUser(v)) return v.name;
                if (Array.isArray(v)) {
                    for (const it of v) { const r = walk(it); if (r) return r; }
                } else {
                    for (const val of Object.values(v)) { const r = walk(val); if (r) return r; }
                }
                return null;
            }
            return walk(data);
        } catch (_) { return null; }
    }

    function getHeader(headers, name) {
        try {
            if (!headers) return null;
            const low = name.toLowerCase();
            if (headers instanceof Headers) return headers.get(name);
            if (Array.isArray(headers)) {
                const p = headers.find(([k]) => String(k).toLowerCase() === low);
                return p ? p[1] : null;
            }
            if (typeof headers === 'object') {
                return headers[name] || headers[low] || headers['X-Access-Token'];
            }
        } catch (_) {}
        return null;
    }

    const origFetch = window.fetch;
    window.fetch = async function (...args) {
        let url = '';
        try {
            url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            const init = args[1] || {};
            const tok = getHeader(init.headers, 'x-access-token');
            if (tok && tok.length > 20) post({ session: tok });
        } catch (_) {}

        const res = await origFetch.apply(this, args);

        try {
            if (url.includes('graphql') || url.includes('/_api/')) {
                res.clone().json().then(data => {
                    const name = findUsername(data);
                    if (name) {
                        console.log('%c[Surya:bridge] fetch found username: ' + name + ' from ' + url, 'color:#9ee493');
                        post({ username: name, url });
                    }
                }).catch(() => {});
            }
        } catch (_) {}

        return res;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const origSet  = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (m, u, ...r) {
        this.__sc_url = u || '';
        return origOpen.call(this, m, u, ...r);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (n, v) {
        try {
            if (String(n).toLowerCase() === 'x-access-token' && v && v.length > 20) {
                post({ session: v });
            }
        } catch (_) {}
        return origSet.call(this, n, v);
    };
    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', function () {
            try {
                const u = this.__sc_url || '';
                if (u.includes('graphql') || u.includes('/_api/')) {
                    const data = JSON.parse(this.responseText);
                    const name = findUsername(data);
                    if (name) {
                        console.log('%c[Surya:bridge] XHR found username: ' + name + ' from ' + u, 'color:#9ee493');
                        post({ username: name, url: u });
                    }
                }
            } catch (_) {}
        });
        return origSend.apply(this, args);
    };

    console.log('%c[Surya] Page-world username bridge installed (v9.7)', 'color:#9ee493');
})();
`;
    try {
        const s = document.createElement('script');
        s.textContent = bridgeCode;
        (document.documentElement || document.head).appendChild(s);
        s.remove();
        return true;
    } catch (e) {
        _diag('Bridge inject failed: ' + e.message);
        return false;
    }
}

// ── unsafeWindow hooks (TM real page context) ─────────────────
function _installUnsafeWindowHooks() {
    try {
        if (typeof unsafeWindow === 'undefined' || unsafeWindow === window) {
            _diag('unsafeWindow not available (sandbox mode?)');
            return false;
        }

        const realFetch = unsafeWindow.fetch;
        if (typeof realFetch !== 'function') {
            _diag('unsafeWindow.fetch not a function');
            return false;
        }

        const captureSession = (tok) => {
            if (!tok || tok.length < 20 || _interceptedSession) return;
            _interceptedSession = tok;
            _diag('Session captured via unsafeWindow');
            if (!_interceptedUsername) {
                _usernameFromGQL(tok).then(n => {
                    if (n && !_interceptedUsername) _notifyUsernameWaiters(n);
                });
            }
        };

        unsafeWindow.fetch = async function (...args) {
            let url = '';
            try {
                url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
                const init = args[1] || {};
                const hdrs = init.headers || {};
                let tok = null;
                if (hdrs && typeof hdrs.get === 'function') {
                    try { tok = hdrs.get('x-access-token'); } catch (_) {}
                } else if (Array.isArray(hdrs)) {
                    const p = hdrs.find(([k]) => String(k).toLowerCase() === 'x-access-token');
                    if (p) tok = p[1];
                } else if (typeof hdrs === 'object') {
                    tok = hdrs['x-access-token'] || hdrs['X-Access-Token'];
                }
                if (tok) captureSession(tok);
            } catch (_) {}

            const res = await realFetch.apply(this, args);

            try {
                if (!_interceptedUsername && (url.includes('graphql') || url.includes('/_api/'))) {
                    res.clone().json().then(data => {
                        const name = _findUsernameInResponse(data);
                        if (name && !_interceptedUsername) {
                            _notifyUsernameWaiters(name);
                        }
                    }).catch(() => {});
                }
            } catch (_) {}

            return res;
        };

        const XHR = unsafeWindow.XMLHttpRequest;
        if (XHR && XHR.prototype) {
            const oOpen = XHR.prototype.open;
            const oSend = XHR.prototype.send;
            const oSet  = XHR.prototype.setRequestHeader;

            XHR.prototype.open = function (m, u, ...r) {
                this.__sc_url = u || '';
                return oOpen.call(this, m, u, ...r);
            };
            XHR.prototype.setRequestHeader = function (n, v) {
                try {
                    if (String(n).toLowerCase() === 'x-access-token') captureSession(v);
                } catch (_) {}
                return oSet.call(this, n, v);
            };
            XHR.prototype.send = function (...args) {
                this.addEventListener('load', () => {
                    try {
                        const u = this.__sc_url || '';
                        if (!_interceptedUsername && (u.includes('graphql') || u.includes('/_api/'))) {
                            const data = JSON.parse(this.responseText);
                            const name = _findUsernameInResponse(data);
                            if (name && !_interceptedUsername) _notifyUsernameWaiters(name);
                        }
                    } catch (_) {}
                });
                return oSend.apply(this, args);
            };
        }

        _diag('unsafeWindow hooks installed');
        return true;
    } catch (e) {
        _diag('unsafeWindow hook failed: ' + e.message);
        return false;
    }
}

// ── Main interceptor installer ────────────────────────────────
function _installUsernameInterceptors() {
    if (_interceptorReady) return;
    _interceptorReady = true;
    _diag('Installing interceptors (v9.7)');

    const CH = 'SC_UNAME_' + Math.random().toString(36).slice(2);

    window.addEventListener('message', (ev) => {
        if (ev.source !== window) return;
        const m = ev.data;
        if (!m || m.type !== CH) return;

        if (m.session && !_interceptedSession && m.session.length > 20) {
            _interceptedSession = m.session;
            _diag('Session via page bridge');
            if (!_interceptedUsername) {
                _usernameFromGQL(m.session).then(n => {
                    if (n && !_interceptedUsername) _notifyUsernameWaiters(n);
                });
            }
        }

        if (m.username && !_interceptedUsername && _validUsername(m.username)) {
            _notifyUsernameWaiters(m.username);
        }
    });

    _installUnsafeWindowHooks();

    if (document.documentElement) {
        _installPageBridge(CH);
    } else {
        const tryInject = setInterval(() => {
            if (document.documentElement) {
                clearInterval(tryInject);
                _installPageBridge(CH);
            }
        }, 20);
        setTimeout(() => clearInterval(tryInject), 5000);
    }

    // v9.19.1: two-phase GQL polling — hits hard for the first 10 seconds (every 500ms)
    // so /settings/offers direct-load resolves the username within 1–2 seconds of Stake's
    // first authenticated API call, then relaxes to a 2s heartbeat. This is the fix for
    // the "username detected on /settings but not /settings/offers" complaint: on direct
    // load of offers, we now win the race against DOM fallbacks.
    let pollCount = 0;
    let _fastPhase = true;
    const _tick = async () => {
        if (_interceptedUsername) return;
        pollCount++;
        // Fast phase: 20 shots at 500ms = 10s. Slow phase: 2s heartbeat up to ~2min.
        if (_fastPhase && pollCount >= 20) { _fastPhase = false; }
        if (pollCount > 80) { _diag('GQL polling gave up after ~2.5min'); return; }
        const tok = _interceptedSession || getSession() || null;
        const name = await _usernameFromGQL(tok);
        if (name && !_interceptedUsername) { _notifyUsernameWaiters(name); return; }
        setTimeout(_tick, _fastPhase ? 500 : 2000);
    };
    // Fire the first shot immediately — don't wait 500ms for the initial call
    setTimeout(_tick, 0);
}

// ── Static data scan (with diagnostic logging) ────────────────
function _usernameFromStaticData() {
    try {
        function extractFromValue(val, depth) {
            if (depth > 8 || !val) return null;
            if (typeof val === 'string') {
                if (val.length > 20 && val.includes('"name"')) {
                    try { return extractFromValue(JSON.parse(val), depth + 1); } catch (_) {}
                }
                return null;
            }
            if (Array.isArray(val)) {
                for (const item of val) { const r = extractFromValue(item, depth + 1); if (r) return r; }
                return null;
            }
            if (typeof val === 'object') {
                if (_isLikelyUserObject(val)) return val.name;
                for (const v of Object.values(val)) { const r = extractFromValue(v, depth + 1); if (r) return r; }
            }
            return null;
        }
        for (const s of document.querySelectorAll('script[data-sveltekit-fetched], script[type="application/json"]')) {
            const raw = (s.textContent || '').trim();
            if (!raw || !raw.includes('name')) continue;
            try {
                const found = extractFromValue(JSON.parse(raw), 0);
                if (found) { _diag('Static: SvelteKit script tag → ' + found); return found; }
            } catch (_) {}
        }
        for (const key of Object.getOwnPropertyNames(window)) {
            if (!key.startsWith('__sveltekit')) continue;
            try {
                const found = extractFromValue(window[key], 0);
                if (found) { _diag('Static: window.' + key + ' → ' + found); return found; }
            } catch (_) {}
        }
        const apollo = window.__APOLLO_STATE__;
        if (apollo && typeof apollo === 'object') {
            for (const [key, val] of Object.entries(apollo)) {
                if (/^User:/i.test(key) && _isLikelyUserObject(val)) {
                    _diag('Static: Apollo cache → ' + val.name);
                    return val.name;
                }
            }
        }
        for (const key of ['__NUXT__','__NEXT_DATA__','__STAKE__']) {
            if (!window[key]) continue;
            const found = extractFromValue(window[key], 0);
            if (found) { _diag('Static: ' + key + ' → ' + found); return found; }
        }
    } catch (e) {
        _diag('Static scan error: ' + e.message);
    }
    return null;
}

// ── VIP box scan (DOM fallback) ──────────────────────────────
function _usernameFromVIPProgress() {
    try {
        // Stake's header VIP widget renders text as:
        //   "Your VIP Progress\n<username>\n<percent>%\nNext level: ..."
        // Scan container elements; grab line 2 when line 1 matches.
        var nodes = document.querySelectorAll('div, section, aside, header');
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            var txt = (el.innerText || el.textContent || '').trim();
            if (!txt) continue;
            if (txt.length > 800) continue;
            if (txt.indexOf('Your VIP Progress') !== 0 && txt.indexOf('VIP Progress') !== 0) continue;
            var lines = txt.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
            for (var L = 1; L < Math.min(lines.length, 4); L++) {
                var candidate = lines[L];
                if (_validUsername(candidate)) {
                    _diag('VIP progress widget line ' + L + ' -> ' + candidate);
                    return candidate;
                }
            }
        }
    } catch (e) { _diag('VIP progress scan error: ' + e.message); }
    return null;
}

function _usernameFromVIPBox() {
    // v9.19.1: DISABLED. This scanner used to match ANY <a href*="/user/"> link and any
    // .vip / .progress element on the page — on /settings/offers those selectors
    // captured promo attribution links ("shared by @streamerX", campaign owner names,
    // referral badges, etc.) and locked in the WRONG username. GQL + static data
    // + the header VIP-progress widget are all authoritative for the current user,
    // so this leaky DOM scanner is no longer part of the fallback chain.
    return null;
}

async function detectUsername() {
    if (_interceptedUsername) return _interceptedUsername;

    // MANUAL OVERRIDE: if user set one via suryaSetUsername(), use it immediately
    try {
        var manual = GM_getValue('SC_MANUAL_USERNAME', '');
        if (manual && typeof manual === 'string' && manual.trim().length >= 2) {
            _diag('Manual username from GM_setValue: ' + manual);
            _notifyUsernameWaiters(manual.trim());
            return manual.trim();
        }
    } catch (_) {}

    // v9.15: GQL is AUTHORITATIVE — it returns the *logged-in* account's name
    // straight from Stake's API, so it can't be fooled by promo/streamer/leaderboard
    // names that are rendered elsewhere on the /settings/offers page. Try it FIRST.
    const sess    = getSession() || _interceptedSession || null;
    const fromGQL = await _usernameFromGQL(sess);
    if (fromGQL) { _notifyUsernameWaiters(fromGQL); return fromGQL; }

    // Static app data (also authoritative — the SPA's own embedded user object).
    const fromStatic = _usernameFromStaticData();
    if (fromStatic) { _notifyUsernameWaiters(fromStatic); return fromStatic; }

    // LAST RESORT: only the safe DOM scan (header's "Your VIP Progress" widget —
    // that widget always renders the currently-logged-in user). The leaky
    // _usernameFromVIPBox() scanner is disabled in v9.19.1.
    if (document.readyState !== 'loading') {
        var fromVip = _usernameFromVIPProgress();
        if (fromVip) { _notifyUsernameWaiters(fromVip); return fromVip; }
    }

    return null;
}

async function waitForUsername(timeoutMs = 60_000) {
    if (_interceptedUsername) return _interceptedUsername;
    try {
        var manual = GM_getValue('SC_MANUAL_USERNAME', '');
        if (manual && typeof manual === 'string' && manual.trim().length >= 2) {
            _notifyUsernameWaiters(manual.trim());
            return manual.trim();
        }
    } catch (_) {}
    const quick = await detectUsername();
    if (quick) return quick;
    return new Promise(resolve => {
        if (_interceptedUsername) { resolve(_interceptedUsername); return; }
        _usernameWaiters.push(resolve);
        const deadline = Date.now() + timeoutMs;
        const poll = setInterval(async () => {
            if (_interceptedUsername) { clearInterval(poll); return; }
            if (Date.now() > deadline) {
                clearInterval(poll);
                const idx = _usernameWaiters.indexOf(resolve);
                if (idx !== -1) _usernameWaiters.splice(idx, 1);
                resolve(null);
                return;
            }
            const tok = _interceptedSession || getSession() || null;
            const g = await _usernameFromGQL(tok);
            if (g) { clearInterval(poll); _notifyUsernameWaiters(g); return; }
            // v9.19.1: authoritative-first order — static SvelteKit user data before
            // any DOM scan. Drops the VIP-box scanner entirely (leaky on /settings/offers).
            const s = _usernameFromStaticData();
            if (s) { clearInterval(poll); _notifyUsernameWaiters(s); return; }
            const vp = _usernameFromVIPProgress();
            if (vp) { clearInterval(poll); _notifyUsernameWaiters(vp); }
        }, 1_000);
    });
}

// ════════════════════════════════════════════════════════════
// SESSION
// ════════════════════════════════════════════════════════════
function getSession() {
    for (const part of document.cookie.split('; ')) {
        if (/^(?:session|sid|auth_token)=/i.test(part)) { const v = part.split('=').slice(1).join('='); if (v?.length > 20) return v; }
    }
    const directKeys = ['session','auth','token','accessToken','access_token','user','profile'];
    for (const k of directKeys) { const v = localStorage.getItem(k); if (v?.length > 20) return v; }
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        try {
            const obj = JSON.parse(raw);
            const found = (function search(o) {
                if (!o || typeof o !== 'object') return null;
                for (const [k, v] of Object.entries(o)) {
                    if (typeof v === 'string' && v.length > 30 && /^[A-Za-z0-9\-_.~+/]+$/.test(v)) {
                        if (/session|token|auth/i.test(k)) return v;
                    }
                    if (v && typeof v === 'object') { const deep = search(v); if (deep) return deep; }
                }
                return null;
            })(obj);
            if (found) return found;
        } catch (_) {}
    }
    const globals = ['__APOLLO_STATE__','__NUXT__','__NEXT_DATA__','__STAKE__'];
    for (const g of globals) {
        try {
            const str   = JSON.stringify(window[g] || '');
            const match = str.match(/"(?:session|accessToken|access_token|x-access-token)"\s*:\s*"([A-Za-z0-9\-_.~+/]{20,})"/);
            if (match && match[1]) return match[1];
        } catch (_) {}
    }
    return null;
}

// ════════════════════════════════════════════════════════════
// SUPABASE AUTH
// ════════════════════════════════════════════════════════════
function checkAuth(uname) {
    return new Promise(resolve => {
        GM_xmlhttpRequest({
            method:  'GET',
            url:     `${CFG.SUPABASE_URL}/rest/v1/users?username=eq.${encodeURIComponent(uname)}&select=*`,
            headers: { 'apikey': CFG.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${CFG.SUPABASE_ANON_KEY}` },
            timeout: 10_000,
            onload:    res => {
                try {
                    const d = JSON.parse(res.responseText);
                    if (Array.isArray(d) && d.length > 0) {
                        const row     = d[0];
                        // v9.11: accept whichever expiry column exists in the users table
                        const tillRaw = row.active_till ?? row.active_until ?? row.expires_at ?? row.valid_until ?? row.expiry ?? null;
                        let   expMs   = null;
                        if (tillRaw != null && tillRaw !== '') {
                            let p;
                            if (typeof tillRaw === 'number') {
                                p = tillRaw;
                            } else {
                                // v9.14: Supabase timestamptz without an explicit zone must be read as
                                // UTC, otherwise a still-valid user can be wrongly shown EXPIRED.
                                let s = String(tillRaw).trim().replace(' ', 'T');
                                if (!/[zZ]|[+\-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
                                p = Date.parse(s);
                            }
                            if (!isNaN(p)) expMs = p;
                        }
                        const expired = (expMs !== null) && (Date.now() >= expMs);
                        const active  = (row.is_active === true) && !expired;
                        resolve({ found: true, active, expMs, expired });
                    } else {
                        resolve({ found: false, active: false, expMs: null, expired: false });
                    }
                } catch (_) { resolve({ found: false, active: false, expMs: null, expired: false }); }
            },
            onerror:   () => resolve({ found: false, active: false, expMs: null, expired: false }),
            ontimeout: () => resolve({ found: false, active: false, expMs: null, expired: false }),
        });
    });
}

// ════════════════════════════════════════════════════════════
// ERROR / CODE TYPE CLASSIFIERS
// ═══════════════════════════════════════════════════════���════
function getErrorType(msg) {
    const m = (msg || '').toLowerCase();
    if (/conditionbonuscodetimeout|bonuscodetimeout|claim.?timeout/.test(m)) return 'timeoutSoftSuccess';
    if (/bonuscodeinactive|fully.claimed|inactive/.test(m))       return 'bonusCodeInactive';
    if (/weeklywagerrequirement|wager.requirement/.test(m))        return 'wagerRequired';
    if (/alreadyclaimed|already.claimed|already.redeemed/.test(m)) return 'alreadyClaimed';
    if (/withdrawerror|withdraw.error/.test(m))                    return 'withdrawError';
    if (/emailunverified|email.unverified/.test(m))                return 'emailUnverified';
    if (/kyclevel|kyc/.test(m))                                    return 'kycInsufficient';
    if (/invalid.?turnstile|turnstile.?invalid|turnstile.?token|cf.?turnstile/.test(m)) return 'invalidTurnstile';
    return 'unknown';
}

function getCodeType(payload) {
    if (!payload || !payload.type) return 'OtherDrops';
    if (payload.type === 'DailyDrops') {
        if (payload.amount === 1) return 'Daily1';
        if (payload.amount === 2) return 'Daily2';
        if (payload.amount === 3) return 'Daily3';
        return 'DailyOther';
    }
    return payload.type;
}

function shouldProcess(payload) {
    if (!userSettings) return true;
    if (userSettings.processAll) return true;
    const type = getCodeType(payload);
    return userSettings.drops && userSettings.drops.includes(type);
}

// ════════════════════════════════════════════════════════════
// CLAIM — v9.4 FIXED
//
// FIX 5: After a successful claim, explicitly call
//         tsManager._triggerFill() to pre-warm the next token
//         immediately, rather than relying solely on getFastToken()'s
//         internal trigger (which may have been blocked by isGenerating).
// ═══���════════════════════════════════════════════════════════
const _retryCount = new Map();
const _codeValue  = new Map(); // v9.22: advertised $ value per code (Telegram "Value: $X", forwarded by server)

// ── v9.17.4: fire-and-forget claim reporting ─────────────────────────────
// Sends the claim outcome to the admin panel. NEVER awaited, and only called
// AFTER the claim result has already been fully handled + rendered — so it can
// add ZERO latency to the claim path. Every failure is swallowed silently.
// v9.17.6: friendly claim-failure reasons for the admin panel — never send bare "unknown".
const REPORT_REASON = {
    bonusCodeInactive: 'expired', alreadyClaimed: 'already claimed', wagerRequired: 'wager required',
    withdrawError: 'deposit required', emailUnverified: 'email unverified', kycInsufficient: 'KYC insufficient',
    invalidTurnstile: 'turnstile rejected', timeoutSoftSuccess: 'server timeout',
};
function failReason(errType, errMsg) {
    // Prefer a human label; otherwise fall back to Stake's raw message; never "unknown".
    if (errType && REPORT_REASON[errType]) return REPORT_REASON[errType];
    const raw = (errMsg || '').trim();
    if (raw && !/^unknown/i.test(raw)) return raw.slice(0, 160);
    if (errType && errType !== 'unknown') return errType;
    return 'unclassified error';
}
// v9.18: also mirror every claim outcome to Project 2 (api-claimer dashboard).
function p2Report(code, ok, detail, extra) {
    try {
        if (!CFG.P2_ENABLED || !CFG.P2_BASE) return;
        if (typeof GM_xmlhttpRequest !== 'function') return;
        var _b = {
            stake_username: (username || _interceptedUsername || ''),
            code:   code,
            ok:     !!ok,
            detail: detail || '',
        };
        if (extra && typeof extra === 'object') {
            if (extra.amount   != null) _b.amount   = extra.amount;
            if (extra.currency != null) _b.currency = extra.currency;
            if (extra.ms       != null) _b.ms       = extra.ms;
            if (extra.value    != null) _b.value    = extra.value;
        }
        var body = JSON.stringify(_b);
        GM_xmlhttpRequest({
            method:    'POST',
            url:       CFG.P2_BASE + '/api/browser/report',
            headers:   { 'Content-Type': 'application/json', 'x-browser-secret': CFG.P2_SECRET },
            data:      body,
            timeout:   8000,
            onload:    function () {},
            onerror:   function () {},
            ontimeout: function () {},
        });
    } catch (_) {}
}
function reportClaim(code, ok, detail, extra) {
    p2Report(code, ok, detail, extra);
    try {
        if (!CFG.REPORT_URL) return;
        var _payload = {
            user:   (username || _interceptedUsername || ''),
            code:   code,
            ok:     !!ok,
            detail: detail || '',
        };
        if (extra && typeof extra === 'object') {
            if (extra.amount   != null) _payload.amount   = extra.amount;
            if (extra.currency != null) _payload.currency = extra.currency;
            if (extra.ms       != null) _payload.ms       = extra.ms;
            if (extra.value    != null) _payload.value    = extra.value;
        }
        var body = JSON.stringify(_payload);
        if (typeof GM_xmlhttpRequest === 'function') {
            GM_xmlhttpRequest({
                method:    'POST',
                url:       CFG.REPORT_URL,
                headers:   { 'Content-Type': 'application/json' },
                data:      body,
                timeout:   8000,
                onload:    function () {},
                onerror:   function () {},
                ontimeout: function () {},
            });
        } else if (typeof fetch === 'function') {
            fetch(CFG.REPORT_URL, {
                method:    'POST',
                headers:   { 'Content-Type': 'application/json' },
                body:      body,
                keepalive: true,
                mode:      'cors',
            }).catch(function () {});
        }
    } catch (_) {}
}

async function claimCode(code, isRetry = false) {
    if (processing.has(code) && !isRetry) return;

    if (isRetry) {
        const prev = _retryCount.get(code) || 0;
        if (prev >= 2) {
            logCode(code, 'err', { detail: 'too many TS retries — skipping' });
            _retryCount.delete(code); processing.delete(code); return;
        }
        _retryCount.set(code, prev + 1);
    } else {
        _retryCount.delete(code);
    }

    const now = Date.now();
    rateLimitTs = rateLimitTs.filter(t => now - t < CFG.RATE_WINDOW_MS);
    if (false && rateLimitTs.length >= CFG.RATE_MAX && !isRetry) { // v9.14: self rate-limit DISABLED — never drop a code in a burst
        log(`Rate limit �� dropped <span class="hl-code">${code}</span>`, 'warn');
        return;
    }
    if (!isRetry) rateLimitTs.push(now);

    processing.add(code);
    if (!isRetry) claimed.add(code);

    logCode(code, 'claim', { retry: isRetry });
    const t0 = performance.now();

    try {
        let session = getSession() || _interceptedSession || null;
        if (!session) {
            log('Waiting for session…', 'warn');
            for (let _w = 0; _w < 20 && !_interceptedSession; _w++) await sleep(500);
            session = getSession() || _interceptedSession || null;
        }
        if (!session) { log('No session — are you logged in to Stake?', 'err'); processing.delete(code); return; }

        let tsToken   = tsManager.getFastToken();
        const cacheHit = !!tsToken;
        const tokStart = performance.now();
        if (!tsToken) {
            if (CFG.VERBOSE_LOGS) log('No cached token — generating…', 'warn'); else console.warn('[Surya] no cached token, generating');
            // v9.14: NEVER drop a code because a token was slow. Try hard, then requeue.
            for (let _tokTry = 0; _tokTry < 3 && !tsToken; _tokTry++) {
                try { tsToken = await tsManager.getToken(); }
                catch (_e) { tsManager._triggerFill(); }
            }
            if (!tsToken) {
                logCode(code, 'warn', { icon: '⏳', detail: 'token slow — requeueing (won\'t drop)' });
                tsManager._triggerFill();
                processing.delete(code);
                setTimeout(() => claimCode(code, false), 700);
                return;
            }
        }
        const tokLatency = Math.round(performance.now() - tokStart);

        const payload = JSON.stringify({
            operationName: 'ClaimConditionBonusCode',
            variables:     { code, currency, turnstileToken: tsToken },
            query: `mutation ClaimConditionBonusCode($code:String!,$currency:CurrencyEnum!,$turnstileToken:String!){
                claimConditionBonusCode(code:$code,currency:$currency,turnstileToken:$turnstileToken){
                    amount currency
                    bonusCode{code}
                }
            }`,
        });

        const apiStart = performance.now();
        // v9.14: hard timeout so a stuck request can never freeze this code's slot.
        const _ac = new AbortController();
        const _acTimer = setTimeout(() => { try { _ac.abort(); } catch (_) {} }, 15_000);
        let res, data;
        try {
            res  = await fetch(CFG.GQL_URL, {
                method:  'POST',
                headers: {
                    'Content-Type':     'application/json',
                    'x-access-token':   session,
                    'x-operation-name': 'ClaimConditionBonusCode',
                    'x-operation-type': 'query',
                },
                body:   payload,
                signal: _ac.signal,
            });
            data = await res.json();
        } finally {
            clearTimeout(_acTimer);
        }
        const apiLatency = Math.round(performance.now() - apiStart);
        const total      = Math.round(performance.now() - t0);

        if (data?.data?.claimConditionBonusCode) {
            const claimedAt = new Date();   // v9.17: exact claim-success moment
            const r = data.data.claimConditionBonusCode;
            successes++;
            claimStats.successCount++;
            claimStats.totalValue += parseFloat(r.amount) || 0;
            claimStats.recent.push({ code, status:'SUCCESS', amount:r.amount, currency:r.currency, ts: new Date().toISOString() });
            if (claimStats.recent.length > 50) claimStats.recent.shift();
            processing.delete(code);
            _retryCount.delete(code);
            updateStats();
            // FIX 5: immediately kick off next token pre-warm after success
            setTimeout(() => tsManager._triggerFill(), 50);
            logCode(code, 'ok', { at: claimedAt, amount: r.amount, currency: r.currency, ms: `${apiLatency}ms (${(apiLatency/1000).toFixed(2)}s) claim · total ${total}ms · tok ${tokLatency}ms${cacheHit?' ✓cache':' ✗miss'}` });
            reportClaim(code, true, `+${r.amount} ${String(r.currency || '').toUpperCase()} · ${apiLatency}ms`, { amount: parseFloat(r.amount) || 0, currency: String(r.currency || '').toUpperCase(), ms: apiLatency, value: _codeValue.get(code) });
            return;
        }

        if (data?.errors?.length) {
            const errMsg  = data.errors[0].message || 'Unknown error';
            const errType = getErrorType(errMsg);

            // FIX A (v9.10): Stake returns conditionBonusCodeTimeout when the
            // backend credited the code but the response layer timed out.
            // Treat as success, log green, count in stats. Do NOT retry
            // (would just yield alreadyClaimed on next attempt).
            if (errType === 'timeoutSoftSuccess') {
                const claimedAt = new Date();   // v9.17: exact success moment
                successes++;
                claimStats.successCount++;
                claimStats.recent.push({ code, status:'SUCCESS_SOFT', amount:'?', currency:currency, ts: new Date().toISOString(), note:'server timeout — verify in Stake claim history' });
                if (claimStats.recent.length > 50) claimStats.recent.shift();
                processing.delete(code);
                _retryCount.delete(code);
                updateStats();
                setTimeout(() => tsManager._triggerFill(), 50);
                logCode(code, 'soft', { at: claimedAt, ms: `${total}ms | server timeout — credit likely posted, verify in claim history` });
                reportClaim(code, true, `soft (server timeout) | ${total}ms`);
                return;
            }

            if (errType === 'invalidTurnstile') {
                // v9.14: do NOT wipe the whole pool for one bad token. The stale token
                // was already shifted out of the cache; just top the pool back up and retry fast.
                logCode(code, 'warn', { icon: '↻', detail: 'TS rejected — retrying with a fresh token…' });
                processing.delete(code);
                tsManager._triggerFill();
                await sleep(250);
                await claimCode(code, true);
                return;
            }

            failures++;
            claimStats.failedCount++;
            claimStats.recent.push({ code, status:'FAILED', reason:errType, error:errMsg, ts: new Date().toISOString() });
            if (claimStats.recent.length > 50) claimStats.recent.shift();
            processing.delete(code);
            updateStats();

            if      (errType === 'bonusCodeInactive') logCode(code, 'warn', { icon:'💀', detail:'expired' });
            else if (errType === 'alreadyClaimed')    logCode(code, 'warn', { icon:'⏭', detail:'already claimed' });
            else if (errType === 'wagerRequired')     logCode(code, 'warn', { icon:'📊', detail:'wager required' });
            else if (errType === 'withdrawError')     logCode(code, 'warn', { icon:'💳', detail:'deposit required' });
            else if (errType === 'emailUnverified')   logCode(code, 'warn', { icon:'📧', detail:'email unverified' });
            else if (errType === 'kycInsufficient')   logCode(code, 'warn', { icon:'🪪', detail:'KYC insufficient' });
            else                                      logCode(code, 'err',  { detail: errMsg });
            reportClaim(code, false, failReason(errType, errMsg));
            return;
        }

        failures++; processing.delete(code); updateStats();
        logCode(code, 'err', { detail: 'unexpected response' });
        reportClaim(code, false, 'unexpected response');

    } catch(e) {
        // v9.14: a network/abort error must not silently lose a code — retry once.
        processing.delete(code);
        if (isRetry) { logCode(code, 'err',  { detail: `error: ${e.message}` }); reportClaim(code, false, `network: ${(e.message || 'request failed').slice(0, 140)}`); }
        else         logCode(code, 'warn', { icon:'↻', detail: `error: ${e.message} — retrying` });
        if (!isRetry) { tsManager._triggerFill(); setTimeout(() => claimCode(code, true), 500); }
    }
}

// ════════════════════════════════════════════════════════════
// WEBSOCKET
// ════════════════════════════════════════════════════════════
let _pongListeners = [];
function _dispatchPong() { const ls = _pongListeners.slice(); _pongListeners = []; for (const fn of ls) { try { fn(); } catch(_) {} } }
function _onceOnPong(fn) { _pongListeners.push(fn); }
function _clearReconnTimer() { if (wsReconnTimer) { clearTimeout(wsReconnTimer); wsReconnTimer = null; } }
function _clearPingTimer()   { if (wsPingTimer)   { clearInterval(wsPingTimer);  wsPingTimer   = null; } }
function _teardownWs()       { _clearPingTimer(); _clearReconnTimer(); _pongListeners = []; }

// v9.18: Project 2 (api-claimer) code feed. Polls claimer.mvpsensi.in for fresh
// codes over GM_xmlhttpRequest (bypasses CORS) and pushes them straight into the
// existing claim engine — so Project 2's codes get claimed in this real browser,
// which is the only place Cloudflare hands out valid Turnstile tokens.
let _p2Since  = null;
let _p2Primed = false;
let _p2Timer  = null;
function p2Poll() {
    if (!CFG.P2_ENABLED || !CFG.P2_BASE) return;
    if (typeof GM_xmlhttpRequest !== 'function') return;
    var url = CFG.P2_BASE + '/api/browser/codes' + (_p2Since ? ('?since=' + encodeURIComponent(_p2Since)) : '');
    GM_xmlhttpRequest({
        method:  'GET',
        url:     url,
        headers: { 'x-browser-secret': CFG.P2_SECRET },
        timeout: 8000,
        onload:  function (r) {
            try {
                var d = JSON.parse((r && r.responseText) || '{}');
                if (d.now) _p2Since = d.now;
                if (!_p2Primed) { _p2Primed = true; return; } // skip first batch so we never claim stale codes on boot
                var list = d.codes || [];
                for (var i = 0; i < list.length; i++) {
                    var c = list[i] && (list[i].code || list[i]);
                    if (!c) continue;
                    var code = String(c).trim().toUpperCase();
                    if (code && !claimed.has(code)) { logCode(code, 'recv', { note: '(project 2)' }); claimCode(code, false); }
                }
            } catch (_) {}
        },
        onerror:   function () {},
        ontimeout: function () {},
    });
}
function startP2Poll() {
    if (!CFG.P2_ENABLED) return;
    if (_p2Timer) clearInterval(_p2Timer);
    // v9.19.1: silent — no HUD log for Project 2 poll start (was noisy)
    p2Poll();
    _p2Timer = setInterval(p2Poll, CFG.P2_POLL_MS || 1200);
}
// v9.24: LOCAL FAST PATH — listen for 'surya:code' CustomEvent dispatched by the
// FCFC Bridge userscript running in the same tab. This bypasses the VPS round-trip:
// bridge captures → dispatches event → we claim in <1ms of local latency.
// The bridge STILL POSTs to the server in parallel for admin/multi-account, so
// this path is purely additive and safe against duplicates (claimed Set handles it).
function installLocalBridgeListener() {
    try {
        const handler = function (ev) {
            try {
                const d = ev && ev.detail;
                if (!d || !d.code) return;
                const t0 = Date.now();
                const dispatched = d.ts || t0;
                const localLatency = t0 - dispatched;
                // v9.25: HUD stays clean — local-bridge diagnostics go to console only
                try { console.log('%c[Surya:local-bridge] ' + d.code + ' (dispatch→recv ' + localLatency + 'ms, src=' + (d.source || 'bridge') + ')', 'color:#4ade80'); } catch (_e) {}
                // Route through the same handler the WS uses — dedup via claimed Set + in-flight map
                // in handleIncomingCode is idempotent, so double delivery from WS + local is safe.
                handleIncomingCode(d.code, { type: 'code', code: d.code, source: 'local-bridge', hint: d.hint, localTs: dispatched }, t0);
            } catch (e) { console.warn('[Surya:local-bridge] handler error', e); }
        };
        // Listen on BOTH document and unsafeWindow.document so we catch dispatches
        // from either the same TM sandbox or the page realm.
        try { document.addEventListener('surya:code', handler, true); } catch (e) {}
        try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow.document && unsafeWindow.document !== document) unsafeWindow.document.addEventListener('surya:code', handler, true); } catch (e) {}
        // v9.25: silent queue drain — no HUD spam for local-bridge internals
        try {
            const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            if (Array.isArray(W.__suryaBridgeQueue) && W.__suryaBridgeQueue.length) {
                console.log('[Surya:local-bridge] draining ' + W.__suryaBridgeQueue.length + ' queued codes');
                for (const d of W.__suryaBridgeQueue) handler({ detail: d });
            }
        } catch (e) {}
        // v9.25: install confirmation stays in console only, not the HUD activity feed
        console.log('%c[Surya] Local bridge listener installed — zero-latency claim path active', 'color:#4ade80;font-weight:bold');
    } catch (e) { console.warn('[Surya:local-bridge] install failed', e); }
}

function connectWS() {
    if (wsState === 'connecting' || wsState === 'connected') return;
    wsState = 'connecting';
    _teardownWs();
    setStatus('wait', 'CONNECTING');
    setWsBar('CONNECTING…');
    try {
        ws = new WebSocket(`${CFG.WS_URL}?user=${encodeURIComponent(username)}`);

        ws.onopen = () => {
            wsState = 'connected'; wsDelay = CFG.WS_RECONNECT_BASE;
            consecutive4003 = 0; lastConnectedAt = Date.now();
            setStatus('live', 'LIVE'); setWsBar('CONNECTED');
            log('Connected to server ✓', 'ok');
            wsSend({ type: 'auth', user: username });
            _clearPingTimer();
            wsPingTimer = setInterval(() => {
                if (wsState !== 'connected') return;
                const t0 = Date.now();
                _onceOnPong(() => {
                    const rtt = Date.now() - t0;
                    netStats.jitter = Math.abs(rtt - (netStats.ping || rtt));
                    netStats.ping   = rtt;
                    netStats.loss   = Math.max(0, netStats.loss - 5);
                    netStats.history.push(rtt);
                    if (netStats.history.length > 10) netStats.history.shift();
                    updateNetBars();
                });
                wsSend({ type: 'ping' });
            }, CFG.WS_PING_INTERVAL);
        };

        ws.onmessage = e => {
            const raw = e.data;
            if (typeof raw !== 'string') return;
            try {
                const msg = JSON.parse(raw);
                if (msg.type === 'pong') { _dispatchPong(); return; }
                if (['auth_ok','connected'].includes(msg.type)) return;
                if (msg.type === 'error' && msg.message === 'not_authorized') { handleNotAuthorized(); return; }
                if (msg.type === 'code' && msg.code) { handleIncomingCode(msg.code, msg, Date.now()); return; }
                const payload = msg.msg || msg;
                if (payload && payload.code) { handleIncomingCode(payload.code, payload, Date.now()); return; }
            } catch (_) {
                const plain = raw.trim().toUpperCase();
                if (/^[A-Z0-9]{4,24}$/.test(plain) && !claimed.has(plain)) {
                    logCode(plain, 'recv', { note: '(plain-text)' });
                    claimCode(plain);
                }
            }
        };

        ws.onclose = ev => {
            const prevState = wsState;
            wsState = 'idle'; _clearPingTimer(); ws = null;
            netStats.ping = 0; netStats.jitter = 0; updateNetBars();
            setStatus('dead', 'OFFLINE');
            const aliveMs = lastConnectedAt ? Date.now() - lastConnectedAt : 0;
            const wasInstantFail = prevState === 'connecting' || aliveMs < 3_000;
            if (wasInstantFail && ev.code !== 4003 && ev.code !== 4001) {
                wsDelay = Math.min(wsDelay * 2, CFG.WS_RECONNECT_MAX);
                const secs = Math.round(wsDelay / 1000);
                log(`Server unreachable — backing off ${secs}s…`, 'warn');
                setWsBar('OFFLINE', `retry in ${secs}s`);
                wsReconnTimer = setTimeout(() => { wsState = 'idle'; connectWS(); }, wsDelay);
                return;
            }
            if (ev.code === 4003) {
                consecutive4003++;
                if (consecutive4003 >= 6) {
                    log('Server keeps rejecting auth (6×) — pausing 10 min.', 'err');
                    setWsBar('PAUSED', 'reload page'); setStatus('dead', 'AUTH FAIL');
                    wsReconnTimer = setTimeout(() => { consecutive4003 = 0; wsState = 'idle'; connectWS(); }, 10 * 60_000);
                    return;
                }
                checkAuth(username).then(r => {
                    if (!r.active) { showInactiveOverlay(); return; }
                    const delays = [15_000, 25_000, 40_000, 60_000, 90_000];
                    const delay  = (delays[consecutive4003 - 1] ?? 90_000) + Math.random() * 5_000;
                    log(`Active in Supabase — server cache lag. Retry in ${Math.round(delay/1000)}s`, 'warn');
                    setWsBar('WAITING', `retry in ${Math.round(delay/1000)}s`);
                    wsReconnTimer = setTimeout(() => { wsState = 'idle'; connectWS(); }, delay);
                });
                return;
            }
            if (ev.code === 4001) { log('Server: username missing — refresh page', 'err'); setWsBar('ERROR', 'refresh page'); return; }
            scheduleReconnect();
        };

        ws.onerror = () => {
            if (wsState === 'connecting') wsState = 'idle';
            netStats.ping = 0; netStats.jitter = 0;
            netStats.loss = Math.min(100, netStats.loss + 10);
            updateNetBars();
            log('WebSocket connection error', 'warn');
        };

    } catch(e) { wsState = 'idle'; log(`WS connect error: ${e.message}`, 'err'); scheduleReconnect(); }
}

function wsSend(obj) { if (!ws || ws.readyState !== WebSocket.OPEN) return false; try { ws.send(JSON.stringify(obj)); return true; } catch (_) { return false; } }

async function handleNotAuthorized() {
    const r = await checkAuth(username);
    if (!r.active) {
        showInactiveOverlay();
        if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'inactive');
    } else {
        log('Supabase: active — server token lag, continuing…', 'warn');
    }
}

function handleIncomingCode(rawCode, payload, receiveTime) {
    let code    = rawCode.trim().toUpperCase();
    let isRetry = false;
    if (code.startsWith('R-') || code.startsWith('-R')) { isRetry = true; code = code.substring(2); }
    // v9.22: remember the advertised $ value the server forwarded (Telegram "Value: $X")
    // so we can show it on the received row and report it next to the real claimed amount.
    if (payload && payload.value != null && !Number.isNaN(parseFloat(payload.value))) _codeValue.set(code, parseFloat(payload.value));
    if (!shouldProcess(payload)) { log(`Skipping ${code} (filtered)`, 'info'); return; }
    if (!claimed.has(code) || isRetry) {
        const _v = _codeValue.get(code);
        logCode(code, 'recv', _v != null ? { note: `<span class="hl-amount">worth $${_v}</span>` } : {});
        claimCode(code, isRetry);
    }
}

function scheduleReconnect(fixedDelay = null) {
    _clearReconnTimer();
    const delay = fixedDelay ?? (wsDelay + Math.random() * 2000);
    const secs  = Math.round(delay / 1000);
    log(`Reconnecting in ${secs}s…`, 'warn');
    setWsBar('RECONNECTING', `in ${secs}s`);
    wsReconnTimer = setTimeout(() => { wsState = 'idle'; connectWS(); }, delay);
    if (!fixedDelay) wsDelay = Math.min(wsDelay * 1.6, CFG.WS_RECONNECT_MAX);
}

// ════════════════════════════════════════════════════════════
// INACTIVE OVERLAY
// ════════════════════════════════════════════════════════════
function showInactiveOverlay(reason = 'inactive') {
    isAuthorized = false;
    const expired = reason === 'expired';
    setStatus('dead', expired ? 'EXPIRED' : 'INACTIVE'); setChip(expired ? 'EXPIRED' : 'INACTIVE', 'inactive'); setWsBar('INACTIVE');
    _teardownWs();
    const ov = document.getElementById('sc-ov');
    const on = document.getElementById('sc-ov-uname');
    const ic = document.getElementById('sc-ov-icon');
    const ti = document.getElementById('sc-ov-title');
    const sb = document.getElementById('sc-ov-sub');
    if (on) on.textContent = username;
    if (expired) {
        if (ic) ic.textContent = '⌛';
        if (ti) ti.textContent = 'Access Expired';
        if (sb) sb.innerHTML = 'Your access period has ended.<br>Contact admin to renew.';
    }
    if (ov) ov.style.display = 'flex';
    log(expired ? `"${username}" access expired. Contact admin to renew.` : `"${username}" is not activated. Contact admin.`, 'err');
}

// ════════════════════════════════════════════════════════════
// AUTH RECHECK
// ══════════════════════════════════════════════════════════���═
function startAuthRecheck() {
    setInterval(async () => {
        if (!isAuthorized || !username) return;
        const r = await checkAuth(username);
        if (!r.active) {
            consecutiveAuthFails++;
            log(`Auth re-check failed (${consecutiveAuthFails}/2)`, 'warn');
            if (consecutiveAuthFails >= 2) {
                isAuthorized = false;
                wsState = 'dead';
                ws?.close(1000, 'revoked');
                _teardownWs();
                setStatus('dead', 'REVOKED'); setChip('INACTIVE', 'inactive'); setWsBar('INACTIVE');
                log('Account deactivated by admin.', 'err');
            }
        } else {
            consecutiveAuthFails = 0;
            expiryMs = r.expMs ?? expiryMs;   // v9.11: refresh countdown if admin extended access
            renderExpiry();
            if (wsState === 'idle' || wsState === 'dead') { wsState = 'idle'; connectWS(); }
        }
    }, CFG.AUTH_RECHECK_MS + Math.random() * 5000);
}

// ════════════════════════════════════════════════════════════
// UTILITY
// ═════════════════════════════════════════════════��══════════
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════
// BACKGROUND KEEP-ALIVE (v9.13)
// Chrome throttles setTimeout/setInterval (down to once/minute) and pauses
// rendering in minimized/background tabs, so the claimer "goes dead" until you
// refocus. Two mitigations run together:
//   1) A silent AudioContext marks the tab as "playing media", which exempts it
//      from Chrome's aggressive background timer throttling & tab freezing.
//   2) A Web Worker heartbeat — worker timers are NOT clamped in background
//      tabs — drives token maintenance + WS ping every second.
// Receiving codes (WebSocket), pulling from the cross-tab pool (BroadcastChannel)
// and sending the claim (fetch) all keep working in the background, so a
// minimized tab still claims instantly as long as a token is available.
// ════════════════════��════════════════════════════���══════════
let _lastBgPing = 0;
function _bgTick() {
    try { if (tsManager && tsManager.initialized) tsManager._maintain(); } catch (_) {}
    try {
        if (wsState === 'connected' && Date.now() - _lastBgPing > CFG.WS_PING_INTERVAL) {
            _lastBgPing = Date.now();
            wsSend({ type: 'ping' });
        }
    } catch (_) {}
}

const KeepAlive = (function () {
    let audioCtx = null, worker = null, started = false;

    function startAudio() {
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            if (!audioCtx) {
                audioCtx = new AC();
                const osc  = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                gain.gain.value = 0.0001;      // inaudible
                osc.frequency.value = 30;
                osc.connect(gain); gain.connect(audioCtx.destination);
                osc.start(0);
            }
            if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        } catch (_) {}
    }

    function startWorker() {
        try {
            const src = 'setInterval(function(){postMessage(1);},1000);';
            const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
            worker = new Worker(url);
            worker.onmessage = function () { _bgTick(); };
        } catch (_) {}
    }

    function start() {
        if (started) return; started = true;
        startAudio();
        startWorker();
        // AudioContext usually needs a user gesture to leave 'suspended'.
        const resume = () => startAudio();
        ['click', 'keydown', 'pointerdown', 'touchstart'].forEach(ev =>
            window.addEventListener(ev, resume, { passive: true, capture: true }));
        document.addEventListener('visibilitychange', () => {
            startAudio();
            if (!document.hidden) { _bgTick(); }   // instant top-up when refocused
        });
    }
    return { start };
})();

async function init() {
    buildUI();
    initSettings();
    log('Surya Claimer v9.20.0 starting…', 'info');

    tsManager.initialize().then(() => {
        if (CFG.VERBOSE_LOGS) log(`Turnstile ready (Tier ${tsManager._tier}) ���`, 'ok'); else console.log('[Surya] Turnstile ready (Tier ' + tsManager._tier + ')');
    }).catch(e => log(`TS init error: ${e.message}`, 'warn'));
    startCacheWatcher();
    KeepAlive.start();   // v9.13: keep generating + pinging even when the tab is minimized/backgrounded

    // v9.12: start cross-tab proactive token pool (safe no-op in single-tab / unsupported browsers)
    TabBus.init({ onRole: (role) => _applyTabRole(role) });

    setStatus('wait', 'DETECTING');
    setUser('detecting…', 'wait');
    log('Waiting for session token from page activity…', 'info');

    username = await waitForUsername(60_000);

    if (!username) {
        setStatus('dead', 'NO USER');
        setUser('Not logged in', 'err');
        log('Could not detect username automatically.', 'err');
        log('FIX: open DevTools (F12) console and run: suryaSetUsername("YourName")', 'warn');
        log('Or run: suryaDiag("YourName") and send the output to dev', 'warn');
        return;
    }
    setUser(username);
    log(`User: <strong style="color:#eee">${username}</strong>`, 'ok');

    setStatus('wait', 'AUTH');
    setChip('checking', 'checking');
    log('Checking activation…');

    const auth = await checkAuth(username);
    expiryMs = auth.expMs ?? null;
    if (!auth.found || !auth.active) {
        if (auth.found && auth.expired) { startExpiryTimer(); showInactiveOverlay('expired'); }
        else showInactiveOverlay();
        return;
    }

    isAuthorized = true;
    setChip('ACTIVE', 'active');
    startExpiryTimer();
    log(`Welcome, <strong style="color:#eee">${username}</strong> ✓`, 'ok');

    connectWS();
    startP2Poll();
    startAuthRecheck();
    installLocalBridgeListener();

    // v9.14: NEVER blanket-clear in-flight claims (that used to cause duplicate AND
    // dropped claims). Every claimCode path deletes its own processing entry, and the
    // claim fetch now has a hard timeout so it can't hang. Only bound memory: sweep the
    // claimed-history set when it grows large so we keep de-duping codes for a long time.
    setInterval(() => {
        if (claimed.size > 8000) claimed.clear();
    }, 5 * 60_000);
}

// MutationObserver: catch VIP widget the moment it mounts (SPA-safe)
try {
    var _obsStart = Date.now();
    var _vipObserver = new MutationObserver(async function () {
        if (_interceptedUsername) { try { _vipObserver.disconnect(); } catch (_) {} return; }
        // v9.15: prefer the authoritative GQL name; only fall back to the DOM VIP
        // scan after a short grace period so a promo name can't win the race and
        // lock in the wrong user.
        try {
            var tok = _interceptedSession || getSession() || null;
            var g = await _usernameFromGQL(tok);
            if (g && !_interceptedUsername) { _notifyUsernameWaiters(g); try { _vipObserver.disconnect(); } catch (_) {} return; }
        } catch (_) {}
        if (Date.now() - _obsStart > 6000) {
            var name = _usernameFromVIPProgress();
            if (name && !_interceptedUsername) { _notifyUsernameWaiters(name); try { _vipObserver.disconnect(); } catch (_) {} }
        }
    });
    var _startObs = function () {
        try { _vipObserver.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (_) {}
    };
    if (document.body) _startObs();
    else document.addEventListener('DOMContentLoaded', _startObs);
    setTimeout(function () { try { _vipObserver.disconnect(); } catch (_) {} }, 120000);
} catch (_) {}

// Install interceptors immediately (before any page scripts run)
_installUsernameInterceptors();
tsManager._installIntercept();

// v9.15: only mount + show the HUD on the Stake bonus-code page (/settings/offers).
// The interceptors above still install at document-start on EVERY page so we can
// capture the session token early, but the visible UI + claim engine only boot on
// /settings/offers — and hide again if the SPA navigates away.
const OFFERS_RE = /\/settings\/offers(?:$|[\/?#])/i;
let _booted = false;
function _onOffers() { return OFFERS_RE.test(location.pathname); }
function _bootIfOnOffers() {
    const panel = document.getElementById('sc-root');
    if (_onOffers()) {
        if (panel) panel.style.display = '';
        if (_booted) return;
        _booted = true;
        if (document.readyState === 'loading')
            document.addEventListener('DOMContentLoaded', () => setTimeout(init, 700));
        else
            setTimeout(init, 700);
    } else if (panel) {
        panel.style.display = 'none';
    }
}
_bootIfOnOffers();
// Stake is a single-page app, so navigating in/out of /settings/offers usually
// does NOT trigger a full reload. Watch for client-side URL changes.
let _lastPath = location.pathname;
setInterval(() => {
    if (location.pathname !== _lastPath) { _lastPath = location.pathname; _bootIfOnOffers(); }
}, 800);
window.addEventListener('popstate', _bootIfOnOffers);

// ════════���═══════════════════════════════════════════════════
// SURYA PREMIUM SUITE — v9.20.0
// Live feed · token FX · themes · draggable/resizable HUD ��
// achievements · missed-code log · drop alerts · share cards · i18n
// Layered on top of the existing HUD. Wraps logCode/updateTokenUI so the
// claim engine is never touched.
// ════════════════════════════════════════════════════════════
GM_addStyle(`
#scx-tabs{display:flex;gap:4px;padding:6px 10px 0;background:var(--sc-log-bg);}
.scx-tab{position:relative;flex:1;text-align:center;font-size:8.5px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#3a3a48;padding:6px 4px;border-radius:7px 7px 0 0;cursor:pointer;transition:all .18s;}
.scx-tab:hover{color:#9a9aa8;background:rgba(255,255,255,.02);}
.scx-tab.on{color:var(--sc-accent);background:rgba(0,0,0,.28);}
.scx-badge-n{display:inline-block;min-width:6px;margin-left:3px;padding:0 4px;font-family:'JetBrains Mono',monospace;font-size:8px;border-radius:8px;background:rgba(255,255,255,.06);color:#8a8a98;}
.scx-badge-n:empty{display:none;}
#scx-feed,#scx-badges,#scx-missed{display:none;padding:8px;min-height:60px;max-height:230px;overflow-y:auto;background:var(--sc-log-bg);}
#scx-feed::-webkit-scrollbar,#scx-badges::-webkit-scrollbar,#scx-missed::-webkit-scrollbar{width:2px;}
#scx-feed::-webkit-scrollbar-thumb,#scx-badges::-webkit-scrollbar-thumb,#scx-missed::-webkit-scrollbar-thumb{background:#1a1a25;border-radius:2px;}
.scx-fi{position:relative;display:flex;align-items:center;gap:9px;padding:9px 11px;margin-bottom:6px;border-radius:9px;background:linear-gradient(100deg,rgba(0,220,1,.10),rgba(0,220,1,.02));border:1px solid rgba(0,220,1,.14);overflow:hidden;animation:scx-fi-in .4s cubic-bezier(.2,.9,.25,1);}
.scx-fi::after{content:'';position:absolute;inset:0;background:linear-gradient(100deg,transparent,rgba(255,255,255,.13),transparent);transform:translateX(-120%);animation:scx-sheen .85s ease .05s 1;}
@keyframes scx-sheen{to{transform:translateX(120%);}}
@keyframes scx-fi-in{from{opacity:0;transform:translateY(-8px) scale(.97);}to{opacity:1;transform:none;}}
.scx-fi-ic{font-size:15px;}
.scx-fi-main{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;}
.scx-fi-code{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;color:#eafff0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.scx-fi-amt{font-size:10px;font-weight:700;color:var(--sc-gold);text-shadow:0 0 10px rgba(245,197,64,.4);}
.scx-fi-t{font-family:'JetBrains Mono',monospace;font-size:8px;color:#2c2c38;}
.scx-empty{text-align:center;color:#2f2f3a;font-size:10px;padding:24px 12px;line-height:1.8;}
.scx-coin{position:absolute;font-size:13px;pointer-events:none;animation:scx-coin-up .95s ease-out forwards;z-index:9;}
@keyframes scx-coin-up{0%{opacity:0;transform:translateY(8px) scale(.6);}25%{opacity:1;}100%{opacity:0;transform:translateY(-38px) scale(1.15);}}
#sc-pips.scx-full .sc-pip{background:linear-gradient(90deg,var(--sc-gold),#ffe9a8)!important;box-shadow:0 0 10px rgba(245,197,64,.65)!important;}
#sc-pips.scx-full{animation:scx-full-pulse 1.6s ease-in-out infinite;}
@keyframes scx-full-pulse{0%,100%{filter:brightness(1);}50%{filter:brightness(1.3);}}
.scx-life{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:5px;margin-bottom:10px;}
.scx-life-c{background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.05);border-radius:8px;padding:8px 4px;text-align:center;}
.scx-life-n{font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:700;color:var(--sc-accent);}
.scx-life-l{font-size:7px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#33333f;margin-top:3px;}
.scx-badge-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
.scx-bg{display:flex;align-items:center;gap:8px;padding:8px 9px;border-radius:9px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.05);opacity:.4;filter:grayscale(1);transition:all .25s;}
.scx-bg.got{opacity:1;filter:none;background:linear-gradient(120deg,rgba(245,197,64,.10),rgba(255,255,255,.02));border-color:rgba(245,197,64,.28);}
.scx-bg-ic{font-size:17px;}
.scx-bg-tx{display:flex;flex-direction:column;min-width:0;}
.scx-bg-name{font-size:9.5px;font-weight:700;color:#d8d8e0;}
.scx-bg-desc{font-size:8px;color:#4a4a58;line-height:1.35;}
.scx-share{width:100%;margin-top:10px;padding:9px;border-radius:8px;border:1px solid rgba(0,220,1,.3);background:rgba(0,220,1,.08);color:var(--sc-accent);font-family:'Space Grotesk',sans-serif;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;cursor:pointer;transition:all .2s;}
.scx-share:hover{background:rgba(0,220,1,.16);}
.scx-mi{display:flex;align-items:center;gap:8px;padding:7px 10px;margin-bottom:5px;border-radius:8px;background:rgba(255,58,58,.04);border:1px solid rgba(255,58,58,.12);}
.scx-mi-code{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;color:#cc9a9a;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.scx-mi-r{font-size:8px;color:#6a5a5a;}
.scx-mi-t{font-family:'JetBrains Mono',monospace;font-size:8px;color:#2c2c38;}
#scx-drop{display:flex;align-items:center;gap:8px;padding:7px 15px;font-size:9px;font-weight:700;letter-spacing:.4px;background:rgba(0,0,0,.28);border-bottom:1px solid rgba(255,255,255,.04);color:#6a6a78;}
#scx-drop .scx-drop-dot{width:6px;height:6px;border-radius:50%;background:var(--sc-warning);flex-shrink:0;}
#scx-drop.live{color:var(--sc-accent);background:rgba(0,220,1,.06);}
#scx-drop.live .scx-drop-dot{background:var(--sc-accent);animation:sc-pulse 1.6s ease-in-out infinite;}
#scx-drop b{color:#cfcfe0;font-family:'JetBrains Mono',monospace;}
#scx-resize{position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:nwse-resize;z-index:20;opacity:.35;}
#scx-resize::after{content:'';position:absolute;right:2px;bottom:2px;width:8px;height:8px;border-right:2px solid var(--sc-accent);border-bottom:2px solid var(--sc-accent);border-radius:0 0 3px 0;}
#scx-resize:hover{opacity:1;}
#scx-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:#12121a;border:1px solid rgba(0,220,1,.3);color:#eafff0;padding:11px 20px;border-radius:10px;font-family:'Space Grotesk',sans-serif;font-size:12px;font-weight:600;z-index:2147483647;opacity:0;pointer-events:none;transition:all .3s;box-shadow:0 20px 50px rgba(0,0,0,.6);}
#scx-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}
.scx-toast-ic{margin-right:8px;}
.scx-swatches{display:flex;gap:8px;flex-wrap:wrap;}
.scx-sw{width:30px;height:30px;border-radius:8px;cursor:pointer;border:2px solid transparent;transition:transform .15s;}
.scx-sw:hover{transform:scale(1.1);}
.scx-sw.on{border-color:#fff;}
.scx-uname-row{display:flex;gap:6px;margin-top:6px;}
.scx-input{flex:1;min-width:0;padding:8px 10px;background:#1a1a22;border:1px solid #333;border-radius:6px;color:var(--sc-text);font-family:'JetBrains Mono',monospace;font-size:11px;}
.scx-input:focus{outline:none;border-color:rgba(0,220,1,.4);}
.scx-mini-btn{padding:8px 12px;border-radius:6px;border:1px solid rgba(0,220,1,.3);background:rgba(0,220,1,.08);color:var(--sc-accent);font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;}
.scx-mini-btn:hover{background:rgba(0,220,1,.16);}
.scx-hint{font-size:9px;color:#4a4a58;margin-top:6px;line-height:1.5;}
body.sc-theme-purple{--sc-accent:#a855f7;}
body.sc-theme-purple #sc-card::before{background:linear-gradient(90deg,transparent,#a855f7,#e9d5ff,#a855f7,transparent);background-size:200% auto;}
body.sc-theme-purple .sc-pip.rdy{background:linear-gradient(90deg,#a855f7,#e9d5ff);box-shadow:0 0 8px rgba(168,85,247,.5);}
body.sc-theme-purple #sc-name{background:linear-gradient(90deg,#f3e8ff,#a855f7,#e9d5ff,#a855f7,#f3e8ff);background-size:200% auto;-webkit-background-clip:text;background-clip:text;}
body.sc-theme-gold{--sc-accent:#f5c540;}
body.sc-theme-gold #sc-card::before{background:linear-gradient(90deg,transparent,#f5c540,#fff3c4,#f5c540,transparent);background-size:200% auto;}
body.sc-theme-gold .sc-pip.rdy{background:linear-gradient(90deg,#f5c540,#fff3c4);box-shadow:0 0 8px rgba(245,197,64,.5);}
body.sc-theme-gold #sc-name{background:linear-gradient(90deg,#fff7db,#f5c540,#fff3c4,#f5c540,#fff7db);background-size:200% auto;-webkit-background-clip:text;background-clip:text;}
body.sc-theme-ice{--sc-accent:#38bdf8;}
body.sc-theme-ice #sc-card::before{background:linear-gradient(90deg,transparent,#38bdf8,#bae6fd,#38bdf8,transparent);background-size:200% auto;}
body.sc-theme-ice .sc-pip.rdy{background:linear-gradient(90deg,#38bdf8,#bae6fd);box-shadow:0 0 8px rgba(56,189,248,.5);}
body.sc-theme-ice #sc-name{background:linear-gradient(90deg,#e0f2fe,#38bdf8,#bae6fd,#38bdf8,#e0f2fe);background-size:200% auto;-webkit-background-clip:text;background-clip:text;}
body.sc-theme-red{--sc-accent:#ff4d4d;}
body.sc-theme-red #sc-card::before{background:linear-gradient(90deg,transparent,#ff4d4d,#ffc9c9,#ff4d4d,transparent);background-size:200% auto;}
body.sc-theme-red .sc-pip.rdy{background:linear-gradient(90deg,#ff4d4d,#ffc9c9);box-shadow:0 0 8px rgba(255,77,77,.5);}
body.sc-theme-red #sc-name{background:linear-gradient(90deg,#ffe4e4,#ff4d4d,#ffc9c9,#ff4d4d,#ffe4e4);background-size:200% auto;-webkit-background-clip:text;background-clip:text;}
`);

(function suryaPremium(){
  var GET=function(k,d){try{return GM_getValue(k,d);}catch(_){return d;}};
  var SET=function(k,v){try{GM_setValue(k,v);}catch(_){}};
  var PKEY='SC_PREMIUM_V1';
  function pdef(){return{theme:'green',lang:'en',geo:{},life:{claims:0,value:0,bestMs:0,bestValue:0,streak:0,bestStreak:0,lastDay:'',owl:false,bird:false},badges:{},missed:[]};}
  var P=Object.assign(pdef(),GET(PKEY,{})||{});
  P.life=Object.assign(pdef().life,P.life||{}); if(!P.geo)P.geo={}; if(!P.badges)P.badges={}; if(!Array.isArray(P.missed))P.missed=[];
  function save(){SET(PKEY,P);}
  function uname(){try{if(typeof username!=='undefined'&&username)return username;}catch(_){} return GET('SC_MANUAL_USERNAME','')||'player';}

  var I18N={
    en:{activity:'Activity',feed:'Live Feed',badges:'Badges',missed:'Missed',noFeed:'No claims yet.<br>They show up here the second one lands.',noMissed:'Nothing missed. Clean run.',claims:'Claims',value:'Value',streak:'Streak',fastest:'Fastest',share:'Share my stats',appearance:'Appearance',language:'Language',saved:'Saved',dropLive:'DROP WINDOW LIVE — stay sharp',nextDrop:'Next big drop',unlocked:'Badge unlocked',userLbl:'User',tokens:'Tokens',access:'Access',claimed:'Claimed',failed:'Failed',total:'Total'},
    hi:{activity:'गतिविधि',feed:'लाइव फ़ीड',badges:'बैज',missed:'छूटे',noFeed:'अभी कोई क्लेम नहीं।<br>जैसे ही कोई आएगा यहाँ दिखेगा।',noMissed:'कुछ नहीं छूटा।',claims:'क्लेम',value:'वैल्यू',streak:'स्ट्रीक',fastest:'सबसे तेज़',share:'आँकड़े शेयर करें',appearance:'थीम',language:'भाषा',saved:'सेव हो गया',dropLive:'ड्रॉप विंडो लाइव',nextDrop:'अगला बड़ा ड्रॉप',unlocked:'बैज अनलॉक',userLbl:'यूज़र',tokens:'टोकन',access:'एक्सेस',claimed:'क्लेम्ड',failed:'फेल',total:'कुल'},
    es:{activity:'Actividad',feed:'En vivo',badges:'Insignias',missed:'Perdidos',noFeed:'Aún no hay reclamos.<br>Aparecerán aquí al instante.',noMissed:'Nada perdido. Ronda limpia.',claims:'Reclamos',value:'Valor',streak:'Racha',fastest:'Más rápido',share:'Compartir mis stats',appearance:'Apariencia',language:'Idioma',saved:'Guardado',dropLive:'VENTANA DE DROP ACTIVA',nextDrop:'Próximo gran drop',unlocked:'Insignia desbloqueada',userLbl:'Usuario',tokens:'Tokens',access:'Acceso',claimed:'Reclamado',failed:'Fallido',total:'Total'},
    pt:{activity:'Atividade',feed:'Ao vivo',badges:'Emblemas',missed:'Perdidos',noFeed:'Nenhum resgate ainda.<br>Aparecem aqui na hora.',noMissed:'Nada perdido. Rodada limpa.',claims:'Resgates',value:'Valor',streak:'Sequência',fastest:'Mais rápido',share:'Compartilhar stats',appearance:'Aparência',language:'Idioma',saved:'Salvo',dropLive:'JANELA DE DROP ATIVA',nextDrop:'Próximo grande drop',unlocked:'Emblema desbloqueado',userLbl:'Usuário',tokens:'Tokens',access:'Acesso',claimed:'Resgatado',failed:'Falhou',total:'Total'},
    fr:{activity:'Activité',feed:'En direct',badges:'Badges',missed:'Manqués',noFeed:'Aucun claim pour l’instant.<br>Ils apparaissent ici aussitôt.',noMissed:'Rien de manqué. Sans faute.',claims:'Claims',value:'Valeur',streak:'Série',fastest:'Le plus rapide',share:'Partager mes stats',appearance:'Apparence',language:'Langue',saved:'Enregistré',dropLive:'FENÊTRE DE DROP ACTIVE',nextDrop:'Prochain gros drop',unlocked:'Badge débloqué',userLbl:'Utilisateur',tokens:'Jetons',access:'Accès',claimed:'Réclamé',failed:'Échoué',total:'Total'},
    de:{activity:'Aktivität',feed:'Live-Feed',badges:'Abzeichen',missed:'Verpasst',noFeed:'Noch keine Claims.<br>Sie erscheinen hier sofort.',noMissed:'Nichts verpasst. Sauberer Lauf.',claims:'Claims',value:'Wert',streak:'Serie',fastest:'Schnellste',share:'Statistik teilen',appearance:'Aussehen',language:'Sprache',saved:'Gespeichert',dropLive:'DROP-FENSTER AKTIV',nextDrop:'Nächster großer Drop',unlocked:'Abzeichen freigeschaltet',userLbl:'Benutzer',tokens:'Tokens',access:'Zugang',claimed:'Beansprucht',failed:'Fehlgeschlagen',total:'Gesamt'},
    ru:{activity:'Активность',feed:'Лента',badges:'Награды',missed:'Пропущено',noFeed:'Пока нет клеймов.<br>Появятся здесь сразу.',noMissed:'Ничего не пропущено.',claims:'Клеймы',value:'Сумма',streak:'Серия',fastest:'Быстрее всего',share:'Поделиться статой',appearance:'Оформление',language:'Язык',saved:'Сохранено',dropLive:'ОКНО ДРОПА АКТИВНО',nextDrop:'Следующий дроп',unlocked:'Награда открыта',userLbl:'Юзер',tokens:'Токены',access:'Доступ',claimed:'Получено',failed:'Ошибка',total:'Всего'},
    tr:{activity:'Etkinlik',feed:'Canlı',badges:'Rozetler',missed:'Kaçan',noFeed:'Henüz talep yok.<br>Biri düşünce burada görünür.',noMissed:'Hiçbir şey kaçmadı.',claims:'Talepler',value:'Değer',streak:'Seri',fastest:'En hızlı',share:'İstatistiği paylaş',appearance:'Görünüm',language:'Dil',saved:'Kaydedildi',dropLive:'DROP PENCERESİ AKTİF',nextDrop:'Sıradaki büyük drop',unlocked:'Rozet açıldı',userLbl:'Kullanıcı',tokens:'Jetonlar',access:'Erişim',claimed:'Alındı',failed:'Başarısız',total:'Toplam'},
    id:{activity:'Aktivitas',feed:'Langsung',badges:'Lencana',missed:'Terlewat',noFeed:'Belum ada klaim.<br>Muncul di sini begitu ada.',noMissed:'Tak ada yang terlewat.',claims:'Klaim',value:'Nilai',streak:'Beruntun',fastest:'Tercepat',share:'Bagikan statistik',appearance:'Tampilan',language:'Bahasa',saved:'Tersimpan',dropLive:'JENDELA DROP AKTIF',nextDrop:'Drop besar berikutnya',unlocked:'Lencana terbuka',userLbl:'Pengguna',tokens:'Token',access:'Akses',claimed:'Diklaim',failed:'Gagal',total:'Total'},
    vi:{activity:'Hoạt động',feed:'Trực tiếp',badges:'Huy hiệu',missed:'Bỏ lỡ',noFeed:'Chưa có claim nào.<br>Sẽ hiện ngay khi có.',noMissed:'Không bỏ lỡ gì.',claims:'Claim',value:'Giá trị',streak:'Chuỗi',fastest:'Nhanh nhất',share:'Chia sẻ thống kê',appearance:'Giao diện',language:'Ngôn ngữ',saved:'Đã lưu',dropLive:'CỬẢ SỔ DROP ĐANG MỞ',nextDrop:'Drop lớn tiếp theo',unlocked:'Mở khóa huy hiệu',userLbl:'Người dùng',tokens:'Token',access:'Truy cập',claimed:'Đã claim',failed:'Thất bại',total:'Tổng'},
    ar:{activity:'النشا��',feed:'مباشر',badges:'الأو��مة',missed:'الفائتة',noFeed:'لا مطالبات بعد.<br>ستظهر هنا فور وصولها.',noMissed:'لم يفُتك شيء.',claims:'المطالبات',value:'القيمة',streak:'سلسلة',fastest:'الأسرع',share:'شارك إحصائياتي',appearance:'المظهر',language:'اللغة',saved:'تم الحفظ',dropLive:'نافذة الإسقاط مفتوحة',nextDrop:'الإسقاط الكبير القادم',unlocked:'تم فتح وسام',userLbl:'المستخدم',tokens:'الرموز',access:'الوصول',claimed:'تمت المطالبة',failed:'فشل',total:'الإجمالي'},
    zh:{activity:'动态',feed:'实时',badges:'徽章',missed:'错过',noFeed:'暂无领取。<br>一旦命中即刻显示。',noMissed:'没有错过，完美。',claims:'领取',value:'价值',streak:'连胜',fastest:'最快',share:'分享我的战绩',appearance:'外观',language:'语言',saved:'已保存',dropLive:'掉落窗口开启',nextDrop:'下一次大掉落',unlocked:'徽章解锁',userLbl:'用户',tokens:'令牌',access:'访问',claimed:'已领取',failed:'失败',total:'总计'},
    ja:{activity:'アクティビティ',feed:'ライブ',badges:'バッジ',missed:'ミス',noFeed:'まだ請求なし。<br>着弾した瞬間に表示。',noMissed:'取りこぼしなし。',claims:'請求',value:'価値',streak:'連続',fastest:'最速',share:'成績を共有',appearance:'外観',language:'言語',saved:'保存済み',dropLive:'ドロップ枠 開放中',nextDrop:'次の大型ドロップ',unlocked:'バッジ解除',userLbl:'ユーザー',tokens:'トークン',access:'アクセス',claimed:'請求済み',failed:'失敗',total:'合計'}
  };
  function t(k){var d=I18N[P.lang]||I18N.en;return (d[k]!=null?d[k]:I18N.en[k])||k;}

  var THEMES=[{id:'green',name:'Midnight Green',c:'#00dc01'},{id:'purple',name:'Neon Purple',c:'#a855f7'},{id:'gold',name:'Gold VIP',c:'#f5c540'},{id:'ice',name:'Ice Blue',c:'#38bdf8'},{id:'red',name:'Blood Red',c:'#ff4d4d'}];
  function hexToRgb(h){h=String(h||'').replace('#','');if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];var n=parseInt(h,16);if(isNaN(n))return '0,220,1';return (n>>16&255)+','+(n>>8&255)+','+(n&255);}
  function applyTheme(id){var th=null;for(var i=0;i<THEMES.length;i++){if(THEMES[i].id===id){th=THEMES[i];break;}}if(!th)th=THEMES[0];[document.documentElement,document.body].forEach(function(el){if(!el)return;THEMES.forEach(function(x){el.classList.remove('sc-theme-'+x.id);});el.classList.add('sc-theme-'+th.id);});var vt=[document.documentElement];var root=document.getElementById('sc-root');if(root)vt.push(root);var rgb=hexToRgb(th.c);vt.forEach(function(el){try{el.style.setProperty('--sc-accent',th.c);el.style.setProperty('--sc-accent-rgb',rgb);}catch(_){}});P.theme=th.id;save();}
  GM_addStyle(`
#sc-card{border-color:rgba(var(--sc-accent-rgb,0,220,1),.22)!important;box-shadow:0 0 0 1px rgba(var(--sc-accent-rgb,0,220,1),.10),0 0 24px rgba(var(--sc-accent-rgb,0,220,1),.14),0 32px 80px rgba(0,0,0,.95)!important;}
#sc-dot.live{background:var(--sc-accent)!important;box-shadow:0 0 12px rgba(var(--sc-accent-rgb,0,220,1),.9),0 0 0 3px rgba(var(--sc-accent-rgb,0,220,1),.18)!important;}
#sc-uname{color:var(--sc-accent)!important;text-shadow:0 0 8px rgba(var(--sc-accent-rgb,0,220,1),.55);}
#sc-badge.live{color:var(--sc-accent)!important;border-color:rgba(var(--sc-accent-rgb,0,220,1),.4)!important;background:rgba(var(--sc-accent-rgb,0,220,1),.12)!important;box-shadow:0 0 12px rgba(var(--sc-accent-rgb,0,220,1),.3);}
#sc-chip.active{color:var(--sc-accent)!important;border-color:rgba(var(--sc-accent-rgb,0,220,1),.3)!important;background:rgba(var(--sc-accent-rgb,0,220,1),.12)!important;}
#sc-settings-btn svg{fill:var(--sc-accent)!important;opacity:.75;}
.sc-pip.rdy{background:linear-gradient(90deg,var(--sc-accent),#ffffff)!important;box-shadow:0 0 10px rgba(var(--sc-accent-rgb,0,220,1),.7)!important;}
#scx-tabs .scx-tab.on{color:var(--sc-accent)!important;box-shadow:inset 0 -2px 0 var(--sc-accent);text-shadow:0 0 8px rgba(var(--sc-accent-rgb,0,220,1),.6);}
#scx-tabs .scx-tab .scx-badge-n{background:rgba(var(--sc-accent-rgb,0,220,1),.16);color:var(--sc-accent);}
.scx-fi{border-color:rgba(var(--sc-accent-rgb,0,220,1),.22)!important;background:linear-gradient(100deg,rgba(var(--sc-accent-rgb,0,220,1),.12),rgba(var(--sc-accent-rgb,0,220,1),.02))!important;box-shadow:0 0 16px rgba(var(--sc-accent-rgb,0,220,1),.10);}
.scx-fi-amt{color:var(--sc-accent)!important;text-shadow:0 0 10px rgba(var(--sc-accent-rgb,0,220,1),.5);}
.scx-life-n{color:var(--sc-accent)!important;text-shadow:0 0 10px rgba(var(--sc-accent-rgb,0,220,1),.5);}
.scx-bg.got{border-color:rgba(var(--sc-accent-rgb,0,220,1),.35)!important;background:linear-gradient(120deg,rgba(var(--sc-accent-rgb,0,220,1),.12),rgba(255,255,255,.02))!important;box-shadow:0 0 14px rgba(var(--sc-accent-rgb,0,220,1),.12);}
.scx-share,.scx-mini-btn{border-color:rgba(var(--sc-accent-rgb,0,220,1),.4)!important;background:rgba(var(--sc-accent-rgb,0,220,1),.10)!important;color:var(--sc-accent)!important;box-shadow:0 0 12px rgba(var(--sc-accent-rgb,0,220,1),.15);}
.scx-share:hover,.scx-mini-btn:hover{background:rgba(var(--sc-accent-rgb,0,220,1),.2)!important;box-shadow:0 0 20px rgba(var(--sc-accent-rgb,0,220,1),.3);}
.scx-sw.on{border-color:#fff!important;box-shadow:0 0 0 2px rgba(var(--sc-accent-rgb,0,220,1),.5),0 0 12px rgba(var(--sc-accent-rgb,0,220,1),.4);}
#scx-drop.live{color:var(--sc-accent)!important;background:rgba(var(--sc-accent-rgb,0,220,1),.08)!important;}
#scx-drop.live .scx-drop-dot{background:var(--sc-accent)!important;box-shadow:0 0 8px rgba(var(--sc-accent-rgb,0,220,1),.8);}
#scx-resize::after{border-color:var(--sc-accent)!important;}
#scx-toast{border-color:rgba(var(--sc-accent-rgb,0,220,1),.4)!important;box-shadow:0 0 24px rgba(var(--sc-accent-rgb,0,220,1),.25),0 20px 50px rgba(0,0,0,.6)!important;}
`);

  var BADGES=[
    {id:'first',ic:'🎯',name:'First Blood',desc:'Land your first claim',test:function(l){return l.claims>=1;}},
    {id:'ten',ic:'🔥',name:'Warmed Up',desc:'10 claims',test:function(l){return l.claims>=10;}},
    {id:'fifty',ic:'💪',name:'Grinder',desc:'50 claims',test:function(l){return l.claims>=50;}},
    {id:'hundred',ic:'💯',name:'Century',desc:'100 claims',test:function(l){return l.claims>=100;}},
    {id:'five',ic:'🚀',name:'Machine',desc:'500 claims',test:function(l){return l.claims>=500;}},
    {id:'grand',ic:'👑',name:'Legend',desc:'1000 claims',test:function(l){return l.claims>=1000;}},
    {id:'speed',ic:'⚡',name:'Speed Demon',desc:'Claim under 1s',test:function(l){return l.bestMs>0&&l.bestMs<1000;}},
    {id:'light',ic:'🌩️',name:'Lightning',desc:'Claim under 500ms',test:function(l){return l.bestMs>0&&l.bestMs<500;}},
    {id:'owl',ic:'🦉',name:'Night Owl',desc:'Claim 12–5 AM',test:function(l){return !!l.owl;}},
    {id:'bird',ic:'🐦',name:'Early Bird',desc:'Claim 5–8 AM',test:function(l){return !!l.bird;}},
    {id:'roller',ic:'🎰',name:'High Roller',desc:'One claim worth 5+',test:function(l){return l.bestValue>=5;}},
    {id:'whale',ic:'🐋',name:'Whale',desc:'One claim worth 25+',test:function(l){return l.bestValue>=25;}},
    {id:'s3',ic:'📅',name:'Regular',desc:'3-day streak',test:function(l){return l.bestStreak>=3;}},
    {id:'s7',ic:'🗓️',name:'On Fire',desc:'7-day streak',test:function(l){return l.bestStreak>=7;}},
    {id:'s30',ic:'💎',name:'Diehard',desc:'30-day streak',test:function(l){return l.bestStreak>=30;}}
  ];

  function toast(msg,ic){var el=document.getElementById('scx-toast');if(!el){el=document.createElement('div');el.id='scx-toast';document.body.appendChild(el);}el.innerHTML='<span class="scx-toast-ic">'+(ic||'✓')+'</span>'+msg;el.classList.add('show');clearTimeout(el._t);el._t=setTimeout(function(){el.classList.remove('show');},2600);}
  function todayStr(){var d=new Date();return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate();}
  function parseAmt(a){var n=parseFloat(String(a==null?'':a).replace(/[^0-9.]/g,''));return isNaN(n)?0:n;}

  var _counted={};
  function onClaimSuccess(code,opts){
    if(code){if(_counted[code])return;_counted[code]=1;}
    var l=P.life;l.claims++;
    var amt=parseAmt(opts&&opts.amount);if(amt>0){l.value+=amt;if(amt>l.bestValue)l.bestValue=amt;}
    var ms=opts&&opts.ms?parseInt(String(opts.ms).replace(/[^0-9]/g,''),10):0;
    if(ms>0&&(l.bestMs===0||ms<l.bestMs))l.bestMs=ms;
    var h=new Date().getHours();
    if(h>=0&&h<5)l.owl=true; if(h>=5&&h<8)l.bird=true;
    var td=todayStr();
    if(l.lastDay!==td){var y=new Date();y.setDate(y.getDate()-1);var yStr=y.getFullYear()+'-'+(y.getMonth()+1)+'-'+y.getDate();if(l.lastDay===yStr)l.streak=(l.streak||0)+1;else l.streak=1;l.lastDay=td;if(l.streak>l.bestStreak)l.bestStreak=l.streak;}
    checkBadges();save();renderBadges();addFeed(code,opts);popCoins();
  }
  function checkBadges(){BADGES.forEach(function(b){if(!P.badges[b.id]&&b.test(P.life)){P.badges[b.id]=Date.now();toast(t('unlocked')+': '+b.name+' '+b.ic,'🏆');}});}

  function addFeed(code,opts){
    var box=document.getElementById('scx-feed');if(!box)return;
    var empty=box.querySelector('.scx-empty');if(empty)empty.remove();
    var amt=opts&&opts.amount!=null?('+'+opts.amount+(opts.currency?String(opts.currency).toUpperCase():'')):'CLAIMED';
    var it=document.createElement('div');it.className='scx-fi';
    var tm=new Date().toLocaleTimeString('en-US',{hour12:false});
    it.innerHTML='<span class="scx-fi-ic">💰</span><div class="scx-fi-main"><span class="scx-fi-code">'+(code||'code')+'</span><span class="scx-fi-amt">'+amt+'</span></div><span class="scx-fi-t">'+tm+'</span>';
    box.insertBefore(it,box.firstChild);
    while(box.children.length>30)box.removeChild(box.lastChild);
    var tb=document.querySelector('.scx-tab[data-tab="feed"] .scx-badge-n');if(tb){var n=(parseInt(tb.textContent,10)||0)+1;tb.textContent=n>99?'99+':String(n);}
  }
  function popCoins(){
    var host=document.getElementById('sc-card');if(!host)return;
    for(var i=0;i<5;i++){(function(i){setTimeout(function(){var c=document.createElement('div');c.className='scx-coin';c.textContent=(i%2?'🪙':'✨');c.style.left=(38+Math.random()*40)+'%';c.style.top='120px';host.appendChild(c);setTimeout(function(){if(c&&c.remove)c.remove();},980);},i*70);})(i);}
  }

  function onMissed(code,reason){
    if(!code)return;
    P.missed=P.missed.filter(function(m){return m.code!==code;});
    P.missed.unshift({code:code,reason:reason||'failed',t:Date.now()});
    if(P.missed.length>50)P.missed.length=50;save();renderMissed();
    var tb=document.querySelector('.scx-tab[data-tab="missed"] .scx-badge-n');if(tb)tb.textContent=P.missed.length>99?'99+':String(P.missed.length);
  }
  function clearMissed(code){var before=P.missed.length;P.missed=P.missed.filter(function(m){return m.code!==code;});if(P.missed.length!==before){save();var tb=document.querySelector('.scx-tab[data-tab="missed"] .scx-badge-n');if(tb)tb.textContent=P.missed.length?String(P.missed.length):'';renderMissed();}}

  function renderBadges(){
    var box=document.getElementById('scx-badges');if(!box)return;
    var l=P.life;var vv=l.value>=1000?(l.value/1000).toFixed(1)+'k':l.value.toFixed(2);
    var life='<div class="scx-life"><div class="scx-life-c"><div class="scx-life-n">'+l.claims+'</div><div class="scx-life-l">'+t('claims')+'</div></div><div class="scx-life-c"><div class="scx-life-n">'+vv+'</div><div class="scx-life-l">'+t('value')+'</div></div><div class="scx-life-c"><div class="scx-life-n">'+(l.bestStreak||0)+'</div><div class="scx-life-l">'+t('streak')+'</div></div><div class="scx-life-c"><div class="scx-life-n">'+(l.bestMs?l.bestMs+'ms':'—')+'</div><div class="scx-life-l">'+t('fastest')+'</div></div></div>';
    var grid=BADGES.map(function(b){var got=!!P.badges[b.id];return '<div class="scx-bg'+(got?' got':'')+'" title="'+b.desc+'"><span class="scx-bg-ic">'+b.ic+'</span><span class="scx-bg-tx"><span class="scx-bg-name">'+b.name+'</span><span class="scx-bg-desc">'+b.desc+'</span></span></div>';}).join('');
    box.innerHTML=life+'<div class="scx-badge-grid">'+grid+'</div><button class="scx-share" id="scx-share-btn">📸 '+t('share')+'</button>';
    var sb=document.getElementById('scx-share-btn');if(sb)sb.onclick=shareCard;
  }
  function renderMissed(){
    var box=document.getElementById('scx-missed');if(!box)return;
    if(!P.missed.length){box.innerHTML='<div class="scx-empty">'+t('noMissed')+'</div>';return;}
    box.innerHTML=P.missed.map(function(m){var tm=new Date(m.t).toLocaleTimeString('en-US',{hour12:false});return '<div class="scx-mi"><span class="scx-mi-code">'+m.code+'</span><span class="scx-mi-r">'+m.reason+'</span><span class="scx-mi-t">'+tm+'</span></div>';}).join('');
  }
  function renderFeedEmpty(){var box=document.getElementById('scx-feed');if(box&&!box.children.length)box.innerHTML='<div class="scx-empty">'+t('noFeed')+'</div>';}

  function shareCard(){
    try{
      var l=P.life,th=(THEMES.filter(function(x){return x.id===P.theme;})[0]||THEMES[0]);
      var W=1000,H=1000,cv=document.createElement('canvas');cv.width=W;cv.height=H;var x=cv.getContext('2d');
      var g=x.createLinearGradient(0,0,W,H);g.addColorStop(0,'#0a0a0f');g.addColorStop(1,'#12121b');x.fillStyle=g;x.fillRect(0,0,W,H);
      x.strokeStyle=th.c;x.lineWidth=8;x.strokeRect(28,28,W-56,H-56);
      x.textAlign='center';
      x.fillStyle=th.c;x.font='700 46px Arial, sans-serif';x.fillText('SURYA CLAIMER',W/2,140);
      x.fillStyle='#e8e8f0';x.font='700 30px monospace';x.fillText('@'+uname(),W/2,200);
      x.fillStyle=th.c;x.font='700 210px monospace';x.fillText(String(l.claims),W/2,470);
      x.fillStyle='#8a8a98';x.font='700 34px Arial, sans-serif';x.fillText('CODES CLAIMED',W/2,530);
      function stat(lbl,val,cx){x.fillStyle='#f5c540';x.font='700 50px monospace';x.fillText(val,cx,700);x.fillStyle='#6a6a78';x.font='700 22px Arial, sans-serif';x.fillText(lbl,cx,740);}
      stat('VALUE',(l.value>=1000?(l.value/1000).toFixed(1)+'k':l.value.toFixed(1)),W*0.25);
      stat('BEST STREAK',(l.bestStreak||0)+'d',W*0.5);
      stat('FASTEST',(l.bestMs?l.bestMs+'ms':'—'),W*0.75);
      var got=BADGES.filter(function(b){return P.badges[b.id];});
      x.font='58px serif';x.fillText(got.slice(-6).map(function(b){return b.ic;}).join('   ')||'—',W/2,860);
      x.fillStyle='#3a3a48';x.font='600 22px Arial, sans-serif';x.fillText('claimer.mvpsensi.in   ·   '+new Date().toLocaleDateString(),W/2,940);
      var a=document.createElement('a');a.href=cv.toDataURL('image/png');a.download='surya-stats-'+uname()+'.png';document.body.appendChild(a);a.click();a.remove();
      toast('Stat card downloaded','📸');
    }catch(e){toast('Could not build card','⚠');}
  }

  function nextSat6(){var now=new Date();var d=new Date(now);var add=(6-now.getDay()+7)%7;d.setDate(now.getDate()+add);d.setHours(18,0,0,0);if(d.getTime()<=now.getTime())d.setDate(d.getDate()+7);return d;}
  function inWindow(){var n=new Date();return n.getDay()===6&&n.getHours()>=18&&n.getHours()<21;}
  function fmtLeft(ms){var s=Math.floor(ms/1000);var d=Math.floor(s/86400);s-=d*86400;var h=Math.floor(s/3600);s-=h*3600;var m=Math.floor(s/60);if(d>0)return d+'d '+h+'h';if(h>0)return h+'h '+m+'m';return m+'m';}
  function renderDrop(){var el=document.getElementById('scx-drop');if(!el)return;if(inWindow()){el.className='live';el.innerHTML='<span class="scx-drop-dot"></span>🔥 '+t('dropLive');}else{var nd=nextSat6();el.className='';el.innerHTML='<span class="scx-drop-dot"></span>'+t('nextDrop')+': <b>Sat 6 PM</b> · '+fmtLeft(nd.getTime()-Date.now());}}

  function tabEl(id,label){return '<div class="scx-tab" data-tab="'+id+'">'+label+'<span class="scx-badge-n"></span></div>';}
  function augment(){
    var body=document.getElementById('sc-body');var log=document.getElementById('sc-log');var card=document.getElementById('sc-card');
    if(!body||!log||!card)return;
    applyTheme(P.theme);
    if(document.getElementById('scx-tabs'))return;
    var drop=document.createElement('div');drop.id='scx-drop';body.insertBefore(drop,body.firstChild);
    var tabs=document.createElement('div');tabs.id='scx-tabs';tabs.innerHTML=tabEl('log',t('activity'))+tabEl('feed',t('feed'))+tabEl('badges',t('badges'))+tabEl('missed',t('missed'));
    log.parentNode.insertBefore(tabs,log);
    var feed=document.createElement('div');feed.id='scx-feed';
    var badges=document.createElement('div');badges.id='scx-badges';
    var missed=document.createElement('div');missed.id='scx-missed';
    log.parentNode.insertBefore(feed,log.nextSibling);
    log.parentNode.insertBefore(badges,feed.nextSibling);
    log.parentNode.insertBefore(missed,badges.nextSibling);
    tabs.querySelector('.scx-tab[data-tab="log"]').classList.add('on');
    tabs.querySelectorAll('.scx-tab').forEach(function(tb){tb.addEventListener('click',function(){tabs.querySelectorAll('.scx-tab').forEach(function(o){o.classList.remove('on');});tb.classList.add('on');var id=tb.getAttribute('data-tab');log.style.display=id==='log'?'':'none';feed.style.display=id==='feed'?'block':'none';badges.style.display=id==='badges'?'block':'none';missed.style.display=id==='missed'?'block':'none';if(id==='badges')renderBadges();if(id==='missed')renderMissed();if(id==='feed')renderFeedEmpty();});});
    var rz=document.createElement('div');rz.id='scx-resize';card.appendChild(rz);
    var rzOn=false,rw=0,rsx=0;
    rz.addEventListener('mousedown',function(e){var r=document.getElementById('sc-root');rzOn=true;rw=r.offsetWidth;rsx=e.clientX;e.preventDefault();e.stopPropagation();});
    document.addEventListener('mousemove',function(e){if(!rzOn)return;var r=document.getElementById('sc-root');var w=Math.max(300,Math.min(560,rw+(e.clientX-rsx)));r.style.width=w+'px';});
    document.addEventListener('mouseup',function(){if(rzOn){rzOn=false;var r=document.getElementById('sc-root');P.geo.width=r.offsetWidth;save();}});
    renderFeedEmpty();renderBadges();renderMissed();renderDrop();
    if(P.missed.length){var mb=document.querySelector('.scx-tab[data-tab="missed"] .scx-badge-n');if(mb)mb.textContent=String(P.missed.length);}
    setInterval(renderDrop,30000);
    injectSettings();
    restoreGeo();
  }
  function restoreGeo(){var r=document.getElementById('sc-root');if(!r)return;if(P.geo.width)r.style.width=P.geo.width+'px';if(P.geo.left!=null&&P.geo.top!=null){r.style.left=P.geo.left+'px';r.style.top=P.geo.top+'px';r.style.right='auto';}}
  document.addEventListener('mouseup',function(){var r=document.getElementById('sc-root');if(!r||!document.getElementById('scx-tabs'))return;var s=r.style;if(s.left){var lft=parseInt(s.left,10),tp=parseInt(s.top,10);if(!isNaN(lft)&&!isNaN(tp)){P.geo.left=lft;P.geo.top=tp;save();}}});

  function injectSettings(){
    var sbody=document.querySelector('#sc-settings-modal .sc-sp-body');if(!sbody||document.getElementById('scx-settings'))return;
    var wrap=document.createElement('div');wrap.id='scx-settings';
    var sw=THEMES.map(function(th){return '<div class="scx-sw'+(P.theme===th.id?' on':'')+'" data-t="'+th.id+'" title="'+th.name+'" style="background:'+th.c+'"></div>';}).join('');
    var LANGS=[['en','English'],['hi','हिन्दी'],['es','Español'],['pt','Português'],['fr','Français'],['de','Deutsch'],['ru','Русский'],['tr','Türkçe'],['id','Indonesia'],['vi','Tiếng Việt'],['ar','العربية'],['zh','中文'],['ja','日本語']];
    var opts=LANGS.map(function(l){return '<option value="'+l[0]+'"'+(P.lang===l[0]?' selected':'')+'>'+l[1]+'</option>';}).join('');
    wrap.innerHTML='<div class="sc-section"><div class="sc-section-title">'+t('appearance')+'</div><div class="scx-swatches">'+sw+'</div></div><div class="sc-section"><div class="sc-section-title">'+t('language')+'</div><select class="sc-select" id="scx-lang">'+opts+'</select></div>';
    sbody.insertBefore(wrap,sbody.firstChild);
    wrap.querySelectorAll('.scx-sw').forEach(function(sel){sel.addEventListener('click',function(){applyTheme(sel.getAttribute('data-t'));wrap.querySelectorAll('.scx-sw').forEach(function(o){o.classList.remove('on');});sel.classList.add('on');});});
    document.getElementById('scx-lang').addEventListener('change',function(e){P.lang=e.target.value;save();relabel();toast(t('saved'),'✓');});
  }
  function relabel(){var map={log:'activity',feed:'feed',badges:'badges',missed:'missed'};document.querySelectorAll('#scx-tabs .scx-tab').forEach(function(tb){var id=tb.getAttribute('data-tab');if(tb.childNodes[0])tb.childNodes[0].nodeValue=t(map[id]);});function setTxt(sel,key){var e=document.querySelector(sel);if(e)e.textContent=t(key);}setTxt('#sc-user-lbl','userLbl');setTxt('#sc-tok-lbl','tokens');setTxt('#sc-exp-lbl','access');var st=document.querySelectorAll('#sc-stats .sc-stat-l');if(st[0])st[0].textContent=t('claimed');if(st[1])st[1].textContent=t('failed');if(st[2])st[2].textContent=t('total');var secs=document.querySelectorAll('#scx-settings .sc-section-title');if(secs[0])secs[0].textContent=t('appearance');if(secs[1])secs[1].textContent=t('language');var r=document.getElementById('sc-root');if(r)r.style.direction=(P.lang==='ar'?'rtl':'ltr');try{renderBadges();}catch(_){}try{renderMissed();}catch(_){}try{renderDrop();}catch(_){}try{renderFeedEmpty();}catch(_){}}

  if(typeof logCode==='function'){var _origLC=logCode;logCode=function(code,stage,opts){_origLC.apply(this,arguments);try{if(stage==='ok'||stage==='soft'){clearMissed(code);onClaimSuccess(code,opts||{});}else if(stage==='err'){onMissed(code,(opts&&opts.detail?String(opts.detail).slice(0,42):'failed'));}}catch(_){}};}
  if(typeof updateTokenUI==='function'){var _origTU=updateTokenUI;updateTokenUI=function(){_origTU.apply(this,arguments);try{var pips=document.getElementById('sc-pips');if(pips&&typeof tsManager!=='undefined'&&tsManager){var max=tsManager.maxCacheSize||CFG.TOKEN_SLOTS;var len=tsManager.tokenCache?tsManager.tokenCache.length:0;if(len>0&&len>=max)pips.classList.add('scx-full');else pips.classList.remove('scx-full');}}catch(_){}};}

  applyTheme(P.theme);
  (function unameRecovery(){var done=false;var tries=0;var iv=setInterval(function(){if(done)return;tries++;var el=document.getElementById('sc-uname');if(el){var txt=(el.textContent||'').trim();if(txt&&txt.length>1&&!/detect|—/i.test(txt)&&!el.classList.contains('wait')&&!el.classList.contains('err')){done=true;clearInterval(iv);return;}}try{if(typeof detectUsername==='function'){Promise.resolve(detectUsername()).then(function(n){if(n&&!done){done=true;clearInterval(iv);var e=document.getElementById('sc-uname');if(e){e.textContent=n;e.classList.remove('wait','err');}try{if(typeof checkAuth==='function')checkAuth(n);}catch(_){}}}).catch(function(){});}}catch(_){}if(tries>150){done=true;clearInterval(iv);}},4000);})();
  var _try=setInterval(function(){if(document.getElementById('sc-body')&&document.getElementById('sc-log')){augment();}if(document.getElementById('scx-tabs')){clearInterval(_try);relabel();var s2=setInterval(function(){if(document.querySelector('#sc-settings-modal .sc-sp-body')){injectSettings();relabel();clearInterval(s2);}},500);setTimeout(function(){clearInterval(s2);},20000);}},400);
  setTimeout(function(){clearInterval(_try);},60000);
})();

})();
