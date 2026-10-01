(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const STORE_KEY = 'tabber.doc.v1';
  const PREF_KEY = 'tabber.prefs.v1';
  const MAX_CELL = 8;
  const JOIN_MS = 450;
  // Characters that can be typed into a cell.
  const ALLOWED = /^[0-9a-zA-Z/\\~()<>.*^=+]$/;
  // In advance mode these attach to the previous note instead of starting a new one…
  const JOIN_PREV = /^[hpbr/\\~svt)]$/;
  // …and these make the next digit attach too (5h → 5h7, ( → (5)).
  const EXPECT_NEXT = /^[hpbr/\\st(]$/;

  const TUNINGS = [
    { name: 'Standard', strings: ['e', 'B', 'G', 'D', 'A', 'E'] },
    { name: 'Drop D', strings: ['e', 'B', 'G', 'D', 'A', 'D'] },
    { name: 'Half step down', strings: ['eb', 'Bb', 'Gb', 'Db', 'Ab', 'Eb'] },
    { name: 'Drop C', strings: ['d', 'A', 'F', 'C', 'G', 'C'] },
    { name: 'Open G', strings: ['D', 'B', 'G', 'D', 'G', 'D'] },
    { name: 'Open D', strings: ['D', 'A', 'F#', 'D', 'A', 'D'] },
    { name: 'DADGAD', strings: ['D', 'A', 'G', 'D', 'A', 'D'] },
    { name: '7-string', strings: ['e', 'B', 'G', 'D', 'A', 'E', 'B'] },
    { name: 'Bass (4)', strings: ['G', 'D', 'A', 'E'] },
    { name: 'Bass (5)', strings: ['G', 'D', 'A', 'E', 'B'] },
    { name: 'Ukulele', strings: ['A', 'E', 'C', 'G'] },
  ];

  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
  };

  // ---------------------------------------------------------------- model

  const prefs = Object.assign({ advance: 0, cols: 32, page: 'letter' }, safeParse(storage.get(PREF_KEY)) || {});

  function safeParse(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
  function newCol(n) { return { bar: false, n: Array(n).fill('') }; }
  function newStaff(n, cols = prefs.cols) {
    return { label: '', cols: Array.from({ length: Math.max(1, cols) }, () => newCol(n)) };
  }
  function blankDoc() {
    const tuning = TUNINGS[0].strings.slice();
    return { version: 1, title: '', artist: '', info: '', tuning, staves: [newStaff(tuning.length)] };
  }

  // Validate / repair a doc loaded from storage or a file.
  function normalize(d) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.staves)) return null;
    const tuning = Array.isArray(d.tuning) && d.tuning.length
      ? d.tuning.map((t) => String(t).slice(0, 3) || '?')
      : TUNINGS[0].strings.slice();
    const n = tuning.length;
    const staves = d.staves.map((st) => {
      const cols = (Array.isArray(st && st.cols) ? st.cols : []).map((c) => {
        const notes = Array.isArray(c && c.n) ? c.n.map((v) => String(v || '').slice(0, MAX_CELL)) : [];
        return { bar: !!(c && c.bar), n: resizeNotes(notes, n) };
      });
      if (!cols.length) cols.push(newCol(n));
      return { label: String((st && st.label) || ''), cols };
    });
    if (!staves.length) staves.push(newStaff(n));
    return {
      version: 1,
      title: String(d.title || ''),
      artist: String(d.artist || ''),
      info: String(d.info || ''),
      tuning,
      staves,
    };
  }

  // Fewer strings: drop from the top. More strings: add low strings at the bottom.
  function resizeNotes(notes, n) {
    if (notes.length > n) return notes.slice(notes.length - n);
    return notes.concat(Array(n - notes.length).fill(''));
  }

  let doc = normalize(safeParse(storage.get(STORE_KEY))) || blankDoc();
  let cursor = { s: 0, c: 0, r: 0 };
  let anchor = null;      // selection anchor (same shape as cursor)
  let session = null;     // manual mode: cell currently being typed into
  let last = null;        // advance mode: last note typed { s, c, r, t, join, after }
  let clip = null;        // internal clipboard

  const nStrings = () => doc.tuning.length;
  const colsOf = (s) => doc.staves[s].cols.length;
  const getVal = (p) => doc.staves[p.s].cols[p.c].n[p.r];
  const samePos = (a, b) => a && b && a.s === b.s && a.c === b.c && a.r === b.r;

  function clampCursor() {
    cursor.s = Math.max(0, Math.min(cursor.s, doc.staves.length - 1));
    cursor.c = Math.max(0, Math.min(cursor.c, colsOf(cursor.s) - 1));
    cursor.r = Math.max(0, Math.min(cursor.r, nStrings() - 1));
  }

  // ---------------------------------------------------------------- undo

  const undoStack = [];
  const redoStack = [];
  const snapshot = () => JSON.stringify({ doc, cursor });

  function pushUndo(snap = snapshot()) {
    undoStack.push(snap);
    if (undoStack.length > 400) undoStack.shift();
    redoStack.length = 0;
  }
  function restore(json) {
    const o = JSON.parse(json);
    doc = o.doc;
    cursor = o.cursor;
    anchor = null; session = null; last = null;
    clampCursor();
    syncMeta();
    render();
    save();
  }
  function undo() { if (undoStack.length) { redoStack.push(snapshot()); restore(undoStack.pop()); } }
  function redo() { if (redoStack.length) { undoStack.push(snapshot()); restore(redoStack.pop()); } }

  // ---------------------------------------------------------------- persistence

  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => storage.set(STORE_KEY, JSON.stringify(doc)), 200);
    schedulePreview();
  }
  const savePrefs = () => storage.set(PREF_KEY, JSON.stringify(prefs));

  // ---------------------------------------------------------------- DOM

  const sheet = $('#sheet');
  const keysink = $('#keysink');
  let grids = [];

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function setCellContent(cell, v) {
    cell.textContent = '';
    if (v) cell.appendChild(el('span', '', v));
  }

  function render() {
    clampCursor();
    sheet.textContent = '';
    grids = [];
    painted = [];
    doc.staves.forEach((st, s) => sheet.appendChild(buildStaff(st, s)));
    paint(false);
    syncTuningSelect();
  }

  function buildStaff(st, s) {
    const wrap = el('section', 'staff');
    wrap.dataset.s = s;

    const head = el('div', 'staff-head');
    const label = el('input', 'staff-label');
    label.value = st.label;
    label.placeholder = 'Section label (e.g. Verse)';
    label.dataset.s = s;
    const actions = el('div', 'staff-actions');
    for (const [act, txt, title] of [
      ['more', '+8 cols', 'Add 8 columns to this staff'],
      ['dup', 'Duplicate', 'Duplicate this staff'],
      ['up', '↑', 'Move staff up'],
      ['down', '↓', 'Move staff down'],
      ['del', 'Delete', 'Delete this staff'],
    ]) {
      const b = el('button', '', txt);
      b.dataset.act = act;
      b.title = title;
      actions.appendChild(b);
    }
    head.append(label, actions);

    const n = nStrings();
    const grid = el('div', 'grid');
    grid.style.gridTemplateColumns = 'auto ' +
      st.cols.map((c) => (c.bar ? '14px' : 'minmax(24px, max-content)')).join(' ') + ' 2px';
    for (let r = 0; r < n; r++) {
      const edge = (r === 0 ? ' rf' : '') + (r === n - 1 ? ' rl' : '');
      const tun = el('div', 'tun' + edge, doc.tuning[r]);
      tun.dataset.r = r;
      tun.title = 'Click to rename string';
      grid.appendChild(tun);
      st.cols.forEach((col, c) => {
        const cell = el('div', 'cell' + edge + (col.bar ? ' bar' : ''));
        cell.dataset.s = s;
        cell.dataset.c = c;
        cell.dataset.r = r;
        if (!col.bar) setCellContent(cell, col.n[r]);
        grid.appendChild(cell);
      });
      grid.appendChild(el('div', 'end' + edge));
    }
    grids[s] = grid;
    const scroller = el('div', 'scroller');
    scroller.appendChild(grid);
    wrap.append(head, scroller);
    return wrap;
  }

  const cellEl = (s, c, r) => grids[s] && grids[s].children[r * (colsOf(s) + 2) + 1 + c];

  function updateCol(s, c) {
    const col = doc.staves[s].cols[c];
    for (let r = 0; r < nStrings(); r++) setCellContent(cellEl(s, c, r), col.bar ? '' : col.n[r]);
  }

  let painted = [];
  function paint(scroll = true) {
    for (const e of painted) e.classList.remove('cur', 'sel', 'colhl');
    painted = [];
    const mark = (e, cls) => { if (e) { e.classList.add(cls); painted.push(e); } };
    const rg = range();
    if (rg) {
      for (let c = rg.c0; c <= rg.c1; c++) for (let r = rg.r0; r <= rg.r1; r++) mark(cellEl(rg.s, c, r), 'sel');
    }
    for (let r = 0; r < nStrings(); r++) mark(cellEl(cursor.s, cursor.c, r), 'colhl');
    const cur = cellEl(cursor.s, cursor.c, cursor.r);
    mark(cur, 'cur');
    if (cur) {
      const rect = cur.getBoundingClientRect();
      keysink.style.left = (rect.left + window.scrollX) + 'px';
      keysink.style.top = (rect.top + window.scrollY) + 'px';
      if (scroll) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function focusSink() { keysink.focus({ preventScroll: true }); }

  // ---------------------------------------------------------------- selection

  function range() {
    if (!anchor || anchor.s !== cursor.s || samePos(anchor, cursor)) return null;
    return {
      s: cursor.s,
      c0: Math.min(anchor.c, cursor.c), c1: Math.max(anchor.c, cursor.c),
      r0: Math.min(anchor.r, cursor.r), r1: Math.max(anchor.r, cursor.r),
    };
  }
  function rangeOrCursor() {
    return range() || { s: cursor.s, c0: cursor.c, c1: cursor.c, r0: cursor.r, r1: cursor.r };
  }

  // ---------------------------------------------------------------- navigation

  function move(dc, dr, extend = false) {
    session = null;
    last = null;
    if (extend) {
      if (!anchor) anchor = { ...cursor };
      cursor.c = Math.max(0, Math.min(cursor.c + dc, colsOf(cursor.s) - 1));
      cursor.r = Math.max(0, Math.min(cursor.r + dr, nStrings() - 1));
      paint();
      return;
    }
    anchor = null;
    let { s, c, r } = cursor;
    c += dc;
    r += dr;
    let structural = false;
    while (c >= colsOf(s)) {
      c -= colsOf(s);
      if (s === doc.staves.length - 1) {
        doc.staves.push(newStaff(nStrings()));
        structural = true;
      }
      s++;
    }
    while (c < 0) {
      if (s === 0) { c = 0; break; }
      s--;
      c += colsOf(s);
    }
    if (r < 0) {
      if (s > 0) { s--; r = nStrings() - 1; c = Math.min(c, colsOf(s) - 1); } else r = 0;
    } else if (r >= nStrings()) {
      if (s < doc.staves.length - 1) { s++; r = 0; c = Math.min(c, colsOf(s) - 1); } else r = nStrings() - 1;
    }
    cursor = { s, c, r };
    if (structural) { render(); save(); }
    paint();
  }

  // ---------------------------------------------------------------- editing

  function setVal(p, v) {
    const col = doc.staves[p.s].cols[p.c];
    if (col.bar) {
      col.bar = false;
      col.n[p.r] = v;
      render();
    } else {
      col.n[p.r] = v;
      updateCol(p.s, p.c);
    }
    save();
  }

  function typeChar(ch) {
    const now = performance.now();
    const adv = prefs.advance;
    const isDigit = ch >= '0' && ch <= '9';
    anchor = null;

    if (adv > 0) {
      // Attach to the previous note? (two-digit frets, techniques like 5h7)
      if (last && samePos(cursor, last.after)) {
        const v = getVal(last);
        const join = v && (isDigit
          ? last.join || (now - last.t < JOIN_MS && /(^|\D)[12]$/.test(v))
          : JOIN_PREV.test(ch) && !last.join);
        if (join && v.length < MAX_CELL) {
          pushUndo();
          setVal(last, v + ch);
          last.t = now;
          last.join = EXPECT_NEXT.test(ch);
          paint();
          return;
        }
      }
      pushUndo();
      const at = { ...cursor };
      setVal(at, ch);
      move(adv, 0);
      while (doc.staves[cursor.s].cols[cursor.c].bar) move(1, 0); // hop over bar lines
      last ={ ...at, t: now, join: EXPECT_NEXT.test(ch), after: { ...cursor } };
      return;
    }

    // Manual mode: keep typing into the same cell until the cursor moves.
    pushUndo();
    const v = getVal(cursor);
    let nv = ch;
    if (samePos(session, cursor) && v) {
      nv = v + ch;
      const digitRun = /\d*$/.exec(nv)[0].length;
      if (digitRun > 2 || nv.length > MAX_CELL) nv = ch;
    }
    setVal(cursor, nv);
    session = { ...cursor };
    paint();
  }

  function clearRange(rg) {
    const st = doc.staves[rg.s];
    let structural = false;
    for (let c = rg.c0; c <= rg.c1; c++) {
      const col = st.cols[c];
      if (col.bar) { col.bar = false; structural = true; }
      for (let r = rg.r0; r <= rg.r1; r++) col.n[r] = '';
      if (!structural) updateCol(rg.s, c);
    }
    if (structural) render();
    save();
  }

  function backspace() {
    const rg = range();
    if (rg) { pushUndo(); clearRange(rg); anchor = null; paint(); return; }
    const col = doc.staves[cursor.s].cols[cursor.c];
    if (col.bar) { pushUndo(); clearRange(rangeOrCursor()); return; }
    const v = getVal(cursor);
    if (samePos(session, cursor) && v) {
      pushUndo();
      setVal(cursor, v.slice(0, -1));
      return;
    }
    if (last && samePos(cursor, last.after) && getVal(last)) {
      // Advance mode: delete the note just typed and step back onto it.
      pushUndo();
      const back = { s: last.s, c: last.c, r: last.r };
      setVal(back, '');
      cursor = back;
      last = null;
      session = null;
      paint();
      return;
    }
    if (v) {
      pushUndo();
      setVal(cursor, '');
      session = null;
      return;
    }
    move(-1, 0);
    if (getVal(cursor) || doc.staves[cursor.s].cols[cursor.c].bar) {
      pushUndo();
      clearRange(rangeOrCursor());
    }
  }

  function del() {
    pushUndo();
    clearRange(rangeOrCursor());
    session = null;
    paint();
  }

  function toggleBar() {
    pushUndo();
    const rg = rangeOrCursor();
    const st = doc.staves[rg.s];
    const on = !st.cols[cursor.c].bar;
    for (let c = rg.c0; c <= rg.c1; c++) {
      st.cols[c].bar = on;
      if (on) st.cols[c].n.fill('');
    }
    session = null; last = null;
    render();
    save();
  }

  function insertCol() {
    pushUndo();
    const rg = rangeOrCursor();
    const count = rg.c1 - rg.c0 + 1;
    const st = doc.staves[cursor.s];
    st.cols.splice(rg.c0, 0, ...Array.from({ length: count }, () => newCol(nStrings())));
    session = null; last = null;
    render();
    save();
  }

  function deleteCols() {
    pushUndo();
    const rg = rangeOrCursor();
    const st = doc.staves[rg.s];
    st.cols.splice(rg.c0, rg.c1 - rg.c0 + 1);
    if (!st.cols.length) st.cols.push(newCol(nStrings()));
    cursor.c = Math.min(rg.c0, st.cols.length - 1);
    anchor = null; session = null; last = null;
    render();
    save();
  }

  function addStaff(after = cursor.s) {
    pushUndo();
    doc.staves.splice(after + 1, 0, newStaff(nStrings()));
    cursor = { s: after + 1, c: 0, r: 0 };
    anchor = null; session = null; last = null;
    render();
    save();
    paint();
  }

  function selectAll() {
    anchor = { s: cursor.s, c: 0, r: 0 };
    cursor = { s: cursor.s, c: colsOf(cursor.s) - 1, r: nStrings() - 1 };
    paint(false);
  }

  function copy() {
    const rg = rangeOrCursor();
    const st = doc.staves[rg.s];
    clip = {
      full: rg.r0 === 0 && rg.r1 === nStrings() - 1,
      cols: st.cols.slice(rg.c0, rg.c1 + 1).map((c) => ({ bar: c.bar, n: c.n.slice(rg.r0, rg.r1 + 1) })),
    };
    // Also put plain-text tab on the system clipboard for other apps.
    const text = staffToLines({ cols: st.cols.slice(rg.c0, rg.c1 + 1).map((c) => ({ bar: c.bar, n: c.n.slice(rg.r0, rg.r1 + 1) })) },
      doc.tuning.slice(rg.r0, rg.r1 + 1)).join('\n');
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
  }

  function cut() {
    copy();
    del();
  }

  function paste() {
    if (!clip) return;
    pushUndo();
    const st = doc.staves[cursor.s];
    const r0 = clip.full ? 0 : cursor.r;
    clip.cols.forEach((src, i) => {
      const c = cursor.c + i;
      while (c >= st.cols.length) st.cols.push(newCol(nStrings()));
      const col = st.cols[c];
      if (src.bar && clip.full) { col.bar = true; col.n.fill(''); return; }
      if (src.bar) return;
      col.bar = false;
      src.n.forEach((v, j) => { if (r0 + j < nStrings()) col.n[r0 + j] = v; });
    });
    anchor = null; session = null; last = null;
    render();
    save();
  }

  // ---------------------------------------------------------------- keyboard

  function onKey(e) {
    const k = e.key;
    if (k === 'Unidentified' || k === 'Process' || e.isComposing) return; // let 'input' handle it
    const mod = e.metaKey || e.ctrlKey;
    if (mod) {
      switch (k.toLowerCase()) {
        case 'z': e.shiftKey ? redo() : undo(); break;
        case 'y': redo(); break;
        case 'c': copy(); break;
        case 'x': cut(); break;
        case 'v': paste(); break;
        case 'a': selectAll(); break;
        case 'i': insertCol(); break;
        case 'backspace': case 'delete': deleteCols(); break;
        case 'enter': addStaff(); break;
        case 'arrowleft': move(-colsOf(cursor.s), 0, e.shiftKey); break;
        case 'arrowright': move(colsOf(cursor.s), 0, e.shiftKey); break;
        default: return;
      }
      e.preventDefault();
      return;
    }
    if (e.altKey && k.length === 1) return;
    const step = Math.max(1, prefs.advance);
    switch (k) {
      case 'ArrowLeft': move(-1, 0, e.shiftKey); break;
      case 'ArrowRight': move(1, 0, e.shiftKey); break;
      case 'ArrowUp': move(0, -1, e.shiftKey); break;
      case 'ArrowDown': move(0, 1, e.shiftKey); break;
      case 'Home': move(-cursor.c, 0, e.shiftKey); break;
      case 'End': move(colsOf(cursor.s) - 1 - cursor.c, 0, e.shiftKey); break;
      case 'Tab': move(e.shiftKey ? -1 : 1, 0); break;
      case ' ': case 'Enter': move(e.shiftKey ? -step : step, 0); break;
      case 'Backspace': backspace(); break;
      case 'Delete': del(); break;
      case 'Insert': insertCol(); break;
      case 'Escape': anchor = null; session = null; last = null; paint(false); break;
      case '|': toggleBar(); break;
      default:
        if (k.length === 1 && ALLOWED.test(k)) typeChar(k);
        else return;
    }
    e.preventDefault();
  }

  keysink.addEventListener('keydown', onKey);
  // Fallback for mobile keyboards that don't report keys in keydown.
  keysink.addEventListener('input', () => {
    const v = keysink.value;
    keysink.value = '';
    for (const ch of v) {
      if (ch === '|') toggleBar();
      else if (ch === ' ') move(Math.max(1, prefs.advance), 0);
      else if (ALLOWED.test(ch)) typeChar(ch);
    }
  });
  keysink.addEventListener('focus', () => sheet.classList.add('editing'));
  keysink.addEventListener('blur', () => sheet.classList.remove('editing'));

  // Keys pressed while nothing is focused go to the editor.
  document.addEventListener('keydown', (e) => {
    if (e.target !== document.body) return;
    focusSink();
    onKey(e);
  });

  // ---------------------------------------------------------------- mouse

  let dragging = false;
  let dragFrom = null;
  const posOf = (cell) => ({ s: +cell.dataset.s, c: +cell.dataset.c, r: +cell.dataset.r });

  sheet.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const cell = e.target.closest('.cell');
    if (!cell) return;
    e.preventDefault();
    const p = posOf(cell);
    if (e.shiftKey && p.s === cursor.s) {
      if (!anchor) anchor = { ...cursor };
      dragFrom = anchor;
    } else {
      anchor = null;
      dragFrom = p;
    }
    cursor = p;
    session = null;
    last = null;
    dragging = true;
    paint(false);
    focusSink();
  });

  sheet.addEventListener('mouseover', (e) => {
    if (!dragging) return;
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const p = posOf(cell);
    if (p.s !== dragFrom.s || samePos(p, cursor)) return;
    anchor = { ...dragFrom };
    cursor = p;
    paint(false);
  });

  window.addEventListener('mouseup', () => { dragging = false; });

  sheet.addEventListener('click', (e) => {
    const tun = e.target.closest('.tun');
    if (tun) {
      const r = +tun.dataset.r;
      const name = prompt('String name', doc.tuning[r]);
      if (name && name.trim()) {
        pushUndo();
        doc.tuning[r] = name.trim().slice(0, 3);
        render();
        save();
      }
      focusSink();
      return;
    }
    const btn = e.target.closest('.staff-actions button');
    if (btn) {
      const s = +btn.closest('.staff').dataset.s;
      staffAction(btn.dataset.act, s);
    }
  });

  function staffAction(act, s) {
    pushUndo();
    const st = doc.staves[s];
    switch (act) {
      case 'more':
        for (let i = 0; i < 8; i++) st.cols.push(newCol(nStrings()));
        break;
      case 'dup':
        doc.staves.splice(s + 1, 0, JSON.parse(JSON.stringify(st)));
        cursor = { s: s + 1, c: 0, r: 0 };
        break;
      case 'up':
        if (s > 0) { doc.staves.splice(s - 1, 0, doc.staves.splice(s, 1)[0]); cursor.s = s - 1; }
        break;
      case 'down':
        if (s < doc.staves.length - 1) { doc.staves.splice(s + 1, 0, doc.staves.splice(s, 1)[0]); cursor.s = s + 1; }
        break;
      case 'del':
        if (doc.staves.length > 1) {
          doc.staves.splice(s, 1);
          if (cursor.s >= s && cursor.s > 0) cursor.s--;
        } else {
          doc.staves[0] = newStaff(nStrings());
        }
        break;
    }
    anchor = null; session = null; last = null;
    render();
    save();
    focusSink();
  }

  // Section labels: undo as one step per edit.
  let labelSnap = null;
  sheet.addEventListener('focusin', (e) => {
    if (e.target.classList.contains('staff-label')) labelSnap = snapshot();
  });
  sheet.addEventListener('input', (e) => {
    if (!e.target.classList.contains('staff-label')) return;
    doc.staves[+e.target.dataset.s].label = e.target.value;
    save();
  });
  sheet.addEventListener('change', (e) => {
    if (e.target.classList.contains('staff-label') && labelSnap) { pushUndo(labelSnap); labelSnap = null; }
  });
  sheet.addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('staff-label')) return;
    if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'ArrowDown') {
      e.preventDefault();
      const s = +e.target.dataset.s;
      e.target.blur();
      cursor = { s, c: 0, r: 0 };
      paint();
      focusSink();
    }
  });

  // ---------------------------------------------------------------- metadata

  const metaFields = ['title', 'artist', 'info'];
  function syncMeta() { for (const f of metaFields) $('#' + f).value = doc[f]; }
  for (const f of metaFields) {
    const input = $('#' + f);
    let snap = null;
    input.addEventListener('focus', () => { snap = snapshot(); });
    input.addEventListener('input', () => { doc[f] = input.value; save(); });
    input.addEventListener('change', () => { if (snap) { pushUndo(snap); snap = null; } });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      e.preventDefault();
      const next = metaFields[metaFields.indexOf(f) + 1];
      if (e.key === 'Enter' && next) $('#' + next).focus();
      else { input.blur(); paint(); focusSink(); }
    });
  }

  // ---------------------------------------------------------------- tuning

  const selTuning = $('#selTuning');
  TUNINGS.forEach((t, i) => selTuning.appendChild(new Option(`${t.name} (${t.strings.length})`, i)));
  selTuning.appendChild(new Option('Custom…', 'custom'));

  function syncTuningSelect() {
    const key = doc.tuning.join(' ');
    const i = TUNINGS.findIndex((t) => t.strings.join(' ') === key);
    selTuning.value = i >= 0 ? String(i) : 'custom';
  }

  selTuning.addEventListener('change', () => {
    let strings;
    if (selTuning.value === 'custom') {
      const v = prompt('String names from highest to lowest, separated by spaces', doc.tuning.join(' '));
      strings = v && v.trim().split(/\s+/).map((x) => x.slice(0, 3));
    } else {
      strings = TUNINGS[+selTuning.value].strings.slice();
    }
    if (strings && strings.length) applyTuning(strings);
    syncTuningSelect();
    focusSink();
  });

  function applyTuning(strings) {
    pushUndo();
    const n = strings.length;
    for (const st of doc.staves) for (const col of st.cols) col.n = resizeNotes(col.n, n);
    doc.tuning = strings;
    render();
    save();
  }

  // ---------------------------------------------------------------- text export

  function staffToLines(st, tuning) {
    const w = Math.max(...tuning.map((t) => t.length));
    const lines = tuning.map((t) => t.padEnd(w, ' ') + '|-');
    st.cols.forEach((col, i) => {
      if (col.bar) {
        if (i === st.cols.length - 1) return; // closing bar is drawn anyway
        for (let k = 0; k < lines.length; k++) lines[k] += '|-';
        return;
      }
      const cw = Math.max(1, ...col.n.map((v) => v.length));
      col.n.forEach((v, k) => { lines[k] += v.padEnd(cw, '-') + '-'; });
    });
    return lines.map((l) => l + '|');
  }

  const isEmptyStaff = (st) => !st.label && st.cols.every((c) => !c.bar && c.n.every((v) => !v));

  function exportStaves() {
    const staves = doc.staves.slice();
    while (staves.length > 1 && isEmptyStaff(staves[staves.length - 1])) staves.pop();
    return staves.map((st) => ({
      label: st.label.trim().replace(/^\[(.*)\]$/, '$1'),
      lines: staffToLines(st, doc.tuning),
    }));
  }

  const tuningLine = () => 'Tuning: ' + doc.tuning.slice().reverse().join(' ');

  function docToText() {
    const out = [];
    if (doc.title.trim()) out.push(doc.title.trim());
    if (doc.artist.trim()) out.push('by ' + doc.artist.trim());
    if (doc.info.trim()) out.push(doc.info.trim());
    out.push(tuningLine());
    out.push('');
    for (const st of exportStaves()) {
      if (st.label) out.push(`[${st.label}]`);
      out.push(...st.lines, '');
    }
    return out.join('\n');
  }

  let previewTimer = 0;
  const previewBox = $('#previewBox');
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { if (previewBox.open) $('#preview').textContent = docToText(); }, 120);
  }
  previewBox.addEventListener('toggle', schedulePreview);

  // ---------------------------------------------------------------- text import

  function parseText(text) {
    const lines = text.replace(/\t/g, '    ').split(/\r?\n/);
    const re = /^\s*([A-Ga-g][#b]?)\s*\|(.*)$/;
    const staves = [];
    const pre = [];
    let tuning = null;
    let pendingLabel = '';
    let i = 0;
    while (i < lines.length) {
      if (re.test(lines[i])) {
        const grp = [];
        while (i < lines.length && re.test(lines[i])) grp.push(re.exec(lines[i++]));
        if (grp.length >= 2) {
          if (!tuning) tuning = grp.map((g) => g[1]);
          const cols = parseBodies(grp.map((g) => g[2]))
            .map((c) => ({ bar: c.bar, n: resizeNotes(c.n, tuning.length) }));
          staves.push({ label: pendingLabel, cols });
          pendingLabel = '';
        }
        continue;
      }
      const t = lines[i].trim();
      if (t) {
        const lab = /^\[(.+)\]$/.exec(t);
        if (lab) pendingLabel = lab[1];
        else if (!staves.length) pre.push(t);
        else if (t.length <= 40) pendingLabel = t;
      }
      i++;
    }
    if (!staves.length) return null;
    const meta = pre.filter((l) => !/^tuning\s*:/i.test(l));
    const d = { title: '', artist: '', info: '', tuning, staves };
    if (meta.length) d.title = meta.shift();
    if (meta.length && /^by\s+/i.test(meta[0])) d.artist = meta.shift().replace(/^by\s+/i, '');
    d.info = meta.join(' · ');
    return normalize(d);
  }

  function parseBodies(bodies) {
    let rows = bodies.map((b) => b.replace(/\s+$/, '').replace(/\|+$/, ''));
    const L = Math.max(0, ...rows.map((r) => r.length));
    rows = rows.map((r) => r.padEnd(L, '-'));
    const n = rows.length;
    const isDash = (ch) => ch === '-' || ch === ' ';
    const isNote = (ch) => !isDash(ch) && ch !== '|';
    const cols = [];
    let dash = 0;
    const flush = () => {
      const empties = Math.max(0, Math.floor((dash - 1) / 2));
      for (let k = 0; k < empties; k++) cols.push(newCol(n));
      dash = 0;
    };
    let i = 0;
    while (i < L) {
      const chars = rows.map((r) => r[i]);
      if (chars.every(isDash)) { dash++; i++; continue; }
      if (chars.every((ch) => !isNote(ch))) {
        flush();
        cols.push({ bar: true, n: Array(n).fill('') });
        i++;
        continue;
      }
      // A note column spans every adjacent non-dash run that overlaps it (e.g. "12" over "5").
      let end = i + 1;
      for (let grew = true; grew;) {
        grew = false;
        for (const r of rows) {
          for (let j = i; j < end; j++) {
            if (!isNote(r[j])) continue;
            let k = j;
            while (k < L && isNote(r[k])) k++;
            if (k > end) { end = k; grew = true; }
          }
        }
      }
      flush();
      cols.push({ bar: false, n: rows.map((r) => r.slice(i, end).replace(/[-\s|]/g, '').slice(0, MAX_CELL)) });
      i = end;
    }
    flush();
    if (!cols.length) cols.push(newCol(n));
    return cols;
  }

  // ---------------------------------------------------------------- files

  function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = el('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const fileBase = () => (doc.title.trim() || 'tab').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'tab';

  function loadDoc(d) {
    pushUndo();
    doc = d;
    cursor = { s: 0, c: 0, r: 0 };
    anchor = null; session = null; last = null;
    syncMeta();
    render();
    save();
  }

  $('#fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const json = /\.json$/i.test(file.name) || /^\s*\{/.test(text) ? safeParse(text) : null;
    const d = json ? normalize(json) : parseText(text);
    if (d) loadDoc(d);
    else alert("Couldn't find any tab in that file.");
  });

  // ---------------------------------------------------------------- toolbar

  const actions = {
    btnNew() {
      if (!confirm('Start a new tab? (You can undo this.)')) return;
      loadDoc(blankDoc());
    },
    btnOpen() { $('#fileInput').click(); },
    btnSave() { download(fileBase() + '.tabber.json', JSON.stringify(doc, null, 1), 'application/json'); },
    btnUndo: undo,
    btnRedo: redo,
    btnInsert: insertCol,
    btnDelete: deleteCols,
    btnBar: toggleBar,
    btnStaff: () => addStaff(),
    btnAddStaffBottom: () => addStaff(doc.staves.length - 1),
    btnTxt() { download(fileBase() + '.txt', docToText(), 'text/plain;charset=utf-8'); },
    btnPdf() {
      const bytes = window.TabPDF.build({
        title: doc.title.trim(),
        artist: doc.artist.trim(),
        info: doc.info.trim(),
        subtitle: tuningLine(),
        staves: exportStaves(),
      }, { size: prefs.page });
      download(fileBase() + '.pdf', bytes, 'application/pdf');
    },
  };
  for (const [id, fn] of Object.entries(actions)) {
    const b = document.getElementById(id);
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep editor focus
    b.addEventListener('click', () => {
      fn();
      if (id !== 'btnOpen') focusSink();
    });
  }

  const selAdvance = $('#selAdvance');
  selAdvance.value = String(prefs.advance);
  selAdvance.addEventListener('change', () => {
    prefs.advance = +selAdvance.value;
    last = null;
    savePrefs();
    focusSink();
  });

  const selPage = $('#selPage');
  selPage.value = prefs.page;
  selPage.addEventListener('change', () => { prefs.page = selPage.value; savePrefs(); });

  const inpCols = $('#inpCols');
  inpCols.value = prefs.cols;
  inpCols.addEventListener('change', () => {
    prefs.cols = Math.max(4, Math.min(128, Math.round(+inpCols.value) || 32));
    inpCols.value = prefs.cols;
    savePrefs();
  });

  window.addEventListener('resize', () => paint(false));

  // ---------------------------------------------------------------- go

  syncMeta();
  render();
  schedulePreview();
  focusSink();

  // Exposed for debugging / tests.
  window.tabber = { get doc() { return doc; }, docToText, parseText };
})();
