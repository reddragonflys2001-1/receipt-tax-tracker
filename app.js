'use strict';
const STORAGE_KEY = 'receipt-tax-tracker-v1';
const GOOGLE_CLIENT_ID = '478639604325-3vtre31j0k863i6uif25mt50e4cs9j4l.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const BACKUP_FILE_NAME = 'Receipt-Tax-Tracker-Backup.json';
const FOLDER_NAME = 'Receipt Tax Tracker';

const form = document.querySelector('#receipt-form');
const itemsBox = document.querySelector('#items');
const taxesBox = document.querySelector('#taxes');
const receiptsList = document.querySelector('#receipts-list');
const driveStatus = document.querySelector('#drive-status');
const driveMessage = document.querySelector('#drive-message');
const connectButton = document.querySelector('#connect-drive');
const backupButton = document.querySelector('#backup-drive');
const restoreButton = document.querySelector('#restore-drive');

let receipts = loadReceipts();
let pendingPhoto = '';
let editId = null;
let tokenClient = null;
let accessToken = '';
let driveFolderId = '';

const money = value => Number(value || 0).toFixed(2);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function loadReceipts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(receipts));
    renderReceipts();
    return true;
  } catch (error) {
    alert('The browser could not save these records. A receipt photo may be too large for browser storage. Download a backup if possible, then try a smaller image.');
    return false;
  }
}
function setDriveMessage(text, error = false) {
  driveMessage.textContent = text;
  driveMessage.classList.toggle('error', error);
}
function setConnected(connected) {
  driveStatus.textContent = connected ? 'Connected for this session' : 'Not connected';
  driveStatus.classList.toggle('connected', connected);
  backupButton.disabled = !connected;
  restoreButton.disabled = !connected;
}
const TAX_TYPES = ['State sales tax','Local sales tax','Special/district tax','Product-specific tax','Washington State Fuel Tax','Federal Fuel Tax','Other tax'];
// Published Washington DOL gasoline and highway diesel rates, through Dec 2026.
// Do not guess rates outside supported dates or for other fuels.
const FUEL_RATE_SOURCE = 'https://dol.wa.gov/vehicles-and-boats/prorate-and-fuel-tax/fuel-tax/fuel-licenses/fuel-licenses-motor-vehicle-fuel-or-special-fuel';
const FUEL_RATES = [
  {start:'2026-01-01', end:'2026-06-30', Gasoline:{state:0.554,federal:0.184}, Diesel:{state:0.584,federal:0.244}},
  {start:'2026-07-01', end:'2026-12-31', Gasoline:{state:0.565,federal:0.184}, Diesel:{state:0.595,federal:0.244}}
];
const FUEL_TAX_NAMES = ['Washington State Fuel Tax', 'Federal Fuel Tax'];
const roundCents = n => Math.round((n + Number.EPSILON) * 100) / 100;
function applicableFuelRates() {
  if (form.elements.category.value !== 'Gas and vehicle') return null;
  const date = form.elements.date.value;
  const fuel = form.elements.fuelType.value;
  const gallons = Number(form.elements.gallons.value);
  if (!date || !['Gasoline','Diesel'].includes(fuel) || !Number.isFinite(gallons) || gallons <= 0) return null;
  const period = FUEL_RATES.find(p => date >= p.start && date <= p.end);
  return period ? {period, fuel, gallons, ...period[fuel]} : null;
}
function fuelTaxRow(name) {
  return [...taxesBox.querySelectorAll('.tax-row')].find(row => row.dataset.autoFuelTax === name);
}
function refreshFuelEstimates() {
  const notice = document.querySelector('#fuel-estimate-status');
  const rates = applicableFuelRates();
  if (!rates) {
    notice.textContent = form.elements.category.value !== 'Gas and vehicle' ? '' : 'Choose a 2026 purchase date, gasoline or diesel, and gallons greater than zero to calculate. Rates for other dates or fuels are not available in this version.';
    // Remove only auto-created rows, never user-entered rows.
    for (const row of taxesBox.querySelectorAll('.tax-row[data-auto-fuel-tax]')) row.remove();
    return;
  }
  const definitions = [
    {name:FUEL_TAX_NAMES[0], amount:roundCents(rates.gallons * rates.state), jurisdiction:'Washington', rate:rates.state},
    {name:FUEL_TAX_NAMES[1], amount:roundCents(rates.gallons * rates.federal), jurisdiction:'United States', rate:rates.federal}
  ];
  for (const item of definitions) {
    let row = fuelTaxRow(item.name);
    if (!row) {
      // If an existing receipt has a matching saved line, preserve it instead of duplicating it.
      row = [...taxesBox.querySelectorAll('.tax-row')].find(r => r.querySelector('[data-key="name"]').value === item.name && r.querySelector('[data-key="source"]').value === 'Calculated estimate');
    }
    if (!row) {
      addTax({name:item.name, amount:item.amount, taxType:item.name, jurisdiction:item.jurisdiction, source:'Calculated estimate'});
      row = taxesBox.lastElementChild;
    } else if (row.dataset.autoFuelTax === item.name && row.dataset.userEdited !== 'true') {
      row.querySelector('[data-key="amount"]').value = item.amount.toFixed(2);
    }
    row.dataset.autoFuelTax = item.name;
    row.querySelector('[data-key="name"]').value = item.name;
    row.querySelector('[data-key="taxType"]').value = item.name;
    row.querySelector('[data-key="jurisdiction"]').value = item.jurisdiction;
    row.querySelector('[data-key="source"]').value = 'Calculated estimate';
    row.dataset.rate = String(item.rate);
    row.dataset.ratePeriod = `${rates.period.start} to ${rates.period.end}`;
  }
  notice.textContent = `Estimated taxes included in the pump price. Washington $${rates.state.toFixed(3)}/gal; federal $${rates.federal.toFixed(3)}/gal (${rates.period.start} through ${rates.period.end}). Review/edit amounts before saving. Rates: Washington DOL.`;
}
for (const name of ['date','fuelType','gallons']) form.elements[name].addEventListener('change', refreshFuelEstimates);
form.elements.gallons.addEventListener('input', refreshFuelEstimates);

