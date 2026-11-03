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
// Washington DOR review fields are advisory metadata only. Never auto-change printed tax lines.
const WA_RATE_SOURCE = 'https://dor.wa.gov/taxes-rates/sales-use-tax-rates/sales-use-tax-rate-lookup';
const WA_STATE_GENERAL_RATE = 6.5; // Washington general state retail sales tax; exceptions may apply.
// A complete-looking address is only eligible for lookup; it is not verified by DOR.
function validateWaStoreAddress(raw) {
  const address = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!address) return {ok:false, message:'Enter the store street address, city, WA, and 5-digit ZIP before looking up tax.'};
  const match = address.match(/^(.+?),\s*([^,]+),\s*(WA|Washington)\s+(\d{5})(?:-\d{4})?$/i);
  if (!match || !/^\d+\s+\S/.test(match[1])) return {ok:false, message:'Check the address format: 315 N Amboy Ave, Yacolt, WA 98675. Include street number, street, city, WA, and ZIP.'};
  return {ok:true, message:'Address format looks complete. Review it against the receipt, then use the official DOR lookup to verify the jurisdiction and rate.'};
}
function checkWaAddress() {
  const result = validateWaStoreAddress(form.elements.storeAddress.value);
  const status = document.querySelector('#wa-address-status');
  status.textContent = result.message;
  status.classList.toggle('error', !result.ok);
  document.querySelector('#wa-official-link').hidden = !result.ok;
  return result.ok;
}
document.querySelector('#wa-check-address').addEventListener('click', checkWaAddress);

// Diagnostic only. Browser cross-origin permissions are tested against the actual DOR address API.
// No fields or saved receipt data are modified by this test.
document.querySelector('#wa-test-access').addEventListener('click', async () => {
  const status = document.querySelector('#wa-access-status');
  const button = document.querySelector('#wa-test-access');
  if (!checkWaAddress()) {
    status.textContent = 'Please correct the store address first. No request was sent.';
    status.classList.add('error');
    return;
  }
  const match = form.elements.storeAddress.value.replace(/\s+/g, ' ').trim()
    .match(/^(.+?),\s*([^,]+),\s*(?:WA|Washington)\s+(\d{5})(?:-\d{4})?$/i);
  const params = new URLSearchParams({output:'xml', addr:match[1], city:match[2], zip:match[3]});
  const url = `https://webgis.dor.wa.gov/webapi/AddressRates.aspx?${params}`;
  button.disabled = true;
  status.classList.remove('error');
  status.textContent = 'Contacting the official Washington DOR address API…';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {method:'GET', mode:'cors', cache:'no-store', signal:controller.signal});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.text();
    const xml = new DOMParser().parseFromString(raw, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('The response was not valid XML');
    const root = xml.documentElement;
    if (root.nodeName.toLowerCase() !== 'response') throw new Error('Unexpected API response');
    const code = root.getAttribute('code') || 'unknown';
    const loc = root.getAttribute('loccode') || 'unknown';
    const rate = root.querySelector('rate');
    const address = root.querySelector('addressline');
    const stateRate = rate?.getAttribute('staterate');
    const localRate = rate?.getAttribute('localrate') || root.getAttribute('localrate');
    const combined = root.getAttribute('rate');
    const percent = v => v !== null && Number.isFinite(Number(v)) && Number(v) >= 0 ? `${(Number(v)*100).toFixed(2)}%` : 'unavailable';
    if (loc === '-1' || !combined || Number(combined) < 0) {
      status.textContent = `DOR replied, but did not return a usable rate (response code ${code}; location ${loc}). Check the address on the official DOR website. No receipt data changed.`;
      status.classList.add('error');
    } else {
      status.textContent = `SUCCESS: This browser can read the DOR address API. Jurisdiction: ${rate?.getAttribute('name') || 'not supplied'}; location code: ${loc}; state: ${percent(stateRate)}; local: ${percent(localRate)}; combined: ${percent(combined)}; rate period: ${address?.getAttribute('period') || 'not supplied'}; API response code: ${code}. Diagnostic only—nothing was saved or changed. Check the rate period against the receipt date before using these figures.`;
    }
  } catch (error) {
    status.textContent = error.name === 'AbortError'
      ? 'The DOR address API request timed out. No receipt data changed.'
      : `This browser could not read the DOR address API (${error.message === 'Failed to fetch' ? 'possibly blocked by cross-origin browser security' : error.message}). Opening the API in another tab can still work. No receipt data changed.`;
    status.classList.add('error');
  } finally {
    clearTimeout(timeout);
    button.disabled = false;
  }
});

