/* Shared helpers: DOM/SVG building, formatting, tooltips and the
   interactive charts used by the dashboards. No dependencies. */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Creates an HTML element with optional class and text. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Creates an SVG element with attributes. */
export function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) node.setAttribute(key, String(value));
  }
  return node;
}

export const fmtSize = (bytes) => {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

export const fmtDelta = (bytes) => (bytes > 0 ? '+' : '−') + fmtSize(Math.abs(bytes));

/** Page path relative to the site root, for display. */
export const sitePath = (p) => '/' + p.split('/').slice(1).join('/');

export const pageHref = (scan, path) =>
  `/page.html?scan=${encodeURIComponent(scan)}&path=${encodeURIComponent(path)}`;

// --- Tooltip -----------------------------------------------------------

let tooltipEl = null;

function ensureTooltip() {
  if (!tooltipEl) {
    tooltipEl = el('div');
    tooltipEl.id = 'tooltip';
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

/**
 * Attaches a hover tooltip to any element.
 * @param {Element} target
 * @param {() => {title: string, rows?: string[], hint?: string}} build
 */
export function tip(target, build) {
  const node = ensureTooltip();

  target.addEventListener('mouseenter', (event) => {
    const { title, rows = [], hint } = build();
    node.innerHTML = '';
    node.appendChild(el('div', 't-title', title));
    for (const row of rows) node.appendChild(el('div', 't-row', row));
    if (hint) node.appendChild(el('div', 't-hint', hint));
    node.style.display = 'block';
    move(event);
  });
  target.addEventListener('mousemove', move);
  target.addEventListener('mouseleave', () => { node.style.display = 'none'; });

  function move(event) {
    const pad = 14;
    const rect = node.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - pad;
    node.style.left = `${Math.max(4, x)}px`;
    node.style.top = `${Math.max(4, y)}px`;
  }
}

export function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = 'none';
}

// --- Colour ------------------------------------------------------------

/** Categorical palette, stable per index. */
export const PALETTE = [
  '#0b6bcb', '#1a8a4a', '#b9760a', '#8a3ffc', '#0f8f9e',
  '#c62828', '#4a6572', '#7a5c00', '#3b6ea5', '#6a8f2f',
];

export const colorFor = (i) => PALETTE[i % PALETTE.length];

// --- Treemap -----------------------------------------------------------

/**
 * Squarified treemap layout.
 * @param {{value: number}[]} items - Sorted descending by value.
 * @param {number} width
 * @param {number} height
 * @returns {{x: number, y: number, w: number, h: number, item: object}[]}
 */
export function squarify(items, width, height) {
  const total = items.reduce((sum, i) => sum + i.value, 0);
  if (total <= 0) return [];

  const scale = (width * height) / total;
  const queue = items.map(item => ({ item, area: item.value * scale }));
  const out = [];
  let x = 0, y = 0, w = width, h = height;

  const worst = (row, side) => {
    const sum = row.reduce((s, r) => s + r.area, 0);
    const max = Math.max(...row.map(r => r.area));
    const min = Math.min(...row.map(r => r.area));
    const side2 = side * side;
    const sum2 = sum * sum;
    return Math.max((side2 * max) / sum2, sum2 / (side2 * min));
  };

  const layoutRow = (row) => {
    const sum = row.reduce((s, r) => s + r.area, 0);
    const horizontal = w >= h;
    const thickness = horizontal ? sum / h : sum / w;
    let offset = 0;
    for (const cell of row) {
      const length = cell.area / thickness;
      out.push(horizontal
        ? { x, y: y + offset, w: thickness, h: length, item: cell.item }
        : { x: x + offset, y, w: length, h: thickness, item: cell.item });
      offset += length;
    }
    if (horizontal) { x += thickness; w -= thickness; }
    else { y += thickness; h -= thickness; }
  };

  let row = [];
  while (queue.length) {
    const next = queue[0];
    const side = Math.min(w, h);
    if (side <= 0) break;
    if (row.length === 0 || worst([...row, next], side) <= worst(row, side)) {
      row.push(queue.shift());
    } else {
      layoutRow(row);
      row = [];
    }
  }
  if (row.length) layoutRow(row);

  return out;
}

/**
 * Renders an interactive treemap.
 * @param {object} opts
 * @param {{label: string, value: number, meta: object}[]} opts.items
 * @param {number} [opts.height]
 * @param {(item: object) => {title: string, rows: string[], hint?: string}} opts.tooltip
 * @param {(item: object) => void} opts.onClick
 * @returns {SVGElement}
 */
export function treemap({ items, height = 260, tooltip, onClick }) {
  const width = 1000; // viewBox units; scales to the container
  const root = svg('svg', {
    class: 'chart', viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none', height,
  });

  const sorted = [...items].sort((a, b) => b.value - a.value);
  const cells = squarify(sorted, width, height);

  cells.forEach((cell, i) => {
    const g = svg('g', { class: 'node' });
    g.appendChild(svg('rect', {
      x: cell.x + 1, y: cell.y + 1,
      width: Math.max(0, cell.w - 2), height: Math.max(0, cell.h - 2),
      rx: 3, fill: colorFor(i),
    }));

    // Only label cells with room for text.
    if (cell.w > 70 && cell.h > 26) {
      g.appendChild(Object.assign(
        svg('text', { class: 'node-label', x: cell.x + 9, y: cell.y + 20 }),
        { textContent: cell.item.label }));
      if (cell.h > 42) {
        g.appendChild(Object.assign(
          svg('text', { class: 'node-sub', x: cell.x + 9, y: cell.y + 35 }),
          { textContent: `${cell.item.value} pages` }));
      }
    }

    tip(g, () => tooltip(cell.item));
    g.addEventListener('click', () => { hideTooltip(); onClick(cell.item); });
    root.appendChild(g);
  });

  return root;
}

/**
 * Horizontal bar chart where every bar is hoverable and clickable.
 * @param {object} opts
 * @param {{label: string, value: number, meta: object}[]} opts.items
 * @param {string} [opts.color]
 * @param {(item: object) => object} opts.tooltip
 * @param {(item: object) => void} opts.onClick
 * @param {(value: number) => string} [opts.format]
 */
export function barChart({ items, color = '#0b6bcb', tooltip, onClick, format = String }) {
  const rowH = 26;
  const labelW = 300;
  const width = 1000;
  const height = Math.max(rowH, items.length * rowH) + 6;
  const max = Math.max(...items.map(i => i.value), 1);

  const root = svg('svg', {
    class: 'chart', viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'xMinYMin meet', height,
  });

  items.forEach((item, i) => {
    const y = i * rowH + 3;
    const barW = Math.max(2, ((width - labelW - 90) * item.value) / max);
    const g = svg('g', { class: 'bar' });

    const label = svg('text', { class: 'axis', x: 0, y: y + 14 });
    label.textContent = item.label.length > 46 ? '…' + item.label.slice(-45) : item.label;
    g.appendChild(label);

    g.appendChild(svg('rect', {
      x: labelW, y: y + 3, width: barW, height: rowH - 10, rx: 2, fill: color,
    }));

    const value = svg('text', { class: 'axis', x: labelW + barW + 8, y: y + 14 });
    value.textContent = format(item.value);
    g.appendChild(value);

    // Invisible hit area so the whole row is hoverable.
    g.appendChild(svg('rect', { x: 0, y, width, height: rowH, fill: 'transparent' }));

    tip(g, () => tooltip(item));
    g.addEventListener('click', () => { hideTooltip(); onClick(item); });
    root.appendChild(g);
  });

  return root;
}

/**
 * Vertical histogram (used for crawl depth).
 */
export function histogram({ items, color = '#0b6bcb', tooltip, onClick }) {
  const width = 1000;
  const height = 170;
  const padBottom = 28;
  const max = Math.max(...items.map(i => i.value), 1);
  const slot = width / Math.max(items.length, 1);

  const root = svg('svg', {
    class: 'chart', viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none', height,
  });

  items.forEach((item, i) => {
    const barH = Math.max(2, ((height - padBottom - 20) * item.value) / max);
    const x = i * slot + slot * 0.15;
    const w = slot * 0.7;
    const y = height - padBottom - barH;

    const g = svg('g', { class: 'bar' });
    g.appendChild(svg('rect', { x, y, width: w, height: barH, rx: 3, fill: color }));

    const value = svg('text', { class: 'axis', x: x + w / 2, y: y - 6, 'text-anchor': 'middle' });
    value.textContent = item.value;
    g.appendChild(value);

    const label = svg('text', {
      class: 'axis', x: x + w / 2, y: height - 9, 'text-anchor': 'middle',
    });
    label.textContent = item.label;
    g.appendChild(label);

    g.appendChild(svg('rect', { x, y: 0, width: w, height, fill: 'transparent' }));
    tip(g, () => tooltip(item));
    g.addEventListener('click', () => { hideTooltip(); onClick(item); });
    root.appendChild(g);
  });

  return root;
}
