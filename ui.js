function loadingCards(){
  return Array.from({length:6},()=>`<div class="activity-card skeleton"><div></div><span></span><span></span><span></span></div>`).join("");
}

function renderVenues(progressText=""){
  const grid=$("#venueGrid"), count=$("#venueCount"), notice=$("#venueNotice");
  let list=state.venues;
  if(state.filter!=="all") list=list.filter(v=>v.type===state.filter);
  list=list.slice(0,30);
  if(count){
    if(progressText) count.textContent=`${list.length} ranked places · ${progressText}`;
    else if(state.pricingStatus==="checking") count.textContent=`${list.length} popular places · checking official websites…`;
    else count.textContent=list.length?`${list.length} places ranked by popularity and pricing detail`:"No places returned";
  }
  if(!list.length){
    if(grid) grid.innerHTML="";
    if(notice){
      notice.hidden=false;
      notice.innerHTML=`Nearby discovery did not return results right now. You can still create a custom group for ${safe(state.selected?.city||"this destination")}.`;
    }
    return;
  }
  if(notice) notice.hidden=true;
  if(grid) grid.innerHTML=list.map((v,i)=>`
    <article class="activity-card">
      <div class="card-art art-${(i%5)+1}">
        <span>${safe(v.type)}</span>
        <b class="rank-badge">#${i+1}</b>
      </div>
      <div class="card-copy">
        <p class="micro">${safe(popularityLabel(v))}${v.distanceKm!==null?` · ${safe((v.distanceKm*.621371).toFixed(1))} mi`:""}</p>
        <h4>${safe(v.name)}</h4>
        <p class="address">${safe(v.address)}</p>
        ${pricingPanel(v)}
        <div class="card-actions">
          <a href="${safe(v.url)}" target="_blank" rel="noopener">${v.website?"Official site":"Map page"}</a>
          <button data-venue="${safe(v.name)}">Start a group</button>
        </div>
      </div>
    </article>`).join("");
  $$("[data-venue]",grid).forEach(b=>b.onclick=()=>openGroupModal(b.dataset.venue));
}

function popularityLabel(v){
  if(v.popularityScore>=100) return "Major destination";
  if(v.popularityScore>=75) return "Popular attraction";
  if(v.popularityScore>=50) return "Notable local venue";
  return "Nearby activity";
}

function pricingPanel(v){
  const p=v.pricing||{};
  const official=p.status==="official", partial=p.status==="partial";
  const heading=official?"Official group rate found":partial?"Official venue details found":"Group pricing not published";
  const badge=official?"Official source":partial?"Website checked":"Not verified";
  const rows=[
    ["Group rate",p.groupRate||"Not found"],
    ["Regular admission",p.regularRate||"Not found"],
    ["Minimum group",p.minimumGroup||"Not found"],
    ["Estimated savings",p.savings||"Not calculable"]
  ];
  const source=p.sourceUrl?`<a class="pricing-source" href="${safe(p.sourceUrl)}" target="_blank" rel="noopener">View official source ↗</a>`:"";
  const reserve=p.bookingUrl?`<a class="reserve-link" href="${safe(p.bookingUrl)}" target="_blank" rel="noopener">Check reservation times ↗</a>`:"";
  const checked=p.checkedAt?`<small>Checked ${safe(new Date(p.checkedAt).toLocaleDateString())}</small>`:"";
  return `<div class="rate-line ${official?"verified":partial?"partial":""}">
    <div class="rate-head"><strong>${safe(heading)}</strong><span class="source-badge">${safe(badge)}</span></div>
    <div class="rate-grid">${rows.map(([k,val])=>`<div><span>${safe(k)}</span><b>${safe(val)}</b></div>`).join("")}</div>
    ${p.restrictions?`<p><b>Restrictions:</b> ${safe(p.restrictions)}</p>`:""}
    ${p.bookingContact?`<p><b>Group booking contact:</b> ${safe(p.bookingContact)}</p>`:""}
    ${p.availability?`<p><b>Availability:</b> ${safe(p.availability)}</p>`:""}
    <div class="source-row">${source}${reserve}${checked}</div>
    ${official?`<em>Auto-extracted from the linked official page; confirm before collecting payment.</em>`:`<em>${v.website?"The official site was checked, but complete group pricing was not found.":"No official venue website was listed in the map data."}</em>`}
  </div>`;
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
