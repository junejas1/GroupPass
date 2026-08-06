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
  marker:null
};

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
  $("#citySubhead").textContent=`Explore nearby places in ${place.label} and organize a group around the experience.`;
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

const US_STATE_CODES={
  Alabama:"AL",Alaska:"AK",Arizona:"AZ",Arkansas:"AR",California:"CA",Colorado:"CO",Connecticut:"CT",Delaware:"DE",
  Florida:"FL",Georgia:"GA",Hawaii:"HI",Idaho:"ID",Illinois:"IL",Indiana:"IN",Iowa:"IA",Kansas:"KS",Kentucky:"KY",
  Louisiana:"LA",Maine:"ME",Maryland:"MD",Massachusetts:"MA",Michigan:"MI",Minnesota:"MN",Mississippi:"MS",Missouri:"MO",
  Montana:"MT",Nebraska:"NE",Nevada:"NV","New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY",
  "North Carolina":"NC","North Dakota":"ND",Ohio:"OH",Oklahoma:"OK",Oregon:"OR",Pennsylvania:"PA","Rhode Island":"RI",
  "South Carolina":"SC","South Dakota":"SD",Tennessee:"TN",Texas:"TX",Utah:"UT",Vermont:"VT",Virginia:"VA",Washington:"WA",
  "West Virginia":"WV",Wisconsin:"WI",Wyoming:"WY","District of Columbia":"DC"
};

function slugPart(value=""){
  return String(value).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
}

function catalogCityId(place){
  const country=String(place.country||"").toLowerCase();
  if(country && !country.includes("united states") && country!=="us" && country!=="usa") return "";
  const region=String(place.region||"").trim();
  const code=(US_STATE_CODES[region]||region).toUpperCase();
  if(!/^[A-Z]{2}$/.test(code)) return "";
  if(code==="DC") return "washington-dc";
  return `${slugPart(cityName(place))}-${code.toLowerCase()}`;
}

function venueKey(name=""){
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
}

function standardVenueType(value=""){
  const text=String(value).toLowerCase();
  if(/museum|gallery|art|science|history|cultural|planetarium|observatory/.test(text)) return "Museums & art";
  if(/park|zoo|aquarium|garden|outdoor|cruise|boat|kayak|rafting|trail|nature/.test(text)) return "Outdoors";
  if(/sport|stadium|arena|golf|bowling|climbing|skating|archery|paintball|kart/.test(text)) return "Sports";
  if(/theatre|theater|cinema|amusement|theme|escape|arcade|laser|trampoline|entertainment/.test(text)) return "Entertainment";
  return "Attraction";
}

function normalizeStaticVenue(v){
  return {
    name:v.name,
    type:standardVenueType(v.category||v.type),
    address:v.address||"Near the selected city",
    url:v.groupSource||v.website||v.regularSource||"",
    sourceBacked:Boolean(v.sourceBacked),
    groupPrice:v.groupPrice||"",
    groupDetails:Array.isArray(v.groupDetails)?v.groupDetails:[],
    savings:v.savings||"",
    minimum:v.minimum||"",
    eligibility:v.eligibility||"",
    bookingNotes:Array.isArray(v.bookingNotes)?v.bookingNotes:[],
    lastVerified:v.lastVerified||"",
    regularPrice:v.regularPrice||"",
    rateStatus:v.rateStatus||""
  };
}

async function loadStaticCatalog(place){
  const id=catalogCityId(place);
  if(!id) return [];
  try{
    const r=await fetch(`./data/venues/${encodeURIComponent(id)}.json`,{cache:"no-store"});
    if(!r.ok) return [];
    const rows=await r.json();
    return Array.isArray(rows)?rows.map(normalizeStaticVenue).filter(v=>v.name):[];
  }catch(e){
    return [];
  }
}

