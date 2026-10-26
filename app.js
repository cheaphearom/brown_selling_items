'use strict';
// =====================================================================
// CONFIG — everything in this file is visible to anyone who opens the page.
// Products and orders come from the server API. Order history is also cached in this browser.
// Loyalty card + serial reuse is checked server-side; authenticity requires an external loyalty service.
// =====================================================================
const DATA_URL = '/api/menu';
const SHOP_NAME = 'BROWN';
// Optional: put the shop's WhatsApp number (digits only, with country code, e.g. '855123456789').
// When set, the customer gets a button that sends the order to the shop. Leave '' to hide it.
const SHOP_WHATSAPP = '';
const MENU_IMAGE_BASE = 'https://www.browncoffee.com.kh/uploads/ximg/item_menus/';
const HIDDEN_STATUSES = [0];            // menu `status` values to hide (0 = test/inactive, 3 = live)
const ORDER_TTL_MS = 7 * 24 * 3600 * 1000;   // orders kept on this device for 7 days
const MAX_ORDER_QTY = 1;                // exactly one product, quantity one, per order
const MODAL_CLOSE_MS = 280;             // must match the slideDown / fadeOut time in the CSS

// =====================================================================
// Helpers: storage, escaping, rate limiting
// =====================================================================
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = (v) => '$' + (Number(v) || 0).toFixed(2);
// Discount: menu_discount is a percent (20 = 20% off). The price after discount is always calculated here.
const discOf = (item) => Math.min(100, Math.max(0, Number(item && item.discount) || 0));
const finalPrice = (item) => Math.round((parseFloat(item && item.price) || 0) * 100 * (100 - discOf(item)) / 100) / 100;
const priceHtml = (item) => discOf(item) > 0
  ? `<span class="price-wrap"><span class="menu-price">${money(finalPrice(item))}</span><s class="price-old">${money(item.price)}</s></span>`
  : `<span class="menu-price">${money(item.price)}</span>`;
const discBadge = (item) => discOf(item) > 0 ? `<span class="disc-badge">-${esc(discOf(item))}%</span>` : '';
const safeImg = (u) => /^https:\/\//i.test(u || '') ? u : '';
const photo = (item) => safeImg(item.item_picture)
  ? `<img src="${esc(safeImg(item.item_picture))}" loading="lazy" referrerpolicy="no-referrer" alt="${esc(item.item_name)}">`
  : '<div class="menu-placeholder">☕</div>';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};

// Client-side throttle for loyalty card attempts (a speed bump only).
const limiter = {
  left(name) { const s = store.get('rl_' + name, { n: 0, until: 0 }); return Math.max(0, Math.ceil((s.until - Date.now()) / 1000)); },
  fail(name, max, lockSec) {
    const s = store.get('rl_' + name, { n: 0, until: 0 });
    s.n += 1; if (s.n >= max) { s.until = Date.now() + lockSec * 1000; s.n = 0; }
    store.set('rl_' + name, s);
  },
  reset(name) { store.del('rl_' + name); }
};

async function itemKey(groupId, categoryId, itemId) {
  const text = groupId + '\0' + categoryId + '\0' + itemId;
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return encodeURIComponent(groupId + '-' + categoryId + '-' + itemId);
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join(''));

// =====================================================================
// Loading overlay + alert popup
// =====================================================================
const loaderEl = $('loader'), alertEl = $('alertBox');
document.body.appendChild(loaderEl);
document.body.appendChild(alertEl);

let loadingCount = 0;
function showLoading(text) {
  loadingCount++;
  $('loaderText').textContent = text || 'Please wait…';
  loaderEl.classList.add('open');
}
function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (!loadingCount) loaderEl.classList.remove('open');
}

