const STATIC_STATE_CODES={
  Alabama:"AL",Alaska:"AK",Arizona:"AZ",Arkansas:"AR",California:"CA",Colorado:"CO",Connecticut:"CT",Delaware:"DE",
  Florida:"FL",Georgia:"GA",Hawaii:"HI",Idaho:"ID",Illinois:"IL",Indiana:"IN",Iowa:"IA",Kansas:"KS",Kentucky:"KY",
  Louisiana:"LA",Maine:"ME",Maryland:"MD",Massachusetts:"MA",Michigan:"MI",Minnesota:"MN",Mississippi:"MS",Missouri:"MO",
  Montana:"MT",Nebraska:"NE",Nevada:"NV","New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY",
  "North Carolina":"NC","North Dakota":"ND",Ohio:"OH",Oklahoma:"OK",Oregon:"OR",Pennsylvania:"PA","Rhode Island":"RI",
  "South Carolina":"SC","South Dakota":"SD",Tennessee:"TN",Texas:"TX",Utah:"UT",Vermont:"VT",Virginia:"VA",Washington:"WA",
  "West Virginia":"WV",Wisconsin:"WI",Wyoming:"WY","District of Columbia":"DC"
};

function staticSlug(value=""){
  return String(value).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
}

function staticCityId(place){
  const country=String(place.country||place.label||"").toLowerCase();
  if(country&&!country.includes("united states")&&!country.includes(" usa")&&country!=="us") return "";
  let region=String(place.region||"").trim();
  if(!region){
    const label=String(place.label||"");
    region=Object.keys(STATIC_STATE_CODES).find(name=>label.includes(name))||"";
  }
  const code=(STATIC_STATE_CODES[region]||region).toUpperCase();
  if(!/^[A-Z]{2}$/.test(code)) return "";
  if(code==="DC") return "washington-dc";
  return `${staticSlug(cityName(place))}-${code.toLowerCase()}`;
}

function staticVenueType(value=""){
  const text=String(value).toLowerCase();
  if(/museum|gallery|art|science|history|cultural|planetarium|observatory/.test(text)) return "Museums & art";
  if(/park|zoo|aquarium|garden|outdoor|cruise|boat|kayak|rafting|trail|nature/.test(text)) return "Outdoors";
  if(/sport|stadium|arena|golf|bowling|climbing|skating|archery|paintball|kart/.test(text)) return "Sports";
  if(/theatre|theater|cinema|amusement|theme|escape|arcade|laser|trampoline|entertainment/.test(text)) return "Entertainment";
  return "Attraction";
}

function staticVenueKey(name=""){
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
}

function normalizeSavedVenue(row,place){
  const lat=Number(row.lat),lon=Number(row.lon);
  const distanceKm=Number.isFinite(lat)&&Number.isFinite(lon)?haversineKm(place.lat,place.lon,lat,lon):null;
  const official=Boolean(row.sourceBacked);
  const website=asHttpUrl(row.website||row.groupSource||row.regularSource||"");
  const sourceUrl=asHttpUrl(row.groupSource||row.website||row.regularSource||"");
  const bookingNotes=Array.isArray(row.bookingNotes)?row.bookingNotes:[];
  const groupDetails=Array.isArray(row.groupDetails)?row.groupDetails:[];
  const restrictions=[row.eligibility,...groupDetails,...bookingNotes].filter(Boolean).join(" · ");
  const checkedAt=row.lastVerified?new Date(`${row.lastVerified}T12:00:00Z`).toISOString():"";
  return {
    id:row.id||`saved-${staticVenueKey(row.name).replace(/\s+/g,"-")}`,
    name:row.name,
    type:staticVenueType(row.category||row.type),
    kind:row.category||row.type||"attraction",
    address:row.address||place.label,
    website,
    url:sourceUrl||website||`https://www.google.com/search?q=${encodeURIComponent(`${row.name} ${place.label}`)}`,
    osmUrl:"",
    phone:"",
    email:"",
    bookingUrl:sourceUrl,
    reservation:"",
    openingHours:"",
    fee:"",
    wikipedia:"",
    wikidata:"",
    brand:"",
    operator:"",
    lat,lon,distanceKm,
    tags:{},
    sourceBacked:official,
    popularityScore:official?115:45+Math.round(Number(row.confidence||0)*30),
    pricing:{
      status:official?"official":"unverified",
      groupRate:row.groupPrice||"",
      regularRate:row.regularPrice||"",
      minimumGroup:row.minimum||"",
      savings:row.savings||"",
      restrictions,
      bookingContact:"",
      availability:bookingNotes.join(" · "),
      bookingUrl:sourceUrl,
      sourceUrl,
      sourceLabel:official?"Saved official group-pricing source":"Saved venue catalog",
      checkedAt
    }
  };
}