function mergeVenues(primary,secondary){
  const seen=new Set(), out=[];
  for(const venue of [...primary,...secondary]){
    const key=venueKey(venue.name);
    if(!key||seen.has(key)) continue;
    seen.add(key); out.push(venue);
  }
  return out;
}

async function loadOverpassVenues(place){
  const q=`[out:json][timeout:14];(
    nwr["tourism"~"attraction|museum|gallery|zoo|aquarium|theme_park"](around:10000,${place.lat},${place.lon});
    nwr["leisure"~"park|sports_centre|stadium|bowling_alley|escape_game|water_park|amusement_arcade"](around:10000,${place.lat},${place.lon});
    nwr["amenity"~"theatre|arts_centre|cinema"](around:10000,${place.lat},${place.lon});
  );out center tags 45;`;
  const endpoints=["https://overpass-api.de/api/interpreter","https://overpass.kumi.systems/api/interpreter"];
  for(const endpoint of endpoints){
    try{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),13000);
      const r=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},body:"data="+encodeURIComponent(q),signal:controller.signal});
      clearTimeout(timer);
      if(r.ok) return normalizeVenues((await r.json())?.elements||[]);
    }catch(e){}
  }
  return [];
}

async function loadNearbyVenues(place){
  const grid=$("#venueGrid"), count=$("#venueCount"), notice=$("#venueNotice");
  if(grid) grid.innerHTML=loadingCards();
  if(count) count.textContent="Loading the saved city catalog…";
  if(notice) notice.hidden=true;

  const saved=await loadStaticCatalog(place);
  state.venues=saved;
  if(saved.length){
    renderVenues();
    if(count) count.textContent=`${saved.length} saved places · checking for more nearby`;
  }

  const discovered=await loadOverpassVenues(place);
  state.venues=mergeVenues(saved,discovered);
  renderVenues();
}

function normalizeVenues(items){
  const seen=new Set(), out=[];
  for(const x of items){
    const t=x.tags||{}, name=t.name||t["name:en"];
    const key=venueKey(name);
    if(!name || seen.has(key)) continue;
    seen.add(key);
    const all=[t.tourism,t.leisure,t.amenity].filter(Boolean).join(" ");
    const type=standardVenueType(all);
    const addr=[t["addr:housenumber"],t["addr:street"],t["addr:city"]].filter(Boolean).join(" ") || "Near the selected city";
    const url=t.website||t["contact:website"]||`https://www.openstreetmap.org/${x.type}/${x.id}`;
    out.push({name,type,address:addr,url,sourceBacked:false,groupPrice:"",groupDetails:[],savings:"",minimum:"",eligibility:"",bookingNotes:[],lastVerified:"",regularPrice:"",rateStatus:"Venue discovered; group rate not yet verified"});
  }
  return out.sort((a,b)=>a.name.localeCompare(b.name)).slice(0,45);
}

function loadingCards(){
  return Array.from({length:6},()=>`<div class="activity-card skeleton"><div></div><span></span><span></span><span></span></div>`).join("");
}

