'use strict';
// Tesseract.js runs recognition in the browser. Initial load requires network access.
let scanImages = [];
const scanInput = document.querySelector('#ocr-files');
const scanCamera = document.querySelector('#ocr-camera');
const scanStatus = document.querySelector('#ocr-status');
const scanPreview = document.querySelector('#ocr-preview');
const scanButton = document.querySelector('#ocr-run');
const scanText = document.querySelector('#ocr-text');
const scanWarnings = document.querySelector('#ocr-warnings');
function ocrStatus(message) { scanStatus.textContent = message; }
function compressReceipt(file) {
  return new Promise((resolve,reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1900, scale = Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1,Math.round(img.naturalWidth*scale));
      canvas.height = Math.max(1,Math.round(img.naturalHeight*scale));
      canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg',0.82));
    };
    img.onerror = () => {URL.revokeObjectURL(url);reject(new Error('Cannot open this image'));};
    img.src=url;
  });
}
function renderScanImages() {
  scanPreview.replaceChildren();
  scanImages.forEach((src,index) => {
    const wrap=document.createElement('div');wrap.className='ocr-image';
    const img=document.createElement('img');img.src=src;img.alt=`Receipt photo ${index+1}`;
    const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent='Remove';
    remove.addEventListener('click',()=>{scanImages.splice(index,1);renderScanImages();});
    wrap.append(img,remove);scanPreview.append(wrap);
  });
  scanButton.disabled = scanImages.length===0;
}
async function receiveImages(event) {
  const files=[...(event.target.files||[])];
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (scanImages.length>=8) {ocrStatus('Maximum 8 photos per receipt.');break;}
    try {scanImages.push(await compressReceipt(file));} catch(error) {ocrStatus(error.message);}
  }
  event.target.value='';renderScanImages();
  if (scanImages.length) ocrStatus(`${scanImages.length} optimized photo(s) ready. Photos are not uploaded for OCR.`);
}
scanInput.addEventListener('change',receiveImages);
scanCamera.addEventListener('change',receiveImages);
function reviewField(name,value,uncertain) {
  const input=form.elements[name];if (!input || !value) return;
  input.value=value;
  input.classList.toggle('ocr-uncertain',Boolean(uncertain));
  input.title=uncertain?'OCR suggestion — verify against the receipt':'';
}
function parseReceiptText(text) {
  const lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const amount = line => {const m=line.match(/(?:\$\s*)?(\d{1,5}[.,]\d{2})\s*$/);return m?Number(m[1].replace(',','.')):null;};
  const totalLines=lines.filter(x=>/\b(total|amount due|balance due|grand total)\b/i.test(x)&&!/subtotal|tax|savings/i.test(x));
  const totalLine=totalLines.reverse().find(x=>amount(x)!==null);
  const subtotalLine=lines.find(x=>/sub\s*total/i.test(x)&&amount(x)!==null);
  const dateMatch=text.match(/\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b|\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/);
  let date='';if(dateMatch){const y=dateMatch[1]||dateMatch[6],m=dateMatch[2]||dateMatch[4],d=dateMatch[3]||dateMatch[5];date=`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;}
  const store=lines.find(x=>/[A-Za-z]{3}/.test(x)&&!/^receipt|thank you|welcome|tel\b/i.test(x));
  reviewField('store',store||'',true);
  reviewField('date',date,true);
  reviewField('total',totalLine?String(amount(totalLine)):'',true);
  reviewField('subtotal',subtotalLine?String(amount(subtotalLine)):'',true);
  // Only extract explicit tax labels; do not fabricate tax rate splits.
  const taxLines=lines.filter(x=>/\b(tax|sales tax|gst|hst)\b/i.test(x)&&!/tax exempt|tax id|taxable/i.test(x)&&amount(x)!==null);
  taxLines.slice(0,8).forEach(line=>addTax({name:line.replace(/\s*\$?\d+[.,]\d{2}\s*$/,'').slice(0,70),amount:amount(line),taxType:'Other tax',source:'Printed on receipt'}));
  // Line-item extraction is intentionally conservative: don't invent products.
  return {fields:[store&&'Store',date&&'Date',totalLine&&'Total',subtotalLine&&'Subtotal'].filter(Boolean),taxCount:taxLines.length};
}
scanButton.addEventListener('click',async()=>{
  if(!scanImages.length)return;
  scanButton.disabled=true;
  scanWarnings.textContent='';
  try {
    if(!window.Tesseract) throw new Error('OCR library could not load. Check your internet connection and reload.');
    const worker=await Tesseract.createWorker('eng',1,{logger:m=>{if(m.status==='recognizing text')ocrStatus(`Recognizing text: ${Math.round((m.progress||0)*100)}%`);}});
    let texts=[];
    try {for(let i=0;i<scanImages.length;i++){ocrStatus(`Scanning photo ${i+1} of ${scanImages.length}...`);const result=await worker.recognize(scanImages[i]);texts.push(result.data.text||'');}}
    finally {await worker.terminate();}
    const combined=texts.join('\n');scanText.value=combined;
    // Clear prior OCR suggestions only, leave existing manual fields/taxes intact.
    document.querySelectorAll('.ocr-uncertain').forEach(el=>el.classList.remove('ocr-uncertain'));
    const parsed=parseReceiptText(combined);
    if(scanImages.length){pendingPhoto=scanImages[0];window.pendingOcrPhotos=[...scanImages];}
    scanWarnings.textContent=`OCR suggested ${parsed.fields.join(', ')||'no standard fields'} and ${parsed.taxCount} printed tax line(s). Verify all amounts and dates. Item lines and missing tax breakdowns must be entered manually when uncertain. Only the first photo is shown in older receipt views; all optimized photos are saved in the receipt record.`;
    ocrStatus('Scan complete. Review highlighted fields and the receipt photo before saving.');
    form.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(error){ocrStatus(`Scan failed: ${error.message}`);}
  finally{scanButton.disabled=false;}
});
window.resetOcrPhotos=()=>{scanImages=[];window.pendingOcrPhotos=[];scanText.value='';scanWarnings.textContent='';renderScanImages();};