async function loadSavedCityCatalog(place){
  const id=staticCityId(place);
  if(!id) return [];
  try{
    const response=await fetch(`./data/venues/${encodeURIComponent(id)}.json`,{cache:"no-store"});
    if(!response.ok) return [];
    const rows=await response.json();
    if(!Array.isArray(rows)) return [];
    const venues=rows.map(row=>normalizeSavedVenue(row,place)).filter(venue=>venue.name);
    primeSavedPricingCache(venues);
    return venues;
  }catch(e){
    return [];
  }
}

function primeSavedPricingCache(venues){
  if(typeof getPricingCache!=="function"||typeof setPricingCache!=="function"||typeof cacheKey!=="function") return;
  const cache=getPricingCache();
  let changed=false;
  for(const venue of venues){
    if(!venue.sourceBacked||!venue.website) continue;
    cache[cacheKey(venue.website)]={cachedAt:Date.now(),pricing:venue.pricing};
    changed=true;
  }
  if(changed) setPricingCache(cache);
}

function mergeVenueCatalogs(saved,live){
  const seen=new Set(),merged=[];
  for(const venue of [...saved,...live]){
    const key=staticVenueKey(venue.name);
    if(!key||seen.has(key)) continue;
    seen.add(key);merged.push(venue);
  }
  return merged;
}

async function fetchLiveNearbyVenues(place){
  const q=`[out:json][timeout:22];(
    nwr["tourism"~"attraction|museum|gallery|zoo|aquarium|theme_park"](around:40000,${place.lat},${place.lon});
    nwr["leisure"~"theme_park|water_park|stadium|sports_centre|bowling_alley|escape_game|amusement_arcade"](around:40000,${place.lat},${place.lon});
    nwr["amenity"~"theatre|arts_centre|cinema|events_venue"](around:25000,${place.lat},${place.lon});
    nwr["leisure"="park"]["wikidata"](around:25000,${place.lat},${place.lon});
    nwr["leisure"="park"]["wikipedia"](around:25000,${place.lat},${place.lon});
    nwr["leisure"="park"]["website"](around:18000,${place.lat},${place.lon});
  );out center tags 180;`;
  const endpoints=["https://overpass-api.de/api/interpreter","https://overpass.kumi.systems/api/interpreter"];
  for(const endpoint of endpoints){
    try{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),23000);
      const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},body:"data="+encodeURIComponent(q),signal:controller.signal});
      clearTimeout(timer);
      if(response.ok) return normalizeVenues((await response.json())?.elements||[],place);
    }catch(e){}
  }
  return [];
}

async function loadNearbyVenues(place){
  const grid=$("#venueGrid"),count=$("#venueCount"),notice=$("#venueNotice");
  const run=++state.enrichmentRun;
  state.pricingStatus="checking";
  if(grid) grid.innerHTML=loadingCards();
  if(count) count.textContent="Loading the saved city catalog…";
  if(notice) notice.hidden=true;

  const saved=await loadSavedCityCatalog(place);
  if(run!==state.enrichmentRun) return;
  state.venues=saved;
  if(saved.length){
    sortVenues();
    renderVenues(`${saved.length} saved venues loaded; checking for more nearby`);
  }

  const live=await fetchLiveNearbyVenues(place);
  if(run!==state.enrichmentRun) return;
  state.venues=mergeVenueCatalogs(saved,live);
  sortVenues();
  renderVenues();
  await enrichPopularVenues(run);
}

