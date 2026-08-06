function getPricingCache(){
  try{return JSON.parse(localStorage.getItem(PRICING_CACHE_KEY)||"{}")}
  catch{return{}}
}

function setPricingCache(cache){
  try{localStorage.setItem(PRICING_CACHE_KEY,JSON.stringify(cache))}catch(e){}
}

function cacheKey(url){
  try{return new URL(url).hostname.replace(/^www\./,"")+new URL(url).pathname.replace(/\/$/,"")}
  catch{return url}
}

async function enrichPopularVenues(run){
  const targets=state.venues.filter(v=>v.website).slice(0,WEBSITE_LOOKUP_LIMIT);
  if(!targets.length){
    state.pricingStatus="complete";
    renderVenues();
    return;
  }
  const cache=getPricingCache();
  let completed=0;
  for(const venue of targets){
    if(run!==state.enrichmentRun) return;
    const key=cacheKey(venue.website), saved=cache[key];
    if(saved&&Date.now()-saved.cachedAt<PRICING_CACHE_MS){
      venue.pricing={...venue.pricing,...saved.pricing};
    }else{
      const official=await readOfficialVenueDetails(venue);
      if(official){
        venue.pricing={...venue.pricing,...official};
        cache[key]={cachedAt:Date.now(),pricing:official};
        setPricingCache(cache);
      }
    }
    completed++;
    sortVenues();
    renderVenues(`${completed} of ${targets.length} official sites checked`);
  }
  if(run!==state.enrichmentRun) return;
  state.pricingStatus="complete";
  sortVenues();
  renderVenues();
}

async function readerText(url){
  if(!/^https?:\/\//i.test(url)) return "";
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),14000);
  try{
    const r=await fetch(READER_PREFIX+url,{headers:{Accept:"text/plain"},signal:controller.signal});
    if(!r.ok) return "";
    return (await r.text()).slice(0,240000);
  }catch(e){return ""}
  finally{clearTimeout(timer)}
}

async function readOfficialVenueDetails(venue){
  const home=await readerText(venue.website);
  if(!home) return null;
  let details=extractOfficialDetails(home,venue.website);
  const nextPages=findOfficialDetailLinks(home,venue.website,details);
  for(const next of nextPages){
    const page=await readerText(next);
    if(page) details=mergeOfficialDetails(details,extractOfficialDetails(page,next));
  }
  details.bookingContact=details.bookingContact||venue.pricing.bookingContact;
  details.bookingUrl=details.bookingUrl||venue.bookingUrl;
  details.availability=details.availability||reservationText(venue.reservation,details.bookingUrl);
  details.savings=details.savings||calculateSavings(details.regularRate,details.groupRate);
  details.checkedAt=new Date().toISOString();
  const officialFields=[details.groupRate,details.regularRate,details.minimumGroup,details.restrictions,details.bookingUrl,details.bookingContact,details.availability].filter(Boolean);
  details.status=details.groupRate?"official":officialFields.length?"partial":"unverified";
  details.sourceLabel=details.groupRate?"Official group-pricing source":"Official venue website checked";
  return details;
}

