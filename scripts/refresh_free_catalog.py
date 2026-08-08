#!/usr/bin/env python3
import json, re, time
from datetime import date
from pathlib import Path
from urllib.parse import urljoin, urlparse
import requests
from bs4 import BeautifulSoup

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'data'; VENUES=DATA/'venues'
TARGETS=DATA/'target-cities.json'; CITIES=DATA/'cities.json'; STATUS=DATA/'database-status.json'
WIKI='https://en.wikipedia.org/w/api.php'; WIKIDATA='https://www.wikidata.org/w/api.php'
UA='GroupPassCatalogBot/4.0 (https://github.com/junejas1/GroupPass)'
S=requests.Session(); S.headers.update({'User-Agent':UA,'Accept-Language':'en-US,en;q=0.9'})
GROUP=('group tickets','group rates','group admission','group visits','group sales','group reservations','field trips','school groups','tour groups','group booking')
MONEY=re.compile(r'(?:US\$|USD\s*|\$)\s*\d{1,4}(?:\.\d{1,2})?',re.I)
BAD=re.compile(r'\b(station|airport|terminal|neighborhood|district|county|university|college|school|church|hospital|hotel|restaurant|railway|railroad|list of|category:)\b',re.I)
KINDS=[('museum','Museums & art'),('science center','Museums & art'),('zoo','Outdoors'),('aquarium','Outdoors'),('botanical garden','Outdoors'),('historic site','History'),('tourist attraction','Attractions'),('observation deck','Entertainment'),('amusement park','Entertainment'),('stadium','Sports')]

def load(p,d): return json.loads(p.read_text()) if p.exists() else d
def save(p,v): p.parent.mkdir(parents=True,exist_ok=True); p.write_text(json.dumps(v,indent=2,ensure_ascii=False)+'\n')
def host(u):
    try:return (urlparse(u).hostname or '').lower().removeprefix('www.')
    except:return ''
def same(a,b):
    x,y=host(a),host(b); return bool(x and y and (x==y or x.endswith('.'+y) or y.endswith('.'+x)))
def clean(x): return re.sub(r'\s+',' ',str(x or '')).strip()
def fetch(url):
    if not url or not url.startswith(('http://','https://')): return None,'',url
    try:
        r=S.get(url,timeout=20,allow_redirects=True)
        if r.status_code>=400:return None,'',r.url
        soup=BeautifulSoup(r.text,'html.parser')
        for t in soup(['script','style','noscript','svg']): t.decompose()
        return soup,clean(soup.get_text(' ',strip=True))[:250000],r.url
    except requests.RequestException:return None,'',url
def has_group(text): return any(x in text.lower() for x in GROUP)
def links(soup,base):
    out=[]
    if not soup:return out
    for a in soup.find_all('a',href=True):
        u=urljoin(base,a['href']).split('#')[0]; blob=(clean(a.get_text(' ',strip=True))+' '+u).lower()
        if same(u,base) and any(x in blob for x in GROUP): out.append(u)
    return list(dict.fromkeys(out))[:8]
def find_group_page(site):
    soup,_,final=fetch(site)
    for u in links(soup,final or site):
        _,text,resolved=fetch(u)
        if text and has_group(text): return resolved or u
    return ''
def price(text):
    for s in re.split(r'(?<=[.!?])\s+',text):
        if any(x in s.lower() for x in GROUP):
            m=MONEY.search(s)
            if m:return clean(m.group(0))
    return 'Quote required' if any(x in text.lower() for x in ('request a quote','contact group sales','group inquiry')) else ''
def verify(row):
    r=dict(row); url=r.get('groupSource') or ''
    if not url and r.get('website'): url=find_group_page(r['website'])
    _,text,resolved=fetch(url)
    if not text or not has_group(text): r.update({'lastChecked':date.today().isoformat(),'verificationStatus':'needs_recheck'}); return r
    p=price(text)
    if p:r['groupPrice']=p
    r.update({'groupSource':resolved or url,'lastChecked':date.today().isoformat(),'lastVerified':date.today().isoformat(),'verificationStatus':'verified','sourceBacked':True})
    return r

def wiki_search(q):
    try:return S.get(WIKI,params={'action':'query','format':'json','list':'search','srnamespace':0,'srlimit':8,'srsearch':q},timeout=20).json().get('query',{}).get('search',[])
    except:return []
def pageprops(ids):
    if not ids:return {}
    try:return {int(k):v for k,v in S.get(WIKI,params={'action':'query','format':'json','prop':'pageprops','pageids':'|'.join(map(str,ids[:50]))},timeout=20).json().get('query',{}).get('pages',{}).items()}
    except:return {}
