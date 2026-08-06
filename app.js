const state={cities:[],city:null,venues:[],filter:"All"};
const $=(s,r=document)=>r.querySelector(s);const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=(v="")=>String(v).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));

async function init(){
  try{
    const response=await fetch("./data/cities.json",{cache:"no-store"});
    if(!response.ok)throw new Error("City database unavailable");
    state.cities=await response.json();
    $("#cityTotal").textContent=state.cities.length;
    renderCityChips();
    bind();
    const city=new URLSearchParams(location.search).get("city");
    if(city){const found=state.cities.find(c=>c.id===city);if(found)openCity(found,false)}
  }catch(error){$("#searchStatus").textContent="The curated city database could not be loaded."}
}

function bind(){
  $("#citySearch").addEventListener("submit",e=>{e.preventDefault();chooseFromInput()});
  $("#cityInput").addEventListener("input",showSuggestions);
  $("#cityInput").addEventListener("focus",showSuggestions);
  $("#backButton").addEventListener("click",showHome);
  $("#homeButton").addEventListener("click",showHome);
  $("#modalClose").addEventListener("click",closeModal);
  $("#groupModal").addEventListener("click",e=>{if(e.target.id==="groupModal")closeModal()});
  $("#groupForm").addEventListener("submit",saveGroup);
}

function matches(city,q){const hay=[city.name,city.region,city.country,...(city.aliases||[])].join(" ").toLowerCase();return hay.includes(q.toLowerCase())}
function renderCityChips(){
  $("#cityChips").innerHTML=state.cities.map(c=>`<button class="city-chip" data-city="${esc(c.id)}">${esc(c.name)}</button>`).join("");
  $$('[data-city]',$("#cityChips")).forEach(b=>b.onclick=()=>openCity(state.cities.find(c=>c.id===b.dataset.city)));
}
function showSuggestions(){
  const q=$("#cityInput").value.trim();const results=(q?state.cities.filter(c=>matches(c,q)):state.cities).slice(0,8);const box=$("#cityResults");
  box.innerHTML=results.map(c=>`<button type="button" class="city-option" data-id="${esc(c.id)}"><span><strong>${esc(c.name)}</strong><br><small>${esc(c.region)}</small></span><small>${c.venueCount} venues</small></button>`).join("");
  box.hidden=!results.length;
  $$(".city-option",box).forEach(b=>b.onclick=()=>openCity(state.cities.find(c=>c.id===b.dataset.id)));
}
function chooseFromInput(){
  const q=$("#cityInput").value.trim();const exact=state.cities.find(c=>[c.name,c.id,...(c.aliases||[])].some(v=>String(v).toLowerCase()===q.toLowerCase()));const city=exact||state.cities.find(c=>matches(c,q));
  if(city)openCity(city);else{$("#searchStatus").textContent="That city is not in the curated database yet.";$("#cityResults").hidden=true}
}

async function openCity(city,push=true){
  state.city=city;state.filter="All";$("#cityResults").hidden=true;$("#searchStatus").textContent="";
  $("#homeView").hidden=true;$("#catalogView").hidden=false;$("#cityTitle").textContent=city.name;$("#citySummary").textContent=`${city.venueCount} manually researched venues in ${city.name}, ${city.region}. Prices were last reviewed ${formatDate(city.lastVerified)} and should be confirmed on the linked official source before payment.`;
  $("#venueGrid").innerHTML="";$("#notice").hidden=true;$("#venueCount").textContent="Loading curated records…";
  if(push)history.pushState({},"",`?city=${encodeURIComponent(city.id)}`);
  try{
    const response=await fetch(`./data/venues/${city.id}.json`,{cache:"no-store"});if(!response.ok)throw new Error();
    state.venues=await response.json();renderFilters();renderVenues();window.scrollTo({top:0,behavior:"smooth"});
  }catch(error){state.venues=[];$("#venueCount").textContent="No records available";$("#notice").hidden=false;$("#notice").textContent="This city is listed, but its venue file is not available yet."}
}
function showHome(push=true){if(push)history.pushState({},"",location.pathname);$("#catalogView").hidden=true;$("#homeView").hidden=false;window.scrollTo({top:0,behavior:"smooth"})}
window.addEventListener("popstate",()=>{const id=new URLSearchParams(location.search).get("city");const city=state.cities.find(c=>c.id===id);city?openCity(city,false):showHome(false)});

function renderFilters(){
  const categories=["All",...new Set(state.venues.map(v=>v.category).filter(Boolean))];$("#filters").innerHTML=categories.map(c=>`<button class="filter ${c===state.filter?"active":""}" data-filter="${esc(c)}">${esc(c)}</button>`).join("");
  $$(".filter",$("#filters")).forEach(b=>b.onclick=()=>{state.filter=b.dataset.filter;renderFilters();renderVenues()});
}
function renderVenues(){
  const list=state.filter==="All"?state.venues:state.venues.filter(v=>v.category===state.filter);$("#venueCount").textContent=`${list.length} curated venue${list.length===1?"":"s"}`;
  $("#venueGrid").innerHTML=list.map((v,i)=>`<article class="venue-card"><div class="card-top"><p>#${i+1} · ${esc(v.category||"Attraction")}</p><h3>${esc(v.name)}</h3></div><div class="card-body"><p class="address">${esc(v.address||"")}</p><div class="price-grid"><div><span>Regular admission</span><strong>${esc(v.regularPrice||"See official site")}</strong></div><div><span>Group rate</span><strong>${esc(v.groupPrice||"Request a quote")}</strong></div><div><span>Minimum group</span><strong>${esc(v.minimum||"Not published")}</strong></div><div><span>Eligibility</span><strong>${esc(v.eligibility||"Confirm with venue")}</strong></div></div>${v.savings?`<p class="saving">${esc(v.savings)}</p>`:""}${detailList(v)}<span class="verified">Official source reviewed ${esc(formatDate(v.lastVerified))}</span><div class="card-actions"><a href="${esc(v.groupSource||v.website||v.regularSource)}" target="_blank" rel="noopener">Official details</a><button data-start="${esc(v.name)}">Start a group</button></div></div></article>`).join("");
  $$('[data-start]',$("#venueGrid")).forEach(b=>b.onclick=()=>openModal(b.dataset.start));
}
function detailList(v){const details=[...(v.groupDetails||[]),...(v.bookingNotes||[]),v.restrictions,v.availability,v.bookingContact?`Booking contact: ${v.bookingContact}`:""].filter(Boolean);return details.length?`<ul class="details">${details.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`:""}
function formatDate(v){if(!v)return "not recorded";try{return new Date(`${v}T12:00:00`).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})}catch{return v}}

function openModal(name){$("#groupActivity").value=name;$("#groupDate").value=new Date(Date.now()+7*86400000).toISOString().slice(0,10);$("#groupTime").value="11:00";$("#groupModal").hidden=false}
function closeModal(){$("#groupModal").hidden=true}
function saveGroup(e){e.preventDefault();const key="groupup-groups-v2";let groups=[];try{groups=JSON.parse(localStorage.getItem(key)||"[]")}catch{}groups.unshift({cityId:state.city?.id,activity:$("#groupActivity").value,date:$("#groupDate").value,time:$("#groupTime").value,target:Number($("#groupTarget").value),createdAt:new Date().toISOString()});localStorage.setItem(key,JSON.stringify(groups));closeModal();toast("Group saved on this device")}
function toast(text){const el=$("#toast");el.textContent=text;el.classList.add("show");clearTimeout(window.__toast);window.__toast=setTimeout(()=>el.classList.remove("show"),2200)}

document.addEventListener("DOMContentLoaded",init);