function extractOfficialDetails(markdown,sourceUrl){
  const baseLines=markdown.split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/).map(cleanLine).filter(l=>l.length>2&&l.length<420);
  const lines=[...new Set(baseLines.flatMap((line,i)=>[
    line,
    [line,baseLines[i+1]].filter(Boolean).join(" "),
    [line,baseLines[i+1],baseLines[i+2]].filter(Boolean).join(" ")
  ]).filter(l=>l.length<520))];
  const groupLabel=/\bgroups?\b|group\s+(?:admission|rate|pricing|ticket|discount|sales)/i;
  const regularLabel=/\b(?:general|regular|adult|standard|park|daily|single.?day)\s+(?:admission|ticket|price|rate)\b|\bgate price\b|\badmission\b/i;
  const groupLine=bestLine(lines,l=>moneyAfterLabel(l,groupLabel),true);
  const regularLine=bestLine(lines,l=>moneyAfterLabel(l,regularLabel)&&! /\bgroups?\b/i.test(l),false);
  const minimumLine=bestLine(lines,l=>/\bgroups?\b|group admission/i.test(l)&&/(?:minimum|at least|or more|\+\s*(?:people|guests)?|\d+\s*(?:-|to)\s*\d+)/i.test(l),false);
  const groupIndex=Math.max(0,baseLines.findIndex(l=>groupLabel.test(l)));
  const restrictionLines=baseLines.filter((l,i)=>(/\bgroups?\b/i.test(l)||Math.abs(i-groupIndex)<=5)&&/advance|reservation|required|blackout|weekday|school|tax|gratuity|deposit|non.?refundable|not valid|must be booked|cannot be combined/i.test(l)).slice(0,2);
  const availabilityLine=bestLine(baseLines,l=>/reservation|reserve|book online|select (?:a )?(?:date|time)|advance booking/i.test(l),false);
  const bookingUrl=findBookingLink(markdown,sourceUrl);
  const email=(markdown.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)||[])[0]||"";
  const phoneLine=baseLines.find(l=>/(?:group sales|reservations?|booking|contact)/i.test(l)&&/(?:\+?\d[\d().\s-]{7,}\d)/.test(l))||"";
  const phone=(phoneLine.match(/(?:\+?\d[\d().\s-]{7,}\d)/)||[])[0]||"";
  return {
    groupRate:pricePhrase(groupLine),regularRate:pricePhrase(regularLine),minimumGroup:minimumGroup(minimumLine),
    savings:"",restrictions:restrictionLines.join(" "),bookingContact:[email,phone].filter(Boolean).join(" · "),
    availability:availabilityLine?availabilityPhrase(availabilityLine,bookingUrl):bookingUrl?"Official reservation page available":"",
    bookingUrl,sourceUrl,sourceLabel:"Official venue website",checkedAt:"",status:"partial"
  };
}

function cleanLine(line=""){
  return String(line).replace(/!\[[^\]]*\]\([^)]*\)/g," ").replace(/\[([^\]]+)\]\([^)]*\)/g,"$1")
    .replace(/^\s*[-*#>]+\s*/,"").replace(/[|*_`]/g," ").replace(/\s+/g," ").trim();
}

function hasMoney(line){return /(?:US\$|USD\s*|\$|£|€)\s*\d+(?:[.,]\d{1,2})?/i.test(line)}

function moneyAfterLabel(line,labelRegex){
  const moneyIndex=String(line).search(/(?:US\$|USD\s*|\$|£|€)\s*\d/i);
  const labelIndex=String(line).search(labelRegex);
  return labelIndex>=0&&moneyIndex>labelIndex;
}

function bestLine(lines,test,preferPerPerson){
  let best="",score=-1;
  for(const line of lines){
    if(!test(line)) continue;
    let s=0;
    if(/admission|ticket|rate|price/i.test(line)) s+=5;
    if(/per person|per guest|each/i.test(line)) s+=preferPerPerson?7:2;
    if(/starting|from as low as/i.test(line)) s-=1;
    if(/park ticket|daily ticket|single.?day ticket/i.test(line)) s+=5;
    if(/gate price/i.test(line)) s-=3;
    if(line.length<180) s+=3;
    if(s>score){best=line;score=s}
  }
  return best;
}

function pricePhrase(line=""){
  if(!line) return "";
  const money=(line.match(/(?:US\$|USD\s*|\$|£|€)\s*\d+(?:[.,]\d{1,2})?/i)||[])[0];
  if(!money) return "";
  const unit=(line.match(/(?:per person|per guest|per adult|per child|each|adult|child)/i)||[])[0];
  return [money,unit].filter(Boolean).join(" ");
}

function minimumGroup(line=""){
  if(!line) return "";
  const patterns=[
    /(?:minimum(?: group size)?|at least)\s*(?:of\s*)?(\d{1,3})/i,
    /groups?\s+(?:of\s+)?(\d{1,3})\s*(?:or more|\+)?/i,
    /(?:groups?|group admission)\s*(?:of\s*)?(\d{1,3})\s*(?:-|to)\s*\d{1,3}/i,
    /(\d{1,3})\s*(?:or more|people minimum|person minimum|guests minimum)/i
  ];
  for(const p of patterns){const m=line.match(p);if(m)return `${m[1]} people`}
  return "";
}

function availabilityPhrase(line,bookingUrl){
  if(/required|must/i.test(line)) return "Advance reservation required";
  if(/recommended/i.test(line)) return "Advance reservation recommended";
  if(/select (?:a )?(?:date|time)|availability/i.test(line)) return "Check dates and times on the official calendar";
  return bookingUrl?"Official reservation page available":"Booking information published";
}

function markdownLinks(markdown){
  const out=[];
  for(const m of markdown.matchAll(/\[([^\]]{1,120})\]\((https?:\/\/[^)\s]+)\)/g)) out.push({label:m[1],url:m[2]});
  return out;
}