let alertAfter = null;
// type: 'error' (default), 'info' or 'ok'.  `after` runs when the popup is closed.
function showAlert(title, message, type, after) {
  type = type || 'error';
  $('alertInner').className = 'alert-box ' + type;
  $('alertIcon').textContent = type === 'ok' ? '✓' : type === 'info' ? 'i' : '!';
  $('alertTitle').textContent = title || 'Something went wrong';
  $('alertMsg').textContent = message || '';
  alertAfter = typeof after === 'function' ? after : null;
  alertEl.classList.add('open');
  $('alertOk').focus();
}
function closeAlert() {
  if (!alertEl.classList.contains('open')) return;
  alertEl.classList.remove('open');
  const cb = alertAfter; alertAfter = null;
  if (cb) cb();
}

function friendlyError(e) {
  if (e instanceof TypeError) return 'Could not connect to the shop API. Please try again.';
  return (e && e.message) || 'Something went wrong. Please try again.';
}

// =====================================================================
// 1. Menu — read from data.json
// =====================================================================
const lookup = {};
let menuPages = [], currentPage = 0;
let DATA = null;

function showError(msg) { const b = $('menu-error'); b.textContent = msg; b.style.display = 'block'; $('menu-count').textContent = ''; }

function setMenuLoading() {
  $('menu-root').innerHTML = '<div class="menu-loading"><div class="spinner"></div><p>Loading menu…</p></div>';
}
function menuFailed(msg) {
  showError(msg);
  $('menu-root').innerHTML = `<div class="menu-loading"><p>${esc(msg)}</p><button type="button" class="btn btn-primary" id="btnRetry" style="flex:none;width:200px">Try again</button></div>`;
  $('btnRetry').onclick = loadMenu;
  showAlert('Menu unavailable', msg, 'error');
}

