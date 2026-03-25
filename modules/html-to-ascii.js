// ─── Tiny Tokenizer ─────────────────────────────────────────────────────────
// Splits HTML into a flat list of { type, tag?, attrs?, text?, selfClosing? }
function tokenize(html) {
  const tokens = [];
  let i = 0;

  while (i < html.length) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) {
        tokens.push({ type: 'text', text: html.slice(i) });
        break;
      }

      const raw = html.slice(i + 1, end).trim();

      // Comment
      if (raw.startsWith('!--')) {
        i = html.indexOf('-->', i);
        i = i === -1 ? html.length : i + 3;
        continue;
      }
      // Doctype / processing instructions
      if (raw.startsWith('!') || raw.startsWith('?')) {
        i = end + 1;
        continue;
      }

      const closing = raw.startsWith('/');
      const body = closing ? raw.slice(1).trim() : raw;
      const selfClosing =
        body.endsWith('/') ||
        /^(br|hr|img|input|meta|link|col|area|base|embed|source|track|wbr)(\s|$)/i.test(
          body
        );
      const spaceIdx = body.search(/[\s/]/);
      const tag = (spaceIdx === -1 ? body : body.slice(0, spaceIdx))
        .toLowerCase()
        .replace(/\/$/, '');

      // Rough attribute parser (good enough for src, href, alt, colspan, rowspan)
      const attrs = {};
      const attrStr = spaceIdx === -1 ? '' : body.slice(spaceIdx);
      const attrRe = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
      let m;
      while ((m = attrRe.exec(attrStr))) {
        attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
      }

      tokens.push({
        type: closing ? 'close' : 'open',
        tag,
        attrs,
        selfClosing,
      });
      i = end + 1;
    } else {
      const next = html.indexOf('<', i);
      const text = next === -1 ? html.slice(i) : html.slice(i, next);
      if (text) tokens.push({ type: 'text', text });
      i = next === -1 ? html.length : next;
    }
  }
  return tokens;
}

// ─── Entity Decoder ──────────────────────────────────────────────────────────

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ndash;': '–',
  '&mdash;': '—',
  '&laquo;': '«',
  '&raquo;': '»',
  '&bull;': '•',
  '&hellip;': '…',
  '&copy;': '©',
  '&reg;': '®',
  '&trade;': '™',
  '&larr;': '←',
  '&rarr;': '→',
  '&uarr;': '↑',
  '&darr;': '↓',
};

function decodeEntities(str) {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&[a-zA-Z]+;/g, (ent) => ENTITIES[ent] ?? ent);
}

// ─── Table Renderer ──────────────────────────────────────────────────────────

function renderTable(tableNode) {
  // 1. Collect rows → cells
  const rows = [];
  walkForRows(tableNode.children, rows);

  if (rows.length === 0) return '';

  // 2. Expand colspan / rowspan into a grid
  const grid = [];
  for (let r = 0; r < rows.length; r++) {
    if (!grid[r]) grid[r] = [];
    let colCursor = 0;
    for (const cell of rows[r]) {
      while (grid[r][colCursor]) colCursor++; // skip occupied
      const cs = parseInt(cell.attrs.colspan, 10) || 1;
      const rs = parseInt(cell.attrs.rowspan, 10) || 1;
      const text = inlineText(cell).trim();
      for (let dr = 0; dr < rs; dr++) {
        for (let dc = 0; dc < cs; dc++) {
          if (!grid[r + dr]) grid[r + dr] = [];
          grid[r + dr][colCursor + dc] = dr === 0 && dc === 0 ? text : '';
        }
      }
      colCursor += cs;
    }
  }

  // 3. Column widths
  const numCols = Math.max(...grid.map((r) => r.length));
  const colWidths = Array.from({ length: numCols }, (_, c) =>
    Math.max(3, ...grid.map((row) => (row[c] ?? '').length))
  );

  // 4. Draw
  const hLine = (l, m, r, f) =>
    l + colWidths.map((w) => f.repeat(w + 2)).join(m) + r;

  const top = hLine('┌', '┬', '┐', '─');
  const mid = hLine('├', '┼', '┤', '─');
  const bottom = hLine('└', '┴', '┘', '─');

  const lines = [top];
  grid.forEach((row, ri) => {
    const cells = colWidths.map((w, ci) => {
      const val = (row[ci] ?? '').slice(0, w);
      return ' ' + val.padEnd(w) + ' ';
    });
    lines.push('│' + cells.join('│') + '│');
    lines.push(
      ri === 0 && grid.length > 1 ? mid : ri < grid.length - 1 ? mid : bottom
    );
  });
  if (lines[lines.length - 1] !== bottom) lines.push(bottom);

  return '\n' + lines.join('\n') + '\n';
}

function walkForRows(children, rows) {
  for (const child of children) {
    if (child.tag === 'tr') {
      const cells = child.children.filter(
        (c) => c.tag === 'td' || c.tag === 'th'
      );
      rows.push(cells);
    } else if (child.children) {
      walkForRows(child.children, rows);
    }
  }
}

// ─── Tiny DOM Builder ────────────────────────────────────────────────────────
// Builds a lightweight tree from the flat token list.

const BLOCK_TAGS = new Set([
  'div',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'nav',
  'main',
  'figure',
  'figcaption',
  'details',
  'summary',
  'dl',
  'dt',
  'dd',
  'hr',
  'br',
  'address',
]);
const SKIP_TAGS = new Set(['script', 'style', 'svg', 'noscript', 'template']);
const VOID_TAGS = new Set([
  'br',
  'hr',
  'img',
  'input',
  'meta',
  'link',
  'col',
  'area',
  'base',
  'embed',
  'source',
  'track',
  'wbr',
]);

