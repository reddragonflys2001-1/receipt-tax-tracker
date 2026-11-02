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
function addTax(data = {}) {
  const row = document.createElement('div');
  row.className = 'line-row tax-row';
  row.innerHTML = `<label>Tax name<input data-key="name" placeholder="Local sales tax" value="${escapeHtml(data.name || '')}"></label>
    <label>Amount ($)<input data-key="amount" type="number" min="0" step="0.01" placeholder="0.00" value="${escapeHtml(data.amount ?? '')}"></label>
    <label>Type<select data-key="source"><option ${data.source === 'Printed on receipt' ? 'selected' : ''}>Printed on receipt</option><option ${data.source === 'Calculated estimate' ? 'selected' : ''}>Calculated estimate</option></select></label>
    <button type="button" class="secondary">Remove</button>`;
  row.querySelector('button').addEventListener('click', () => row.remove());
  taxesBox.append(row);
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
    taxes: getRows(taxesBox, 'tax-row').map(row => ({
      name: row.name, amount: Number(row.amount || 0), source: row.source
    })),
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
        <b>Tax lines</b><ul>${(r.taxes || []).length ? r.taxes.map(t => `<li>${escapeHtml(t.name || 'Unnamed tax')}: $${money(t.amount)} <small>(${escapeHtml(t.source)})</small></li>`).join('') : '<li>No tax lines recorded</li>'}</ul>
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
document.querySelector('#export-csv').addEventListener('click', () => {
  const headers = ['Store name','Purchase date','Category','Receipt total','Subtotal','Tax 1 name','Tax 1 amount','Tax 2 name','Tax 2 amount','Tax 3 name','Tax 3 amount','All tax lines JSON','Items JSON','Fuel type','Gallons','Price per gallon','Notes','Receipt photo included'];
  const rows = receipts.map(r => [
    r.store, r.date, r.category, r.total, r.subtotal,
    ...[0,1,2].flatMap(i => [r.taxes?.[i]?.name || '', r.taxes?.[i]?.amount ?? '']),
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