function sameHost(a,b){
  try{return new URL(a).hostname.replace(/^www\./,"")===new URL(b).hostname.replace(/^www\./,"")}
  catch{return false}
}

function findOfficialDetailLinks(markdown,baseUrl,details){
  const links=markdownLinks(markdown).filter(l=>sameHost(l.url,baseUrl));
  const scored=links.map(link=>{
    const text=`${link.label} ${link.url}`.toLowerCase();
    let groupScore=0,regularScore=0;
    if(/group|field.?trip|school.?group/.test(text)) groupScore+=16;
    if(/book|reserve|reservation/.test(text)) groupScore+=5;
    if(/ticket|admission|price|daily.?ticket|single.?day|plan.?visit/.test(text)) regularScore+=12;
    if(/group/.test(text)) regularScore-=4;
    if(/privacy|terms|login|donate|membership|calendar\.ics|accessibility/.test(text)){groupScore-=20;regularScore-=20}
    return {url:link.url,groupScore,regularScore};
  });
  const chosen=[];
  if(!details.groupRate){
    const g=[...scored].sort((a,b)=>b.groupScore-a.groupScore)[0];
    if(g&&g.groupScore>=6) chosen.push(g.url);
  }
  if(!details.regularRate){
    const r=[...scored].filter(x=>!chosen.includes(x.url)).sort((a,b)=>b.regularScore-a.regularScore)[0];
    if(r&&r.regularScore>=6) chosen.push(r.url);
  }
  return chosen.slice(0,2);
}

function findBookingLink(markdown,baseUrl){
  const links=markdownLinks(markdown);
  let best="",score=0;
  for(const link of links){
    const text=`${link.label} ${link.url}`.toLowerCase();
    let s=0;
    if(/group/.test(text)) s+=5;
    if(/book|reserve|reservation/.test(text)) s+=9;
    if(/ticket/.test(text)) s+=5;
    if(/login|privacy|terms/.test(text)) s-=10;
    if(s>score){best=link.url;score=s}
  }
  return score>=5?best:"";
}

function mergeOfficialDetails(a,b){
  const merged={...a};
  for(const key of ["groupRate","regularRate","minimumGroup","restrictions","bookingContact","availability","bookingUrl"]){
    if(!merged[key]&&b[key]) merged[key]=b[key];
  }
  if(b.groupRate||b.minimumGroup){merged.sourceUrl=b.sourceUrl;merged.sourceLabel="Official group-pricing source"}
  return merged;
}

function numericPrice(value=""){
  const m=String(value).replace(/,/g,"").match(/\d+(?:\.\d{1,2})?/);
  return m?Number(m[0]):null;
}

function calculateSavings(regular,group){
  const r=numericPrice(regular),g=numericPrice(group);
  if(!r||g===null||g>=r) return "";
  return `${Math.round((r-g)/r*100)}%`;
}
