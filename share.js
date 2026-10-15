// Encode a tab into a URL hash fragment (and back), like mermaid.live.
// The fragment never leaves the browser, so sharing needs no server.
//
//   #t=<base64url(deflate-raw(json))>   compressed (default)
//   #u=<base64url(json)>                uncompressed fallback for old browsers
window.TabShare = (() => {
  'use strict';

  const MAX_JSON = 4 * 1024 * 1024; // refuse absurd payloads (zip bombs)
  const canCompress = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

  // ---- compact JSON form ----
  // { v, t, a, i, u: tuning, s: [[label, cols, count]] }
  // A column is '|' for a bar, otherwise its notes joined with ',' (trailing
  // empties trimmed). Trailing empty columns are dropped; `count` restores them.
  function compact(doc) {
    const o = { v: 1, u: doc.tuning };
    if (doc.title) o.t = doc.title;
    if (doc.artist) o.a = doc.artist;
    if (doc.info) o.i = doc.info;
    o.s = doc.staves.map((st) => {
      const cols = st.cols.map((c) => (c.bar ? '|' : c.n.join(',').replace(/,+$/, '')));
      const count = cols.length;
      while (cols.length && cols[cols.length - 1] === '') cols.pop();
      return [st.label, cols, count];
    });
    return o;
  }

  function expand(o) {
    if (!o || o.v !== 1 || !Array.isArray(o.s)) return null;
    return {
      title: o.t || '',
      artist: o.a || '',
      info: o.i || '',
      tuning: o.u,
      staves: o.s.map(([label, cols, count]) => {
        const out = (Array.isArray(cols) ? cols : []).map((c) => (c === '|'
          ? { bar: true, n: [] }
          : { bar: false, n: String(c).split(',') }));
        while (out.length < (+count || 0)) out.push({ bar: false, n: [] });
        return { label: label || '', cols: out };
      }),
    };
  }

  // ---- bytes / base64url ----
  function toB64u(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64u(str) {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function readAll(stream, limit) {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) { reader.cancel(); throw new Error('Shared tab is too large'); }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  const deflate = (bytes) => readAll(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw')), Infinity);
  const inflate = (bytes) => readAll(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')), MAX_JSON);

  // ---- public API ----

  /** doc -> hash fragment string (without the leading '#'). */
  async function encode(doc) {
    const json = new TextEncoder().encode(JSON.stringify(compact(doc)));
    if (canCompress) return 't=' + toB64u(await deflate(json));
    return 'u=' + toB64u(json);
  }

  /** hash fragment (with or without '#') -> loose doc object, or null if it isn't a tab. Throws on corrupt data. */
  async function decode(hash) {
    const m = /^#?([tu])=([A-Za-z0-9_-]+)$/.exec(hash || '');
    if (!m) return null;
    let bytes = fromB64u(m[2]);
    if (m[1] === 't') {
      if (!canCompress) throw new Error('This browser can’t open compressed share links');
      bytes = await inflate(bytes);
    } else if (bytes.length > MAX_JSON) {
      throw new Error('Shared tab is too large');
    }
    return expand(JSON.parse(new TextDecoder().decode(bytes)));
  }

  const isShareHash = (hash) => /^#?[tu]=/.test(hash || '');

  return { encode, decode, isShareHash };
})();
