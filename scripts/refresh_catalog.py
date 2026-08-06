#!/usr/bin/env python3
"""Refresh static venue files from Overture Places.

This runs in GitHub Actions. The website itself remains plain static files.
"""
from __future__ import annotations
import argparse, json, math, re, subprocess, tempfile, time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'data'
VENUES=DATA/'venues'
UA='GroupPassCatalog/1.0 (+https://github.com/junejas1/GroupPass)'
TERMS=('museum','aquarium','zoo','amusement','theme park','water park','bowling','escape','trampoline','climbing','skating','ice rink','roller rink','cinema','movie theater','theatre','theater','botanical','garden','golf','miniature golf','go kart','karting','arcade','laser tag','sports center','sports centre','stadium','arena','tour','cruise','boat','kayak','rafting','paintball','archery','horse riding','winery','brewery','observatory','planetarium','historic site','landmark','cultural center','science center','visitor attraction')

def slug(s): return re.sub(r'[^a-z0-9]+','-',s.lower()).strip('-')
def geocode(city,centers):
    if city['id'] in centers and centers[city['id']].get('lat') is not None:return centers[city['id']]
    r=requests.get('https://nominatim.openstreetmap.org/search',params={'q':city['query'],'format':'json','limit':1,'countrycodes':'us'},headers={'User-Agent':UA},timeout=20)
    r.raise_for_status(); rows=r.json()
    if not rows: raise RuntimeError('No geocode result')
    center={'lat':float(rows[0]['lat']),'lon':float(rows[0]['lon'])};centers[city['id']]=center;time.sleep(1.1);return center

def text_values(x):
    if x is None:return []
    if isinstance(x,str):return [x]
    if isinstance(x,(int,float)):return [str(x)]
    if isinstance(x,list):
        out=[]
        for v in x: out+=text_values(v)
        return out
    if isinstance(x,dict):
        out=[]
        for k,v in x.items():out.append(str(k));out+=text_values(v)
        return out
    return []
def primary_name(p):
    names=p.get('names') or {}
    primary=names.get('primary') if isinstance(names,dict) else None
    if isinstance(primary,str):return primary
    if isinstance(primary,dict):return primary.get('name') or next(iter(primary.values()),'')
    return p.get('name') or ''
def first_url(p):
    for key in ('websites','website'):
        for v in text_values(p.get(key)):
            if v.startswith('http'):return v
    return ''
def address_text(p,city):
    a=p.get('addresses') or []
    if isinstance(a,dict):a=[a]
    if a:
        x=a[0]
        if isinstance(x,dict):
            free=x.get('freeform') or x.get('address') or ''
            locality=x.get('locality') or city['name']; region=x.get('region') or city['state']; post=x.get('postcode') or ''
            return ', '.join([str(v) for v in (free,locality,region,post) if v])
    return city['label']
def category_text(p):
    vals=text_values(p.get('basic_category'))+text_values(p.get('taxonomy'))+text_values(p.get('categories'))
    return ' · '.join(dict.fromkeys(v.replace('_',' ') for v in vals if v))[:180]
def relevant(p):
    hay=' '.join([primary_name(p),category_text(p)]).lower()
    return any(t in hay for t in TERMS)
def point(feature):
    g=feature.get('geometry') or {};coords=g.get('coordinates') or []
    if g.get('type')=='Point' and len(coords)>=2:return float(coords[1]),float(coords[0])
    return None,None

def fetch_city(city,center):
    lat,lon=center['lat'],center['lon']; radius=0.24; lon_radius=radius/max(math.cos(math.radians(lat)),.35)
    bbox=f'{lon-lon_radius},{lat-radius},{lon+lon_radius},{lat+radius}'
    with tempfile.TemporaryDirectory() as td:
        out=Path(td)/'places.geojson'
        cmd=['overturemaps','download',f'--bbox={bbox}','-f','geojson','--type=place','-o',str(out)]
        subprocess.run(cmd,check=True,timeout=600,stdout=subprocess.DEVNULL)
        data=json.load(open(out))
    found=[]
    for f in data.get('features',[]):
        p=f.get('properties') or {}
        if str(p.get('operating_status','')).lower()=='closed' or not relevant(p):continue
        name=primary_name(p).strip()
        if not name:continue
        plat,plon=point(f)
        if plat is None:continue
        cat=category_text(p) or 'Activity'
        found.append({'id':f"overture-{city['id']}-{slug(name)}",'cityId':city['id'],'name':name,'category':cat.title(),'address':address_text(p,city),'lat':plat,'lon':plon,'website':first_url(p),'regularSource':'','groupSource':'','regularPrice':'','regularDetails':[],'groupPrice':'','groupDetails':[],'savings':'','minimum':'','eligibility':'','bookingNotes':[],'lastVerified':time.strftime('%Y-%m-%d'),'sourceBacked':False,'rateStatus':'Venue discovered; group rate not yet verified','confidence':float(p.get('confidence') or 0)})
    found.sort(key=lambda x:(-x['confidence'],x['name']))
    seen=set();dedup=[]
    for v in found:
        k=normalize(v['name'])
        if k in seen:continue
        seen.add(k);dedup.append(v)
        if len(dedup)>=160:break
    return dedup
def normalize(s):return re.sub(r'[^a-z0-9]+',' ',s.lower()).strip()
def merge(city_id,discovered):
    path=VENUES/f'{city_id}.json'
    existing=json.load(open(path)) if path.exists() else []
    curated=[x for x in existing if x.get('sourceBacked')]
    curated_names={normalize(x['name']) for x in curated}
    return curated+[x for x in discovered if normalize(x['name']) not in curated_names]

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--workers',type=int,default=4);ap.add_argument('--limit',type=int,default=100);args=ap.parse_args()
    raw=json.load(open(ROOT/'top-100-cities.json'))[:args.limit]
    cities=[]
    for c in raw:
        cid='washington-dc' if c['name']=='Washington' and c['state']=='DC' else f"{slug(c['name'])}-{c['state'].lower()}"
        cities.append({**c,'id':cid,'label':f"{c['name']}, {c['state']}"})
    centers=json.load(open(DATA/'city-centers.json')) if (DATA/'city-centers.json').exists() else {}
    for c in cities:
        try:
            ctr=geocode(c,centers);c['lat']=ctr['lat'];c['lon']=ctr['lon']
        except Exception as e:print('geocode failed',c['label'],e)
    json.dump(centers,open(DATA/'city-centers.json','w'),indent=2)
    ready=[c for c in cities if c.get('lat') is not None]
    successes=[]
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs={ex.submit(fetch_city,c,{'lat':c['lat'],'lon':c['lon']}):c for c in ready}
        for fut in as_completed(futs):
            c=futs[fut]
            try:
                items=fut.result();json.dump(merge(c['id'],items),open(VENUES/f"{c['id']}.json",'w'),indent=2);successes.append({'id':c['id'],'count':len(items)});print(c['label'],len(items))
            except Exception as e:print('refresh failed',c['label'],e)
    json.dump({'lastRefresh':time.strftime('%Y-%m-%d'),'source':'Overture Places plus source-backed rates','citiesAttempted':len(ready),'citiesUpdated':len(successes),'details':successes},open(DATA/'refresh-status.json','w'),indent=2)
if __name__=='__main__':main()
