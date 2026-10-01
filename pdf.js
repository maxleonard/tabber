// Minimal dependency-free PDF writer for monospaced tablature.
// Uses the PDF standard-14 fonts (Courier / Helvetica), so nothing is embedded.
window.TabPDF = (() => {
  'use strict';

  const SIZES = { letter: [612, 792], a4: [595.28, 841.89] };

  // Unicode -> WinAnsiEncoding for the few non-Latin-1 characters people commonly type.
  const WIN = {
    '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93,
    '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99,
  };

  function enc(s) {
    let out = '';
    for (const ch of String(s)) {
      let c = ch.codePointAt(0);
      if (WIN[ch] !== undefined) c = WIN[ch];
      else if (c > 255 || (c >= 0x80 && c < 0xA0)) c = 63; // '?'
      if (c < 32) c = 32;
      const x = String.fromCharCode(c);
      out += (x === '\\' || x === '(' || x === ')') ? '\\' + x : x;
    }
    return out;
  }

  const num = (n) => String(Math.round(n * 100) / 100);

  /**
   * data: { title, artist, info, subtitle, staves: [{ label, lines: [string] }] }
   * opts: { size: 'letter' | 'a4' }
   * returns Uint8Array
   */
  function build(data, opts = {}) {
    const [W, H] = SIZES[opts.size] || SIZES.letter;
    const M = 54;
    const usable = W - 2 * M;
    const maxLen = Math.max(1, ...data.staves.flatMap((s) => s.lines.map((l) => l.length)));
    // Courier glyphs are 0.6em wide; shrink the font if a staff is too wide.
    const fs = Math.max(5, Math.min(10.5, usable / (0.6 * maxLen)));
    const lead = fs * 1.22;

    const pages = [];
    let ops = '';
    let y = 0;
    const newPage = () => {
      if (ops) pages.push(ops);
      ops = '';
      y = H - M;
    };
    const text = (font, size, x, yy, s) => {
      ops += `BT /${font} ${num(size)} Tf ${num(x)} ${num(yy)} Td (${enc(s)}) Tj ET\n`;
    };
    const gray = (g) => { ops += `${g} g\n`; };

    newPage();
    if (data.title) { y -= 22; text('F4', 22, M, y, data.title); y -= 4; }
    if (data.artist) { y -= 16; text('F3', 13, M, y, data.artist); }
    gray(0.35);
    if (data.info) { y -= 14; text('F3', 10, M, y, data.info); }
    if (data.subtitle) { y -= 14; text('F3', 10, M, y, data.subtitle); }
    gray(0);
    y -= 14;

    for (const st of data.staves) {
      const labelH = st.label ? fs + 8 : 0;
      const h = labelH + st.lines.length * lead;
      // Keep each staff together on one page.
      if (y - h < M + 10 && y < H - M - 1) newPage();
      y -= lead * 0.9;
      if (st.label) { y -= fs; text('F4', fs, M, y, st.label); y -= 6; }
      for (const ln of st.lines) { y -= lead; text('F1', fs, M, y, ln); }
    }
    pages.push(ops);

    const N = pages.length;
    const footered = pages.map((p, i) => {
      let f = p + '0.55 g\n';
      if (data.title) f += `BT /F3 8 Tf ${num(M)} ${num(M / 2)} Td (${enc(data.title)}) Tj ET\n`;
      f += `BT /F3 8 Tf ${num(W - M - 24)} ${num(M / 2)} Td (${i + 1} / ${N}) Tj ET\n0 g\n`;
      return f;
    });

    // ---- Assemble objects ----
    const objs = [null, null]; // 1: catalog, 2: pages
    const add = (s) => { objs.push(s); return objs.length; };
    const font = (base) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`);
    const F1 = font('Courier');
    const F2 = font('Courier-Bold');
    const F3 = font('Helvetica');
    const F4 = font('Helvetica-Bold');
    const res = `<< /Font << /F1 ${F1} 0 R /F2 ${F2} 0 R /F3 ${F3} 0 R /F4 ${F4} 0 R >> >>`;
    const kids = footered.map((content) => {
      const c = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(W)} ${num(H)}] /Resources ${res} /Contents ${c} 0 R >>`);
    });
    objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
    const info = add(`<< /Title (${enc(data.title || 'Guitar tab')}) /Producer (Tabber) >>`);

    let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets = objs.map((o, i) => {
      const at = out.length;
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
      return at;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    out += offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }

  return { build };
})();