function renderVenues(){
  const grid=$("#venueGrid"), count=$("#venueCount"), notice=$("#venueNotice");
  let list=state.venues;
  if(state.filter!=="all") list=list.filter(v=>v.type===state.filter);
  const published=list.filter(v=>v.sourceBacked).length;
  if(count){
    count.textContent=list.length
      ? `${list.length} nearby places${published?` · ${published} with source-backed group information`:""}`
      : "No places returned";
  }
  if(!list.length){
    if(grid) grid.innerHTML="";
    if(notice){
      notice.hidden=false;
      notice.innerHTML=`The saved catalog does not have results for ${safe(state.selected?.city||"this destination")} yet, and live discovery did not respond. The scheduled GitHub update will keep filling city files.`;
    }
    return;
  }
  if(notice) notice.hidden=true;
  if(grid) grid.innerHTML=list.map((v,i)=>{
    const detail=[v.savings,v.minimum,v.eligibility].filter(Boolean).join(" · ");
    const groupDetails=(v.groupDetails||[]).join(" · ");
    const notes=(v.bookingNotes||[]).slice(0,2).join(" · ");
    const sourceUrl=v.url||`https://www.google.com/search?q=${encodeURIComponent(v.name+" "+(state.selected?.label||""))}`;
    const price=v.sourceBacked?(v.groupPrice||"See the official group page"):"Group price not yet verified";
    const explanation=v.sourceBacked
      ? [groupDetails,detail,notes,v.lastVerified?`Checked ${v.lastVerified}`:""].filter(Boolean).join(" · ")
      : "Confirm directly with the venue before collecting money.";
    return `
    <article class="activity-card">
      <div class="card-art art-${(i%5)+1}">
        <span>${safe(v.type)}</span>
      </div>
      <div class="card-copy">
        <p class="micro">${v.sourceBacked?"Published group information":"Nearby activity"}</p>
        <h4>${safe(v.name)}</h4>
        <p class="address">${safe(v.address)}</p>
        <div class="rate-line"><strong>${safe(price)}</strong><span>${safe(explanation)}</span></div>
        <div class="card-actions">
          <a href="${safe(sourceUrl)}" target="_blank" rel="noopener">${v.sourceBacked?"Official group source":"Venue page"}</a>
          <button data-venue="${safe(v.name)}">Start a group</button>
        </div>
      </div>
    </article>`;
  }).join("");
  $$("[data-venue]",grid).forEach(b=>b.onclick=()=>openGroupModal(b.dataset.venue));
}

function setFilter(button){
  $$(".filter-button").forEach(b=>b.classList.remove("active"));
  button.classList.add("active");
  state.filter=button.dataset.filter;
  renderVenues();
}

const GROUP_KEY="groupup-earth-groups-v1";
function getGroups(){ try{return JSON.parse(localStorage.getItem(GROUP_KEY)||"[]")}catch{return[]} }
function saveGroups(list){localStorage.setItem(GROUP_KEY,JSON.stringify(list))}

function renderSavedGroups(){
  const grid=$("#savedGroupGrid"), empty=$("#savedEmpty");
  const label=state.selected?.label;
  const list=getGroups().filter(g=>g.location===label);
  if(empty) empty.hidden=!!list.length;
  if(grid) grid.innerHTML=list.map(g=>`
    <article class="group-card">
      <p class="micro">Community-created</p>
      <h4>${safe(g.activity)}</h4>
      <p>${safe(formatDate(g.date))} · ${safe(g.time)}</p>
      <div class="progress"><span style="width:${Math.min(100,(g.joined/g.target)*100)}%"></span></div>
      <div class="group-bottom"><span>${g.joined} of ${g.target} joined</span><button data-join="${g.id}">Join</button></div>
    </article>`).join("");
  $$("[data-join]",grid||document).forEach(b=>b.onclick=()=>joinGroup(b.dataset.join));
}

function renderDemoGroups(){
  const grid=$("#demoGroupGrid");
  if(!grid) return;
  const c=state.selected?.city||"this city";
  const ideas=[
    {name:`Weekend museum group in ${c}`,date:"Saturday",joined:7,target:12},
    {name:`Outdoor day with new people`,date:"Sunday",joined:4,target:10},
    {name:`Local attraction group plan`,date:"Next weekend",joined:9,target:15}
  ];
  grid.innerHTML=ideas.map((g,i)=>`
    <article class="group-card demo">
      <p class="micro">Example group</p>
      <h4>${safe(g.name)}</h4>
      <p>${safe(g.date)} · Time selected by organizer</p>
      <div class="progress"><span style="width:${(g.joined/g.target)*100}%"></span></div>
      <div class="group-bottom"><span>${g.joined} of ${g.target} interested</span><button onclick="openGroupModal('${safe(g.name)}')">Create similar</button></div>
    </article>`).join("");
}

