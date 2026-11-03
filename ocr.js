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
  // Merchant headings are generally at the very top, before address and transaction details.
  // Single-word headings (GOODWILL, TARGET) are valid. Do not promote a cashier/customer
  // name from later in the receipt just because it contains more words.
  const headerLines=lines.slice(0,Math.min(lines.length,20));
  const merchantStop=/\b(?:receipt|thank|welcome|invoice|order|cashier|station|date|time|closed|phone|tel|debit|credit|card|subtotal|total|purchase|customer|employee|discount|item|sale|transaction|register|associate)\b/i;
  const merchantAddress=/\b(?:ave|avenue|street|st|road|rd|blvd|drive|dr|lane|ln|way|ct|court|place|pl|hwy|highway|wa|zip)\b|\d{3,}/i;
  const merchantBoundary=headerLines.findIndex(x=>merchantAddress.test(x)||merchantStop.test(x));
  const headingLines=headerLines.slice(0,merchantBoundary>0?merchantBoundary:Math.min(6,headerLines.length));
  const storeCandidates=headingLines.map((line,index)=>{
    const cleaned=line.replace(/^[^A-Za-z]+/,'').replace(/[^A-Za-z0-9 '&.-]+$/,'').trim();
    const words=cleaned.split(/\s+/).filter(w=>/^[A-Za-z][A-Za-z'-]{2,}$/.test(w));
    const letters=(cleaned.match(/[A-Za-z]/g)||[]).length;
    const noise=(cleaned.match(/[^A-Za-z0-9 '&.-]/g)||[]).length;
    const uppercase=(cleaned.match(/[A-Z]/g)||[]).length/Math.max(letters,1);
    const valid=!merchantStop.test(cleaned)&&!merchantAddress.test(cleaned)&&letters>=4&&words.length>=1;
    // Reward prominent, clean uppercase headings; penalize OCR debris and later lines.
    const score=(uppercase>.8?28:0)+Math.min(letters,25)*.5+Math.min(words.length,4)*2-noise*10-index*6;
    return {cleaned,score,valid};
  }).filter(x=>x.valid);
  const store=storeCandidates.sort((a,b)=>b.score-a.score)[0]?.cleaned||'';
  // Match standard street suffixes and legitimate suffix-free street names
  // (e.g. 6425 NE Fourth Plain) only when paired with a nearby WA city/ZIP line.
  const addressLines=headerLines.slice(0,16).map(line=>line
    .replace(/_/g,' ').replace(/\s*\.\s*(?=(?:AVE|ST|RD|DR|LN|BLVD|WAY)\b)/gi,' ')
    .replace(/\s+/g,' ').trim());
  const localityPattern=/\b([A-Za-z][A-Za-z .'-]{1,40})\s*,?\s+WA\s*(\d{5}(?:-\d{4})?)\b/i;
  const streetPattern=/\b\d{1,6}\s+(?:(?:N|S|E|W|NE|NW|SE|SW)\s+)?(?:[A-Za-z0-9'-]+\s+){1,7}(?:AVE(?:NUE)?|ST(?:REET)?|RD|ROAD|BLVD|DR(?:IVE)?|LN|LANE|WAY|CT|COURT|PL|PLACE|HWY|HIGHWAY)\b\.?/i;
  const suffixFreeStreet=/\b\d{1,6}\s+(?:(?:N|S|E|W|NE|NW|SE|SW)\s+)?[A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,5}\b/i;
  const localityIndex=addressLines.findIndex(line=>localityPattern.test(line));
  let storeAddress='';
  if(localityIndex>=0){
    const locality=addressLines[localityIndex].match(localityPattern);
    const nearby=addressLines.slice(Math.max(0,localityIndex-3),localityIndex);
    const streetLine=[...nearby].reverse().find(line=>streetPattern.test(line)||suffixFreeStreet.test(line));
    const street=streetLine?.match(streetPattern)?.[0]||streetLine?.match(suffixFreeStreet)?.[0]||'';
    if(street){
      const city=locality[1].trim().replace(/^[^A-Za-z]+/,'');
      storeAddress=`${street.trim().replace(/\.$/,'')}, ${city}, WA ${locality[2]}`;
    }
  }
  const totalCandidates=lines.filter(x=>/\b(grand\s*total|total|amount due|balance due)\b/i.test(x)&&!/subtotal|tax|savings/i.test(x)).map(amount).filter(x=>x!==null);
  const paymentCandidates=lines.filter(x=>/\b(debit card|credit card|card purchase|visa|mastercard|amount paid)\b/i.test(x)).map(amount).filter(x=>x!==null);
  const taxCandidates=[];
  for(const line of lines){
    if(/tax exempt|tax id|taxable grocery|taxable item/i.test(line))continue;
    if(/(?:\b(?:sales tax|tax|gst|hst)\b|\bwashington\s*\(included\))/i.test(line)&&amount(line)!==null){
      taxCandidates.push({name:/washington\s*\(included\)/i.test(line)?'Washington (Included)':'Sales tax',amount:amount(line),source:'Printed on receipt'});
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
  // A recognizable printed tax label is evidence of a tax line even when OCR
  // garbles the amount. Never silently certify the arithmetic difference as printed.
  const printedTaxLabel=lines.find(line=>
    /\b(?:washington\s*\(?\s*included\s*\)?|wa\s*tax|sales\s*tax|tax\s*(?:amount|total|due))\b/i.test(line)
    && !/tax exempt|tax id|taxable grocery|taxable item/i.test(line));
  // If OCR missed the tax label, only infer a tax amount when a printed payment and subtotal reconcile.
  if(!uniqueTaxes.length&&total!==null&&subtotal!==null){
    const difference=Math.round((total-subtotal)*100)/100;
    if(difference>0&&difference<=subtotal*.2){
      if(printedTaxLabel){
        uniqueTaxes.push({name:'Possible printed sales tax — verify OCR amount',amount:difference,source:'Needs review (OCR suggestion)',ocrEvidence:printedTaxLabel});
      }else{
        uniqueTaxes.push({name:'Possible sales tax (calculated difference — verify)',amount:difference,source:'Calculated estimate'});
      }
    }
  }
  reviewField('store',store||'',true);reviewField('storeAddress',storeAddress,true);reviewField('date',date,true);
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
  uniqueTaxes.slice(0,8).forEach(t=>{
    addTax({...t,taxType:'Other tax'});
    const row=taxesBox.lastElementChild;
    row.dataset.ocrSuggestion='true';
    if(t.ocrEvidence){
      const note=document.createElement('p');
      note.className='ocr-match-warning';
      note.textContent=`OCR detected a printed tax label: "${t.ocrEvidence}". The $${money(t.amount)} amount comes from total minus subtotal, NOT a readable tax amount. Compare the photo and select "Printed on receipt" only if confirmed, or "Calculated estimate" otherwise. You must choose before saving.`;
      row.append(note);
    }
  });
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
    name=name.replace(/^.*?(?=\bFS\s+(?:NISC|MISC)\b)/i,'')
      .replace(/\bNISC\b/gi,'MISC').replace(/\bJCK\b/gi,'JACK')
      .replace(/\bTRWBRY\b/gi,'STRAWBERRY')
      .replace(/\bGROCK\b/gi,'GROCERY')
      .replace(/\s*=\s*[A-Z ]{1,18}$/i,'')
      .replace(/\s+\d{1,2}\s*$/,'')
      .replace(/\s*\(\d{1,2}\s*$/,'');
    return name.slice(0,110);
  }
  // Match a product heading to its own price row, never across another heading.
  // A receipt may put quantity, unit price and extended price on separate OCR lines.
  const productAnchors=/\b(?:MISC|NISC|GROCERY|CAYMAN|SPIRIT|FS\s+MISC)\b/i;
  const pricePattern=/\$\s*(\d+[.,]\d{2})\s*\/\s*(?:pc|ea)\b/i;
  const productHeading=line=>{
    if(/\b(?:subtotal|grand total|debit|credit|purchase|cashier|station|invoice|order|date|thank you|balance|change|ref num|transaction|card entry|auth code|weight|unit price|total price|item count|closed to)\b/i.test(line))return false;
    // 'taxable grocery' is a product, not a tax line.
    if(/\b(?:sales tax|tax total|tax due|gst|hst)\b/i.test(line))return false;
    return productAnchors.test(line) && /[A-Za-z]{3,}/.test(line) && !/\$\s*\d+[.,]\d{2}/.test(line);
  };
  const usedPriceLines=new Set();
  for(let i=0;i<lines.length;i++){
    const raw=lines[i];
    if(!productHeading(raw))continue;
    let candidate=null;
    for(let offset=1;offset<=3 && i+offset<lines.length;offset++){
      const j=i+offset;
      if(productHeading(lines[j]) || /(?:^|\s)\d{1,2}\s*[-–]\s*[A-Za-z]/.test(lines[j]))break; // never borrow a later item's price
      if(usedPriceLines.has(j))continue;
      const next=lines[j];
      const allAmounts=[...next.matchAll(/\$\s*(\d+[.,]\d{2})/g)].map(m=>Number(m[1].replace(',','.')));
      if(!allAmounts.length)continue;
      const unitMatch=next.match(pricePattern);
      const unit=unitMatch?Number(unitMatch[1].replace(',','.')):null;
      // The last printed dollar value is normally the extended line total.
      const price=allAmounts.at(-1);
      if(!Number.isFinite(price)||price<=0||price>100000)continue;
      const context=lines.slice(i+1,j+1).join(' ');
      const qtyMatch=context.match(/(?:^|\s)(\d{1,2})\s*(?:pc|pe|ea)\b/i);
      let qty=qtyMatch?Number(qtyMatch[1]):1;
      let uncertain=!qtyMatch;
      // A reliable unit price plus line total is stronger than OCR quantity debris.
      if(unit!==null && unit>0 && price>=unit){
        const ratio=price/unit;
        if(Math.abs(ratio-Math.round(ratio))<0.02 && ratio>=1 && ratio<=100){
          qty=Math.round(ratio);
          uncertain=false;
        }else if(qtyMatch && Math.abs(qty*unit-price)>0.03){uncertain=true;}
      }
      // OCR sometimes reads '$4.29' as '$84.29' in the unit-price position.
      // Do not let that corrupt the final printed line amount.
      if(qty<1||qty>100)continue;
      candidate={j,qty,price,uncertain};break;
    }
    if(!candidate)continue;
    const cleaned=cleanProductName(raw);
    if(cleaned.length<5)continue;
    const uncertain=candidate.uncertain || /\b(?:MISC|NISC|GROCERY)\b/i.test(cleaned) || /\b\d+\s*$/.test(cleaned);
    items.push({name:cleaned,qty:candidate.qty,price:candidate.price,raw,priceText:lines[candidate.j],uncertain});
    usedPriceLines.add(candidate.j);
    i=candidate.j;
  }
  // General-purpose one-line item parser: OCR often prefixes item lines with noise,
  // drops the dollar sign/decimal, or corrupts parentheses on discounts.
  const itemStop=/\b(?:subtotal|grand\s*total|total|tax|cashier|station|invoice|date|time|credit|debit|payment|balance|change|phone|transaction|receipt|amount\s*due|authorization)\b/i;
  const existingSources=new Set(items.map(x=>x.raw));
  const pendingDiscounts=[];
  // OCR can put noise before the quantity marker, and omit decimal points in prices.
  function normalizeOcrItemName(value){
    return value.replace(/\bCriginal\b/gi,'Original')
      .replace(/\b(20[0o]z|200z)\b/gi,'20 oz')
      .replace(/\bEmployes\b/gi,'Employee')
      .replace(/[|§*’]+/g,' ').replace(/\s+/g,' ').trim();
  }
  for(const raw of lines){
    if(existingSources.has(raw)||itemStop.test(raw))continue;
    // Quantity prefix can be preceded by short OCR artifacts, e.g. "mt 1 -".
    const prefix=raw.match(/(?:^|\s)(\d{1,2})\s*[-–]\s*(?=[A-Za-z])/);
    if(!prefix)continue;
    const qty=Number(prefix[1]);
    if(qty<1||qty>100)continue;
    const body=raw.slice(prefix.index+prefix[0].length).trim();
    const discount=/\b(?:employee|employe[es]*|coupon|discount|markdown|savings)\b/i.test(body);
    const monetary=[...body.matchAll(/\$\s*(\d{1,5}[.,]\d{2})\b/g)];
    let price=null, priceStart=-1, uncertain=false;
    if(monetary.length){
      const m=monetary.at(-1);price=Number(m[1].replace(',','.'));priceStart=m.index;
      uncertain=monetary.length>1;
    }else{
      // A bare terminal 3-digit price ("$279" or "279") is ambiguous;
      // suggest 2.79 only when OCR explicitly shows a quantity/product line.
      const compact=body.match(/(?:\$\s*)?(\d{3})\s*[*'’]?\s*$/);
      if(compact){price=Number(compact[1])/100;priceStart=compact.index;uncertain=true;}
    }
    if(discount){
      // A clearly printed parenthesized/negative price can be accepted;
      // corrupted values must be reconciled against the subtotal and flagged.
      const negative=body.match(/\(\s*\$?\s*(\d+[.,]\d{2})\s*\)|-\s*\$\s*(\d+[.,]\d{2})/);
      if(negative){
        const readValue=Number((negative[1]||negative[2]).replace(',','.'));
        if(subtotal!==null && readValue>subtotal){pendingDiscounts.push({raw,body,qty});continue;}
        price=-readValue;priceStart=negative.index;uncertain=true;
      }
      else {pendingDiscounts.push({raw,body,qty});continue;}
    }
    if(price===null||!Number.isFinite(price)||Math.abs(price)>100000||price===0)continue;
    let name=normalizeOcrItemName((priceStart>=0?body.slice(0,priceStart):body).replace(/\s+\d+(?:[.,]\d+)?\s*$/,''));
    if(name.length<4||!/[A-Za-z]{3}/.test(name)||/\b(?:washington|included|taxable|change|cash)\b/i.test(name))continue;
    items.push({name:name.slice(0,110),qty,price,raw,priceText:raw,uncertain:uncertain||/\b(?:criginal|200z|employes)\b/i.test(raw)});
    existingSources.add(raw);
  }
  // Only recover a corrupted discount if it makes the extracted item values
  // reconcile exactly with a clearly printed subtotal. Always mark uncertain.
  if(pendingDiscounts.length===1 && subtotal!==null){
    const current=items.reduce((sum,item)=>sum+item.qty*item.price,0);
    const needed=Math.round((subtotal-current)*100)/100;
    const candidate=pendingDiscounts[0];
    if(needed<0 && Math.abs(needed)<=current && /\(\s*[$8]?\d+[.,]\d{2}\s*\)/.test(candidate.body)){
      items.push({name:'Employee discount (verify OCR)',qty:1,price:needed,raw:candidate.raw,priceText:'Amount inferred from printed subtotal; VERIFY original discount',uncertain:true});
    }
  }
  // Itemized lines are suggestions; warn if they do not reconcile with the
  // printed subtotal (which may legitimately exclude included taxes/discounts).
  const itemSum=items.reduce((sum,item)=>sum+item.qty*item.price,0);
  if(items.length && subtotal!==null && Math.abs(itemSum-subtotal)>0.02){
    const warning=document.createElement('p');
    warning.className='ocr-match-warning';
    warning.textContent=`Item suggestions total $${itemSum.toFixed(2)} versus printed subtotal $${subtotal.toFixed(2)}. Review missing items, discounts, and included taxes; nothing has been adjusted automatically.`;
    // The scan handler displays this warning alongside the OCR summary.
  }
  items.slice(0,30).forEach(item=>{
    addItem(item);
    const row=itemsBox.lastElementChild;
    row.dataset.ocrSuggestion='true';
    row.querySelector('[data-key="name"]').classList.add('ocr-uncertain');
    if(item.uncertain){row.querySelector('[data-key="qty"]').classList.add('ocr-uncertain');row.dataset.reviewNeeded='true';}
    const details=document.createElement('details');details.className='ocr-item-source';
    const summary=document.createElement('summary');summary.textContent='Original OCR product text — compare before saving';
    const original=document.createElement('pre');original.textContent='Description: '+item.raw+'\nPrice line: '+item.priceText;
    details.append(summary,original);row.append(details);
    if(item.uncertain){const note=document.createElement('p');note.className='ocr-match-warning';note.textContent='Review this match: OCR could not fully verify the description or quantity against the price.';row.append(note);}
  });
  return {itemReconciliationWarning:items.length && subtotal!==null && Math.abs(itemSum-subtotal)>0.02 ? ` Item suggestions total $${itemSum.toFixed(2)} versus printed subtotal $${subtotal.toFixed(2)}; review missing items and discounts.` : '',fields:[store&&'Store',date&&'Date',total!==null&&'Total',subtotal!==null&&'Subtotal'].filter(Boolean),taxCount:uniqueTaxes.length,itemCount:items.length,uncertainItems:items.filter(x=>x.uncertain).length,totalFromPayment,estimatedTax:uniqueTaxes.some(t=>t.source==='Calculated estimate'),pendingTaxReview:uniqueTaxes.some(t=>t.source==='Needs review (OCR suggestion)')};
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
    scanWarnings.textContent=`OCR suggested ${parsed.fields.join(', ')||'no standard fields'} and ${parsed.taxCount} tax suggestion(s), plus ${parsed.itemCount} possible item(s). ${parsed.uncertainItems?parsed.uncertainItems+" item match(es) need extra review. ":""}${parsed.totalFromPayment?"Total was suggested from a payment line. ":""}${parsed.itemReconciliationWarning||''}${parsed.itemCount===0?' No products were extracted: check OCR product lines and review manually. ':''}${parsed.estimatedTax?"A possible tax was estimated from the difference; it is NOT verified printed tax. ":""}${parsed.pendingTaxReview?"A printed tax label was detected but the amount was unreadable. Review and classify the suggested amount before saving. ":""}Verify every field, tax and item before saving. Never add a calculated tax estimate on top of a printed tax. Only the first photo is shown in older receipt views; all optimized photos are saved in the receipt record.`;
    ocrStatus('Scan complete. Review highlighted fields and the receipt photo before saving.');
    document.dispatchEvent(new Event('receipt-ocr-complete'));
    form.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(error){ocrStatus(`Scan failed: ${error.message}`);}
  finally{scanButton.disabled=false;}
});
window.resetOcrPhotos=()=>{scanImages=[];window.pendingOcrPhotos=[];scanText.value='';scanWarnings.textContent='';renderScanImages();};