def entities(qids):
    if not qids:return {}
    try:return S.get(WIKIDATA,params={'action':'wbgetentities','format':'json','ids':'|'.join(qids[:50]),'props':'claims'},timeout=20).json().get('entities',{})
    except:return {}
def official(entity):
    for c in (entity.get('claims') or {}).get('P856',[]):
        try:return c['mainsnak']['datavalue']['value']
        except:pass
    return ''

def discover(city,existing,need):
    hits={}
    for kind,cat in KINDS:
        for x in wiki_search(f'"{city["name"]}" {city["state"]} {kind}'):
            title=clean(x.get('title')); pid=int(x.get('pageid') or 0)
            if pid and title.lower() not in existing and not BAD.search(title): hits.setdefault(pid,{'title':title,'cat':cat})
        time.sleep(.05)
    props=pageprops(list(hits)); qids=[]
    for pid,d in hits.items():
        q=((props.get(pid) or {}).get('pageprops') or {}).get('wikibase_item')
        if q:d['qid']=q;qids.append(q)
    ent={}
    for i in range(0,len(qids),50):ent.update(entities(qids[i:i+50]))
    out=[]
    for d in hits.values():
        if len(out)>=need:break
        site=official(ent.get(d.get('qid') or '',{}))
        if not site:continue
        gp=find_group_page(site)
        if not gp:continue
        _,text,resolved=fetch(gp)
        if not text or not has_group(text):continue
        out.append({'id':'verified-'+city['id']+'-'+re.sub(r'[^a-z0-9]+','-',d['title'].lower()).strip('-'),'cityId':city['id'],'name':d['title'],'category':d['cat'],'address':'','website':site,'regularSource':site,'groupSource':resolved or gp,'regularPrice':'See official admission page','regularDetails':[],'groupPrice':price(text) or 'See official group page','groupDetails':[],'savings':'','minimum':'See official group page','eligibility':'General groups; confirm with venue','bookingNotes':['Confirm final pricing on the linked official source'],'lastChecked':date.today().isoformat(),'lastVerified':date.today().isoformat(),'sourceBacked':True,'verificationStatus':'verified','rateStatus':'Official group program confirmed','confidence':1.0,'discoverySource':'Wikimedia discovery; official venue source verification'})
    return out

def city_rows(entry,cid):
    rows=[]; parts=max(1,int((entry or {}).get('parts') or 1))
    for n in range(1,parts+1):
        p=VENUES/f"{cid}{'' if n==1 else '-'+str(n)}.json"
        if p.exists():rows+=load(p,[])
    return rows

def run_city(city,index):
    entry=next((c for c in index if c.get('id')==city['id']),None); rows=[verify(r) for r in city_rows(entry,city['id'])[:20]]
    names={str(r.get('name') or '').lower() for r in rows}; rows+=discover(city,names,max(0,20-len(rows))); rows=rows[:20]; save(VENUES/f"{city['id']}.json",rows)
    if not entry: entry={'id':city['id'],'name':city['name'],'region':city['state'],'country':'United States','aliases':[]}; index.append(entry)
    entry.update({'venueCount':len(rows),'parts':1,'lastVerified':date.today().isoformat()})

def main():
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--batch-size',type=int,default=10);p.add_argument('--city',action='append',default=[]);a=p.parse_args()
    targets=load(TARGETS,[]);index=load(CITIES,[]);wanted={x.lower() for x in a.city}
    selected=[c for c in targets if c['id'].lower() in wanted or c['name'].lower() in wanted] if wanted else targets[(date.today().toordinal()%10)*a.batch_size:((date.today().toordinal()%10)+1)*a.batch_size]
    for c in selected:
        try:run_city(c,index)
        except Exception as e:print(c['name'],e)
    index=[c for c in index if int(c.get('venueCount') or 0)>0];index.sort(key=lambda c:next((t['rank'] for t in targets if t['id']==c['id']),9999));save(CITIES,index)
    done=[c for c in index if int(c.get('venueCount') or 0)>=20];save(STATUS,{'project':'GroupPass verified U.S. attractions database','targetCities':100,'targetVenuesPerCity':20,'targetVenueRecords':2000,'completedCities':len(done),'completedCityIds':[c['id'] for c in done],'completedVenueRecords':sum(int(c.get('venueCount') or 0) for c in index),'method':'Free Wikimedia discovery plus recurring direct checks of official attraction websites. No paid search API required.','lastUpdated':date.today().isoformat()})
if __name__=='__main__':main()