// Suggested DOR data is held in memory until the user explicitly approves it.
let waSuggestion = null;
let waApproved = false;
let waLookupSequence = 0;
const waSuggestionBox = document.querySelector('#wa-suggestion');
const waApproveButton = document.querySelector('#wa-approve-suggestion');
const waReviewButton = document.querySelector('#wa-review-manually');
function receiptQuarter(date) {
  if (!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(date || '')) return '';
  return `Q${Math.ceil(Number(date.slice(5,7))/3)}${date.slice(0,4)}`;
}
function invalidateWaSuggestion(message = 'Address or purchase date changed. Scan again or request a new lookup.') {
  waLookupSequence++;
  waSuggestion = null;
  waApproved = false;
  waSuggestionBox.hidden = true;
  waApproveButton.disabled = true;
  document.querySelector('#wa-auto-status').textContent = message;
}
function waAddressParts() {
  const match = form.elements.storeAddress.value.replace(/\s+/g,' ').trim()
    .match(/^(.+?),\s*([^,]+),\s*(?:WA|Washington)\s+(\d{5})(?:-\d{4})?$/i);
  return match && /^\d+\s+\S/.test(match[1]) ? match : null;
}
async function autoLookupWa() {
  invalidateWaSuggestion('Checking address and purchase date…');
  const sequence = waLookupSequence;
  const match = waAddressParts();
  const date = form.elements.date.value;
  const expectedPeriod = receiptQuarter(date);
  const status = document.querySelector('#wa-auto-status');
  if (!match || !expectedPeriod) {
    status.textContent = 'Automatic lookup needs a complete Washington address and a valid purchase date. Review the OCR fields first, then retry.';
    return;
  }
  const originalAddress = form.elements.storeAddress.value;
  const url = `https://webgis.dor.wa.gov/webapi/AddressRates.aspx?${new URLSearchParams({output:'xml',addr:match[1],city:match[2],zip:match[3]})}`;
  status.textContent = 'Looking up the store address with Washington DOR…';
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),12000);
  try {
    const response = await fetch(url,{mode:'cors',cache:'no-store',signal:controller.signal});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = new DOMParser().parseFromString(await response.text(),'application/xml');
    if (xml.querySelector('parsererror') || xml.documentElement.nodeName.toLowerCase() !== 'response') throw new Error('Unexpected XML response');
    const root=xml.documentElement, rate=root.querySelector('rate'), address=root.querySelector('addressline');
    const locationCode=root.getAttribute('loccode') || '';
    const period=address?.getAttribute('period') || '';
    const combined=Number(root.getAttribute('rate'))*100;
    const state=Number(rate?.getAttribute('staterate'))*100;
    const local=Number(rate?.getAttribute('localrate'))*100;
    const jurisdiction=rate?.getAttribute('name') || '';
    if (sequence !== waLookupSequence || originalAddress !== form.elements.storeAddress.value || date !== form.elements.date.value) return;
    if (!locationCode || locationCode === '-1' || !jurisdiction || !period || !Number.isFinite(combined) || combined <= 0 || !Number.isFinite(state) || !Number.isFinite(local) || Math.abs(state+local-combined) > .011) throw new Error('DOR did not return a complete, consistent tax result');
    if (period.toUpperCase() !== expectedPeriod.toUpperCase()) {
      status.textContent=`DOR returned ${period}, but this receipt is dated in ${expectedPeriod}. Historical rate NOT verified. No suggestion can be approved; check official historical quarterly data.`;
      return;
    }
    waSuggestion={jurisdiction,locationCode,combined,state,local,period,address:originalAddress,date};
    document.querySelector('#wa-suggestion-details').textContent=`${jurisdiction} · code ${locationCode} · state ${state.toFixed(2)}% · local ${local.toFixed(2)}% · combined ${combined.toFixed(2)}% · ${period}`;
    waSuggestionBox.hidden=false;
    waApproveButton.disabled=false;
    status.textContent='Official rate matches the receipt quarter. Review the suggestion and approve it to fill the WA review fields. Printed tax remains unchanged.';
  } catch(error) {
    if (sequence === waLookupSequence) status.textContent=`Automatic lookup unavailable (${error.name === 'AbortError' ? 'timed out' : error.message}). Review the address or use the manual official lookup; no data changed.`;
  } finally {clearTimeout(timeout);}
}
document.querySelector('#wa-auto-retry').addEventListener('click',autoLookupWa);
waApproveButton.addEventListener('click',()=>{
  const v=waSuggestion;
  if (!v || v.address !== form.elements.storeAddress.value || v.date !== form.elements.date.value || v.period.toUpperCase() !== receiptQuarter(v.date).toUpperCase()) return invalidateWaSuggestion();
  form.elements.waTaxJurisdiction.value=v.jurisdiction;
  form.elements.waTaxCode.value=v.locationCode;
  form.elements.waCombinedRate.value=v.combined.toFixed(3);
  form.elements.waRatePeriod.value=`${v.date.slice(0,4)} Q${v.period.charAt(1)}`;
  waApproved=true;
  waSuggestionBox.hidden=true;
  document.querySelector('#wa-auto-status').textContent='Approved: WA review fields filled. Printed tax lines and receipt totals have not changed. Save the receipt when ready.';
});
waReviewButton.addEventListener('click',()=>invalidateWaSuggestion('Automatic suggestion dismissed. Review or enter the Washington tax fields manually.'));
form.elements.date.addEventListener('change',()=>invalidateWaSuggestion());
for (const name of ['waTaxJurisdiction','waTaxCode','waCombinedRate','waRatePeriod']) {
  form.elements[name].addEventListener('input',()=>{waApproved=false;});
}
document.addEventListener('receipt-ocr-complete',()=>{void autoLookupWa();});
form.elements.storeAddress.addEventListener('input', () => {
  invalidateWaSuggestion();
  document.querySelector('#wa-official-link').hidden = true;
  document.querySelector('#wa-address-status').textContent = 'Address changed. Check it again before opening the tax lookup.';
});
function previewWaTax() {
  const out = document.querySelector('#wa-preview-result');
  const status = document.querySelector('#wa-lookup-status');
  const date = form.elements.date.value;
  const address = form.elements.storeAddress.value.trim();
  const jurisdiction = form.elements.waTaxJurisdiction.value.trim();
  const combined = Number(form.elements.waCombinedRate.value);
  const rateEntered = form.elements.waCombinedRate.value !== '';
  const printed = [...taxesBox.querySelectorAll('.tax-row')].filter(row => row.querySelector('[data-key="source"]').value === 'Printed on receipt').reduce((sum,row)=>sum+(Number(row.querySelector('[data-key="amount"]').value)||0),0);
  if (!date || !validateWaStoreAddress(address).ok || !jurisdiction || !rateEntered || !Number.isFinite(combined) || combined < WA_STATE_GENERAL_RATE || combined > 30) {
    out.textContent = 'To preview, enter a purchase date, store address, verified jurisdiction, and verified combined rate of at least 6.5%. Check special cases with DOR.';
    return;
  }
  if (!printed) { out.textContent = 'No printed tax amount found. Add or scan a printed sales-tax line before previewing an allocation.'; return; }
  const state = roundCents(printed * WA_STATE_GENERAL_RATE / combined);
  const local = roundCents(printed - state);
  status.textContent = 'Review-only calculation using the general 6.5% WA state rate. Check taxability, special rates and rounding against DOR records.';
  out.textContent = `Suggested allocation of the existing $${money(printed)} printed tax: state $${money(state)}, local $${money(local)} (combined ${combined}% in ${jurisdiction}). These are NOT additional tax lines and are NOT included separately in reports. Verify before saving.`;
}
document.querySelector('#wa-preview').addEventListener('click', previewWaTax);
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
    <label>Recorded as<select data-key="source"><option ${source === 'Printed on receipt' ? 'selected' : ''}>Printed on receipt</option><option ${source === 'Calculated estimate' ? 'selected' : ''}>Calculated estimate</option><option ${source === 'Needs review (OCR suggestion)' ? 'selected' : ''}>Needs review (OCR suggestion)</option></select></label>
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
    <label>Price ($)<input data-key="price" type="number" step="0.01" value="${escapeHtml(data.price ?? '')}"></label>
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
  if ([...taxesBox.querySelectorAll('.tax-row')].some(row=>row.querySelector('[data-key="source"]')?.value==='Needs review (OCR suggestion)')) {
    alert('Review the OCR tax suggestion before saving. Compare the printed receipt photo, then choose Printed on receipt or Calculated estimate in Recorded as. The difference alone does not prove printed tax.');
    return;
  }
  const data = new FormData(form);
  const oldRecord = editId ? receipts.find(receipt => receipt.id === editId) : null;
  const record = {
    id: editId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    store: String(data.get('store') || '').trim(),
    storeAddress: String(data.get('storeAddress') || '').trim(),
    waTaxReview: {jurisdiction:String(data.get('waTaxJurisdiction')||'').trim(), locationCode:String(data.get('waTaxCode')||'').trim(), combinedRate:data.get('waCombinedRate')===''?'':Number(data.get('waCombinedRate')), ratePeriod:String(data.get('waRatePeriod')||'').trim(), source:WA_RATE_SOURCE, reviewedManually:Boolean(waApproved || (String(data.get('waTaxJurisdiction')||'').trim() && String(data.get('waTaxCode')||'').trim() && String(data.get('waCombinedRate')||'').trim() && String(data.get('waRatePeriod')||'').trim())), approvalMethod:waApproved?'DOR API suggestion approved':'Manual entry reviewed'},
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
    photos: window.pendingOcrPhotos?.length ? [...window.pendingOcrPhotos] : (oldRecord?.photos || []),
    createdAt: oldRecord?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (editId) receipts = receipts.map(existing => existing.id === editId ? record : existing);
  else receipts.unshift(record);
  if (!persist()) return;
  editId = null;
  invalidateWaSuggestion('No automatic tax lookup pending.');
  form.reset();
  itemsBox.innerHTML = '';
  taxesBox.innerHTML = '';
  pendingPhoto = '';
  if (window.resetOcrPhotos) window.resetOcrPhotos();
  form.querySelector('[type="submit"]').textContent = 'Save receipt';
  toggleFuelSection();
});
form.addEventListener('reset', () => {
  setTimeout(() => {
    itemsBox.innerHTML = '';
    taxesBox.innerHTML = '';
    pendingPhoto = '';
    if (window.resetOcrPhotos) window.resetOcrPhotos();
    editId = null;
    invalidateWaSuggestion('No automatic tax lookup pending.');
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
      <div class="receipt-top"><strong>${escapeHtml(r.store)}</strong><strong>$${money(r.total)}</strong></div>${r.storeAddress ? `<div class="hint">Store address: ${escapeHtml(r.storeAddress)}</div>` : ''}
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
  invalidateWaSuggestion('Saved receipt opened. Use Retry automatic lookup if needed.');
  const receipt = receipts.find(r => r.id === id);
  if (!receipt) return;
  editId = id;
  form.elements.store.value = receipt.store || '';
  form.elements.storeAddress.value = receipt.storeAddress || '';
  form.elements.waTaxJurisdiction.value = receipt.waTaxReview?.jurisdiction || '';
  form.elements.waTaxCode.value = receipt.waTaxReview?.locationCode || '';
  form.elements.waCombinedRate.value = receipt.waTaxReview?.combinedRate ?? '';
  form.elements.waRatePeriod.value = receipt.waTaxReview?.ratePeriod || '';
  document.querySelector('#wa-preview-result').textContent = '';
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
// Advisory allocation only: never changes receipt tax lines or totals.
// Apply only to manually reviewed WA general sales-tax records whose rate period matches the purchase quarter.
function reviewedWaAllocation(receipt) {
  const review = receipt.waTaxReview || {};
  const date = String(receipt.date || '');
  const quarter = /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(date)
    ? `${date.slice(0,4)} Q${Math.ceil(Number(date.slice(5,7))/3)}` : '';
  const period = String(review.ratePeriod || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const combined = Number(review.combinedRate);
  if (!review.reviewedManually || !review.jurisdiction || !review.locationCode ||
      !quarter || period !== quarter || !receipt.storeAddress ||
      !Number.isFinite(combined) || combined < WA_STATE_GENERAL_RATE || combined > 30) return null;
  const printed = (receipt.taxes || []).reduce((sum,t) => {
    if (t.source !== 'Printed on receipt') return sum;
    if (FUEL_TAX_NAMES.includes(t.name) || ['Product-specific tax','Special/district tax','Washington State Fuel Tax','Federal Fuel Tax'].includes(t.taxType)) return sum;
    const amount = Number(t.amount);
    return Number.isFinite(amount) && amount > 0 ? sum + amount : sum;
  },0);
  if (!printed) return null;
  const cents = Math.round(printed * 100);
  const stateCents = Math.round(cents * WA_STATE_GENERAL_RATE / combined);
  return {jurisdiction:String(review.jurisdiction).trim(), code:String(review.locationCode).trim(),
    period:quarter, state:stateCents/100, local:(cents-stateCents)/100, printed:cents/100};
}

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
  const waGroups = new Map();
  let waCount = 0, waUnallocated = 0;
  selected.forEach(receipt => {
    const allocation = reviewedWaAllocation(receipt);
    if (!allocation) {
      if ((receipt.taxes || []).some(t => t.source === 'Printed on receipt' && Number(t.amount) > 0)) waUnallocated++;
      return;
    }
    const key = `${allocation.jurisdiction} (${allocation.code})`;
    const group = waGroups.get(key) || {state:0,local:0,printed:0,count:0};
    group.state += Math.round(allocation.state*100);
    group.local += Math.round(allocation.local*100);
    group.printed += Math.round(allocation.printed*100);
    group.count++;
    waGroups.set(key,group);
    waCount++;
  });
  const waOut = document.querySelector('#report-wa-allocation');
  if (!waGroups.size) {
    waOut.innerHTML = '<p class="empty">No reviewed Washington sales-tax allocations for this period. Original printed taxes remain listed above.</p>';
  } else {
    const groups = [...waGroups].sort((a,b)=>a[0].localeCompare(b[0]));
    const totals = groups.reduce((sum,[,g])=>({state:sum.state+g.state,local:sum.local+g.local,printed:sum.printed+g.printed}),{state:0,local:0,printed:0});
    waOut.innerHTML = `<p class="hint">${waCount} receipt(s) with reviewed jurisdiction, location code, rate and matching purchase quarter. These are calculated allocations of existing printed sales tax, <strong>not additional taxes</strong>. They do not change the original tax classifications or report totals.</p><div style="overflow-x:auto"><table class="report-table"><thead><tr><th>Washington jurisdiction</th><th>State (allocated)</th><th>Local (allocated)</th><th>Printed tax allocated</th></tr></thead><tbody>${groups.map(([key,g])=>`<tr><td>${escapeHtml(key)}</td><td>$${money(g.state/100)}</td><td>$${money(g.local/100)}</td><td>$${money(g.printed/100)}</td></tr>`).join('')}<tr><th>Total</th><th>$${money(totals.state/100)}</th><th>$${money(totals.local/100)}</th><th>$${money(totals.printed/100)}</th></tr></tbody></table></div>`;
  }
  if (waUnallocated) waOut.insertAdjacentHTML('beforeend', `<p class="hint">${waUnallocated} receipt(s) with printed tax were not allocated because required review information was missing or not applicable. Special and product-specific taxes need separate verification.</p>`);

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

// CSV Export Center: reports are calculated from saved records without changing them.
const csvStart = document.querySelector('#csv-start');
const csvEnd = document.querySelector('#csv-end');
const csvStatus = document.querySelector('#csv-export-status');
function csvRange() {
  const start = csvStart.value, end = csvEnd.value;
  if (!start || !end || start > end) throw new Error('Choose a valid start date on or before the end date.');
  return {start, end, selected:receipts.filter(r => typeof r.date === 'string' && r.date >= start && r.date <= end)};
}
function taxTotals(r) {
  return (r.taxes || []).reduce((sum,t) => {
    const amount = Number(t.amount);
    if (Number.isFinite(amount)) sum[t.source === 'Calculated estimate' ? 'estimated' : 'printed'] += amount;
    return sum;
  }, {printed:0,estimated:0});
}
function csvEncode(rows) { return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'); }
function reportFiles(selected, rangeLabel) {
  const files = {};
  const prefix = `receipt-tax-tracker-${rangeLabel}`;
  const receiptHeaders = ['Store name','Purchase date','Category','Receipt total','Subtotal',
    ...[1,2,3].flatMap(i=>[`Tax ${i} name`,`Tax ${i} amount`,`Tax ${i} type`,`Tax ${i} jurisdiction`,`Tax ${i} source`]),
    'All tax lines JSON','Items JSON','Fuel type','Gallons','Price per gallon','Notes','Receipt photo included'];
  const receiptRows = selected.map(r => [r.store,r.date,r.category,r.total,r.subtotal,
    ...[0,1,2].flatMap(i=>{const t=r.taxes?.[i];return [t?.name||'',t?.amount??'',t?.taxType||(t?'Other tax':''),t?.jurisdiction||'',t?.source||''];}),
    JSON.stringify(r.taxes||[]),JSON.stringify(r.items||[]),r.fuelType,r.gallons,r.pricePerGallon,r.notes,r.photo?'yes':'no']);
  files.receipts = {name:`${prefix}-receipts.csv`, content:csvEncode([receiptHeaders,...receiptRows])};
  const monthly = new Map();
  for (const r of selected) {
    const key = r.date.slice(0,7), category = r.category || 'Uncategorized';
    const groupKey = `${key}\u0000${category}`;
    const row = monthly.get(groupKey) || {month:key,category,count:0,spending:0,printed:0,estimated:0};
    const t=taxTotals(r); row.count++;row.spending+=Number(r.total)||0;row.printed+=t.printed;row.estimated+=t.estimated;monthly.set(groupKey,row);
  }
  files.monthly={name:`${prefix}-monthly-spending.csv`,content:csvEncode([['Month','Category','Receipt count','Spending','Printed taxes','Estimated taxes'],
    ...[...monthly.values()].sort((a,b)=>a.month.localeCompare(b.month)||a.category.localeCompare(b.category)).map(r=>[r.month,r.category,r.count,roundCents(r.spending),roundCents(r.printed),roundCents(r.estimated)])])};
  const taxGroups = new Map();
  for (const r of selected) for (const t of r.taxes||[]) {
    const amount=Number(t.amount);if(!Number.isFinite(amount))continue;
    const type=FUEL_TAX_NAMES.includes(t.name)&&t.source==='Calculated estimate'?t.name:(t.taxType||'Other tax');
    const jurisdiction=t.jurisdiction?.trim()||'Unspecified jurisdiction';
    const key=`${r.date.slice(0,4)}\u0000${type}\u0000${jurisdiction}`;
    const row=taxGroups.get(key)||{year:r.date.slice(0,4),type,jurisdiction,printed:0,estimated:0};
    row[t.source==='Calculated estimate'?'estimated':'printed']+=amount;taxGroups.set(key,row);
  }
  files.yearly={name:`${prefix}-yearly-taxes.csv`,content:csvEncode([['Year','Tax type','Jurisdiction','Printed taxes','Estimated taxes'],
    ...[...taxGroups.values()].sort((a,b)=>a.year.localeCompare(b.year)||a.type.localeCompare(b.type)||a.jurisdiction.localeCompare(b.jurisdiction)).map(r=>[r.year,r.type,r.jurisdiction,roundCents(r.printed),roundCents(r.estimated)])])};
  const fuelGroups=new Map();
  for(const r of selected) {
    if(r.category!=='Gas and vehicle'||!['Gasoline','Diesel'].includes(r.fuelType))continue;
    const key=`${r.date.slice(0,4)}\u0000${r.fuelType}`;
    const row=fuelGroups.get(key)||{year:r.date.slice(0,4),fuel:r.fuelType,count:0,gallons:0,state:0,federal:0};
    row.count++;const gallons=Number(r.gallons);if(Number.isFinite(gallons)&&gallons>0)row.gallons+=gallons;
    for(const t of r.taxes||[])if(t.source==='Calculated estimate') {
      const amount=Number(t.amount);if(!Number.isFinite(amount))continue;
      if(t.name===FUEL_TAX_NAMES[0])row.state+=amount;
      if(t.name===FUEL_TAX_NAMES[1])row.federal+=amount;
    }
    fuelGroups.set(key,row);
  }
  files.fuel={name:`${prefix}-fuel-taxes.csv`,content:csvEncode([['Year','Fuel type','Receipt count','Gallons','Washington state estimated tax','Federal estimated tax','Total estimated fuel tax'],
    ...[...fuelGroups.values()].sort((a,b)=>a.year.localeCompare(b.year)||a.fuel.localeCompare(b.fuel)).map(r=>[r.year,r.fuel,r.count,Number(r.gallons.toFixed(3)),roundCents(r.state),roundCents(r.federal),roundCents(r.state+r.federal)])])};
  return files;
}
function prepareCsv() {
  const {start,end,selected}=csvRange();
  csvStatus.textContent=`${selected.length} receipt(s) selected · ${start} through ${end}`;
  return {files:reportFiles(selected,`${start}-to-${end}`),start,end};
}
function downloadCsvReport(kind) {
  try { const {files}=prepareCsv();const f=files[kind];downloadBlob(new Blob([f.content],{type:'text/csv;charset=utf-8'}),f.name); }
  catch(error){csvStatus.textContent=error.message;}
}
document.querySelectorAll('[data-csv-report]').forEach(b=>b.addEventListener('click',()=>downloadCsvReport(b.dataset.csvReport)));
for(const el of [csvStart,csvEnd])el.addEventListener('change',()=>{try{const {selected,start,end}=csvRange();csvStatus.textContent=`${selected.length} receipt(s) selected · ${start} through ${end}`;}catch(error){csvStatus.textContent=error.message;}});
// Minimal standards-compliant ZIP writer (stored entries, UTF-8 names, CRC-32); no external CDN required.
function makeZip(files) {
  const encoder=new TextEncoder(), chunks=[], central=[];
  let offset=0;
  const table=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
  const crc32=bytes=>{let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;};
  const u16=(view,at,n)=>view.setUint16(at,n,true),u32=(view,at,n)=>view.setUint32(at,n>>>0,true);
  for(const f of Object.values(files)) {
    const name=encoder.encode(f.name), data=encoder.encode(f.content), crc=crc32(data);
    const local=new Uint8Array(30+name.length), lv=new DataView(local.buffer);
    u32(lv,0,0x04034b50);u16(lv,4,20);u16(lv,6,0x800);u32(lv,14,crc);u32(lv,18,data.length);u32(lv,22,data.length);u16(lv,26,name.length);local.set(name,30);
    chunks.push(local,data);
    const record=new Uint8Array(46+name.length),rv=new DataView(record.buffer);
    u32(rv,0,0x02014b50);u16(rv,4,20);u16(rv,6,20);u16(rv,8,0x800);u32(rv,16,crc);u32(rv,20,data.length);u32(rv,24,data.length);u16(rv,28,name.length);u32(rv,42,offset);record.set(name,46);central.push(record);
    offset+=local.length+data.length;
  }
  const centralSize=central.reduce((n,b)=>n+b.length,0),end=new Uint8Array(22),ev=new DataView(end.buffer);
  u32(ev,0,0x06054b50);u16(ev,8,central.length);u16(ev,10,central.length);u32(ev,12,centralSize);u32(ev,16,offset);
  return new Blob([...chunks,...central,end],{type:'application/zip'});
}
document.querySelector('#csv-export-all').addEventListener('click',()=>{
  try {const {files,start,end}=prepareCsv();downloadBlob(makeZip(files),`receipt-tax-tracker-${start}-to-${end}-all-reports.zip`);}
  catch(error){csvStatus.textContent=error.message;}
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
