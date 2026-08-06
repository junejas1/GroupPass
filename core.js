const POPULAR = {
  Dallas:{lat:32.7767,lon:-96.7970,city:"Dallas",label:"Dallas, Texas, United States"},
  "New York":{lat:40.7128,lon:-74.0060,city:"New York",label:"New York, New York, United States"},
  London:{lat:51.5072,lon:-0.1276,city:"London",label:"London, England, United Kingdom"},
  Tokyo:{lat:35.6762,lon:139.6503,city:"Tokyo",label:"Tokyo, Japan"}
};

const state = {
  selected:null,
  venues:[],
  filter:"all",
  map:null,
  marker:null,
  enrichmentRun:0,
  pricingStatus:"idle"
};

const READER_PREFIX="https://r.jina.ai/";
const WEBSITE_LOOKUP_LIMIT=6;
const PRICING_CACHE_KEY="groupup-official-pricing-v1";
const PRICING_CACHE_MS=7*24*60*60*1000;

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
const sleep = ms => new Promise(r=>setTimeout(r,ms));

function safe(text=""){
  return String(text).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
}

function cityName(place){
  return place.city || place.town || place.village || place.municipality || place.name || "Selected destination";
}

function normalizeNominatim(item){
  const a = item.address || {};
  const city = a.city || a.town || a.village || a.municipality || a.county || String(item.display_name||"").split(",")[0];
  return {
    lat:Number(item.lat),
    lon:Number(item.lon),
    city,
    region:a.state || a.region || "",
    country:a.country || "",
    label:item.display_name || [city,a.state,a.country].filter(Boolean).join(", ")
  };
}

function normalizePhoton(feature){
  const p=feature.properties||{}, c=feature.geometry?.coordinates||[];
  const city=p.city||p.name||p.county||p.state||"Selected destination";
  return {
    lat:Number(c[1]), lon:Number(c[0]), city,
    region:p.state||"", country:p.country||"",
    label:[p.name!==city?p.name:null,city,p.state,p.country].filter(Boolean).join(", ")
  };
}

async function geocode(query){
  const encoded=encodeURIComponent(query.trim());
  try{
    const u=`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&q=${encoded}`;
    const r=await fetch(u);
    if(r.ok){
      const data=await r.json();
      const out=data.map(normalizeNominatim).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon));
      if(out.length) return out;
    }
  }catch(e){}
  try{
    const u=`https://photon.komoot.io/api/?limit=5&q=${encoded}`;
    const r=await fetch(u);
    if(r.ok){
      const data=await r.json();
      const out=(data.features||[]).map(normalizePhoton).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon));
      if(out.length) return out;
    }
  }catch(e){}
  const known=Object.values(POPULAR).filter(p=>p.label.toLowerCase().includes(query.toLowerCase()) || p.city.toLowerCase().includes(query.toLowerCase()));
  return known;
}

function setSearchStatus(text, error=false){
  const el=$("#searchStatus");
  if(!el) return;
  el.textContent=text;
  el.classList.toggle("error",error);
}

async function runSearch(value){
  const input=$("#locationInput");
  const q=(value ?? input?.value ?? "").trim();
  if(!q){ setSearchStatus("Enter a city, region, or destination.",true); input?.focus(); return; }
  if(input) input.value=q;
  setSearchStatus("Finding matching locations…");
  const menu=$("#placeResults");
  if(menu){ menu.hidden=true; menu.innerHTML=""; }
  const results=await geocode(q);
  if(!results.length){ setSearchStatus("No matching destination was found. Try a nearby city.",true); return; }
  setSearchStatus(results.length===1 ? "Choose this destination." : "Choose the correct destination.");
  if(!menu) return;
  menu.innerHTML=results.map((p,i)=>`
    <button class="place-result" data-i="${i}">
      <span><strong>${safe(p.city)}</strong><small>${safe(p.label)}</small></span>
      <span class="result-arrow">→</span>
    </button>`).join("");
  menu.hidden=false;
  $$(".place-result",menu).forEach(b=>b.onclick=()=>choosePlace(results[Number(b.dataset.i)]));
}

async function choosePlace(place){
  state.selected=place;
  $("#placeResults")?.setAttribute("hidden","");
  setSearchStatus(`Zooming into ${place.city}…`);
  await animateDestination(place);
  openCityPage(place);
}

function equirectPoint(place){
  return {x:((place.lon+180)/360)*100,y:((90-place.lat)/180)*100};
}

async function animateDestination(place){
  if(document.body.dataset.design==="background"){
    const scene=$("#earthScene"), pin=$("#destinationPin"), p=equirectPoint(place);
    if(pin){
      pin.style.left=p.x+"%"; pin.style.top=p.y+"%"; pin.classList.add("show");
    }
    if(scene){
      scene.style.transformOrigin=`${p.x}% ${p.y}%`;
      scene.classList.add("zooming");
    }
    await sleep(1450);
    $("#transitionCurtain")?.classList.add("show");
    await sleep(430);
  } else {
    if(state.map && window.L){
      if(state.marker) state.marker.remove();
      state.marker=L.marker([place.lat,place.lon]).addTo(state.map);
      state.map.flyTo([place.lat,place.lon],11,{duration:1.65});
    }else{
      const mapEl=$("#underMap");
      if(mapEl){
        mapEl.classList.add("map-loading-focus");
      }
    }
    await sleep(1650);
    $("#transitionCurtain")?.classList.add("show");
    await sleep(430);
  }
}

function openCityPage(place){
  $("#landingView").hidden=true;
  $("#cityView").hidden=false;
  $("#transitionCurtain")?.classList.remove("show");
  $("#currentCity").textContent=place.city;
  $("#currentLocationFull").textContent=place.label;
  $("#cityHeadline").textContent=`Groups near ${place.city}`;
  $("#citySubhead").textContent=`Popular attractions and activities near ${place.label}, ranked using prominence, official sources, and available group-pricing details.`;
  window.scrollTo({top:0,behavior:"instant"});
  renderSavedGroups();
  renderDemoGroups();
  loadNearbyVenues(place);
}

function returnHome(){
  $("#cityView").hidden=true;
  $("#landingView").hidden=false;
  const scene=$("#earthScene");
  if(scene) scene.classList.remove("zooming");
  const mapEl=$("#underMap");
  if(mapEl) mapEl.classList.remove("map-loading-focus");
  $("#destinationPin")?.classList.remove("show");
  setSearchStatus("");
  window.scrollTo({top:0,behavior:"instant"});
  if(state.map && window.L){
    requestAnimationFrame(()=>{
      state.map.invalidateSize();
      frameWorldMap();
    });
  }
}

async function useMyLocation(){
  setSearchStatus("Finding your location…");
  if(!navigator.geolocation){
    setSearchStatus("Location access is not supported. Search for your city instead.",true);
    return;
  }
  navigator.geolocation.getCurrentPosition(async pos=>{
    const coords={lat:pos.coords.latitude,lon:pos.coords.longitude};
    try{
      const u=`https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=${coords.lat}&lon=${coords.lon}`;
      const r=await fetch(u);
      if(r.ok){
        const p=normalizeNominatim(await r.json());
        choosePlace(p); return;
      }
    }catch(e){}
    choosePlace({...coords,city:"Your location",label:"Your current location"});
  },()=>setSearchStatus("Location permission was unavailable. Search for a city instead.",true),{timeout:9000,maximumAge:300000});
}