function normalizeVenues(items,place){
  const seen=new Set(),out=[];
  for(const x of items){
    const t=x.tags||{},name=t.name||t["name:en"];
    if(!name||seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const kind=t.tourism||t.leisure||t.amenity||"attraction";
    const all=[t.tourism,t.leisure,t.amenity].filter(Boolean).join(" ");
    let type="Attraction";
    if(/museum|gallery|arts/.test(all)) type="Museums & art";
    else if(/park|zoo|aquarium/.test(all)) type="Outdoors";
    else if(/sports|stadium|bowling/.test(all)) type="Sports";
    else if(/theatre|cinema|theme_park|escape|arcade|water_park|events_venue/.test(all)) type="Entertainment";
    const addr=[t["addr:housenumber"],t["addr:street"],t["addr:city"]].filter(Boolean).join(" ")||"Near the selected city";
    const website=asHttpUrl(t.website||t["contact:website"]||t.url||"");
    const osmUrl=`https://www.openstreetmap.org/${x.type}/${x.id}`;
    const lat=Number(x.lat??x.center?.lat),lon=Number(x.lon??x.center?.lon);
    const distanceKm=Number.isFinite(lat)&&Number.isFinite(lon)?haversineKm(place.lat,place.lon,lat,lon):null;
    const bookingUrl=asHttpUrl(t["contact:booking"]||t["reservation:website"]||t.booking||t.tickets||"");
    const phone=t["contact:phone"]||t.phone||"";
    const email=t["contact:email"]||t.email||"";
    const reservation=t.reservation||t["reservation:required"]||"";
    const venue={
      id:`${x.type}-${x.id}`,name,type,kind,address:addr,website,url:website||osmUrl,osmUrl,
      phone,email,bookingUrl,reservation,openingHours:t.opening_hours||"",fee:t.fee||t.charge||"",
      wikipedia:t.wikipedia||"",wikidata:t.wikidata||"",brand:t.brand||"",operator:t.operator||"",
      lat,lon,distanceKm,tags:t,sourceBacked:false,
      pricing:{
        status:"unverified",groupRate:"",regularRate:communityPrice(t),minimumGroup:"",savings:"",
        restrictions:"",bookingContact:[email,phone].filter(Boolean).join(" · "),
        availability:reservationText(reservation,bookingUrl),bookingUrl,sourceUrl:"",sourceLabel:"",checkedAt:""
      }
    };
    venue.popularityScore=popularityScore(venue);
    out.push(venue);
  }
  return out;
}

function asHttpUrl(value=""){
  const v=String(value).trim();
  if(/^https?:\/\//i.test(v)) return v;
  if(/^www\./i.test(v)) return `https://${v}`;
  return "";
}

function communityPrice(tags){
  const value=String(tags.charge||tags["fee:amount"]||"").trim();
  return /(?:\$|£|€|USD|GBP|EUR)\s*\d/i.test(value)?value:"";
}

function reservationText(value,bookingUrl){
  const v=String(value||"").toLowerCase();
  if(/required|yes|mandatory/.test(v)) return "Advance reservation required";
  if(/recommended/.test(v)) return "Advance reservation recommended";
  if(bookingUrl) return "Official reservation page available";
  return "";
}

function haversineKm(aLat,aLon,bLat,bLon){
  const r=6371,rad=n=>n*Math.PI/180;
  const dLat=rad(bLat-aLat),dLon=rad(bLon-aLon);
  const a=Math.sin(dLat/2)**2+Math.cos(rad(aLat))*Math.cos(rad(bLat))*Math.sin(dLon/2)**2;
  return r*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function popularityScore(v){
  const k=v.kind;
  let score=0;
  if(v.wikipedia) score+=44;
  if(v.wikidata) score+=36;
  if(v.website) score+=14;
  if(v.brand) score+=10;
  if(v.operator) score+=6;
  if(k==="theme_park") score+=65;
  else if(k==="zoo"||k==="aquarium") score+=54;
  else if(k==="museum") score+=45;
  else if(k==="stadium") score+=42;
  else if(k==="water_park") score+=38;
  else if(k==="gallery"||k==="theatre"||k==="arts_centre") score+=28;
  else if(k==="attraction") score+=25;
  else if(k==="cinema"||k==="events_venue") score+=20;
  else if(k==="bowling_alley"||k==="escape_game"||k==="amusement_arcade") score+=18;
  else if(k==="sports_centre") score+=12;
  else if(k==="park") score+=v.wikipedia||v.wikidata?22:3;
  if(v.fee&&String(v.fee).toLowerCase()!=="no") score+=5;
  if(v.distanceKm!==null){
    if(v.distanceKm<=8) score+=8;
    else if(v.distanceKm<=20) score+=5;
    else if(v.distanceKm<=40) score+=2;
  }
  return score;
}

function pricingCompleteness(v){
  const p=v.pricing||{};
  return [p.groupRate,p.regularRate,p.minimumGroup,p.savings,p.restrictions,p.bookingContact,p.availability].filter(Boolean).length;
}

function rankingScore(v){
  const p=v.pricing||{};
  return v.popularityScore*2+pricingCompleteness(v)*16+(p.status==="official"?45:p.status==="partial"?18:0)-(v.distanceKm||0)*.12;
}

function sortVenues(){
  state.venues.sort((a,b)=>rankingScore(b)-rankingScore(a)||a.name.localeCompare(b.name));
}
