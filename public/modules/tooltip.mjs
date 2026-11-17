// The widget's own tooltips, in place of the browser's `title` ones. Elements carry their text
// in data-tip (render.mjs); one tooltip element outside #app shows it, as text only.
//
// The page rebuilds its DOM on every render, so the hovered element can vanish under a resting
// pointer. refresh() runs after each render and finds the element now under the pointer.

const DELAY_MS = 450; // first tooltip: wait for a resting pointer
const WARM_MS = 300; // a tooltip closed this recently: the next one shows at once
const GAP = 6;
const MARGIN = 6;

/**
 * Where the tooltip goes, in viewport pixels: above the target, else below, else (a collapsed
 * window is only one header high) beside it on the side with more room. Always inside the view.
 * target: { left, top, right, bottom }; tip: { width, height }; view: { width, height }.
 */
export function place(target, tip, view) {
  const clampX = (x) => Math.max(MARGIN, Math.min(x, view.width - tip.width - MARGIN));
  const clampY = (y) => Math.max(0, Math.min(y, view.height - tip.height));
  const centerX = clampX((target.left + target.right) / 2 - tip.width / 2);
  const above = target.top - GAP - tip.height;
  if (above >= MARGIN) return { left: centerX, top: above, side: 'above' };
  const below = target.bottom + GAP;
  if (below + tip.height <= view.height - MARGIN) return { left: centerX, top: below, side: 'below' };
  const top = clampY((target.top + target.bottom) / 2 - tip.height / 2);
  const roomLeft = target.left - GAP;
  const roomRight = view.width - target.right - GAP;
  return roomLeft >= roomRight
    ? { left: clampX(target.left - GAP - tip.width), top, side: 'left' }
    : { left: clampX(target.right + GAP), top, side: 'right' };
}

/** A tip that only repeats text the element shows in full adds nothing. */
function worthShowing(el) {
  const tip = el.dataset.tip;
  if (!tip) return false;
  const cut = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
  return cut || !el.textContent.includes(tip);
}

export function createTooltips() {
  const box = document.createElement('div');
  box.className = 'tooltip';
  box.setAttribute('role', 'tooltip');
  document.body.append(box);

  let target = null; // the element whose tip is shown or about to be
  let shown = false;
  let timer = null;
  let closedAt = -Infinity;
  let x = -1;
  let y = -1;

  function hide() {
    clearTimeout(timer);
    timer = null;
    if (shown) closedAt = performance.now();
    shown = false;
    target = null;
    box.classList.remove('is-on', 'is-warm');
  }

  function show(warm) {
    timer = null;
    if (!target?.isConnected || !worthShowing(target)) {
      hide();
      return;
    }
    box.textContent = target.dataset.tip;
    box.classList.toggle('is-mono', getComputedStyle(target).fontFamily.includes('Mono'));
    // measure where it will stand, then place it
    box.style.left = '0px';
    box.style.top = '0px';
    const r = target.getBoundingClientRect();
    const spot = place(r, { width: box.offsetWidth, height: box.offsetHeight },
      { width: document.documentElement.clientWidth, height: window.innerHeight });
    box.style.left = `${Math.round(spot.left)}px`;
    box.style.top = `${Math.round(spot.top)}px`;
    box.classList.toggle('is-warm', warm);
    box.classList.add('is-on');
    shown = true;
  }

  function point(el) {
    if (el === target) return;
    const warm = shown || performance.now() - closedAt < WARM_MS;
    hide();
    if (!el) return;
    target = el;
    if (warm) show(true);
    else timer = setTimeout(show, DELAY_MS, false);
  }

  const under = () => (x < 0 ? null : document.elementFromPoint(x, y)?.closest('[data-tip]') ?? null);

  document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    x = e.clientX;
    y = e.clientY;
    point(e.target.closest?.('[data-tip]') ?? null);
  });
  document.documentElement.addEventListener('pointerleave', () => {
    x = -1;
    hide();
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.addEventListener('scroll', hide, { passive: true });
  window.addEventListener('blur', hide);

  return {
    /** After a render: keep the tooltip on the element that replaced the old one, or close it. */
    refresh() {
      if (!target) return;
      const el = under();
      if (el && el.dataset.tip === target.dataset.tip) {
        target = el;
        if (shown) show(true);
      } else {
        hide();
        if (el) point(el);
      }
    },
  };
}