function addTax(data = {}) {
  const row = document.createElement('div');
  row.className = 'line-row tax-row';
  const type = data.taxType || 'Other tax';
  const source = data.source || 'Printed on receipt';
  row.innerHTML = `<label>Tax name<input data-key="name" placeholder="Local sales tax" value="${escapeHtml(data.name || '')}"></label>
    <label>Amount ($)<input data-key="amount" type="number" min="0" step="0.01" placeholder="0.00" value="${escapeHtml(data.amount ?? '')}"></label>
    <label>Tax type<select data-key="taxType">${TAX_TYPES.map(t => `<option ${t === type ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select></label>
    <label>Jurisdiction<input data-key="jurisdiction" placeholder="Washington / Seattle" value="${escapeHtml(data.jurisdiction || '')}"></label>
    <label>Recorded as<select data-key="source"><option ${source === 'Printed on receipt' ? 'selected' : ''}>Printed on receipt</option><option ${source === 'Calculated estimate' ? 'selected' : ''}>Calculated estimate</option></select></label>
    <button type="button" class="secondary">Remove</button>`;
  row.querySelector('button').addEventListener('click', () => row.remove());
  taxesBox.append(row);
  row.querySelector('[data-key="amount"]').addEventListener('input', () => { if (row.dataset.autoFuelTax) row.dataset.userEdited = 'true'; });
}
function addItem(data = {}) {
  const row = document.createElement('div');
  row.className = 'line-row item-row';
  row.innerHTML = `<label>Item description<input data-key="name" placeholder="Product" value="${escapeHtml(data.name || '')}"></label>
    <label>Quantity<input data-key="qty" type="number" min="0" step="0.001" value="${escapeHtml(data.qty ?? 1)}"></label>
    <label>Price ($)<input data-key="price" type="number" min="0" step="0.01" value="${escapeHtml(data.price ?? '')}"></label>
    <button type="button" class="secondary">Remove</button>`;
  row.querySelector('button').addEventListener('click', () => row.remove());
  itemsBox.append(row);
}
function getRows(container, className) {
  return [...container.querySelectorAll('.' + className)].map(row => {
    const result = {};
    row.querySelectorAll('[data-key]').forEach(el => result[el.dataset.key] = el.value);
    return result;
  }).filter(row => Object.values(row).some(value => value !== ''));
}
function toggleFuelSection() {
  document.querySelector('#fuel-section').classList.toggle('hidden', form.elements.category.value !== 'Gas and vehicle');
  refreshFuelEstimates();
}
form.elements.category.addEventListener('change', toggleFuelSection);
document.querySelector('#add-tax').addEventListener('click', () => addTax());
document.querySelector('#add-item').addEventListener('click', () => addItem());

form.elements.photo.addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { pendingPhoto = String(reader.result || ''); };
  reader.onerror = () => alert('The selected image could not be read.');
  reader.readAsDataURL(file);
});

form.addEventListener('submit', event => {
  event.preventDefault();
  const data = new FormData(form);
  const oldRecord = editId ? receipts.find(receipt => receipt.id === editId) : null;
  const record = {
    id: editId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    store: String(data.get('store') || '').trim(),
    date: String(data.get('date') || ''),
    category: String(data.get('category') || ''),
    total: Number(data.get('total') || 0),
    subtotal: data.get('subtotal') === '' ? '' : Number(data.get('subtotal')),
    items: getRows(itemsBox, 'item-row').map(row => ({
      name: row.name, qty: Number(row.qty || 1), price: row.price === '' ? '' : Number(row.price)
    })),
    taxes: [...taxesBox.querySelectorAll('.tax-row')].map(el => {
      const row = Object.fromEntries([...el.querySelectorAll('[data-key]')].map(input => [input.dataset.key, input.value]));
      return {name:row.name, amount:Number(row.amount || 0), taxType:row.taxType, jurisdiction:row.jurisdiction.trim(), source:row.source,
        ...(el.dataset.autoFuelTax ? {fuelTaxRatePerGallon:Number(el.dataset.rate), fuelTaxRatePeriod:el.dataset.ratePeriod, fuelTaxRateSource:FUEL_RATE_SOURCE} : {})};
    }),
    fuelType: data.get('fuelType') || '',
    gallons: data.get('gallons') === '' ? '' : Number(data.get('gallons')),
    pricePerGallon: data.get('pricePerGallon') === '' ? '' : Number(data.get('pricePerGallon')),
    notes: String(data.get('notes') || '').trim(),
    photo: pendingPhoto || oldRecord?.photo || '',
    createdAt: oldRecord?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (editId) receipts = receipts.map(existing => existing.id === editId ? record : existing);
  else receipts.unshift(record);
  if (!persist()) return;
  editId = null;
  form.reset();
  itemsBox.innerHTML = '';
  taxesBox.innerHTML = '';
  pendingPhoto = '';
  form.querySelector('[type="submit"]').textContent = 'Save receipt';
  toggleFuelSection();
});
form.addEventListener('reset', () => {
  setTimeout(() => {
    itemsBox.innerHTML = '';
    taxesBox.innerHTML = '';
    pendingPhoto = '';
    editId = null;
    form.querySelector('[type="submit"]').textContent = 'Save receipt';
    toggleFuelSection();
  }, 0);
});

function renderReceipts() {
  const searchTerm = document.querySelector('#search').value.toLowerCase();
  const yearSelect = document.querySelector('#year-filter');
  const oldYear = yearSelect.value;
  const years = [...new Set(receipts.map(r => String(r.date || '').slice(0, 4)).filter(y => /^\d{4}$/.test(y)))].sort().reverse();
  yearSelect.innerHTML = '<option value="all">All years</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
  yearSelect.value = years.includes(oldYear) ? oldYear : 'all';
  const year = yearSelect.value;
  const filtered = receipts.filter(r =>
    (year === 'all' || String(r.date || '').startsWith(year)) &&
    [r.store, r.notes, r.category].join(' ').toLowerCase().includes(searchTerm)
  );
  renderReports();
  renderMonthlyReports();
  const total = filtered.reduce((sum, r) => sum + Number(r.total || 0), 0);
  document.querySelector('#receipt-count').textContent = `${filtered.length} receipt${filtered.length === 1 ? '' : 's'} · Total $${money(total)}`;
  if (!filtered.length) {
    receiptsList.innerHTML = '<p class="empty">No matching receipts yet.</p>';
    return;
  }
  receiptsList.innerHTML = filtered.map(r => `
    <article class="receipt-card">
      <div class="receipt-top"><strong>${escapeHtml(r.store)}</strong><strong>$${money(r.total)}</strong></div>
      <div class="receipt-meta">${escapeHtml(r.date)} · ${escapeHtml(r.category)}</div>
      <div class="tax-summary">${(r.taxes || []).length} tax line(s) · ${(r.items || []).length} item(s)${r.gallons !== '' && r.gallons != null ? ` · ${escapeHtml(r.gallons)} gal ${escapeHtml(r.fuelType)}` : ''}</div>
      <details><summary>Details, taxes and notes</summary>
        <p><b>Subtotal:</b> ${r.subtotal === '' ? 'Not entered' : '$' + money(r.subtotal)}</p>
        <b>Tax lines</b><ul>${(r.taxes || []).length ? r.taxes.map(t => `<li>${escapeHtml(t.name || 'Unnamed tax')}: $${money(t.amount)} <small>(${escapeHtml(t.taxType || "Other tax")} · ${escapeHtml(t.jurisdiction || "Unspecified jurisdiction")} · ${escapeHtml(t.source || "Printed on receipt")})</small></li>`).join('') : '<li>No tax lines recorded</li>'}</ul>
        <b>Items</b><ul>${(r.items || []).length ? r.items.map(i => `<li>${escapeHtml(i.name)} — quantity ${escapeHtml(i.qty)}, $${money(i.price)}</li>`).join('') : '<li>No items recorded</li>'}</ul>
        <p><b>Notes:</b> ${escapeHtml(r.notes || 'None')}</p>
        ${r.photo ? `<img src="${r.photo}" alt="Receipt photo">` : ''}
        <div class="actions"><button type="button" class="secondary" data-edit="${escapeHtml(r.id)}">Edit</button><button type="button" class="secondary" data-delete="${escapeHtml(r.id)}">Delete</button></div>
      </details>
    </article>`).join('');
  receiptsList.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', () => {
    if (confirm('Delete this receipt?')) {
      receipts = receipts.filter(r => r.id !== button.dataset.delete);
      persist();
    }
  }));
  receiptsList.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => editReceipt(button.dataset.edit)));
}
function editReceipt(id) {
  const receipt = receipts.find(r => r.id === id);
  if (!receipt) return;
  editId = id;
  form.elements.store.value = receipt.store || '';
  form.elements.date.value = receipt.date || '';
  form.elements.category.value = receipt.category || 'Other';
  form.elements.total.value = receipt.total ?? '';
  form.elements.subtotal.value = receipt.subtotal ?? '';
  form.elements.notes.value = receipt.notes || '';
  form.elements.fuelType.value = receipt.fuelType || '';
  form.elements.gallons.value = receipt.gallons ?? '';
  form.elements.pricePerGallon.value = receipt.pricePerGallon ?? '';
  itemsBox.innerHTML = '';
  taxesBox.innerHTML = '';
  (receipt.items || []).forEach(addItem);
  (receipt.taxes || []).forEach(addTax);
  pendingPhoto = '';
  form.elements.photo.value = '';
  form.querySelector('[type="submit"]').textContent = 'Update receipt';
  toggleFuelSection();
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function csvCell(value) { return '"' + String(value ?? '').replace(/"/g, '""') + '"'; }
function renderReports() {
  const selector = document.querySelector('#report-year');
  const previous = selector.value;
  const years = [...new Set(receipts.map(r => String(r.date || '').slice(0,4)).filter(y => /^\d{4}$/.test(y)))].sort().reverse();
  selector.innerHTML = '<option value="all">All years</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
  selector.value = years.includes(previous) ? previous : 'all';
  const selected = receipts.filter(r => selector.value === 'all' || String(r.date || '').startsWith(selector.value));
  const spending = selected.reduce((sum,r) => sum + Number(r.total || 0), 0);
  const byType = new Map(), byJurisdiction = new Map();
  let printed = 0, estimated = 0;
  function accumulate(map, key, amount, isEstimate) {
    const totals = map.get(key) || {printed:0, estimated:0};
    totals[isEstimate ? 'estimated' : 'printed'] += amount;
    map.set(key, totals);
  }
  selected.forEach(r => (r.taxes || []).forEach(t => {
    const amount = Number(t.amount || 0);
    if (!Number.isFinite(amount)) return;
    const isEstimate = t.source === 'Calculated estimate';
    if (isEstimate) estimated += amount; else printed += amount;
    accumulate(byType, FUEL_TAX_NAMES.includes(t.name) && t.source === 'Calculated estimate' ? t.name : (t.taxType || 'Other tax'), amount, isEstimate);
    accumulate(byJurisdiction, t.jurisdiction?.trim() || 'Unspecified jurisdiction', amount, isEstimate);
  }));
  document.querySelector('#report-summary').textContent = `${selected.length} receipts · Spending $${money(spending)} · Printed taxes $${money(printed)} · Estimated taxes $${money(estimated)}`;
  function table(map) {
    if (!map.size) return '<p class="empty">No tax lines recorded for this period.</p>';
    return `<div style="overflow-x:auto"><table class="report-table"><thead><tr><th>Group</th><th>Printed</th><th>Estimated</th></tr></thead><tbody>${[...map].sort((a,b)=>a[0].localeCompare(b[0])).map(([key,v])=>`<tr><td>${escapeHtml(key)}</td><td>$${money(v.printed)}</td><td>$${money(v.estimated)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  document.querySelector('#report-types').innerHTML = table(byType);
  document.querySelector('#report-jurisdictions').innerHTML = table(byJurisdiction);
  const fuel = {Gasoline:{gallons:0, state:0, federal:0, count:0}, Diesel:{gallons:0, state:0, federal:0, count:0}};
  selected.filter(r => r.category === 'Gas and vehicle' && Object.hasOwn(fuel, r.fuelType)).forEach(r => {
    const entry = fuel[r.fuelType];
    const gallons = Number(r.gallons);
    if (Number.isFinite(gallons) && gallons > 0) entry.gallons += gallons;
    entry.count++;
    for (const t of r.taxes || []) {
      if (t.source !== 'Calculated estimate') continue;
      const amount = Number(t.amount);
      if (!Number.isFinite(amount)) continue;
      if (t.name === FUEL_TAX_NAMES[0]) entry.state += amount;
      if (t.name === FUEL_TAX_NAMES[1]) entry.federal += amount;
    }
  });
  const fuelRows = Object.entries(fuel).filter(([,v]) => v.count);
  const fuelSummary = document.querySelector('#report-fuel-summary');
  if (!fuelRows.length) fuelSummary.innerHTML = '<p class="empty">No gasoline or diesel receipts for this period.</p>';
  else {
    const totals = fuelRows.reduce((t,[,v]) => ({gallons:t.gallons+v.gallons,state:t.state+v.state,federal:t.federal+v.federal}), {gallons:0,state:0,federal:0});
    const tr = (name,v) => `<tr><td>${escapeHtml(name)}</td><td>${v.gallons.toFixed(3)}</td><td>$${money(v.state)}</td><td>$${money(v.federal)}</td><td>$${money(v.state+v.federal)}</td></tr>`;
    fuelSummary.innerHTML = `<div style="overflow-x:auto"><table class="report-table"><thead><tr><th>Fuel</th><th>Gallons</th><th>WA state est.</th><th>Federal est.</th><th>Total est.</th></tr></thead><tbody>${fuelRows.map(([name,v]) => tr(name,v)).join('')}${tr('Total',totals)}</tbody></table></div>`;
  }

}

// Monthly reporting uses existing receipt data without modifying stored records.
let monthlySelection = {kind:null, value:null};
const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function renderMonthlyReports() {
  const yearSelect = document.querySelector('#monthly-year');
  const priorYear = yearSelect.value;
  const years = [...new Set(receipts.map(r => String(r.date || '').slice(0,4)).filter(y => /^\d{4}$/.test(y)))].sort().reverse();
  yearSelect.innerHTML = '<option value="all">All years</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
  yearSelect.value = years.includes(priorYear) ? priorYear : 'all';
  const selected = receipts.filter(r => yearSelect.value === 'all' || String(r.date || '').startsWith(yearSelect.value));
  const totals = Array.from({length:12}, (_,i) => ({month:i, spending:0, printed:0, estimated:0, count:0}));
  const categories = new Map();
  const taxAmounts = r => (r.taxes || []).reduce((v,t) => {
    const amount = Number(t.amount || 0);
    if (Number.isFinite(amount)) v[t.source === 'Calculated estimate' ? 'estimated' : 'printed'] += amount;
    return v;
  }, {printed:0, estimated:0});
  selected.forEach(r => {
    const amount = Number(r.total || 0);
    const spend = Number.isFinite(amount) ? amount : 0;
    const category = String(r.category || 'Other');
    const taxes = taxAmounts(r);
    categories.set(category, (categories.get(category) || 0) + spend);
    const month = Number(String(r.date || '').slice(5,7)) - 1;
    if (month >= 0 && month < 12) {
      const row = totals[month]; row.spending += spend; row.printed += taxes.printed;
      row.estimated += taxes.estimated; row.count++;
    }
  });
  const spending = selected.reduce((sum,r) => sum + (Number(r.total) || 0),0);
  const printed = selected.reduce((sum,r) => sum + taxAmounts(r).printed,0);
  const estimated = selected.reduce((sum,r) => sum + taxAmounts(r).estimated,0);
  document.querySelector('#monthly-summary').textContent = `${selected.length} receipts · Spending $${money(spending)} · Printed taxes $${money(printed)} · Estimated taxes $${money(estimated)}`;
  const max = Math.max(1,...totals.map(r => r.spending));
  document.querySelector('#monthly-bars').innerHTML = totals.map(r => `<button type="button" class="monthly-bar${monthlySelection.kind === 'month' && monthlySelection.value === r.month ? ' selected' : ''}" data-month="${r.month}" aria-pressed="${monthlySelection.kind === 'month' && monthlySelection.value === r.month}"><span class="monthly-bar-value">$${money(r.spending)}</span><span class="monthly-bar-track"><span class="monthly-bar-fill" style="height:${Math.max(0,Math.min(100,r.spending/max*100))}%"></span></span><span>${monthNames[r.month]}</span></button>`).join('');
  document.querySelector('#monthly-categories').innerHTML = [...categories].sort((a,b) => b[1]-a[1]).map(([name,value]) => `<button type="button" class="monthly-category${monthlySelection.kind === 'category' && monthlySelection.value === name ? ' selected' : ''}" data-category="${escapeHtml(name)}" aria-pressed="${monthlySelection.kind === 'category' && monthlySelection.value === name}"><span>${escapeHtml(name)}</span><span class="monthly-category-track"><span style="width:${Math.max(0,Math.min(100,value/Math.max(1,spending)*100))}%"></span></span><strong>$${money(value)}</strong></button>`).join('') || '<p class="empty">No categories yet.</p>';
  document.querySelector('#monthly-table').innerHTML = `<div style="overflow-x:auto"><table class="report-table"><thead><tr><th>Month</th><th>Receipts</th><th>Spending</th><th>Printed tax</th><th>Estimated tax</th><th>YTD spending</th></tr></thead><tbody>${totals.map((r,i) => `<tr><td>${monthNames[i]}</td><td>${r.count}</td><td>$${money(r.spending)}</td><td>$${money(r.printed)}</td><td>$${money(r.estimated)}</td><td>$${money(totals.slice(0,i+1).reduce((sum,m) => sum+m.spending,0))}</td></tr>`).join('')}</tbody></table></div>`;
  let filtered = selected;
  if (monthlySelection.kind === 'month') filtered = selected.filter(r => Number(String(r.date || '').slice(5,7))-1 === monthlySelection.value);
  if (monthlySelection.kind === 'category') filtered = selected.filter(r => String(r.category || 'Other') === monthlySelection.value);
  const label = monthlySelection.kind === 'month' ? monthNames[monthlySelection.value] : monthlySelection.kind === 'category' ? monthlySelection.value : 'All receipts';
  document.querySelector('#monthly-filter-label').textContent = `${label} · ${filtered.length} receipt(s) · $${money(filtered.reduce((sum,r) => sum+(Number(r.total)||0),0))}`;
  document.querySelector('#monthly-receipts').innerHTML = filtered.length ? `<div style="overflow-x:auto"><table class="report-table"><thead><tr><th>Date</th><th>Store</th><th>Category</th><th>Amount</th><th>Printed tax</th><th>Estimated tax</th></tr></thead><tbody>${[...filtered].sort((a,b) => String(b.date || '').localeCompare(String(a.date || ''))).map(r => { const t=taxAmounts(r);return `<tr><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.store)}</td><td>${escapeHtml(r.category)}</td><td>$${money(r.total)}</td><td>$${money(t.printed)}</td><td>$${money(t.estimated)}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="empty">No receipts for this selection.</p>';
  document.querySelectorAll('#monthly-bars [data-month]').forEach(button => button.addEventListener('click', () => {const value=Number(button.dataset.month);monthlySelection=monthlySelection.kind==='month'&&monthlySelection.value===value?{kind:null,value:null}:{kind:'month',value};renderMonthlyReports();}));
  document.querySelectorAll('#monthly-categories [data-category]').forEach(button => button.addEventListener('click', () => {const value=button.dataset.category;monthlySelection=monthlySelection.kind==='category'&&monthlySelection.value===value?{kind:null,value:null}:{kind:'category',value};renderMonthlyReports();}));
}
document.querySelector('#monthly-year').addEventListener('change', () => { monthlySelection={kind:null,value:null};renderMonthlyReports(); });
document.querySelector('#monthly-clear').addEventListener('click', () => {monthlySelection={kind:null,value:null};renderMonthlyReports();});

document.querySelector('#report-year').addEventListener('change', renderReports);
document.querySelector('#export-csv').addEventListener('click', () => {
  const headers = ['Store name','Purchase date','Category','Receipt total','Subtotal',
    ...[1,2,3].flatMap(i => [`Tax ${i} name`,`Tax ${i} amount`,`Tax ${i} type`,`Tax ${i} jurisdiction`,`Tax ${i} source`]),
    'All tax lines JSON','Items JSON','Fuel type','Gallons','Price per gallon','Notes','Receipt photo included'];
  const rows = receipts.map(r => [
    r.store, r.date, r.category, r.total, r.subtotal,
    ...[0,1,2].flatMap(i => { const t = r.taxes?.[i]; return [t?.name || '', t?.amount ?? '', t?.taxType || (t ? 'Other tax' : ''), t?.jurisdiction || '', t?.source || '']; }),
    JSON.stringify(r.taxes || []), JSON.stringify(r.items || []), r.fuelType, r.gallons, r.pricePerGallon, r.notes, r.photo ? 'yes' : 'no'
  ]);
  const csv = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
  downloadBlob(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), `receipt-tax-tracker-${new Date().getFullYear()}.csv`);
});
document.querySelector('#backup-json').addEventListener('click', () => {
  const backup = { schemaVersion: 1, exportedAt: new Date().toISOString(), receipts };
  downloadBlob(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }), `receipt-tax-backup-${new Date().toISOString().slice(0,10)}.json`);
});
document.querySelector('#restore-json').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const incoming = Array.isArray(parsed) ? parsed : parsed.receipts;
    if (!Array.isArray(incoming)) throw new Error('Invalid backup format');
    if (confirm(`Import ${incoming.length} receipt(s)? Existing records with matching IDs will be replaced.`)) {
      const merged = new Map(receipts.map(r => [r.id, r]));
      incoming.forEach(r => { if (r && r.id) merged.set(r.id, r); });
      receipts = [...merged.values()];
      persist();
      alert('Backup imported.');
    }
  } catch { alert('Could not import that backup file.'); }
  event.target.value = '';
});
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Google Drive uses Google's browser token client. The access token is kept in memory only.
function initializeGoogleAuth() {
  if (!window.google?.accounts?.oauth2) {
    setTimeout(initializeGoogleAuth, 400);
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: response => {
      if (response.error) {
        setDriveMessage('Google authorization did not complete: ' + response.error, true);
        return;
      }
      accessToken = response.access_token;
      setConnected(true);
      setDriveMessage('Google Drive connected for this browser session. Choose Back up to Drive to upload your saved receipts.');
    }
  });
}
connectButton.addEventListener('click', () => {
  if (!tokenClient) {
    setDriveMessage('Google sign-in is still loading. Wait a moment and try again.', true);
    initializeGoogleAuth();
    return;
  }
  tokenClient.requestAccessToken({ prompt: 'consent' });
});
async function driveFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', 'Bearer ' + accessToken);
  return fetch(url, { ...options, headers });
}
async function ensureDriveFolder() {
  if (driveFolderId) return driveFolderId;
  const query = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const search = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType)&pageSize=100`);
  if (!search.ok) throw new Error(`Could not search Drive folders (HTTP ${search.status}).`);
  const result = await search.json();
  const folder = (result.files || []).find(f => f.name === FOLDER_NAME);
  if (folder) { driveFolderId = folder.id; return driveFolderId; }
  const create = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!create.ok) throw new Error(`Could not create the Drive backup folder (HTTP ${create.status}).`);
  driveFolderId = (await create.json()).id;
  return driveFolderId;
}
async function findBackupFile() {
  const folderId = await ensureDriveFolder();
  const query = encodeURIComponent(`name='${BACKUP_FILE_NAME}' and '${folderId}' in parents and trashed=false`);
  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType,modifiedTime)&pageSize=100`);
  if (!response.ok) throw new Error(`Could not find the Drive backup (HTTP ${response.status}).`);
  const result = await response.json();
  return (result.files || []).find(f => f.name === BACKUP_FILE_NAME)?.id || '';
}
async function uploadDriveBackup() {
  backupButton.disabled = true; restoreButton.disabled = true;
  try {
    const folderId = await ensureDriveFolder();
    const existingId = await findBackupFile();
    const metadata = { name: BACKUP_FILE_NAME, mimeType: 'application/json', ...(existingId ? {} : { parents: [folderId] }) };
    const content = JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), receipts }, null, 2);
    const boundary = 'receipt_tax_tracker_boundary';
    const crlf = '\r\n';
    const body = '--' + boundary + crlf +
      'Content-Type: application/json; charset=UTF-8' + crlf + crlf +
      JSON.stringify(metadata) + crlf +
      '--' + boundary + crlf +
      'Content-Type: application/json; charset=UTF-8' + crlf + crlf +
      content + crlf +
      '--' + boundary + '--';
    const endpoint = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,name,modifiedTime`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime';
    const response = await driveFetch(endpoint, {
      method: existingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 250);
      throw new Error(`Drive upload failed (HTTP ${response.status}). ${details}`);
    }
    const uploaded = await response.json();
    setDriveMessage(`Backup complete: ${receipts.length} receipt(s) saved to Google Drive as ${uploaded.name}.`);
  } catch (error) {
    setDriveMessage(error.message || 'Drive backup failed. Please try again.', true);
  } finally {
    backupButton.disabled = !accessToken;
    restoreButton.disabled = !accessToken;
  }
}
async function restoreDriveBackup() {
  if (!confirm('Restore the backup from Google Drive? Receipts with matching IDs will be replaced; other local receipts will be kept.')) return;
  backupButton.disabled = true; restoreButton.disabled = true;
  try {
    const fileId = await findBackupFile();
    if (!fileId) {
      setDriveMessage('No Receipt-Tax-Tracker-Backup.json file was found in the app backup folder.', true);
      return;
    }
    const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!response.ok) throw new Error(`Drive download failed (HTTP ${response.status}).`);
    const backup = await response.json();
    const incoming = Array.isArray(backup) ? backup : backup.receipts;
    if (!Array.isArray(incoming)) throw new Error('The Drive backup file format was not recognized.');
    const merged = new Map(receipts.map(r => [r.id, r]));
    incoming.forEach(r => { if (r && r.id) merged.set(r.id, r); });
    receipts = [...merged.values()].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    if (!persist()) throw new Error('The browser could not store the restored receipts. Try downloading a JSON backup and restoring fewer/lower-size photos.');
    setDriveMessage(`Restore complete: ${incoming.length} receipt(s) merged from Google Drive.`);
  } catch (error) {
    setDriveMessage(error.message || 'Drive restore failed. Please try again.', true);
  } finally {
    backupButton.disabled = !accessToken;
    restoreButton.disabled = !accessToken;
  }
}
backupButton.addEventListener('click', uploadDriveBackup);
restoreButton.addEventListener('click', restoreDriveBackup);

window.addEventListener('load', () => {
  initializeGoogleAuth();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
});
addTax();
renderReceipts();
toggleFuelSection();
