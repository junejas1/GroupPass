const originalLoadVenueParts=loadVenueParts;

function decodeCompactVenue(row,city){
  const extra=(row[10]&&typeof row[10]==="object"&&!Array.isArray(row[10]))?row[10]:{};
  const groupPrice=row[6]||"Request a group quote";
  const defaultStatus=/quote|request/i.test(groupPrice)?"Official group information; current price may require quote":"Published group information";
  return {
    id:`curated-${city.id}-${String(row[0]||"").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")}`,
    cityId:city.id,
    name:row[0]||"Attraction",
    category:row[1]||"Attraction",
    address:row[2]||`${city.name}, ${city.region}`,
    website:row[3]||"",
    regularSource:extra.rs||row[3]||"",
    groupSource:row[4]||row[3]||"",
    regularPrice:row[5]||"See official admission page",
    regularDetails:extra.rd||[],
    groupPrice,
    groupDetails:extra.gd||[],
    savings:extra.s||"",
    minimum:row[7]||"Confirm with venue",
    eligibility:row[8]||"General groups",
    bookingNotes:Array.isArray(row[9])?row[9]:[],
    lastVerified:city.lastVerified||"2026-08-06",
    sourceBacked:true,
    rateStatus:extra.st||defaultStatus,
    confidence:extra.c??0.9,
    ...(extra.lat!==undefined?{lat:extra.lat}:{}),
    ...(extra.lon!==undefined?{lon:extra.lon}:{})
  };
}

loadVenueParts=async function(city){
  if(city.format!=="compact-v1") return originalLoadVenueParts(city);
  const response=await fetch(`./data/venues/${city.id}.json`,{cache:"no-store"});
  if(!response.ok) throw new Error("Missing compact curated database");
  const data=await response.json();
  if(!Array.isArray(data)) throw new Error("Invalid compact curated database");
  return data.map(row=>decodeCompactVenue(row,city));
};
