async function loadNearbyVenues(place){
  const grid=$("#venueGrid"), count=$("#venueCount"), notice=$("#venueNotice");
  const run=++state.enrichmentRun;
  state.pricingStatus="checking";
  if(grid) grid.innerHTML=loadingCards();
  if(count) count.textContent="Finding popular places and official pricing…";
  if(notice) notice.hidden=true;

  // A metro-sized radius brings major destination attractions into city searches.
  // Parks are limited to notable ones with a website, Wikipedia, or Wikidata entry.
  const q=`[out:json][timeout:22];(
    nwr["tourism"~"attraction|museum|gallery|zoo|aquarium|theme_park"](around:40000,${place.lat},${place.lon});
    nwr["leisure"~"theme_park|water_park|stadium|sports_centre|bowling_alley|escape_game|amusement_arcade"](around:40000,${place.lat},${place.lon});
    nwr["amenity"~"theatre|arts_centre|cinema|events_venue"](around:25000,${place.lat},${place.lon});
    nwr["leisure"="park"]["wikidata"](around:25000,${place.lat},${place.lon});
    nwr["leisure"="park"]["wikipedia"](around:25000,${place.lat},${place.lon});
    nwr["leisure"="park"]["website"](around:18000,${place.lat},${place.lon});
  );out center tags 180;`;
  const endpoints=["https://overpass-api.de/api/interpreter","https://overpass.kumi.systems/api/interpreter"];
  let data=null;
  for(const endpoint of endpoints){
    try{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),23000);
      const r=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},body:"data="+encodeURIComponent(q),signal:controller.signal});
      clearTimeout(timer);
      if(r.ok){ data=await r.json(); break; }
    }catch(e){}
  }
  if(run!==state.enrichmentRun) return;
  state.venues=normalizeVenues(data?.elements||[],place);
  sortVenues();
  renderVenues();
  await enrichPopularVenues(run);
}

function normalizeVenues(items,place){
  const seen=new Set(), out=[];
  for(const x of items){
    const t=x.tags||{}, name=t.name||t["name:en"];
    if(!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const kind=t.tourism||t.leisure||t.amenity||"attraction";
    const all=[t.tourism,t.leisure,t.amenity].filter(Boolean).join(" ");
    let type="Attraction";
    if(/museum|gallery|arts/.test(all)) type="Museums & art";
    else if(/park|zoo|aquarium/.test(all)) type="Outdoors";
    else if(/sports|stadium|bowling/.test(all)) type="Sports";
    else if(/theatre|cinema|theme_park|escape|arcade|water_park|events_venue/.test(all)) type="Entertainment";
    const addr=[t["addr:housenumber"],t["addr:street"],t["addr:city"]].filter(Boolean).join(" ") || "Near the selected city";
    const website=asHttpUrl(t.website||t["contact:website"]||t.url||"");
    const osmUrl=`https://www.openstreetmap.org/${x.type}/${x.id}`;
    const lat=Number(x.lat??x.center?.lat), lon=Number(x.lon??x.center?.lon);
    const distanceKm=Number.isFinite(lat)&&Number.isFinite(lon)?haversineKm(place.lat,place.lon,lat,lon):null;
    const bookingUrl=asHttpUrl(t["contact:booking"]||t["reservation:website"]||t.booking||t.tickets||"");
    const phone=t["contact:phone"]||t.phone||"";
    const email=t["contact:email"]||t.email||"";
    const reservation=t.reservation||t["reservation:required"]||"";
    const venue={
      id:`${x.type}-${x.id}`,name,type,kind,address:addr,website,url:website||osmUrl,osmUrl,
      phone,email,bookingUrl,reservation,openingHours:t.opening_hours||"",fee:t.fee||t.charge||"",
      wikipedia:t.wikipedia||"",wikidata:t.wikidata||"",brand:t.brand||"",operator:t.operator||"",
      lat,lon,distanceKm,tags:t,
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
  const r=6371, rad=n=>n*Math.PI/180;
  const dLat=rad(bLat-aLat), dLon=rad(bLon-aLon);
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
  if(v.fee && String(v.fee).toLowerCase()!=="no") score+=5;
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