function joinGroup(id){
  const list=getGroups(), g=list.find(x=>x.id===id);
  if(!g)return;
  g.joined=Math.min(g.target,g.joined+1);
  saveGroups(list); renderSavedGroups(); toast("You joined the group");
}

function openGroupModal(name=""){
  $("#groupActivity").value=name;
  $("#groupDate").value=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
  $("#groupTime").value="11:00";
  $("#groupModal").classList.add("open");
}
function closeGroupModal(){ $("#groupModal").classList.remove("open"); }

function createGroup(event){
  event.preventDefault();
  const list=getGroups();
  list.unshift({
    id:(crypto.randomUUID?crypto.randomUUID():String(Date.now())),
    location:state.selected?.label,
    activity:$("#groupActivity").value.trim(),
    date:$("#groupDate").value,
    time:$("#groupTime").value,
    target:Number($("#groupTarget").value),
    joined:1
  });
  saveGroups(list); closeGroupModal(); renderSavedGroups(); toast("Group created on this device");
}

function formatDate(v){
  try{return new Date(v+"T12:00:00").toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})}
  catch{return v}
}

function toast(text){
  const el=$("#toast"); if(!el)return;
  el.textContent=text; el.classList.add("show");
  clearTimeout(window.__toast); window.__toast=setTimeout(()=>el.classList.remove("show"),2400);
}

function frameWorldMap(){
  const mapEl=$("#underMap");
  if(!state.map || !mapEl) return;

  const width=Math.max(320,mapEl.clientWidth);

  // At this zoom, one complete Web-Mercator world nearly fills the panel width.
  // The tiny reduction prevents the date-line edges from being clipped.
  const zoom=Math.log2(width/256)-0.035;

  state.map.setView([14,0],zoom,{animate:false});
}

function initLeaflet(){
  const mapEl=$("#underMap");
  if(!mapEl || !window.L) return;
  state.map=L.map(mapEl,{
    zoomControl:true,
    attributionControl:true,
    worldCopyJump:false,
    minZoom:1,
    maxZoom:18,
    zoomSnap:0,
    zoomDelta:0.25,
    maxBounds:[[-85.0511,-180],[85.0511,180]],
    maxBoundsViscosity:1
  });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{
    maxZoom:18,
    noWrap:true,
    detectRetina:true,
    bounds:[[-85.0511,-180],[85.0511,180]],
    attribution:'© OpenStreetMap contributors'
  }).addTo(state.map);
  const frame=()=>{state.map.invalidateSize();frameWorldMap();};
  requestAnimationFrame(frame);
  setTimeout(frame,200);
  window.addEventListener("resize",()=>{
    clearTimeout(window.__mapResize);
    window.__mapResize=setTimeout(frame,100);
  });
}

document.addEventListener("DOMContentLoaded",()=>{
  $("#searchForm")?.addEventListener("submit",e=>{e.preventDefault();runSearch()});
  $$(".popular-city").forEach(b=>b.onclick=()=>{
    const p=POPULAR[b.dataset.city]; $("#locationInput").value=b.dataset.city; choosePlace(p);
  });
  $("#locationButton")?.addEventListener("click",useMyLocation);
  $("#returnHome")?.addEventListener("click",returnHome);
  $("#changeLocation")?.addEventListener("click",returnHome);
  $("#startGroupTop")?.addEventListener("click",()=>openGroupModal(""));
  $("#groupForm")?.addEventListener("submit",createGroup);
  $("#modalClose")?.addEventListener("click",closeGroupModal);
  $("#groupModal")?.addEventListener("click",e=>{if(e.target.id==="groupModal")closeGroupModal()});
  $$(".filter-button").forEach(b=>b.onclick=()=>setFilter(b));
  if(document.body.dataset.design==="below"){
    if(window.L) initLeaflet();
    else window.addEventListener("load",initLeaflet,{once:true});
  }
});
