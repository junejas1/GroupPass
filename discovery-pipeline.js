const GP_OVERPASS_ENDPOINTS=[
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

function gpDiscoveryQueries(place){
  const c=`${place.lat},${place.lon}`;
  return [
    {
      label:"major attractions",
      query:`[out:json][timeout:9];(
        nwr["tourism"~"museum|zoo|aquarium|theme_park"]["name"](around:40000,${c});
        nwr["leisure"~"theme_park|water_park|stadium"]["name"](around:40000,${c});
      );out center tags 70;`
    },
    {
      label:"museums and landmarks",
      query:`[out:json][timeout:9];(
        nwr["tourism"~"museum|gallery"]["name"](around:18000,${c});
        nwr["amenity"~"theatre|arts_centre"]["name"](around:15000,${c});
        nwr["tourism"="attraction"]["name"]["wikidata"](around:20000,${c});
        nwr["tourism"="attraction"]["name"]["website"](around:12000,${c});
      );out center tags 80;`
    },
    {
      label:"activities and notable parks",
      query:`[out:json][timeout:9];(
        nwr["leisure"~"bowling_alley|escape_game|amusement_arcade|sports_centre"]["name"](around:15000,${c});
        nwr["amenity"~"cinema|events_venue"]["name"](around:15000,${c});
        nwr["leisure"="park"]["name"]["wikidata"](around:15000,${c});
        nwr["leisure"="park"]["name"]["wikipedia"](around:15000,${c});
      );out center tags 80;`
    }
  ];
}

async function gpFetchOverpass(query,startIndex=0){
  for(let step=0;step<GP_OVERPASS_ENDPOINTS.length;step++){
    const endpoint=GP_OVERPASS_ENDPOINTS[(startIndex+step)%GP_OVERPASS_ENDPOINTS.length];
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),7500);
    try{
      const response=await fetch(endpoint,{
        method:"POST",
        headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},
        body:"data="+encodeURIComponent(query),
        signal:controller.signal
      });
      if(response.ok){
        const json=await response.json();
        return Array.isArray(json.elements)?json.elements:[];
      }
    }catch(e){}
    finally{clearTimeout(timer)}
  }
  return [];
}

function gpWikiActivityKind(text=""){
  const t=String(text).toLowerCase();
  if(/theme park|amusement park/.test(t)) return "theme_park";
  if(/zoo|zoological/.test(t)) return "zoo";
  if(/aquarium/.test(t)) return "aquarium";
  if(/stadium|arena/.test(t)) return "stadium";
  if(/museum|science center|science centre|history center|history centre/.test(t)) return "museum";
  if(/gallery|art center|art centre/.test(t)) return "gallery";
  if(/theatre|theater|performing arts/.test(t)) return "theatre";
  if(/botanical garden|garden|park|nature reserve/.test(t)) return "park";
  if(/cinema/.test(t)) return "cinema";
  return "attraction";
}

function gpWikiLooksLikeActivity(page){
  const text=`${page.title||""} ${page.extract||""}`;
  if(/disambiguation|list of|neighborhood|district|county|municipality|railway station|metro station|freeway|highway/i.test(text)) return false;
  return /museum|gallery|zoo|aquarium|theme park|amusement park|stadium|arena|theatre|theater|performing arts|science center|science centre|botanical garden|garden|observatory|planetarium|monument|memorial|historic site|landmark|tourist attraction|visitor attraction|park|nature reserve|palace|castle|tower|cathedral|temple|market hall|entertainment venue/i.test(text);
}

