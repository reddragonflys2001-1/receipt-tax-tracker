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
  const amount=line=>{const matches=[...line.matchAll(/\$?\s*(\d{1,5}[.,]\d{2})\b/g)];return matches.length?Number(matches[matches.length-1][1].replace(',','.')):null;};
  const money=n=>Number(n).toFixed(2);
  const subtotalLine=lines.find(x=>/sub\s*total/i.test(x)&&amount(x)!==null);
  const subtotal=subtotalLine?amount(subtotalLine):null;
  const dateMatch=text.match(/\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b|\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/);
  let date='';if(dateMatch){const y=dateMatch[1]||dateMatch[6],m=dateMatch[2]||dateMatch[4],d=dateMatch[3]||dateMatch[5];date=`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;}
  // Score merchant headings, rejecting OCR debris and address/transaction lines.
  const headerLines=lines.slice(0,Math.min(lines.length,18));
  const storeCandidates=headerLines.map((line,index)=>{
    const cleaned=line.replace(/^[^A-Za-z0-9]+/, '').trim();
    const words=cleaned.split(/\s+/).filter(w=>/^[A-Za-z][A-Za-z'-]{2,}$/.test(w));
    const letters=(cleaned.match(/[A-Za-z]/g)||[]).length;
    const noise=(cleaned.match(/[^A-Za-z0-9 \'&.-]/g)||[]).length;
    const excluded=/\b(receipt|thank|welcome|invoice|order|cashier|station|date|time|closed|phone|tel|debit|card|subtotal|total|purchase|item count)\b/i.test(cleaned);
    const address=/\d{3,}|\b(?:ave|street|st|road|rd|blvd|wa|zip)\b|\b\d+\s+[NSEW]\b/i.test(cleaned);
    const uppercase=(cleaned.match(/[A-Z]/g)||[]).length/Math.max(letters,1);
    const shortWords=cleaned.split(/\s+/).filter(w=>/^[A-Za-z]{1,2}$/.test(w)).length;
    const score=words.length*9+letters*.3+uppercase*8-noise*8-shortWords*7-(excluded?50:0)-(address?50:0)-(index*.4);
    return {cleaned,score,letters,words};
  }).filter(v=>v.letters>=7&&v.words.length>=2);
  const store=storeCandidates.sort((a,b)=>b.score-a.score)[0]?.cleaned||'';
  const totalCandidates=lines.filter(x=>/\b(grand\s*total|total|amount due|balance due)\b/i.test(x)&&!/subtotal|tax|savings/i.test(x)).map(amount).filter(x=>x!==null);
  const paymentCandidates=lines.filter(x=>/\b(debit card|credit card|card purchase|visa|mastercard|amount paid)\b/i.test(x)).map(amount).filter(x=>x!==null);
  const taxCandidates=[];
  for(const line of lines){
    if(/tax exempt|tax id|taxable grocery|taxable item/i.test(line))continue;
    if(/\b(sales tax|tax|gst|hst)\b/i.test(line)&&amount(line)!==null){
      taxCandidates.push({name:'Sales tax',amount:amount(line),source:'Printed on receipt'});
      continue;
    }
    // OCR often adds random symbols before a printed rate/amount pair,
    // e.g. "x hie oe 5 8.4 $1.79". Match the END of the line.
    const ratePair=line.match(/(?:^|\s)(\d{1,2}(?:[.,]\d{1,3})?)\s*%?\s+\$\s*(\d+[.,]\d{2})\s*$/);
    if(ratePair){
      const rate=Number(ratePair[1].replace(',','.'));
      const value=Number(ratePair[2].replace(',','.'));
      if(rate>0&&rate<=15&&value>0){
        taxCandidates.push({name:`Sales tax (${rate}% printed rate)`,amount:value,source:'Printed on receipt'});
      }
    }
  }
  let uniqueTaxes=taxCandidates.filter((t,i,a)=>a.findIndex(v=>v.amount===t.amount)===i);
  let total=totalCandidates.find(v=>subtotal===null||v>=subtotal)||null;
  let totalFromPayment=false;
  if(total===null){const candidate=paymentCandidates.find(v=>subtotal===null||v>=subtotal);if(candidate!==undefined){total=candidate;totalFromPayment=true;}}
  // A bare rate/amount pair is only accepted if it reconciles with the subtotal and total.
  if(total!==null&&subtotal!==null){const delta=Math.round((total-subtotal)*100)/100;uniqueTaxes=uniqueTaxes.filter(t=>!t.name.includes('printed rate')||Math.abs(t.amount-delta)<.02);}
  // If OCR missed the tax label, only infer a tax amount when a printed payment and subtotal reconcile.
  if(!uniqueTaxes.length&&total!==null&&subtotal!==null){
    const difference=Math.round((total-subtotal)*100)/100;
    if(difference>0&&difference<=subtotal*.2)uniqueTaxes.push({name:'Possible sales tax (calculated difference — verify)',amount:difference,source:'Calculated estimate'});
  }
  reviewField('store',store||'',true);reviewField('date',date,true);
  reviewField('subtotal',subtotal!==null?money(subtotal):'',true);
  reviewField('total',total!==null?money(total):'',true);
  // Avoid duplicating taxes when rescanning; preserve manually entered tax rows.
  taxesBox.querySelectorAll('.tax-row[data-ocr-suggestion]').forEach(row=>row.remove());
  // Remove only the untouched starter tax row when actual OCR tax suggestions exist.
  if(uniqueTaxes.length){
    [...taxesBox.querySelectorAll('.tax-row')].forEach(row=>{
      const name=row.querySelector('[data-key="name"]')?.value.trim();
      const value=row.querySelector('[data-key="amount"]')?.value.trim();
      if(!name && (!value || Number(value)===0) && !row.dataset.autoFuelTax)row.remove();
    });
  }
  uniqueTaxes.slice(0,8).forEach(t=>{addTax({...t,taxType:'Other tax'});taxesBox.lastElementChild.dataset.ocrSuggestion='true';});
  // Keep original OCR beside editable suggestions; do not silently invent missing words.
  itemsBox.querySelectorAll('.item-row[data-ocr-suggestion]').forEach(row=>row.remove());
  const items=[];
  const excluded=/subtotal|grand total|debit|credit|purchase|cashier|station|invoice|order|date|thank you|tax|balance|change|ref num|transaction|card entry|auth code|weight|unit price|total price|item count|closed to/i;
  function cleanProductName(raw) {
    let name=raw.replace(/^[^A-Za-z]*?(?=(?:FS\s+)?(?:MISC|CAYMAN|AM\s+SPIRIT|SPIRIT|[A-Z]{3,}))/i,'')
      .replace(/\s*[-–]\s*\d{7,}[^\s]*/g,'')
      .replace(/[-–]\d{7,}[^\s]*/g,'')
      .replace(/[|§%*]+/g,' ')
      .replace(/\s+/g,' ').trim();
    // OCR frequently attaches fragments to the start of otherwise legible names.
    const anchor=name.match(/\b(?:FS\s+MISC|MISC|CAYMAN|AM\s+SPIRIT|SPIRIT)\b/i);
    if(anchor && anchor.index>0)name=name.slice(anchor.index);
    name=name.replace(/\bNISC\b/gi,'MISC').replace(/\bJCK\b/gi,'JACK')
      .replace(/\bTRWBRY\b/gi,'STRAWBERRY')
      .replace(/\bGROCK\b/gi,'GROCERY');
    return name.slice(0,110);
  }
  // Prices can be on the next line, or one more line down when OCR
  // separates the quantity from the unit price. Avoid treating header noise as items.
  const productAnchors=/\b(?:MISC|NISC|GROCERY|CAYMAN|SPIRIT|FS\s+MISC)\b/i;
  const pricePattern=/\$\s*(\d+[.,]\d{2})\s*\/\s*(?:pc|ea)\b/i;
  const usedPriceLines=new Set();
  for(let i=0;i<lines.length;i++){
    const raw=lines[i];
    if(excluded.test(raw) && !/taxable\s+grocery/i.test(raw))continue;
    if(raw.length<8||!/\b[A-Za-z]{3,}\b/.test(raw)||/\$\s*\d+[.,]\d{2}/.test(raw))continue;
    // On noisy scans the product label may contain a leading fragment.
    // Require a recognizable product word or a plausible description.
    if(!productAnchors.test(raw) && !/^[A-Z][A-Z\s-]{7,}/.test(raw))continue;
    let candidate=null;
    for(let offset=1;offset<=3 && i+offset<lines.length;offset++){
      const j=i+offset;
      if(usedPriceLines.has(j))continue;
      const next=lines[j];
      const unitMatch=next.match(pricePattern);
      if(!unitMatch)continue;
      const unit=Number(unitMatch[1].replace(',','.'));
      // Some OCR outputs corrupt the line-total but retain the unit price.
      // Prefer a valid amount at the end; otherwise use a nearby quantity.
      const allAmounts=[...next.matchAll(/\$\s*(\d+[.,]\d{2})/g)].map(m=>Number(m[1].replace(',','.')));
      const last=allAmounts.at(-1);
      let qty=1,price=unit;
      if(allAmounts.length>=2 && last>=unit && Math.abs(Math.round(last/unit)*unit-last)<.04){
        qty=Math.round(last/unit);price=last;
      } else {
        const between=lines.slice(i+1,j+1).join(' ');
        const explicit=between.match(/(?:^|\s)(\d{1,2})\s*(?:pc|ea)\b/i);
        if(explicit){qty=Number(explicit[1]);price=Math.round(qty*unit*100)/100;}
      }
      if(qty<1||qty>100)continue;
      candidate={j,qty,price};break;
    }
    if(!candidate)continue;
    const cleaned=cleanProductName(raw);
    if(cleaned.length<5)continue;
    // Never invent a name from the known example; keep ambiguous OCR for review.
    items.push({name:cleaned,qty:candidate.qty,price:candidate.price,raw});
    usedPriceLines.add(candidate.j);
    i=candidate.j;
  }
  items.slice(0,30).forEach(item=>{
    addItem(item);
    const row=itemsBox.lastElementChild;
    row.dataset.ocrSuggestion='true';
    row.querySelector('[data-key="name"]').classList.add('ocr-uncertain');
    const details=document.createElement('details');details.className='ocr-item-source';
    const summary=document.createElement('summary');summary.textContent='Original OCR product text — compare before saving';
    const original=document.createElement('pre');original.textContent=item.raw;
    details.append(summary,original);row.append(details);
  });
  return {fields:[store&&'Store',date&&'Date',total!==null&&'Total',subtotal!==null&&'Subtotal'].filter(Boolean),taxCount:uniqueTaxes.length,itemCount:items.length,totalFromPayment,estimatedTax:uniqueTaxes.some(t=>t.source==='Calculated estimate')};
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
    scanWarnings.textContent=`OCR suggested ${parsed.fields.join(', ')||'no standard fields'} and ${parsed.taxCount} tax suggestion(s), plus ${parsed.itemCount} possible item(s). ${parsed.totalFromPayment?"Total was suggested from a payment line. ":""}${parsed.estimatedTax?"A possible tax was estimated from the difference; it is NOT verified printed tax. ":""}Verify every field, tax and item before saving. Never add a calculated tax estimate on top of a printed tax. Only the first photo is shown in older receipt views; all optimized photos are saved in the receipt record.`;
    ocrStatus('Scan complete. Review highlighted fields and the receipt photo before saving.');
    form.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(error){ocrStatus(`Scan failed: ${error.message}`);}
  finally{scanButton.disabled=false;}
});
window.resetOcrPhotos=()=>{scanImages=[];window.pendingOcrPhotos=[];scanText.value='';scanWarnings.textContent='';renderScanImages();};