// menu_picture is a bare filename (or the string "null"); build a full https URL or return '' for the placeholder.
function menuPicture(p) {
  p = String(p || '').trim();
  if (!p || p === 'null') return '';
  if (/^https:\/\//i.test(p)) return p;
  return MENU_IMAGE_BASE ? MENU_IMAGE_BASE + encodeURIComponent(p) : '';
}

// Loads the API menu once. Menu rows: {result:{data:[...]}}, {data:[...]} or a plain array.
async function fetchData() {
  if (DATA) return DATA;
  const res = await fetch(DATA_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not read data.json (HTTP ' + res.status + ').');
  let json;
  try { json = await res.json(); } catch (e) { throw new Error('data.json is not valid JSON.'); }
  DATA = json;
  return DATA;
}
function menuRows(json) {
  const batch = Array.isArray(json) ? json
    : Array.isArray(json.data) ? json.data
    : (json.result && Array.isArray(json.result.data)) ? json.result.data
    : [];
  const rows = [], seen = new Set();
  for (const m of batch) {
    const k = m.id_menu_group + '|' + m.id_menu_category + '|' + m.id_menu;
    if (!seen.has(k)) { seen.add(k); rows.push(m); }
  }
  return rows;
}


// Flat rows -> groups[].categories[].items[]
function buildGroups(rows) {
  const groups = new Map();
  for (const m of rows) {
    if (!m || m.id_menu === undefined || m.id_menu === null) continue;
    if (HIDDEN_STATUSES.includes(Number(m.status))) continue;
    if (m.deleted_date && !String(m.deleted_date).startsWith('1900')) continue;   // soft-deleted
    let g = groups.get(m.id_menu_group);
    if (!g) groups.set(m.id_menu_group, g = { group_id: m.id_menu_group, group_name: m.group_name, cats: new Map() });
    let c = g.cats.get(m.id_menu_category);
    if (!c) g.cats.set(m.id_menu_category, c = { category_id: m.id_menu_category, category_name: m.category_name, items: [] });
    c.items.push({
      item_id: m.id_menu, item_name: m.menu_name, price: m.menu_price, discount: Number(m.menu_discount) || 0,
      item_picture: menuPicture(m.menu_picture), _order: Number(m.index_number) || 0,
      // sold out only when a stock value is present and it is 0 or less
      out_of_stock: m.menu_stock !== undefined && m.menu_stock !== null && m.menu_stock !== '' && Number(m.menu_stock) <= 0
    });
  }
  return [...groups.values()].map(g => ({
    group_id: g.group_id, group_name: g.group_name,
    categories: [...g.cats.values()].map(c => ({ ...c, items: c.items.sort((a, b) => a._order - b._order) }))
  }));
}

async function loadMenu() {
  $('menu-error').style.display = 'none';
  $('menu-count').textContent = 'Loading…';
  setMenuLoading();
  DATA = null;

  let groups;
  try { groups = buildGroups(menuRows(await fetchData())); }
  catch (err) { return menuFailed('Could not load the menu. ' + friendlyError(err)); }
  if (!groups.length) return menuFailed('The menu has no items right now.');

  const pages = []; let total = 0;
  for (const [gi, group] of groups.entries()) {
    const groupId = String(group.group_id ?? gi), groupName = group.group_name || 'Menu';
    let html = '', count = 0;
    for (const [ci, cat] of (group.categories || []).entries()) {
      const categoryId = String(cat.category_id ?? ci), categoryName = cat.category_name || 'Other';
      const cards = [];
      for (const item of (cat.items || [])) {
        if (!item || item.item_id === undefined) continue;
        const key = await itemKey(groupId, categoryId, String(item.item_id));
        lookup[key] = { key, item, group: groupName, category: categoryName, groupId, categoryId };
        total++; count++;
        cards.push(`
          <a class="menu-card${item.out_of_stock ? ' sold-out' : ''}" href="#" data-key="${esc(key)}">
            <div class="menu-photo">${photo(item)}${item.out_of_stock ? '<span class="sold-badge">Out of stock</span>' : ''}${discBadge(item)}</div>
            <div class="menu-card-content">
              <p class="menu-card-name">${esc(item.item_name || 'Untitled item')}</p>
              <div class="menu-card-bottom">${priceHtml(item)}
                ${item.out_of_stock ? '<span class="menu-action sold-action">Out of stock</span>' : '<span class="menu-action">Add +</span>'}</div>
            </div></a>`);
      }
      if (cards.length) html += `<section class="menu-section"><div class="menu-section-heading"><h2>${esc(categoryName)}</h2><span>${esc(groupName)}</span></div><div class="menu-grid">${cards.join('')}</div></section>`;
    }
    if (html) pages.push({ name: groupName, html, count });
  }
  menuPages = pages;
  $('menu-count').textContent = total + ' menu entries';
  // drop saved lines that no longer exist or are now sold out
  cart = cart.filter(l => lookup[l.k] && !lookup[l.k].item.out_of_stock);
  saveCart(); renderPage(0);
}

function pagerHtml() {
  const last = menuPages.length - 1;
  return `<nav class="pager" aria-label="Menu groups">
    <button type="button" data-p="prev" ${currentPage === 0 ? 'disabled' : ''}>‹ Prev</button>
    ${menuPages.map((p, i) => `<button type="button" data-p="${i}" class="${i === currentPage ? 'on' : ''}">${esc(p.name)}</button>`).join('')}
    <button type="button" data-p="next" ${currentPage === last ? 'disabled' : ''}>Next ›</button></nav>`;
}
function renderPage(i) {
  if (!menuPages.length) { $('menu-root').innerHTML = '<p>No menu items available.</p>'; return; }
  currentPage = Math.min(Math.max(0, i), menuPages.length - 1);
  const p = menuPages[currentPage];
  $('menu-root').innerHTML = `${menuPages.length > 1 ? pagerHtml() : ''}
    <div class="menu-muted" style="margin:0 0 16px">Group ${currentPage + 1} of ${menuPages.length} · ${esc(p.name)} · ${p.count} items</div>
    ${p.html}${menuPages.length > 1 ? pagerHtml() : ''}`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// =====================================================================
// 2. Cart  (stores only item key + qty; prices always come from the live menu API)
// =====================================================================
let cart = store.get('brown_cart', []).filter(l => l && typeof l.k === 'string' && l.q > 0);
const saveCart = () => { store.set('brown_cart', cart); updateFab(); };
const cartCount = () => cart.reduce((n, l) => n + l.q, 0);
const cartCents = () => cart.reduce((s, l) => s + Math.round((lookup[l.k] ? finalPrice(lookup[l.k].item) : 0) * 100) * l.q, 0);
const limitAlert = () => showAlert('Limit reached', `You can order up to ${MAX_ORDER_QTY} items per order.`, 'info');
function addToCart(key, qty) {
  if (cartCount() + qty > MAX_ORDER_QTY) { limitAlert(); return false; }
  const l = cart.find(x => x.k === key);
  if (l) l.q += qty; else cart.push({ k: key, q: qty });
  saveCart();
  return true;
}
function updateFab() {
  const f = $('cartFab'), n = cartCount();
  f.classList.toggle('show', n > 0);
  f.textContent = `🛒 Cart · ${n} item${n === 1 ? '' : 's'} · ${money(cartCents() / 100)}`;
}

// =====================================================================
// Modal plumbing  (opens by sliding up from the bottom, closes by sliding back down)
// =====================================================================
const modal = $('modal'), body = $('modalBody');
document.body.appendChild(modal);
let closeTimer = null;
const flow = { loyalty: null, details: { name: '', phone: '' } };

function openModal() {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }   // reopened while it was still closing
  modal.classList.remove('closing');
  modal.classList.add('open'); document.body.style.overflow = 'hidden';
}
function closeModal() {
  flow.loyalty = null;            // never keep card/serial material around after closing
  if (!modal.classList.contains('open') || closeTimer) return;
  modal.classList.add('closing');
  closeTimer = setTimeout(() => {
    closeTimer = null;
    modal.classList.remove('open', 'closing');
    document.body.style.overflow = '';
  }, MODAL_CLOSE_MS);
}
function setHead(title, steps, active) {
  $('modalHeadTitle').textContent = title;
  const s = $('steps');
  if (!steps) { s.style.display = 'none'; return; }
  s.style.display = 'flex';
  s.innerHTML = steps.map((t, i) => `<span class="${i + 1 < active ? 'done' : i + 1 === active ? 'on' : ''}">${i + 1}. ${esc(t)}</span>`).join('');
}
const STEPS = ['Cart', 'Details', 'Receipt'];

// ---- add-to-cart dialog ----
function openItem(key) {
  const e = lookup[key]; if (!e || e.item.out_of_stock) return;   // sold-out items cannot be added
  if (cartCount() >= MAX_ORDER_QTY) return limitAlert();
  const room = MAX_ORDER_QTY - cartCount();                       // how many more can still be added
  let qty = 1;
  setHead('Add to cart'); openModal();
  body.innerHTML = `
    <div class="selected-product"><div class="menu-photo">${photo(e.item)}</div>
      <div><h3>${esc(e.item.item_name)}</h3><p>${esc(e.group)} / ${esc(e.category)}</p><div>${priceHtml(e.item)}</div></div></div>
    <div class="qty-row"><strong>Quantity</strong><div class="qty-buttons">
      <button type="button" id="qm" aria-label="Decrease">−</button><strong id="ql">1</strong><button type="button" id="qp" aria-label="Increase">+</button></div></div>
    <div class="btn-row"><button type="button" class="btn btn-ghost" id="bCancel">Cancel</button><button type="button" class="btn btn-primary" id="bAdd">Add to cart</button></div>`;
  $('qm').onclick = () => { qty = Math.max(1, qty - 1); $('ql').textContent = qty; };
  $('qp').onclick = () => { if (qty >= room) return limitAlert(); qty += 1; $('ql').textContent = qty; };
  $('bCancel').onclick = closeModal;
  $('bAdd').onclick = () => { if (addToCart(key, qty)) closeModal(); };
}

// ---- step 1: cart ----
function renderCart() {
  setHead('Your cart', STEPS, 1); openModal();
  if (!cart.length) {
    body.onclick = null;
    body.innerHTML = `<p style="text-align:center;color:#a39a8b;margin:40px 0">Your cart is empty.</p>
      <div class="btn-row"><button type="button" class="btn btn-ghost" id="bClose">Close</button></div>`;
    $('bClose').onclick = closeModal; return;
  }
  body.innerHTML = cart.map(l => {
    const e = lookup[l.k];
    return `<div class="cart-line"><div class="menu-photo">${photo(e.item)}</div>
      <div class="grow"><strong>${esc(e.item.item_name)}</strong><div style="font-size:14px">${priceHtml(e.item)}</div>
        <button type="button" class="rm" data-rm="${esc(l.k)}">Remove</button></div>
      <div class="qty-buttons"><button type="button" data-dec="${esc(l.k)}">−</button><strong>${l.q}</strong><button type="button" data-inc="${esc(l.k)}">+</button></div></div>`;
  }).join('') + `
    <div class="total-row"><span>Total</span><span>${money(cartCents() / 100)}</span></div>
    <p class="checkout-info" style="margin-top:0">One item per order.</p>
    <div class="btn-row"><button type="button" class="btn btn-ghost" id="bMore">Add more</button><button type="button" class="btn btn-primary" id="bNext">Continue →</button></div>`;
  body.onclick = (ev) => {
    const t = ev.target, rm = t.dataset.rm, dec = t.dataset.dec, inc = t.dataset.inc;
    if (!rm && !dec && !inc) return;
    const l = cart.find(x => x.k === (rm || dec || inc));
    if (!l) return;
    if (rm) cart = cart.filter(x => x !== l);
    else if (dec) l.q = l.q - 1;
    else { if (cartCount() >= MAX_ORDER_QTY) return limitAlert(); l.q += 1; }
    cart = cart.filter(x => x.q > 0); saveCart(); renderCart();
  };
  $('bMore').onclick = closeModal;
  $('bNext').onclick = renderDetails;
}

// ---- step 2: details + loyalty card (checked for previous use through the API) ----
function renderDetails() {
  setHead('Your details', STEPS, 2); body.onclick = null;
  const L = flow.loyalty;
  body.innerHTML = `
    <label class="field"><span>Name *</span><input id="fName" maxlength="60" autocomplete="name" value="${esc(flow.details.name)}"></label>
    <label class="field"><span>Phone *</span><input id="fPhone" type="tel" maxlength="20" autocomplete="tel" value="${esc(flow.details.phone)}"></label>
    <div id="lyBox">${L ? loyaltyOk(L) : `
      <label class="field"><span>Card number *</span><input id="lyCard" inputmode="numeric" maxlength="32" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>Serial number *</span><input id="lySerial" type="password" maxlength="32" autocomplete="off" spellcheck="false"></label>
      <button type="button" class="btn btn-ghost" id="lyBtn" style="width:100%">Verify card</button>`}</div>
    <div class="btn-row"><button type="button" class="btn btn-ghost" id="bBack">← Back</button><button type="button" class="btn btn-primary" id="bPlace">Place order</button></div>`;
  $('bBack').onclick = () => { keepDetails(); renderCart(); };
  $('bPlace').onclick = placeOrder;
  if (L) $('lyRemove').onclick = () => { keepDetails(); flow.loyalty = null; renderDetails(); };
  else $('lyBtn').onclick = verifyLoyalty;
}
const keepDetails = () => { flow.details = { name: $('fName').value.trim(), phone: $('fPhone').value.trim() }; };
const loyaltyOk = (L) => `<div class="ly-card">
    <div class="ly-check">✓</div>
    <div class="ly-info"><strong>Card verified</strong><span>${esc(L.masked)}${L.name ? ' · ' + esc(L.name) : ''}</span></div>
    ${L.points !== undefined && L.points !== null && L.points !== '' ? `<div class="ly-points"><b>${esc(L.points)}</b><small>points</small></div>` : ''}
    <button type="button" class="link-btn" id="lyRemove">Remove</button>
  </div>`;

async function verifyLoyalty() {
  const btn = $('lyBtn');
  const card = $('lyCard').value.replace(/[^\w-]/g, ''), serial = $('lySerial').value.replace(/[^\w-]/g, '');
  const wait = limiter.left('loyalty');
  if (wait) return showAlert('Too many attempts', `Please try again in ${wait} seconds.`, 'error');
  if (card.length < 4 || serial.length < 2) return showAlert('Card details needed', 'Enter both the card number and the serial number.', 'info');
  btn.disabled = true; showLoading('Verifying card…');
  try {
    const response = await fetch('/api/loyalty', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({card_number: card, serial_number: serial}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not check card details.');
    limiter.reset('loyalty');
    keepDetails();
    flow.loyalty = { masked: '•••• ' + card.slice(-4), card, serial };
    renderDetails();
  } catch (e) {
    if (e instanceof TypeError) {
      showAlert('Connection problem', friendlyError(e), 'error');
    } else {
      limiter.fail('loyalty', 5, 300);
      showAlert('Card unavailable', e.message || 'Could not check card details.', 'error');
    }
    btn.disabled = false;
  } finally { hideLoading(); }
}

// =====================================================================
// 3. Place order — created in the browser and saved on this device
// =====================================================================
const orders = {
  all() { const now = Date.now(); const a = store.get('brown_orders', []).filter(o => now - o.at < ORDER_TTL_MS); store.set('brown_orders', a); return a; },
  add(o) { const a = orders.all().filter(x => x.ref !== o.ref); a.unshift(o); store.set('brown_orders', a); updateOrdersBadge(); },
  clear() { store.del('brown_orders'); updateOrdersBadge(); }
};
function updateOrdersBadge() {
  const n = orders.all().length, b = $('ordersCount');
  b.textContent = n; b.hidden = n === 0;
}
const shortRef = (ref) => '#' + String(ref).slice(-6).toUpperCase();

async function placeOrder() {
  keepDetails();
  if (!cart.length) return showAlert('Cart is empty', 'Add an item to your cart first.', 'info');
  if (!flow.details.name) return showAlert('Name needed', 'Please enter your name.', 'info');
  if (!flow.details.phone) return showAlert('Phone number needed', 'Please enter your phone number.', 'info');
  if (!flow.loyalty) return showAlert('Verify card first', 'Enter and check your card number and serial number before ordering.', 'info');
  if (cart.length !== 1 || cart[0].q !== 1) return showAlert('One product only', 'Each order must contain exactly one product, quantity one.', 'info');
  const lines = cart.filter(l => lookup[l.k]).map(l => {
    const it = lookup[l.k].item, unit = finalPrice(it);
    return { id_menu: String(it.item_id), name: it.item_name, qty: l.q, unit, total: Math.round(unit * 100) * l.q / 100 };
  });
  if (!lines.length) return showAlert('Cart is empty', 'Add an item to your cart first.', 'info');
  const total = lines.reduce((s, x) => s + Math.round(x.total * 100), 0) / 100;
  const o = {
    ref: uuid(), at: Date.now(),
    name: flow.details.name, phone: flow.details.phone,
    loyalty: flow.loyalty ? flow.loyalty.masked : '', items: lines, total
  };
  const btn = $('bPlace');
  if (btn) btn.disabled = true;
  showLoading('Saving order and updating stock…');
  try {
    const res = await fetch('/api/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: o.ref, name: o.name, phone: o.phone, card_number: flow.loyalty.card, serial_number: flow.loyalty.serial,
        items: lines.map(x => ({ id_menu: x.id_menu, qty: x.qty })) })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Could not place order.');
    orders.add(result.order);
    cart = []; saveCart(); flow.loyalty = null;
    DATA = null;
    renderDone(result.order);
    loadMenu();
  } catch (err) {
    showAlert('Order not placed', friendlyError(err));
  } finally { hideLoading(); if (btn) btn.disabled = false; }
}

// WhatsApp message text for the shop (only used when SHOP_WHATSAPP is set)
function orderText(o) {
  return [`New order ${shortRef(o.ref)}`, `Name: ${o.name}`, o.phone ? `Phone: ${o.phone}` : '',
    ...o.items.map(i => `${i.qty} x ${i.name} - ${money(i.total)}`), `Total: ${money(o.total)}`].filter(Boolean).join('\n');
}
const waLink = (o) => 'https://wa.me/' + encodeURIComponent(SHOP_WHATSAPP) + '?text=' + encodeURIComponent(orderText(o));
const waButton = (o) => SHOP_WHATSAPP
  ? `<a class="btn btn-primary" style="display:block;flex:none;text-align:center;text-decoration:none;margin:0 0 10px" href="${esc(waLink(o))}" target="_blank" rel="noopener noreferrer">Send order to the shop (WhatsApp)</a>` : '';

// ---- step 3: receipt ----
function renderDone(o) {
  setHead('Order saved', STEPS, 4); body.onclick = null; openModal();
  body.innerHTML = `
    <div class="success"><div class="success-check">✓</div><h3>Order placed!</h3><p>Your order was saved by the shop. A copy is also kept on this device.</p></div>
    <div class="ticket">
      <div class="ticket-top"><div><span>Order</span><strong>${esc(shortRef(o.ref))}</strong></div></div>
      ${o.items.map(i => `<div class="summary-row"><span>${esc(i.qty)} × ${esc(i.name)}</span><span>${money(i.total)}</span></div>`).join('')}
      <div class="total-row"><span>Total</span><span>${money(o.total)}</span></div>
    </div>
    ${waButton(o)}
    <div class="btn-row"><button type="button" class="btn btn-ghost" id="bTrack">View order</button><button type="button" class="btn btn-primary" id="bReceipt">Download receipt</button></div>`;
  $('bTrack').onclick = () => renderOrderDetail(o);
  $('bReceipt').onclick = () => downloadReceipt(o);
}

// =====================================================================
// 4. My orders (saved on this device only)
// =====================================================================
function renderMyOrders() {
  const list = orders.all();
  setHead(list.length ? `My orders (${list.length})` : 'My orders'); openModal();
  body.innerHTML = `
    ${list.length ? list.map(o => `<button type="button" class="order-row" data-ref="${esc(o.ref)}"><span><strong>${esc(shortRef(o.ref))}</strong><br><small style="color:#a39a8b">${esc(new Date(o.at).toLocaleString())}</small></span><span class="menu-price" style="color:#b8860b">${money(o.total)}</span></button>`).join('')
      : '<p style="color:#a39a8b;text-align:center;margin:18px 0">No orders on this device.</p>'}
    <div class="btn-row"><button type="button" class="btn btn-ghost" id="bForget">Clear my orders</button><button type="button" class="btn btn-primary" id="bClose2">Close</button></div>`;
  body.onclick = (ev) => {
    const row = ev.target.closest('.order-row'); if (!row) return;
    const o = orders.all().find(x => x.ref === row.dataset.ref); if (o) renderOrderDetail(o);
  };
  $('bForget').onclick = () => { orders.clear(); renderMyOrders(); };
  $('bClose2').onclick = closeModal;
}

function renderOrderDetail(o) {
  setHead('Order ' + shortRef(o.ref)); body.onclick = null; openModal();
  body.innerHTML = `
    <div class="summary-row"><span>Placed</span><span>${esc(new Date(o.at).toLocaleString())}</span></div>
    <div class="summary-row"><span>Name</span><span>${esc(o.name)}</span></div>
    ${o.phone ? `<div class="summary-row"><span>Phone</span><span>${esc(o.phone)}</span></div>` : ''}
    ${o.loyalty ? `<div class="summary-row"><span>Loyalty card</span><span>${esc(o.loyalty)}</span></div>` : ''}
    <h4>Items</h4>
    ${o.items.map(i => `<div class="summary-row"><span>${esc(i.qty)} × ${esc(i.name)}</span><span>${money(i.total)}</span></div>`).join('')}
    <div class="total-row"><span>Total</span><span>${money(o.total)}</span></div>
    ${waButton(o)}
    <div class="btn-row"><button type="button" class="btn btn-ghost" id="bBackList">← My orders</button>
      <button type="button" class="btn btn-primary" id="bReceipt">Download receipt</button></div>`;
  $('bBackList').onclick = renderMyOrders;
  $('bReceipt').onclick = () => downloadReceipt(o);
}

// =====================================================================
// 5. Receipt download — an HTML file built in the browser
// =====================================================================
function receiptHtml(o) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Receipt ${esc(shortRef(o.ref))}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:30px auto;padding:0 16px;color:#3d2b22}
h1{margin:0 0 4px;font-size:22px}.m{color:#7a6a58;font-size:13px;margin:2px 0}
table{width:100%;border-collapse:collapse;margin:16px 0}td{padding:6px 0;border-bottom:1px dashed #d9cdb8;font-size:14px}td:last-child{text-align:right}
.t td{font-weight:700;font-size:16px;border-bottom:0}</style></head><body>
<h1>${esc(SHOP_NAME)}</h1><p class="m">Order ${esc(shortRef(o.ref))}</p><p class="m">${esc(new Date(o.at).toLocaleString())}</p>
<p class="m">Customer: ${esc(o.name)}${o.phone ? ' · ' + esc(o.phone) : ''}</p>${o.loyalty ? `<p class="m">Loyalty card: ${esc(o.loyalty)}</p>` : ''}
<table>${o.items.map(i => `<tr><td>${esc(i.qty)} × ${esc(i.name)}</td><td>${money(i.total)}</td></tr>`).join('')}
<tr class="t"><td>Total</td><td>${money(o.total)}</td></tr></table>
<p class="m">Thank you!</p></body></html>`;
}
function downloadReceipt(o) {
  try {
    const url = URL.createObjectURL(new Blob([receiptHtml(o)], { type: 'text/html' }));
    const a = document.createElement('a'); a.href = url; a.download = 'receipt-' + String(o.ref).replace(/[^\w.-]/g, '_') + '.html';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { showAlert('Download failed', 'Could not download the receipt. Please try again.', 'error'); }
}

// =====================================================================
// Events
// =====================================================================
$('menu-root').addEventListener('click', ev => {
  const btn = ev.target.closest('.pager button');
  if (btn) { if (btn.disabled) return; const p = btn.dataset.p; return renderPage(p === 'prev' ? currentPage - 1 : p === 'next' ? currentPage + 1 : parseInt(p, 10)); }
  const card = ev.target.closest('.menu-card');
  if (card) { ev.preventDefault(); openItem(card.dataset.key); }
});
$('cartFab').onclick = renderCart;
$('btnMyOrders').onclick = renderMyOrders;
$('modalClose').onclick = closeModal;
$('alertOk').onclick = closeAlert;
alertEl.addEventListener('mousedown', ev => { if (ev.target === alertEl) closeAlert(); });
modal.addEventListener('mousedown', ev => { if (ev.target === modal) closeModal(); });
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  if (alertEl.classList.contains('open')) closeAlert();           // the popup closes first, then the dialog under it
  else if (modal.classList.contains('open')) closeModal();
});
// The script is loaded with `defer`, so the DOM is already parsed here.
updateFab(); updateOrdersBadge(); loadMenu();