function buildTree(tokens) {
  const root = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];

  for (const tok of tokens) {
    const parent = stack[stack.length - 1];

    if (tok.type === 'text') {
      parent.children.push({ tag: '#text', text: decodeEntities(tok.text) });
    } else if (tok.type === 'open') {
      const node = { tag: tok.tag, attrs: tok.attrs, children: [] };
      parent.children.push(node);
      if (!tok.selfClosing && !VOID_TAGS.has(tok.tag)) {
        stack.push(node);
      }
    } else if (tok.type === 'close') {
      // Walk up the stack to find the matching open tag
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tok.tag) {
          stack.length = i;
          break;
        }
      }
    }
  }
  return root;
}

// ─── Tree → Text ─────────────────────────────────────────────────────────────

function inlineText(node) {
  if (node.tag === '#text') return node.text;
  if (!node.children) return '';
  return node.children.map(inlineText).join('');
}

function convert(node, ctx) {
  if (SKIP_TAGS.has(node.tag)) return '';
  if (node.tag === '#text') return node.text;

  const tag = node.tag;

  // Self-closing specials
  if (tag === 'br') return '\n';
  if (tag === 'hr') return '\n' + '─'.repeat(60) + '\n';
  if (tag === 'img') {
    const alt = node.attrs.alt || node.attrs.src || '';
    return alt ? `[image: ${alt}]` : '';
  }

  // Recurse children
  const childText = () =>
    (node.children || []).map((c) => convert(c, ctx)).join('');

  // ── Table ──
  if (tag === 'table') return renderTable(node);
  if (['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'].includes(tag))
    return childText(); // handled by table

  // ── Headings ──
  if (/^h([1-6])$/.test(tag)) {
    const level = Number(RegExp.$1);
    const text = childText().trim();
    if (!text) return '';
    const prefix = level <= 2 ? '' : '#'.repeat(level) + ' ';
    const line = prefix + text.toUpperCase();
    const underline =
      level === 1
        ? '═'.repeat(Math.min(line.length, 60))
        : level === 2
          ? '─'.repeat(Math.min(line.length, 60))
          : '';
    return '\n\n' + line + (underline ? '\n' + underline : '') + '\n\n';
  }

  // ── Paragraphs / Divs / Sections ──
  if (tag === 'p') return '\n\n' + childText().trim() + '\n\n';
  if (tag === 'blockquote') {
    const inner = childText().trim();
    return (
      '\n\n' +
      inner
        .split('\n')
        .map((l) => '  │ ' + l)
        .join('\n') +
      '\n\n'
    );
  }
  if (tag === 'pre') {
    const inner = inlineText(node);
    const border = '┈'.repeat(
      Math.min(60, Math.max(...inner.split('\n').map((l) => l.length), 10))
    );
    return '\n' + border + '\n' + inner + '\n' + border + '\n';
  }

  // ── Lists ──
  if (tag === 'ul' || tag === 'ol') {
    const items = (node.children || []).filter((c) => c.tag === 'li');
    const result = items.map((li, i) => {
      const bullet = tag === 'ol' ? `${i + 1}. ` : ' • ';
      const text = convert(li, ctx).trim().replace(/\n/g, '\n   ');
      return bullet + text;
    });
    return '\n' + result.join('\n') + '\n';
  }
  if (tag === 'li') return childText();

  // ── Definition lists ──
  if (tag === 'dt') return '\n' + childText().trim().toUpperCase() + '\n';
  if (tag === 'dd') return '  ' + childText().trim() + '\n';

  // ── Inline tags ──
  if (tag === 'a') {
    const text = childText().trim();
    const href = node.attrs.href;
    return href && href !== text ? `${text} (${href})` : text;
  }
  if (tag === 'strong' || tag === 'b') return '**' + childText() + '**';
  if (tag === 'em' || tag === 'i') return '_' + childText() + '_';
  if (tag === 'code') return '`' + childText() + '`';
  if (tag === 's' || tag === 'del' || tag === 'strike')
    return '~' + childText() + '~';
  if (tag === 'mark') return '»' + childText() + '«';
  if (tag === 'sup') return '^(' + childText() + ')';
  if (tag === 'sub') return '_(' + childText() + ')';

  // ── Details/Summary ──
  if (tag === 'summary') return '▸ ' + childText().trim();
  if (tag === 'details') return '\n' + childText().trim() + '\n';

  // ── Generic block ──
  if (BLOCK_TAGS.has(tag)) return '\n' + childText() + '\n';

  return childText();
}

// ─── Post-process ────────────────────────────────────────────────────────────

function cleanUp(text) {
  return text
    .replace(/[ \t]+/g, ' ') // collapse horizontal whitespace
    .replace(/ ?\n ?/g, '\n') // trim around newlines
    .replace(/\n{4,}/g, '\n\n\n') // max 2 blank lines
    .trim();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Convert an HTML string to formatted ASCII text.
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  const tokens = tokenize(html);
  const tree = buildTree(tokens);
  const raw = convert(tree, {});
  return cleanUp(raw);
}

module.exports = htmlToText;
module.exports.htmlToText = htmlToText;
module.exports.tokenize = tokenize;
module.exports.buildTree = buildTree;
