'use strict';
// Tesseract.js runs recognition in the browser. Initial load requires network access.
let scanImages = [];
let scanOcrImages = [];
const scanInput = document.querySelector('#ocr-files');
const scanCamera = document.querySelector('#ocr-camera');
const scanStatus = document.querySelector('#ocr-status');
const scanPreview = document.querySelector('#ocr-preview');
const scanButton = document.querySelector('#ocr-run');
const scanText = document.querySelector('#ocr-text');
const scanWarnings = document.querySelector('#ocr-warnings');
function ocrStatus(message) { scanStatus.textContent = message; }
function compressReceipt(file, maxDimension=1900, quality=0.82) {
  return new Promise((resolve,reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = maxDimension, scale = Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1,Math.round(img.naturalWidth*scale));
      canvas.height = Math.max(1,Math.round(img.naturalHeight*scale));
      canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg',quality));
    };
    img.onerror = () => {URL.revokeObjectURL(url);reject(new Error('Cannot open this image'));};
    img.src=url;
  });
}
// OCR long receipts in overlapping vertical bands so tiny printed rows are
// not crushed to fit a single image. Bands are scanned in reading order.
async function receiptOcrBands(dataUrl) {
  const img=new Image();img.src=dataUrl;
  await img.decode();
  const bands=[];
  // Find a pale horizontal gap near each boundary. Each physical receipt row
  // belongs to exactly one section; overlapping OCR sections previously
  // produced duplicate UPC rows (including identical repeated products).
  const probe=document.createElement('canvas');
  probe.width=img.naturalWidth;probe.height=img.naturalHeight;
  const ctx=probe.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(img,0,0);
  const width=probe.width,height=probe.height;
  const rgba=ctx.getImageData(0,0,width,height).data;
  const sampleStep=Math.max(1,Math.floor(width/350));
  function darkness(y){
    let score=0;
    for(let x=0;x<width;x+=sampleStep){
      const k=(y*width+x)*4;
      const gray=.299*rgba[k]+.587*rgba[k+1]+.114*rgba[k+2];
      if(gray<165)score++;
    }
    return score;
  }
  let y=0;
  while(y<height){
    let end=Math.min(height,y+1450);
    if(end<height){
      let best=end,bestScore=Infinity;
      for(let candidate=Math.max(y+950,end-100);candidate<=Math.min(height-1,end+100);candidate+=2){
        const score=darkness(candidate-1)+darkness(candidate)+darkness(candidate+1);
        if(score<bestScore){bestScore=score;best=candidate;}
      }
      end=best;
    }
    const canvas=document.createElement('canvas');
    canvas.width=width;canvas.height=end-y;
    canvas.getContext('2d').drawImage(img,0,y,width,end-y,0,0,width,end-y);
    bands.push(canvas);
    y=end;
  }
  probe.width=0;probe.height=0;
  return bands;
}
// Enhance faint thermal-printer text for a second, independent OCR attempt.
// Compare each band's original and enhanced OCR rather than concatenating both:
// concatenation would double-count purchases printed in both versions.
function enhanceReceiptBand(source) {
  const canvas=document.createElement('canvas');
  canvas.width=source.width;canvas.height=source.height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(source,0,0);
  const frame=ctx.getImageData(0,0,canvas.width,canvas.height);
  const pixels=frame.data;
  for(let i=0;i<pixels.length;i+=4){
    const gray=Math.round(.299*pixels[i]+.587*pixels[i+1]+.114*pixels[i+2]);
    // Moderate contrast stretch, not binary thresholding: retain thin digits.
    const adjusted=Math.max(0,Math.min(255,Math.round((gray-128)*1.65+143)));
    pixels[i]=adjusted;pixels[i+1]=adjusted;pixels[i+2]=adjusted;
  }
  ctx.putImageData(frame,0,0);
  return canvas;
}
// Give the upper part of the first receipt section an additional enlarged
// reading. Barcodes and tightly packed first item rows can cause Tesseract to
// skip a line in a full-section pass. The supplemental text is NOT appended
// wholesale: only UPC-verified, occurrence-checked lines may be recovered.
function enlargedUpperReceiptRegion(source) {
  const top=Math.floor(source.height*0.16);
  const bottom=Math.min(source.height,Math.ceil(source.height*0.76));
  if(bottom-top<120)return null;
  const factor=1.65;
  const canvas=document.createElement('canvas');
  canvas.width=Math.round(source.width*factor);
  canvas.height=Math.round((bottom-top)*factor);
  const ctx=canvas.getContext('2d');
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality='high';
  ctx.drawImage(source,0,top,source.width,bottom-top,0,0,canvas.width,canvas.height);
  return canvas;
}
// Independently inspect several small upper-receipt windows.  Cropping out
// the barcode and unrelated rows gives Tesseract a different segmentation
// opportunity.  Only UPC-and-price-verified new occurrences are merged.
function focusedFirstItemRegions(source) {
  const regions=[];
  const windows=[[0.20,0.48],[0.34,0.62],[0.46,0.74]];
  for(const [start,end] of windows){
    const top=Math.floor(source.height*start);
    const bottom=Math.min(source.height,Math.ceil(source.height*end));
    if(bottom-top<70)continue;
    const factor=2;
    const canvas=document.createElement('canvas');
    canvas.width=Math.round(source.width*factor);
    canvas.height=Math.round((bottom-top)*factor);
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.imageSmoothingEnabled=true;
    ctx.imageSmoothingQuality='high';
    ctx.drawImage(source,0,top,source.width,bottom-top,0,0,canvas.width,canvas.height);
    regions.push(canvas);
  }
  return regions;
}
function receiptOcrItemScore(text){
  const lines=text.split(/\r?\n/);
  let scored=0;
  for(const line of lines){
    // Require a recognizable UPC AND a plausible price in the same line.
    // Counts are only used to select the OCR image; they are not receipt data.
    if(/\b\d[\d ]{8,17}\d\s+(?:[FNTO]\s+)?\$?\d{1,4}[.,]\d{2}\b/i.test(line))scored+=3;
    else if(/\b\d{10,14}\b/.test(line))scored+=1;
  }
  return scored;
}
// Merge two readings of the same physical receipt band conservatively.
// A damaged UPC can differ between passes for the *same* product. Require
// BOTH the UPC occurrence and normalized product-name occurrence to be new.
// This preserves repeated items when one pass actually sees more copies,
// without treating a different OCR spelling of a UPC as another purchase.
function mergeReceiptBandReadings(primary, alternate) {
  const a=primary.split(/\r?\n/), b=alternate.split(/\r?\n/);
  const item=(line)=>{
    const m=line.match(/\b(\d[\d ]{8,16}\d)K?\s+(?:[FNTO]\s+)?\$?\s*(\d{1,4}[.,]\d{2})\s*[XNTO0]?\s*$/i);
    if(!m)return null;
    const upc=m[1].replace(/\s/g,'');
    const name=line.slice(0,m.index).replace(/^[^A-Za-z]+/,'').replace(/^(?:(?:SN|SS|SNS|Wa|Ne|Bi|aN|bo|eh|pl|EL|Xu|J)\s+){1,3}/i,'').trim();
    if(upc.length<10||upc.length>14||!/[A-Za-z]{3}/.test(name))return null;
    const key=name.toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/^[0-9]+/,'');
    if(key.length<4)return null;
    return {upc,key,line};
  };
  const count=(lines,field)=>{
    const counts=new Map();
    for(const line of lines){const x=item(line);if(x)counts.set(x[field],(counts.get(x[field])||0)+1);}
    return counts;
  };
  const upcs=count(a,'upc'), names=count(a,'key');
  const seenUpcs=new Map(), seenNames=new Map(), extras=[];
  for(const line of b){
    const x=item(line);if(!x)continue;
    const upcOccurrence=(seenUpcs.get(x.upc)||0)+1;
    const nameOccurrence=(seenNames.get(x.key)||0)+1;
    seenUpcs.set(x.upc,upcOccurrence);
    seenNames.set(x.key,nameOccurrence);
    if(upcOccurrence>(upcs.get(x.upc)||0) && nameOccurrence>(names.get(x.key)||0))extras.push(x);
  }
  if(!extras.length)return primary;
  let insert=a.findIndex(line=>/\b(?:subtotal|subt[o0]tal|tax\s*[1Il]|total)\b/i.test(line));
  if(insert<0)insert=a.length;
  a.splice(insert,0,...extras.map(x=>x.line));
  return a.join('\n');
}
// A stray OCR echo can appear in the blank gap between the last purchase
// and SUBTOTAL. Only suppress it for item extraction when the same UPC AND
// price were already read above, and the echo is isolated by a blank line.
// Do not deduplicate ordinary repeated UPCs: multiple identical purchases
// are valid and must remain separate rows.
function suppressIsolatedFooterEcho(text) {
  const lines=text.split(/\r?\n/);
  const signature=line=>{
    const m=line.match(/\b(\d[\d ]{8,16}\d)K?\s+(?:[FNTO]\s+)?\$?\s*(\d{1,4}[.,]\d{2})\s*[:;]?\s*[XNTO0]?\s*$/i);
    return m ? m[1].replace(/\s/g,'')+'|'+m[2].replace(',','.') : null;
  };
  const suppressed=[];
  for(let i=2;i<lines.length-1;i++){
    if(lines[i-1].trim()!=='' || !/\bsubt[o0]tal\b/i.test(lines[i+1]))continue;
    const sig=signature(lines[i]);
    if(!sig)continue;
    if(lines.slice(0,i-1).some(line=>signature(line)===sig)){
      suppressed.push(lines[i]);
      lines[i]='';
    }
  }
  return {text:lines.join('\n'),suppressed};
}
function renderScanImages() {
  scanPreview.replaceChildren();
  scanImages.forEach((src,index) => {
    const wrap=document.createElement('div');wrap.className='ocr-image';
    const img=document.createElement('img');img.src=src;img.alt=`Receipt photo ${index+1}`;
    const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent='Remove';
    remove.addEventListener('click',()=>{scanImages.splice(index,1);scanOcrImages.splice(index,1);renderScanImages();});
    wrap.append(img,remove);scanPreview.append(wrap);
  });
  scanButton.disabled = scanImages.length===0;
}
async function receiveImages(event) {
  const files=[...(event.target.files||[])];
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (scanImages.length>=8) {ocrStatus('Maximum 8 photos per receipt.');break;}
    try {
      // Keep the saved receipt photo small, but OCR a higher-resolution copy.
      const preview=await compressReceipt(file);
      const ocrCopy=await compressReceipt(file,4200,0.94);
      scanImages.push(preview);scanOcrImages.push(ocrCopy);
    } catch(error) {ocrStatus(error.message);}
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
  const subtotalLine=lines.find(x=>/\b(?:sub\s*[-:]?\s*total|subt[o0]tal|s[u0]bt[o0]tal)\b/i.test(x)&&amount(x)!==null);
  let subtotal=subtotalLine?amount(subtotalLine):null;
  let subtotalInferred=false;
  const dateMatch=text.match(/\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b|\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/);
  let date='';if(dateMatch){const y=dateMatch[1]||dateMatch[6],m=dateMatch[2]||dateMatch[4],d=dateMatch[3]||dateMatch[5];date=`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;}
  // Walmart and other stores may print a two-digit year or an English month.
  if(!date){
    const short=text.match(/\b(0?[1-9]|1[0-2])[\/.\-](0?[1-9]|[12]\d|3[01])[\/.\-](\d{2})\b/);
    if(short)date=`20${short[3]}-${short[1].padStart(2,'0')}-${short[2].padStart(2,'0')}`;
  }
  if(!date){
    const named=text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})\s*,?\s*(20\d{2})\b/i);
    if(named){const m=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(named[1].slice(0,3).toLowerCase())+1;date=`${named[3]}-${String(m).padStart(2,'0')}-${named[2].padStart(2,'0')}`;}
  }
  // Do not enter an impossible date based on OCR noise.
  if(date){const [y,m,d]=date.split('-').map(Number);const parsed=new Date(Date.UTC(y,m-1,d));if(parsed.getUTCFullYear()!==y||parsed.getUTCMonth()!==m-1||parsed.getUTCDate()!==d)date='';}
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
  let store=storeCandidates.sort((a,b)=>b.score-a.score)[0]?.cleaned||'';
  // A store heading is stronger evidence than a promotional URL or survey line.
  // Do not invent a merchant: only use the brand if it actually occurs in OCR.
  if(headerLines.some(line=>/\b(?:wm\s+supercenter|walmart\s+supercenter)\b/i.test(line)))store='Walmart Supercenter';
  else if(headerLines.some(line=>/\bwalmart\b/i.test(line)))store='Walmart';
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
    // Walmart receipts often print a compact line such as "TAXI 8.9000 % 3.18".
    const walmartTax=line.match(/\bTAX\s*[1Il|]?\s+(\d{1,2}[.,]\d{2,4})\s*%\s+\$?\s*(\d+[.,]\d{2})\b/i);
    if(walmartTax){
      taxCandidates.push({name:`Sales tax (${walmartTax[1].replace(',','.') }% printed rate)`,amount:Number(walmartTax[2].replace(',','.')),source:'Printed on receipt'});
      continue;
    }
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
  // A few Walmart layouts put the tax rate and dollar amount on adjacent
  // lines. Require an explicit tax label and an unambiguous dollar amount.
  for(let i=0;i<lines.length;i++){
    if(!/\b(?:sales\s*tax|tax\s*total|tax\s*amount)\b/i.test(lines[i])||amount(lines[i])!==null)continue;
    const next=lines[i+1]||'';
    if(/^\s*\$\s*\d{1,4}[.,]\d{2}\s*$/.test(next)){
      taxCandidates.push({name:'Sales tax (adjacent printed line)',amount:amount(next),source:'Printed on receipt'});
    }
  }
  let uniqueTaxes=taxCandidates.filter((t,i,a)=>a.findIndex(v=>v.amount===t.amount)===i);
  let total=totalCandidates.find(v=>subtotal===null||v>=subtotal)||null;
  // When Walmart's explicit tax line and total are readable but its subtotal
  // label is absent from OCR, calculate a clearly reviewable subtotal suggestion.
  if(subtotal===null && total!==null && uniqueTaxes.length===1){
    const candidate=Number((total-uniqueTaxes[0].amount).toFixed(2));
    if(candidate>0 && candidate<total){subtotal=candidate;subtotalInferred=true;}
  }
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
    addTax({...t,taxType:t.name.toLowerCase().includes('sales tax')?'Combined sales tax':'Other tax'});
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
  // Walmart's itemized receipt prints one product per UPC row, sometimes with
  // an F taxability marker BEFORE the UPC and a trailing X/N/O marker.
  // Parse the item region as a whole; do not borrow prices from other rows.
  const walmartReceipt=/\b(?:walmart|wm\s+supercenter)\b/i.test(text) && /items\s+sold/i.test(text);
  let walmartParsedItems=[];
  if(walmartReceipt){
    const start=lines.findIndex(x=>/items\s+sold\s*:?\s*\d+/i.test(x));
    const end=lines.findIndex((x,i)=>i>start && /\b(?:subtotal|subt[o0]tal|tax\s*[1Il]|grand\s+total|debit\s+tend)\b/i.test(x));
    const region=lines.slice(Math.max(0,start+1),end>start?end:undefined);
    const walmartItems=[];
    for(const raw of region){
      // Anchored UPC followed by a printed price, not arbitrary numbers in OCR debris.
      const m=raw.match(/\b(\d[\d ]{7,17}\d)K?\s+(?:[FNTO]\s+)?\$?\s*(\d{1,3}[.,]\d{2})\s*(?:[XNTO0])?\s*$/i);
      if(!m)continue;
      const upc=m[1].replace(/\s/g,'');
      if(upc.length<10||upc.length>14)continue;
      let name=raw.slice(0,m.index).replace(/\s+[FNTO]\s*$/i,'').replace(/^[^A-Za-z]+/,'').replace(/[|§]+/g,' ').replace(/\s+/g,' ').trim();
      name=name.replace(/^(?:(?:SN|SS|SNS|Wa|Ne|Bi|aN|bo|eh|pl|EL|Xu|J)\s+){1,3}/i,'').trim();
      if(!/[A-Za-z]{3}/.test(name)||name.length<3)continue;
      const price=Number(m[2].replace(',','.'));
      if(!Number.isFinite(price)||price<=0||price>1000)continue;
      walmartItems.push({name:name.slice(0,110),qty:1,price,raw,priceText:raw,uncertain:true});
    }
    // When the UPC parser recovers a more complete, reconciled list, use it
    // instead of generic suggestions (which may misread an item as $8.92).
    walmartParsedItems=walmartItems;
    const walmartSum=walmartItems.reduce((a,x)=>a+x.price,0);
    const walmartSold=Number(text.match(/items\s+sold\s*:?\s*(\d+)/i)?.[1]||0);
    const genericSum=items.reduce((a,x)=>a+x.qty*(x.price === '' ? 0 : x.price),0);
    const betterCount=walmartItems.length>items.length;
    const betterSubtotal=subtotal!==null && Math.abs(walmartSum-subtotal)<Math.abs(genericSum-subtotal)-0.02;
    if(walmartItems.length && (betterCount||betterSubtotal)){
      items.splice(0,items.length,...walmartItems);
    }
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
  // Walmart UPC and price rows may have OCR debris before and after the values.
  // Preserve duplicates, but never invent an unreadable price.
  const knownItemLines=new Set(items.map(item=>item.raw));
  for(const raw of lines){
    if(knownItemLines.has(raw)||itemStop.test(raw)||/items sold|survey|walmart|supercenter|manager|mgr\./i.test(raw))continue;
    const matches=[...raw.matchAll(/(?:^|\s)(\d(?:[\d\s]{6,17}\d))K?\s+(?:[FNTO]\s+)?\$?\s*(\d{1,4}[.,]\d{2})(?!\d)/gi)];
    if(!matches.length)continue;
    const m=matches[0], upc=m[1].replace(/\s/g,'');
    if(upc.length<8||upc.length>14)continue;
    let name=raw.slice(0,m.index).replace(/^[^A-Za-z]+/,'').replace(/[|§]+/g,' ').replace(/\s+/g,' ').trim();
    name=name.replace(/^(?:(?:SN|SS|SNS|Wa|Ne|Bi|aN|bo|eh|pl|EL)\s+){1,3}/i,'').trim();
    const price=Number(m[2].replace(',','.'));
    if(name.length<3||!/[A-Za-z]{3}/.test(name)||!Number.isFinite(price)||price<=0||price>10000)continue;
    items.push({name:name.slice(0,110),qty:1,price,raw,priceText:raw,uncertain:true});
    knownItemLines.add(raw);
  }
  // Compare all suggestions with the UPC-anchored Walmart extraction after
  // generic recovery. A fuller UPC list or closer subtotal wins; never silently
  // modify a price to force reconciliation.
  if(walmartParsedItems.length){
    const upcSum=walmartParsedItems.reduce((a,x)=>a+x.price,0);
    const generalSum=items.reduce((a,x)=>a+x.qty*(x.price === '' ? 0 : x.price),0);
    const closer=subtotal!==null && Math.abs(upcSum-subtotal)+0.02<Math.abs(generalSum-subtotal);
    if(walmartParsedItems.length>items.length || (walmartParsedItems.length===items.length && closer)){
      items.splice(0,items.length,...walmartParsedItems);
    }
  }
  // Preserve named product lines when OCR loses the price. Never guess an amount.
  const recoveryStart=lines.findIndex(x=>/items\s+sold\s*:?\s*\d+/i.test(x));
  const recoveryEnd=lines.findIndex((x,i)=>i>recoveryStart && /\b(?:subtotal|subt[o0]tal|tax\s*[1Il]|debit\s+tend)\b/i.test(x));
  if(recoveryStart>=0){
    const region=lines.slice(recoveryStart+1,recoveryEnd>recoveryStart?recoveryEnd:undefined);
    const key=name=>name.toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/ROX/g,'BOX');
    for(const raw of region){
      if(items.some(x=>x.raw===raw))continue;
      if(/\b(?:subtotal|tax|total|debit|credit|change|tend|items sold|tc#)\b/i.test(raw))continue;
      let name='';
      const upc=raw.match(/\b\d[\d ]{9,16}\d\b/);
      if(upc) name=raw.slice(0,upc.index).replace(/^[^A-Za-z]+/,'').trim();
      else {
        const bare=raw.replace(/^[^A-Za-z]+/,'').trim();
        if(/^[A-Za-z][A-Za-z0-9 ]{5,45}$/.test(bare) && items.some(x=>key(x.name)===key(bare)))name=bare;
        // Thermal OCR can read the description but corrupt BOTH UPC and price.
        // Example: ONE TI CH DK GLyBOnL 720 2 ¢
        // Recover a leading, multi-word uppercase product description only if
        // the remainder has mixed-case OCR debris and digits. The blank price
        // must be reviewed manually; never infer it from the subtotal.
        if(!name){
          const broken=bare.match(/^((?:[A-Z][A-Z0-9]{1,11}\s+){2,5}[A-Z][A-Z0-9]{1,11})\s+([A-Za-z0-9\s¢$.,:;|]+)$/);
          if(broken && /[a-z]/.test(broken[2]) && /\d/.test(broken[2]) &&
             /[A-Z]{2}/.test(broken[1]) && broken[1].length>=8){
            name=broken[1];
          }
        }
      }
      name=name.replace(/^(?:(?:SN|SS|SNS|Wa|Ne|Bi|aN|bo|eh|pl|EL|Xu|J)\s+){1,3}/i,'').replace(/\s+/g,' ').trim();
      if(name.length<5||!/[A-Za-z]{3}/.test(name))continue;
      items.push({name:name.slice(0,110),qty:1,price:'',raw,
        priceText:'Price unreadable — enter amount from original receipt',uncertain:true,missingPrice:true});
    }
  }
  // Only recover a corrupted discount if it makes the extracted item values
  // reconcile exactly with a clearly printed subtotal. Always mark uncertain.
  if(pendingDiscounts.length===1 && subtotal!==null){
    const current=items.reduce((sum,item)=>sum+item.qty*(item.price === '' ? 0 : item.price),0);
    const needed=Math.round((subtotal-current)*100)/100;
    const candidate=pendingDiscounts[0];
    if(needed<0 && Math.abs(needed)<=current && /\(\s*[$8]?\d+[.,]\d{2}\s*\)/.test(candidate.body)){
      items.push({name:'Employee discount (verify OCR)',qty:1,price:needed,raw:candidate.raw,priceText:'Amount inferred from printed subtotal; VERIFY original discount',uncertain:true});
    }
  }
  // Itemized lines are suggestions; warn if they do not reconcile with the
  // printed subtotal (which may legitimately exclude included taxes/discounts).
  const itemSum=items.reduce((sum,item)=>sum+item.qty*(item.price === '' ? 0 : item.price),0);
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
    if(item.missingPrice){row.dataset.reviewNeeded='true';row.querySelector('[data-key="price"]').classList.add('ocr-uncertain');}
    if(item.uncertain){const note=document.createElement('p');note.className='ocr-match-warning';note.textContent=item.missingPrice?'NEEDS PRICE REVIEW: Enter the missing price from the original receipt.':'Review this match: OCR could not fully verify the description or quantity against the price.';row.append(note);}
  });
  itemsBox.querySelectorAll('[data-ocr-count-warning]').forEach(el=>el.remove());
  const soldLine=lines.find(line=>/#?\s*items\s+sold\s*:?\s*\d+/i.test(line));
  const soldCount=soldLine?Number(soldLine.match(/items\s+sold\s*:?\s*(\d+)/i)?.[1]||0):0;
  itemsBox.dataset.ocrSoldCount = soldCount ? String(soldCount) : '';
  if(soldCount>0 && items.length<soldCount){
    const warning=document.createElement('p');
    warning.className='ocr-match-warning';
    warning.dataset.ocrCountWarning='true';
    warning.setAttribute('role','alert');
    warning.textContent=`INCOMPLETE PRODUCT LIST: Receipt says ${soldCount} items sold, but OCR extracted only ${items.length} product rows. Check the original receipt; do not save this list as complete.`;
    itemsBox.prepend(warning);
  }
  return {soldCount,itemReconciliationWarning:items.length && subtotal!==null && Math.abs(itemSum-subtotal)>0.02 ? ` Initial OCR item suggestions totaled $${itemSum.toFixed(2)} versus receipt subtotal $${subtotal.toFixed(2)}. The live reconciliation below updates when you edit items.` : '',fields:[store&&'Store',date&&'Date',total!==null&&'Total',subtotal!==null&&'Subtotal'].filter(Boolean),taxCount:uniqueTaxes.length,itemCount:items.length,uncertainItems:items.filter(x=>x.uncertain).length,totalFromPayment,estimatedTax:uniqueTaxes.some(t=>t.source==='Calculated estimate'),pendingTaxReview:uniqueTaxes.some(t=>t.source==='Needs review (OCR suggestion)'),subtotalInferred};
}
scanButton.addEventListener('click',async()=>{
  if(!scanImages.length)return;
  scanButton.disabled=true;
  scanWarnings.textContent='';
  try {
    if(!window.Tesseract) throw new Error('OCR library could not load. Check your internet connection and reload.');
    const worker=await Tesseract.createWorker('eng',1,{logger:m=>{if(m.status==='recognizing text')ocrStatus(`Recognizing text: ${Math.round((m.progress||0)*100)}%`);}});
    let texts=[];
    const supplementalDiagnostics=[];
    try {
      for(let i=0;i<scanImages.length;i++){
        const bands=await receiptOcrBands(scanOcrImages[i]||scanImages[i]);
        for(let j=0;j<bands.length;j++){
          ocrStatus(`Scanning photo ${i+1}/${scanImages.length}, section ${j+1}/${bands.length}...`);
          const original=await worker.recognize(bands[j]);
          const originalText=original.data.text||'';
          let selectedText=originalText;
          let alternativeText='';
          const enhanced=enhanceReceiptBand(bands[j]);
          try {
            ocrStatus(`Comparing enhanced text, photo ${i+1}/${scanImages.length}, section ${j+1}/${bands.length}...`);
            const alternative=await worker.recognize(enhanced);
            alternativeText=alternative.data.text||'';
            // Prefer the image that reads more complete UPC/price rows.
            // Never concatenate both: it would duplicate receipt items.
            if(receiptOcrItemScore(alternativeText)>receiptOcrItemScore(originalText))selectedText=alternativeText;
          } finally {enhanced.width=0;enhanced.height=0;}
          // Recover additional, UPC-verified lines from the other reading.
          // Match occurrence counts by UPC to preserve four identical boxes
          // without adding eight when both readings see the same four.
          selectedText=mergeReceiptBandReadings(selectedText,
            selectedText===originalText?alternativeText:originalText);
          // Extra OCR on an enlarged upper region of the first band. Do not
          // append its raw text (which would duplicate existing purchases).
          // The occurrence-aware merge accepts only independently readable
          // UPC + price rows missing from the main reading.
          if(j===0){
            const upper=enlargedUpperReceiptRegion(bands[j]);
            if(upper){
              try {
                ocrStatus(`Checking enlarged first product rows, photo ${i+1}/${scanImages.length}...`);
                const focused=await worker.recognize(upper);
                supplementalDiagnostics.push(`Upper enlarged reading (photo ${i+1}):\n${focused.data.text||'[no text]'}`);
                selectedText=mergeReceiptBandReadings(selectedText,focused.data.text||'');
              } finally {upper.width=0;upper.height=0;}
            }
          }
          // Additional narrow overlapping crops can recover product lines
          // that full-band and broad upper-region OCR skip.  Do not concatenate
          // the readings, which would duplicate repeated purchases.
          if(j===0){
            const regions=focusedFirstItemRegions(bands[j]);
            try {
              for(let k=0;k<regions.length;k++){
                ocrStatus(`Checking first-item crop ${k+1}/${regions.length}, photo ${i+1}/${scanImages.length}...`);
                const focused=await worker.recognize(regions[k]);
                supplementalDiagnostics.push(`Focused crop ${k+1} (photo ${i+1}):\n${focused.data.text||'[no text]'}`);
                selectedText=mergeReceiptBandReadings(selectedText,focused.data.text||'');
                // The alternate contrast pass is confined to the middle crop,
                // keeping scan time reasonable on phones.
                if(k===1){
                  const contrasted=enhanceReceiptBand(regions[k]);
                  try {
                    const alt=await worker.recognize(contrasted);
                    supplementalDiagnostics.push(`Contrasted crop ${k+1} (photo ${i+1}):\n${alt.data.text||'[no text]'}`);
                    selectedText=mergeReceiptBandReadings(selectedText,alt.data.text||'');
                  } finally {contrasted.width=0;contrasted.height=0;}
                }
              }
            } finally {for(const region of regions){region.width=0;region.height=0;}}
          }
          texts.push(selectedText);
          bands[j].width=0;bands[j].height=0;
        }
      }
    }
    finally {await worker.terminate();}
    const combined=texts.join('\n');scanText.value=combined + (supplementalDiagnostics.length ? '\n\n===== UPDATE 29 DIAGNOSTICS (NOT USED FOR PRODUCT EXTRACTION) =====\n' + supplementalDiagnostics.join('\n\n-----\n') : '');
    const footerCheck=suppressIsolatedFooterEcho(combined);
    // Clear prior OCR suggestions only, leave existing manual fields/taxes intact.
    document.querySelectorAll('.ocr-uncertain').forEach(el=>el.classList.remove('ocr-uncertain'));
    const parsed=parseReceiptText(footerCheck.text);
    if(scanImages.length){pendingPhoto=scanImages[0];window.pendingOcrPhotos=[...scanImages];}
    scanWarnings.textContent=`${footerCheck.suppressed.length ? footerCheck.suppressed.length+" isolated duplicate near SUBTOTAL excluded from item suggestions; verify against the photo. " : ""}OCR suggested ${parsed.fields.join(', ')||'no standard fields'} and ${parsed.taxCount} tax suggestion(s), plus ${parsed.itemCount} possible item(s). ${parsed.soldCount&&parsed.itemCount<parsed.soldCount?`Receipt says ${parsed.soldCount} items sold but only ${parsed.itemCount} item rows were recognized. Do not treat the item list as complete. `:''}${parsed.uncertainItems?parsed.uncertainItems+" item match(es) need extra review. ":""}${parsed.totalFromPayment?"Total was suggested from a payment line. ":""}${parsed.itemReconciliationWarning||''}${parsed.itemCount===0?' No products were extracted: check OCR product lines and review manually. ':''}${parsed.estimatedTax?"A possible tax was estimated from the difference; it is NOT verified printed tax. ":""}${parsed.pendingTaxReview?"A printed tax label was detected but the amount was unreadable. Review and classify the suggested amount before saving. ":""}${parsed.subtotalInferred?"Subtotal was calculated as total minus the readable printed tax. Verify it against the receipt before saving. ":""}Verify every field, tax and item before saving. Never add a calculated tax estimate on top of a printed tax. Only the first photo is shown in older receipt views; all optimized photos are saved in the receipt record.`;
    ocrStatus('Scan complete. Review highlighted fields and the receipt photo before saving.');
    document.dispatchEvent(new Event('receipt-ocr-complete'));
    form.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(error){ocrStatus(`Scan failed: ${error.message}`);}
  finally{scanButton.disabled=false;}
});
window.resetOcrPhotos=()=>{scanImages=[];scanOcrImages=[];window.pendingOcrPhotos=[];scanText.value='';scanWarnings.textContent='';renderScanImages();};

// Update 30: live camera guide; optional fallback to native camera remains available.
(() => {
 const open=document.querySelector('#smart-camera-open'),ui=document.querySelector('#smart-camera-ui');
 const video=document.querySelector('#smart-camera-video'),frame=document.querySelector('#smart-camera-frame');
 const mode=document.querySelector('#smart-camera-mode'),feedback=document.querySelector('#smart-camera-feedback');
 const shoot=document.querySelector('#smart-camera-shoot'),close=document.querySelector('#smart-camera-close');
 let stream=null,interval=null,stable=0,busy=false,lastFrame=null,ready=false;
 const canvas=document.createElement('canvas');canvas.width=240;canvas.height=320;
 const ctx=canvas.getContext('2d',{willReadFrequently:true});
 function syncCameraFrame(){if(video.videoWidth&&video.videoHeight){frame.style.setProperty('--camera-aspect',`${video.videoWidth} / ${video.videoHeight}`);frame.dataset.orientation=video.videoHeight>=video.videoWidth?'portrait':'landscape';}}
 video.addEventListener('loadedmetadata',syncCameraFrame);
 function stop(){if(interval)clearInterval(interval);interval=null;if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;ui.hidden=true;open.hidden=false;stable=0;lastFrame=null;ready=false;frame.classList.remove('ready');frame.style.removeProperty('--camera-aspect');}
 async function capture(){if(!stream||busy||scanImages.length>=8)return;busy=true;try{const shot=document.createElement('canvas');shot.width=video.videoWidth;shot.height=video.videoHeight;shot.getContext('2d').drawImage(video,0,0,shot.width,shot.height);const blob=await new Promise(r=>shot.toBlob(r,'image/jpeg',.96));if(!blob)throw Error('Could not capture photo');const file=new File([blob],`receipt-${Date.now()}.jpg`,{type:'image/jpeg'});scanImages.push(await compressReceipt(file));scanOcrImages.push(await compressReceipt(file,4200,.94));renderScanImages();feedback.textContent=`Captured ${scanImages.length} of 8 photos. Reposition for another section or close camera.`;stable=0;}catch(e){feedback.textContent=e.message;}finally{busy=false;}}
 function inspect(){if(!stream||video.readyState<2||busy)return;ctx.drawImage(video,0,0,240,320);const pixels=ctx.getImageData(0,0,240,320).data;let sum=0,sumsq=0,edge=0,centerLight=0,centerCount=0,change=0;const gray=new Uint8Array(240*320);for(let y=0;y<320;y+=1)for(let x=0;x<240;x+=1){const i=y*240+x,k=i*4;const g=Math.round(.299*pixels[k]+.587*pixels[k+1]+.114*pixels[k+2]);gray[i]=g;sum+=g;sumsq+=g*g;if(x>25&&x<215&&y>25&&y<295){centerLight+=g;centerCount++;}if(lastFrame)change+=Math.abs(g-lastFrame[i]);}
 const avg=sum/gray.length,variance=sumsq/gray.length-avg*avg;for(let y=2;y<318;y+=2)for(let x=2;x<238;x+=2){const i=y*240+x;edge+=Math.abs(gray[i]-gray[i-1])+Math.abs(gray[i]-gray[i-240]);}
 const detail=edge/(119*158),motion=lastFrame?change/gray.length:999;lastFrame=gray;
 const issues=[];if(avg<75)issues.push('Add more light');if(avg>222)issues.push('Reduce glare / brightness');if(variance<850||detail<13)issues.push('Move closer or aim at printed text');if(motion>13)issues.push('Hold camera steady');
 ready=issues.length===0;frame.classList.toggle('ready',ready);feedback.textContent=ready?'Green — basic sharpness, light, and stability checks passed. Check that receipt text is fully visible.':'Red — '+issues.join('; ');
 if(mode.value==='auto'&&ready){stable++;if(stable>=4){stable=0;capture();}}else stable=0;
 }
 open.addEventListener('click',async()=>{if(!navigator.mediaDevices?.getUserMedia){feedback.textContent='Live camera unavailable. Use Take photo instead.';ui.hidden=false;return;}try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1080},height:{ideal:1920},aspectRatio:{ideal:0.5625}},audio:false});video.srcObject=stream;await video.play();syncCameraFrame();ui.hidden=false;open.hidden=true;feedback.textContent='Point the camera at the receipt. The guide follows the live image; keep all desired text visible.';interval=setInterval(inspect,450);}catch(e){ui.hidden=false;feedback.textContent='Camera permission or access failed. Use Take photo instead. '+e.message;}});
 shoot.addEventListener('click',capture);close.addEventListener('click',stop);mode.addEventListener('change',()=>{stable=0;});document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});window.addEventListener('pagehide',stop);
})();
