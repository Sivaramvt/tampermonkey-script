// ==UserScript==
// @name         ChatGPT: Questions TOC (Docked)
// @namespace    sivaram.tools
// @version      1.6.0
// @description  Docked right drawer listing your questions with fast filtering and reliable jump.
// @match        https://chatgpt.com/*
// @match        https://www.chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    drawerWidth: 340,
    drawerMinWidth: 230,
    maxItemChars: 110,
    highlightMs: 900,
    refreshDebounceMs: 400,
    scanIntervalMsFallback: 8000,
    selectors: {
      topUserTurn: [
        'article[data-message-author-role="user"]',
        'div[data-message-author-role="user"]',
        '[data-testid="conversation-turn-User"]'
      ].join(','),
      userTextCandidates: [
        '[data-message-author-role="user"] .markdown',
        '[data-message-author-role="user"] .prose',
        '[data-message-author-role="user"]',
        '.whitespace-pre-wrap',
        '.break-words',
        'p, li'
      ].join(','),
      appRoot: 'main, #__next, #root, body'
    }
  };

  let userInteracting = false;
  let filterText = '';     // persists across hydrates
  let hydrateTimer = null;

  // ---------- utils ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c != null) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return node;
  };
  const textFromNode = node => {
    if (!node) return '';
    const cloned = node.cloneNode(true);
    cloned.querySelectorAll('pre, code, nav, button, svg, style, script').forEach(n => n.remove());
    return (cloned.innerText || cloned.textContent || '').replace(/\s+/g, ' ').trim();
  };
  const shorten = (s, m) => s.length <= m ? s : s.slice(0, m - 1).trimEnd() + '…';
  const isVisible = n => { const r = n?.getBoundingClientRect?.(); return !!r && r.width > 0 && r.height > 0; };

  function getScrollContainer(fromEl) {
    let n = fromEl?.parentElement || document.querySelector('main') || document.body;
    const html = document.documentElement;
    const isScrollable = el => {
      const cs = getComputedStyle(el);
      const oy = cs.overflowY;
      return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight;
    };
    while (n && n !== html) {
      if (isScrollable(n)) return n;
      n = n.parentElement;
    }
    return document.querySelector('main') || document.scrollingElement || document.body;
  }

  function smoothScrollTo(target) {
    const container = getScrollContainer(target);
    const cRect = container.getBoundingClientRect();
    const tRect = target.getBoundingClientRect();
    const current = container.scrollTop;
    const delta = (tRect.top - cRect.top) - container.clientHeight * 0.35; // center-ish
    const dest = current + delta;
    try { container.scrollTo({ top: dest, behavior: 'smooth' }); }
    catch { container.scrollTop = dest; }
  }

  async function focusScrollTo(id) {
    const target = document.getElementById(id);
    if (!target) return;

    userInteracting = true; // pause hydrates during jump
    smoothScrollTo(target);

    // after motion ends, re-check and adjust once more (handles virtualization/layout shifts)
    setTimeout(() => {
      const t2 = document.getElementById(id);
      if (!t2) { userInteracting = false; return; }
      const container = getScrollContainer(t2);
      const cRect = container.getBoundingClientRect();
      const tRect = t2.getBoundingClientRect();
      const nearCenter = Math.abs((tRect.top - cRect.top) - container.clientHeight * 0.5) < 24;
      if (!nearCenter) smoothScrollTo(t2);
      userInteracting = false;
    }, 450);

    target.classList.add('cgptq__flash');
    await sleep(CONFIG.highlightMs);
    target.classList.remove('cgptq__flash');
  }

  // ---------- UI (docked drawer) ----------
  function injectStyles() {
    if (document.getElementById('cgptq__styles')) return;
    const css = `
      :root { --cgptq-width:${CONFIG.drawerWidth}px; }
      .cgptq__drawer {
        position: fixed; top: 0; right: 0; height: 100vh;
        width: var(--cgptq-width);
        z-index: 999999;
        background: rgba(255,255,255,.98);
        border-left: 1px solid rgba(0,0,0,.1);
        box-shadow: -8px 0 24px rgba(0,0,0,.12);
        display: flex; flex-direction: column;
        transform: translateX(0);
        transition: transform .25s ease, width .15s ease;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial;
        color:#111827;
      }
      .cgptq__dark .cgptq__drawer { background: rgba(17,24,39,.96); color:#e5e7eb; border-color: rgba(255,255,255,.08); }
      .cgptq__drawer--closed { transform: translateX( calc(100%) ); } /* leave a tab */
      .cgptq__tab {
        position: absolute; left: -34px; top: 40%;
        width: 34px; height: 100px; border-radius: 8px 0 0 8px;
        background: rgba(0,0,0,.1); display:flex; align-items:center; justify-content:center;
        cursor: pointer; user-select:none; font-size:12px; writing-mode: vertical-rl; text-orientation: mixed;
      }
      .cgptq__dark .cgptq__tab { background: rgba(255,255,255,.14); color:#e5e7eb; }
      .cgptq__header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(0,0,0,.08)}
      .cgptq__dark .cgptq__header{border-bottom-color:rgba(255,255,255,.08)}
      .cgptq__title{font-weight:700;font-size:14px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cgptq__count{font-size:11px;opacity:.7;margin-left:8px}
      .cgptq__btn{border:1px solid rgba(0,0,0,.08);background:transparent;padding:6px 8px;border-radius:10px;cursor:pointer;font-size:12px}
      .cgptq__dark .cgptq__btn{border-color:rgba(255,255,255,.14);color:#e5e7eb}
      .cgptq__btn:hover{background:rgba(0,0,0,.05)} .cgptq__dark .cgptq__btn:hover{background:rgba(255,255,255,.06)}
      .cgptq__searchRow{display:flex; gap:6px; padding:8px 10px 0 10px;}
      .cgptq__search{flex:1; box-sizing:border-box;border:1px solid rgba(0,0,0,.08);background:transparent;border-radius:10px;padding:6px 10px;font-size:12px;outline:none}
      .cgptq__dark .cgptq__search{border-color:rgba(255,255,255,.14);color:#e5e7eb}
      .cgptq__list{flex:1;overflow:auto;padding:8px 6px 10px 6px}
      .cgptq__item{border:1px solid transparent;border-radius:12px;padding:8px 10px;margin:6px 4px;cursor:pointer;font-size:12px;line-height:1.4;user-select:none}
      .cgptq__item:hover{background:rgba(0,0,0,.06)} .cgptq__dark .cgptq__item:hover{background:rgba(255,255,255,.08)}
      .cgptq__flash{outline:3px solid #60a5fa!important;transition:outline .2s ease;border-radius:10px}
      .cgptq__mark{font-weight:700}
      /* Push the app over when open */
      body.cgptq__withDrawer:not(.cgptq__closed) main { margin-right: var(--cgptq-width); }
      @media (max-width: 1100px){ body.cgptq__withDrawer:not(.cgptq__closed) main { margin-right: 0; } }
    `;
    document.head.appendChild(el('style', { id: 'cgptq__styles' }, [css]));
  }

  function isDarkMode() {
    const root = document.documentElement;
    const darkClass = root.classList.contains('dark');
    if (darkClass) return true;
    const styles = window.getComputedStyle(root);
    const bg = styles.backgroundColor;
    const nums = bg && bg.match(/\d+/g);
    if (!nums || nums.length < 3) return false;
    const [r,g,b] = nums.slice(0,3).map(Number);
    return (r+g+b)/3 < 128;
  }

  function buildDrawer() {
    if (document.getElementById('cgptq__drawer')) return;

    document.body.classList.add('cgptq__withDrawer');

    const drawer = el('aside', { id: 'cgptq__drawer', class: 'cgptq__drawer' });
    const tab = el('div', { class: 'cgptq__tab', title: 'Questions' }, ['Questions']);

    const header = el('div', { class: 'cgptq__header' }, [
      el('div', { class: 'cgptq__title' }, ['Your Questions']),
      el('span', { id: 'cgptq__count', class: 'cgptq__count' }, ['0']),
      el('button', { class: 'cgptq__btn', id: 'cgptq__refresh' }, ['Refresh']),
    ]);

    const searchRow = el('div', { class: 'cgptq__searchRow' }, [
      el('input', { id: 'cgptq__search', class: 'cgptq__search', type: 'search', placeholder: 'Filter… (supports fuzzy)', autocomplete: 'off', value: filterText }),
      el('button', { class: 'cgptq__btn', id: 'cgptq__clear' }, ['Clear'])
    ]);

    const list = el('div', { id: 'cgptq__list', class: 'cgptq__list' });

    drawer.append(tab, header, searchRow, list);
    document.body.appendChild(drawer);

    const applyTheme = () => drawer.classList.toggle('cgptq__dark', isDarkMode());
    applyTheme();
    new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });

    // Toggle open/closed
    const setClosed = closed => {
      drawer.classList.toggle('cgptq__drawer--closed', closed);
      document.body.classList.toggle('cgptq__closed', closed);
      userInteracting = false;
      scheduleHydrate();
    };
    tab.addEventListener('click', () => setClosed(!drawer.classList.contains('cgptq__drawer--closed')));

    // Pause updates while interacting
    drawer.addEventListener('mouseenter', () => userInteracting = true);
    drawer.addEventListener('mouseleave', () => { userInteracting = false; scheduleHydrate(); });
    list.addEventListener('wheel', () => userInteracting = true, { passive: true });

    // Search filter
    let filterTimer = null;
    const searchEl = document.getElementById('cgptq__search');
    const applyFilter = () => {
      const q = (filterText || '').toLowerCase();
      document.querySelectorAll('.cgptq__item').forEach(item => {
        const full = (item.getAttribute('data-full') || '');
        const show = fuzzyMatch(full, q);
        item.style.display = show ? '' : 'none';
        // highlight
        item.innerHTML = show ? highlightText(shorten(item.getAttribute('data-label') || full, CONFIG.maxItemChars), q) : item.innerHTML;
      });
    };
    searchEl.addEventListener('input', () => {
      clearTimeout(filterTimer);
      filterText = searchEl.value;
      filterTimer = setTimeout(applyFilter, 120);
    });
    document.getElementById('cgptq__clear').addEventListener('click', () => {
      filterText = '';
      searchEl.value = '';
      applyFilter();
    });

    document.getElementById('cgptq__refresh').addEventListener('click', () => hydrateList(true));
  }

  // basic fuzzy: all chars of q must appear in order
  function fuzzyMatch(text, q) {
    if (!q) return true;
    text = text.toLowerCase();
    let i = 0;
    for (const ch of q) {
      i = text.indexOf(ch, i);
      if (i === -1) return false;
      i++;
    }
    return true;
  }
  function highlightText(text, q) {
    if (!q) return escapeHtml(text);
    // simple word-based highlight if q is a word; else return escaped
    const escQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      const rx = new RegExp(`(${escQ})`, 'ig');
      return escapeHtml(text).replace(rx, '<span class="cgptq__mark">$1</span>');
    } catch { return escapeHtml(text); }
  }
  function escapeHtml(s){ return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

  // ---------- extraction ----------
  function extractTextFromTurn(turnEl) {
    const candidates = turnEl.querySelectorAll(CONFIG.selectors.userTextCandidates);
    let best = '';
    for (const c of candidates) {
      const owner = c.closest?.('[data-message-author-role="user"], [data-testid="conversation-turn-User"]');
      if (!owner) continue;
      const t = textFromNode(c);
      if (t && t.length > best.length) best = t;
    }
    if (!best) best = textFromNode(turnEl);
    const first = best.split(/(?<=[.?!])\s+(?=[A-Z(“"'])/).slice(0, 2).join(' ').trim();
    return first || best;
  }

  function findUserTurns() {
    let turns = Array.from(document.querySelectorAll(CONFIG.selectors.topUserTurn)).filter(isVisible);
    // keep only the outermost container
    turns = turns.filter(n => n.closest('[data-message-author-role="user"], [data-testid="conversation-turn-User"]') === n);

    // dedupe by normalized text; keep the lower one on screen (newer)
    const map = new Map();
    for (const node of turns) {
      const txt = extractTextFromTurn(node);
      const norm = (txt || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!norm) continue;
      const prev = map.get(norm);
      if (!prev || node.getBoundingClientRect().top > prev.getBoundingClientRect().top) map.set(norm, node);
    }
    return Array.from(map.values());
  }

  // ---------- hydrate ----------
  function scheduleHydrate() {
    if (userInteracting) return;
    clearTimeout(hydrateTimer);
    hydrateTimer = setTimeout(hydrateList, CONFIG.refreshDebounceMs);
  }

  function hydrateList(force = false) {
    if (!force && userInteracting) return;

    injectStyles();
    buildDrawer();

    const drawer = document.getElementById('cgptq__drawer');
    if (!drawer) return;
    drawer.classList.toggle('cgptq__dark', isDarkMode());

    const list = document.getElementById('cgptq__list');
    list.innerHTML = '';

    const turns = findUserTurns();
    const items = [];
    let idx = 1;
    for (const [i, turn] of turns.entries()) {
      const full = extractTextFromTurn(turn);
      if (!full) continue;
      if (!turn.id) turn.id = 'cgpt-q-' + (i + 1);

      const label = `${idx}. ${full}`;
      const item = el('div', {
        class: 'cgptq__item',
        'data-id': turn.id,
        'data-full': full,
        'data-label': label,
        role: 'button',
        tabindex: '0'
      }, [shorten(label, CONFIG.maxItemChars)]);

      const go = e => { e.preventDefault(); e.stopPropagation(); focusScrollTo(turn.id); };
      item.addEventListener('click', go);
      item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') go(e); });

      list.appendChild(item);
      idx++;
    }

    const countEl = document.getElementById('cgptq__count');
    if (countEl) countEl.textContent = String(idx - 1);

    // apply existing filter and highlight
    const searchEl = document.getElementById('cgptq__search');
    if (searchEl) searchEl.value = filterText;
    document.querySelectorAll('.cgptq__item').forEach(item => {
      const full = item.getAttribute('data-full') || '';
      const label = item.getAttribute('data-label') || full;
      const show = fuzzyMatch(full, (filterText || '').toLowerCase());
      item.style.display = show ? '' : 'none';
      item.innerHTML = highlightText(shorten(label, CONFIG.maxItemChars), filterText.toLowerCase());
    });
  }

  function installObservers() {
    const root = document.querySelector(CONFIG.selectors.appRoot) || document.body;
    const obs = new MutationObserver(() => scheduleHydrate());
    obs.observe(root, { childList: true, subtree: true, attributes: true });

    const push = history.pushState;
    history.pushState = function () { const ret = push.apply(this, arguments); setTimeout(() => hydrateList(true), 150); return ret; };
    window.addEventListener('popstate', () => setTimeout(() => hydrateList(true), 150));

    // Pause updates during manual page scrolls; resume shortly after
    let scrollStopTimer = null;
    const pageScroller = getScrollContainer(document.querySelector('main') || document.body);
    pageScroller.addEventListener('scroll', () => {
      userInteracting = true;
      clearTimeout(scrollStopTimer);
      scrollStopTimer = setTimeout(() => { userInteracting = false; scheduleHydrate(); }, 600);
    }, { passive: true });

    setInterval(() => scheduleHydrate(), CONFIG.scanIntervalMsFallback);
  }

  // ---------- boot ----------
  const isThreadPage = () => /chatgpt\.com|chat\.openai\.com/.test(location.hostname);
  function boot() {
    if (!isThreadPage()) return;
    injectStyles();
    buildDrawer();
    hydrateList(true);
    installObservers();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