async function gpWikidataWebsites(ids){
  const unique=[...new Set(ids.filter(Boolean))].slice(0,50);
  if(!unique.length) return {};
  try{
    const url=new URL("https://www.wikidata.org/w/api.php");
    url.search=new URLSearchParams({
      action:"wbgetentities",ids:unique.join("|"),props:"claims",format:"json",origin:"*"
    });
    const response=await fetch(url);
    if(!response.ok) return {};
    const data=await response.json();
    const out={};
    for(const [id,entity] of Object.entries(data.entities||{})){
      const claims=entity.claims?.P856||[];
      const website=claims.map(c=>c.mainsnak?.datavalue?.value).find(v=>/^https?:\/\//i.test(String(v||"")));
      if(website) out[id]=website;
    }
    return out;
  }catch(e){return {}}
}

async function gpFetchWikipediaAttractions(place){
  try{
    const url=new URL("https://en.wikipedia.org/w/api.php");
    url.search=new URLSearchParams({
      action:"query",
      generator:"geosearch",
      ggscoord:`${place.lat}|${place.lon}`,
      ggsradius:"10000",
      ggslimit:"80",
      ggsnamespace:"0",
      prop:"coordinates|pageprops|extracts|info",
      exintro:"1",
      explaintext:"1",
      exlimit:"max",
      inprop:"url",
      format:"json",
      origin:"*"
    });
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),7000);
    const response=await fetch(url,{signal:controller.signal});
    clearTimeout(timer);
    if(!response.ok) return [];
    const data=await response.json();
    const pages=Object.values(data.query?.pages||{}).filter(gpWikiLooksLikeActivity).slice(0,30);
    const websiteMap=await gpWikidataWebsites(pages.map(p=>p.pageprops?.wikibase_item));
    return pages.map(page=>{
      const coords=page.coordinates?.[0]||{};
      const lat=Number(coords.lat),lon=Number(coords.lon);
      const qid=page.pageprops?.wikibase_item||"";
      const official=asHttpUrl(websiteMap[qid]||"");
      const wiki=page.fullurl||`https://en.wikipedia.org/?curid=${page.pageid}`;
      const kind=gpWikiActivityKind(`${page.title} ${page.extract||""}`);
      const venue={
        id:`wiki-${page.pageid}`,
        name:page.title,
        type:staticVenueType(`${kind} ${page.extract||""}`),
        kind,
        address:`Near ${place.city||place.label}`,
        website:official,
        url:official||wiki,
        osmUrl:"",
        phone:"",email:"",bookingUrl:"",reservation:"",openingHours:"",fee:"",
        wikipedia:wiki,wikidata:qid,brand:"",operator:"",
        lat,lon,
        distanceKm:Number.isFinite(lat)&&Number.isFinite(lon)?haversineKm(place.lat,place.lon,lat,lon):null,
        tags:{},sourceBacked:false,
        pricing:{
          status:"unverified",groupRate:"",regularRate:"",minimumGroup:"",savings:"",restrictions:"",
          bookingContact:"",availability:"",bookingUrl:"",sourceUrl:"",sourceLabel:"",checkedAt:""
        }
      };
      venue.popularityScore=popularityScore(venue)+18;
      return venue;
    });
  }catch(e){return []}
}

function gpMergeIntoCurrent(saved,discovered){
  state.venues=mergeVenueCatalogs(saved,discovered);
  sortVenues();
}

window.loadNearbyVenues=async function(place){
  const grid=$("#venueGrid"),count=$("#venueCount"),notice=$("#venueNotice");
  const run=++state.enrichmentRun;
  state.pricingStatus="checking";
  if(grid) grid.innerHTML=loadingCards();
  if(count) count.textContent="Finding popular attractions…";
  if(notice) notice.hidden=true;

  const saved=await loadSavedCityCatalog(place);
  if(run!==state.enrichmentRun) return;
  const discovered=[];
  gpMergeIntoCurrent(saved,discovered);
  if(saved.length) renderVenues(`${saved.length} saved venues loaded; adding live results`);

  let completed=0;
  const tasks=[];

  tasks.push((async()=>{
    const wiki=await gpFetchWikipediaAttractions(place);
    if(run!==state.enrichmentRun) return;
    discovered.push(...wiki);
    completed++;
    gpMergeIntoCurrent(saved,discovered);
    if(state.venues.length) renderVenues(`Wikipedia landmarks loaded · ${completed} searches complete`);
  })());

  gpDiscoveryQueries(place).forEach((batch,index)=>{
    tasks.push((async()=>{
      const elements=await gpFetchOverpass(batch.query,index);
      if(run!==state.enrichmentRun) return;
      if(elements.length) discovered.push(...normalizeVenues(elements,place));
      completed++;
      gpMergeIntoCurrent(saved,discovered);
      if(state.venues.length) renderVenues(`${batch.label} loaded · ${completed} searches complete`);
    })());
  });

  await Promise.allSettled(tasks);
  if(run!==state.enrichmentRun) return;
  gpMergeIntoCurrent(saved,discovered);

  if(!state.venues.length){
    state.pricingStatus="complete";
    renderVenues();
    return;
  }

  renderVenues(`${state.venues.length} popular places found; checking official pricing`);
  await enrichPopularVenues(run);
};
