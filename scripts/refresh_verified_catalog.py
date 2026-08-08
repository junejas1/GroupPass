#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import time
from datetime import date
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
VENUES = DATA / "venues"
TARGETS_FILE = DATA / "target-cities.json"
CITIES_FILE = DATA / "cities.json"
STATUS_FILE = DATA / "database-status.json"

BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
UA = "GroupPassCatalogBot/3.1 (+https://github.com/junejas1/GroupPass)"

GROUP_TERMS = (
    "group tickets", "group ticket", "group rates", "group rate", "group admission",
    "group visits", "group visit", "group sales", "groups of", "group reservations",
    "group reservation", "field trips", "field trip", "school groups", "tour groups",
    "corporate groups", "youth groups", "group booking", "group bookings",
)
REGULAR_TERMS = ("tickets", "admission", "pricing", "prices", "plan your visit", "buy tickets")
MONEY_RE = re.compile(r"(?:(?:US)?\$|USD\s*)\s*\d{1,4}(?:\.\d{1,2})?", re.I)
MINIMUM_PATTERNS = [
    re.compile(r"(?:minimum(?:\s+group(?:\s+size)?)?|at least)\s*(?:of\s*)?(\d{1,3})", re.I),
    re.compile(r"groups?\s+(?:of\s+)?(\d{1,3})\s*(?:or more|\+)?", re.I),
    re.compile(r"(\d{1,3})\s*\+\s*(?:guests?|people|persons?|visitors?|tickets?)", re.I),
    re.compile(r"(\d{1,3})\s*(?:or more)\s*(?:guests?|people|persons?|visitors?)", re.I),
]

DISCOVERY_QUERIES = [
    ("Attraction", 24, '"{city}" attractions "group tickets"'),
    ("Attraction", 22, '"{city}" attraction "group rates"'),
    ("Museums & art", 25, '"{city}" museum "group visits"'),
    ("Museums & art", 23, '"{city}" museum "group admission"'),
    ("Outdoors", 25, '"{city}" zoo aquarium "group tickets"'),
    ("Outdoors", 22, '"{city}" botanical garden "group visits"'),
    ("Entertainment", 25, '"{city}" amusement park "group tickets"'),
    ("Entertainment", 22, '"{city}" observation deck "group tickets"'),
    ("Sports", 20, '"{city}" stadium tours "group tickets"'),
    ("Attraction", 20, '"{city}" science center "group visits"'),
    ("Museums & art", 20, '"{city}" children museum "group visits"'),
    ("Attraction", 18, '"{city}" historic site "group tours"'),
    ("Attraction", 16, '"{city}" tourist attraction "group sales"'),
    ("Attraction", 12, '"{city}" top attractions official tickets'),
]

BLOCKED_DOMAINS = {
    "tripadvisor.com", "yelp.com", "viator.com", "getyourguide.com", "expedia.com",
    "booking.com", "groupon.com", "eventbrite.com", "reddit.com", "wikipedia.org",
    "facebook.com", "instagram.com", "tiktok.com", "youtube.com", "pinterest.com",
    "x.com", "twitter.com", "mapquest.com", "foursquare.com", "wanderlog.com",
    "trip.com", "travelocity.com", "kayak.com", "hotels.com", "lonelyplanet.com",
    "timeout.com", "thrillist.com", "usnews.com", "forbes.com",
}

GENERIC_TITLE_WORDS = (
    "things to do", "best attractions", "top attractions", "visitor guide",
    "official tourism", "visit ", "tourism", "tripadvisor", "travel guide",
)

session = requests.Session()
session.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})


def log(msg: str) -> None:
    print(msg, flush=True)


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def today() -> str:
    return date.today().isoformat()


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def host(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower().removeprefix("www.")
    except Exception:
        return ""


def blocked_domain(domain: str) -> bool:
    return any(domain == d or domain.endswith("." + d) for d in BLOCKED_DOMAINS)


def same_site(a: str, b: str) -> bool:
    ha, hb = host(a), host(b)
    if not ha or not hb:
        return False
    return ha == hb or ha.endswith("." + hb) or hb.endswith("." + ha)


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def fetch_html(url: str, timeout: int = 20):
    if not url or not url.startswith(("http://", "https://")):
        return None, "", ""
    try:
        r = session.get(url, timeout=timeout, allow_redirects=True)
        if r.status_code >= 400:
            return None, "", r.url
        ctype = r.headers.get("content-type", "")
        if "html" not in ctype and "text" not in ctype:
            return None, "", r.url
        soup = BeautifulSoup(r.text, "html.parser")
        for tag in soup(["script", "style", "noscript", "svg"]):
            tag.decompose()
        text = clean_text(soup.get_text(" ", strip=True))[:320000]
        return soup, text, r.url
    except requests.RequestException:
        return None, "", url


def fingerprint(text: str) -> str:
    normalized = re.sub(r"\d{1,2}:\d{2}", "", text.lower())
    normalized = re.sub(r"\s+", " ", normalized)[:220000]
    return hashlib.sha256(normalized.encode("utf-8", "ignore")).hexdigest()


def brave_search(api_key: str, q: str, count: int = 20) -> list[dict]:
    try:
        r = session.get(
            BRAVE_URL,
            headers={"Accept": "application/json", "X-Subscription-Token": api_key},
            params={
                "q": q, "count": min(20, count), "country": "US",
                "search_lang": "en", "safesearch": "moderate",
                "extra_snippets": "true",
            },
            timeout=30,
        )
        if r.status_code >= 400:
            log(f"Brave Search error {r.status_code}: {r.text[:250]}")
            return []
        return (r.json().get("web") or {}).get("results") or []
    except requests.RequestException as exc:
        log(f"Brave Search request failed: {exc}")
        return []


def result_blob(result: dict) -> str:
    return clean_text(" ".join([
        result.get("title") or "",
        result.get("description") or "",
        " ".join(result.get("extra_snippets") or []),
        result.get("url") or "",
    ]))


def has_group_evidence(text: str) -> bool:
    low = text.lower()
    if any(term in low for term in GROUP_TERMS):
        return True
    return bool(re.search(
        r"\bgroups?\b.{0,120}\b(?:\d{1,3}|minimum|reservation|booking|discount|admission|ticket)",
        low,
    ))


def group_signal(text: str) -> int:
    low = text.lower()
    score = sum(4 for term in GROUP_TERMS if term in low)
    if "group sales" in low or "group tickets" in low:
        score += 10
    if "field trip" in low:
        score += 5
    return score


def discover_candidates(api_key: str, city: dict) -> list[dict]:
    by_domain: dict[str, dict] = {}
    city_label = f"{city['name']}, {city['state']}"
    for category, weight, template in DISCOVERY_QUERIES:
        query = template.format(city=city_label)
        results = brave_search(api_key, query)
        for rank, result in enumerate(results, 1):
            url = result.get("url") or ""
            domain = host(url)
            if not domain or blocked_domain(domain):
                continue
            blob = result_blob(result)
            candidate = by_domain.setdefault(domain, {
                "domain": domain, "score": 0.0, "hits": 0, "urls": [],
                "titles": [], "categoryScores": {},
            })
            prominence = max(0, 21 - rank)
            candidate["score"] += weight + prominence + group_signal(blob)
            candidate["hits"] += 1
            candidate["urls"].append((group_signal(blob), prominence, url))
            candidate["titles"].append(result.get("title") or "")
            candidate["categoryScores"][category] = candidate["categoryScores"].get(category, 0) + weight
        time.sleep(0.12)

    for candidate in by_domain.values():
        candidate["score"] += min(45, (candidate["hits"] - 1) * 9)
        candidate["urls"] = sorted(candidate["urls"], reverse=True)
        candidate["category"] = max(candidate["categoryScores"], key=candidate["categoryScores"].get)
    return sorted(by_domain.values(), key=lambda c: c["score"], reverse=True)


def score_anchor(label: str, href: str, group: bool) -> int:
    text = f"{label} {href}".lower()
    terms = GROUP_TERMS if group else REGULAR_TERMS
    score = sum(8 if ("group" in term or "field" in term) else 4 for term in terms if term in text)
    if any(x in text for x in ("privacy", "terms", "careers", "donate", "membership", "login", "press")):
        score -= 20
    return score


def links_from_page(soup: BeautifulSoup | None, base_url: str, group: bool) -> list[tuple[int, str]]:
    if not soup:
        return []
    out = []
    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"])
        if not same_site(href, base_url):
            continue
        label = clean_text(a.get_text(" ", strip=True))
        score = score_anchor(label, href, group)
        if score > 0:
            out.append((score, href.split("#")[0].rstrip("/")))
    seen, ranked = set(), []
    for score, href in sorted(out, reverse=True):
        if href in seen:
            continue
        seen.add(href)
        ranked.append((score, href))
    return ranked[:10]


def search_site_page(api_key: str, website: str, venue_name: str, group: bool) -> str:
    domain = host(website)
    if not domain:
        return ""
    terms = "group tickets group admission group rates group visits group sales field trips" if group else "tickets admission pricing"
    query = f'site:{domain} "{venue_name}" {terms}'
    best_url, best_score = "", -999
    for result in brave_search(api_key, query):
        url = result.get("url") or ""
        if not same_site(url, website):
            continue
        blob = result_blob(result)
        score = score_anchor(blob, url, group)
        if group:
            score += group_signal(blob)
        if score > best_score:
            best_url, best_score = url, score
    return best_url if best_score > 0 else ""


def jsonld_objects(soup: BeautifulSoup | None):
    if not soup:
        return
    for tag in soup.find_all("script", attrs={"type": re.compile("ld\\+json", re.I)}):
        raw = tag.string or tag.get_text()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except Exception:
            continue
        stack = data if isinstance(data, list) else [data]
        while stack:
            obj = stack.pop()
            if isinstance(obj, dict):
                yield obj
                graph = obj.get("@graph")
                if isinstance(graph, list):
                    stack.extend(graph)
            elif isinstance(obj, list):
                stack.extend(obj)


def first_jsonld_value(soup: BeautifulSoup | None, key: str):
    for obj in jsonld_objects(soup):
        value = obj.get(key)
        if value:
            return value
    return None


def venue_name_from_page(soup: BeautifulSoup | None, fallback_title: str, domain: str) -> str:
    for obj in jsonld_objects(soup):
        typ = obj.get("@type")
        types = typ if isinstance(typ, list) else [typ]
        if any(str(t).lower() in {
            "touristattraction", "museum", "zoo", "aquarium", "amusementpark",
            "organization", "localbusiness", "sportsactivitylocation", "performingartstheater",
        } for t in types):
            name = clean_text(str(obj.get("name") or ""))
            if 2 < len(name) < 120:
                return name
    if soup:
        h1 = soup.find("h1")
        if h1:
            name = clean_text(h1.get_text(" ", strip=True))
            if 2 < len(name) < 120 and not any(w in name.lower() for w in GENERIC_TITLE_WORDS):
                return name
        if soup.title:
            fallback_title = clean_text(soup.title.get_text(" ", strip=True))
    title = re.split(r"\s+[|–—]\s+|\s+-\s+", fallback_title or "")[0].strip()
    if 2 < len(title) < 120 and not any(w in title.lower() for w in GENERIC_TITLE_WORDS):
        return title
    return domain.split(".")[0].replace("-", " ").title()


def address_from_jsonld(soup: BeautifulSoup | None) -> str:
    value = first_jsonld_value(soup, "address")
    if isinstance(value, str):
        return clean_text(value)
    if isinstance(value, dict):
        return ", ".join(filter(None, [
            clean_text(str(value.get("streetAddress") or "")),
            clean_text(str(value.get("addressLocality") or "")),
            clean_text(str(value.get("addressRegion") or "")),
            clean_text(str(value.get("postalCode") or "")),
        ]))
    return ""


def geo_from_jsonld(soup: BeautifulSoup | None):
    value = first_jsonld_value(soup, "geo")
    if isinstance(value, dict):
        try:
            return float(value.get("latitude")), float(value.get("longitude"))
        except (TypeError, ValueError):
            pass
    return None, None


def split_sentences(text: str) -> list[str]:
    text = clean_text(text)
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\s*[|•]\s*", text) if 8 <= len(s.strip()) <= 500]


def extract_minimum(text: str) -> str:
    for sentence in split_sentences(text):
        low = sentence.lower()
        if not ("group" in low or "field trip" in low or "tour" in low):
            continue
        for pattern in MINIMUM_PATTERNS:
            m = pattern.search(sentence)
            if m:
                return f"{m.group(1)}+ guests"
    return ""


def choose_money_line(text: str, group: bool):
    candidates = []
    for sentence in split_sentences(text):
        money = MONEY_RE.findall(sentence)
        if not money:
            continue
        low = sentence.lower()
        if group:
            if not any(term in low for term in GROUP_TERMS):
                continue
            score = 10 + (4 if ("per person" in low or "per guest" in low or "each" in low) else 0)
        else:
            if any(term in low for term in GROUP_TERMS):
                continue
            if not any(term in low for term in ("admission", "ticket", "general admission", "adult")):
                continue
            score = 7 + (3 if ("adult" in low or "general admission" in low) else 0)
        if len(money) > 4:
            score -= 3
        candidates.append((score, sentence, money))
    return max(candidates, default=None, key=lambda x: x[0])


def compact_price(line_info) -> str:
    if not line_info:
        return ""
    _, sentence, values = line_info
    values = list(dict.fromkeys(v.replace(" ", "") for v in values))
    if not values:
        return ""
    value = values[0]
    low = sentence.lower()
    if "per person" in low:
        return f"{value} per person"
    if "per guest" in low:
        return f"{value} per guest"
    if "adult" in low:
        return f"{value} adult"
    return value


def extract_restrictions(text: str) -> list[str]:
    needles = (
        "advance reservation", "advance booking", "reservation required", "must be booked",
        "book at least", "reserve at least", "prepaid", "prepay", "deposit", "weekday",
        "blackout", "not valid", "tax", "gratuity", "chaperone",
    )
    out = []
    for sentence in split_sentences(text):
        low = sentence.lower()
        if ("group" in low or "field trip" in low) and any(n in low for n in needles):
            out.append(sentence[:260])
        if len(out) >= 3:
            break
    return out


def numeric_price(value: str):
    m = re.search(r"\d+(?:\.\d{1,2})?", value or "")
    return float(m.group()) if m else None


def savings_text(regular: str, group: str) -> str:
    r, g = numeric_price(regular), numeric_price(group)
    if r is None or g is None or g >= r:
        return ""
    dollars = r - g
    pct = round(dollars / r * 100)
    return f"Save about ${dollars:.2f} per comparable ticket ({pct}%)".replace(".00", "")


def looks_exact_price(value: str) -> bool:
    return bool(MONEY_RE.search(value or ""))


def verify_candidate(candidate: dict, city: dict, api_key: str):
    for signal, prominence, url in candidate["urls"][:6]:
        soup, text, final = fetch_html(url)
        if not soup or not text:
            continue
        page_name = venue_name_from_page(soup, candidate["titles"][0] if candidate["titles"] else "", candidate["domain"])

        group_page, group_soup, group_text = "", None, ""
        if has_group_evidence(text):
            group_page, group_soup, group_text = final or url, soup, text
        else:
            links = links_from_page(soup, final or url, group=True)
            for _, link in links[:3]:
                gsoup, gtext, gfinal = fetch_html(link)
                if gtext and has_group_evidence(gtext):
                    group_page, group_soup, group_text = gfinal or link, gsoup, gtext
                    break
        if not group_page:
            found = search_site_page(api_key, final or url, page_name, group=True)
            if found:
                gsoup, gtext, gfinal = fetch_html(found)
                if gtext and has_group_evidence(gtext):
                    group_page, group_soup, group_text = gfinal or found, gsoup, gtext
        if not group_page:
            continue

        website = f"{urlparse(group_page).scheme}://{urlparse(group_page).netloc}/"
        regular_page = search_site_page(api_key, website, page_name, group=False) or website
        rsoup, regular_text, rfinal = fetch_html(regular_page)
        if not regular_text:
            regular_text, rsoup, rfinal = group_text, group_soup, regular_page

        group_price = compact_price(choose_money_line(group_text, group=True))
        regular_price = compact_price(choose_money_line(regular_text, group=False))
        address = address_from_jsonld(group_soup) or address_from_jsonld(rsoup) or f"{city['name']}, {city['state']}"
        lat, lon = geo_from_jsonld(group_soup)
        if lat is None:
            lat, lon = geo_from_jsonld(rsoup)

        return {
            "id": f"auto-{city['id']}-{slug(page_name)}",
            "cityId": city["id"], "name": page_name,
            "category": candidate["category"], "address": address,
            "lat": lat, "lon": lon, "website": website,
            "regularSource": rfinal or regular_page, "groupSource": group_page,
            "regularPrice": regular_price or "See current official admission",
            "regularDetails": [],
            "groupPrice": group_price or "See current official group rate",
            "groupDetails": [],
            "savings": savings_text(regular_price, group_price),
            "minimum": extract_minimum(group_text) or "Confirm with venue",
            "eligibility": "Confirm on official group page",
            "bookingNotes": extract_restrictions(group_text),
            "lastVerified": today(), "lastChecked": today(),
            "sourceBacked": True,
            "rateStatus": "Published group rate" if group_price else "Official group program; current rate varies or requires quote",
            "confidence": 0.98 if group_price else 0.92,
            "groupSourceFingerprint": fingerprint(group_text),
            "verificationStatus": "verified_current",
            "discoveredBy": "Brave Search prominence + official-site verification",
            "majorAttractionScore": round(candidate["score"], 2),
        }
    return None


def refresh_existing_record(record: dict, api_key: str) -> dict:
    out = dict(record)
    for key in ("googlePlaceId", "googleRating", "googleUserRatingCount"):
        out.pop(key, None)
    out.setdefault("majorAttractionScore", 100 if str(out.get("id", "")).startswith("curated-") else 60)

    website = out.get("website") or out.get("groupSource") or out.get("regularSource") or ""
    group_page = out.get("groupSource") or ""
    _, group_text, group_final = fetch_html(group_page) if group_page else (None, "", "")

    if not group_text or not has_group_evidence(group_text):
        replacement = search_site_page(api_key, website, out.get("name", ""), group=True) if website else ""
        if replacement:
            _, group_text, group_final = fetch_html(replacement)
            if group_text and has_group_evidence(group_text):
                out["groupSource"] = group_final or replacement

    out["lastChecked"] = today()
    if not group_text or not has_group_evidence(group_text):
        failures = int(out.get("verificationFailures") or 0) + 1
        out["verificationFailures"] = failures
        out["verificationStatus"] = "needs_recheck"
        out["rateStatus"] = "Official group information could not be re-verified"
        if looks_exact_price(out.get("groupPrice", "")):
            out["groupPrice"] = "Recheck current official group rate"
        if failures >= 2 and looks_exact_price(out.get("regularPrice", "")):
            out["regularPrice"] = "Recheck current official admission"
        out["confidence"] = min(float(out.get("confidence") or 0.8), 0.7)
        return out

    out["verificationFailures"] = 0
    out["verificationStatus"] = "verified_current"
    out["lastVerified"] = today()
    new_fp = fingerprint(group_text)
    old_fp = out.get("groupSourceFingerprint")
    out["groupSourceFingerprint"] = new_fp

    if not old_fp or old_fp == new_fp:
        return out

    new_group = compact_price(choose_money_line(group_text, group=True))
    new_minimum = extract_minimum(group_text)
    new_notes = extract_restrictions(group_text)

    regular_page = out.get("regularSource") or website
    _, regular_text, regular_final = fetch_html(regular_page) if regular_page else (None, "", "")
    new_regular = compact_price(choose_money_line(regular_text, group=False)) if regular_text else ""

    if new_group:
        out["groupPrice"] = new_group
        out["rateStatus"] = "Published group rate — automatically re-verified"
        out["confidence"] = 0.98
    else:
        out["groupPrice"] = "See current official group rate"
        out["rateStatus"] = "Official group page changed — confirm current rate"
        out["confidence"] = 0.85

    if new_regular:
        out["regularPrice"] = new_regular
    elif looks_exact_price(out.get("regularPrice", "")):
        out["regularPrice"] = "See current official admission"
    if new_minimum:
        out["minimum"] = new_minimum
    if new_notes:
        out["bookingNotes"] = new_notes
    if regular_final:
        out["regularSource"] = regular_final
    out["savings"] = savings_text(out.get("regularPrice", ""), out.get("groupPrice", ""))
    return out


def load_existing_city(city_id: str, city_meta: dict | None) -> list[dict]:
    parts = max(1, int((city_meta or {}).get("parts") or 1))
    rows = []
    for part in range(1, parts + 1):
        suffix = "" if part == 1 else f"-{part}"
        path = VENUES / f"{city_id}{suffix}.json"
        if path.exists():
            data = load_json(path, [])
            if isinstance(data, list):
                rows.extend(data)
    return rows


def write_city(city: dict, records: list[dict], city_index: list[dict]) -> None:
    records = records[:20]
    save_json(VENUES / f"{city['id']}.json", records)
    meta = next((c for c in city_index if c.get("id") == city["id"]), None)
    if not meta and len(records) >= 20:
        meta = {
            "id": city["id"], "name": city["name"], "region": city["state"],
            "country": "United States", "aliases": [],
        }
        city_index.append(meta)
    if meta:
        meta["venueCount"] = len(records)
        meta["lastVerified"] = today()
        meta.pop("parts", None)


def update_city(city: dict, api_key: str, city_index: list[dict]) -> int:
    city_meta = next((c for c in city_index if c.get("id") == city["id"]), None)
    existing = load_existing_city(city["id"], city_meta)
    log(f"\n{city['name']}: rechecking {len(existing)} saved records")

    refreshed, seen_names, seen_domains = [], set(), set()
    for record in existing:
        updated = refresh_existing_record(record, api_key)
        key = slug(updated.get("name", ""))
        domain = host(updated.get("website") or updated.get("groupSource") or "")
        if key and key not in seen_names:
            refreshed.append(updated)
            seen_names.add(key)
            if domain:
                seen_domains.add(domain)
        time.sleep(0.08)

    if len(refreshed) < 20 or any(r.get("verificationStatus") != "verified_current" for r in refreshed):
        log(f"{city['name']}: searching the web for major group-capable attractions")
        for candidate in discover_candidates(api_key, city):
            if candidate["domain"] in seen_domains:
                continue
            record = verify_candidate(candidate, city, api_key)
            if not record:
                continue
            key = slug(record["name"])
            if not key or key in seen_names:
                continue
            refreshed.append(record)
            seen_names.add(key)
            seen_domains.add(candidate["domain"])
            log(f"  accepted: {record['name']}")
            if len([r for r in refreshed if r.get("verificationStatus") == "verified_current"]) >= 20:
                break
            time.sleep(0.1)

    def rank_record(r):
        return (
            1 if r.get("verificationStatus") == "verified_current" else 0,
            float(r.get("majorAttractionScore") or 0),
            1 if str(r.get("id", "")).startswith("curated-") else 0,
            float(r.get("confidence") or 0),
        )

    refreshed.sort(key=rank_record, reverse=True)
    write_city(city, refreshed, city_index)
    count = min(20, len(refreshed))
    log(f"{city['name']}: saved {count} records")
    return count


def choose_batch(targets: list[dict], batch_size: int, batch_index: int | None):
    if batch_size <= 0 or batch_size >= len(targets):
        return targets
    batches = math.ceil(len(targets) / batch_size)
    if batch_index is None:
        batch_index = date.today().toordinal() % batches
    batch_index %= batches
    start = batch_index * batch_size
    return targets[start:start + batch_size]


def update_status(targets: list[dict], city_index: list[dict]) -> None:
    active = {c["id"]: c for c in city_index if int(c.get("venueCount") or 0) > 0}
    complete = [c for c in targets if int(active.get(c["id"], {}).get("venueCount") or 0) >= 20]
    total_records = sum(min(20, int(active.get(c["id"], {}).get("venueCount") or 0)) for c in targets)
    save_json(STATUS_FILE, {
        "project": "GroupPass verified attraction and group-pricing database",
        "architectureVersion": "3.1-web-search-official-sites",
        "targetCities": len(targets), "targetVenuesPerCity": 20,
        "targetVenueRecords": len(targets) * 20,
        "completedCities": len(complete),
        "completedCityIds": [c["id"] for c in complete],
        "completedVenueRecords": total_records,
        "method": (
            "Major attraction candidates are found with attraction-specific web searches and ranked by repeated "
            "search prominence. Directory, review, social, and booking aggregators are excluded as database sources. "
            "A new venue is accepted only after GroupPass fetches an official venue-domain page and confirms a group "
            "program. Official group pages are fingerprinted and rechecked; exact stale prices are removed whenever "
            "a changed source cannot be confidently re-extracted."
        ),
        "lastUpdated": today(),
    })


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-size", type=int, default=10)
    parser.add_argument("--batch-index", type=int)
    parser.add_argument("--city", action="append", default=[])
    args = parser.parse_args()

    api_key = os.getenv("BRAVE_SEARCH_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("Missing required GitHub Actions secret: BRAVE_SEARCH_API_KEY")

    targets = load_json(TARGETS_FILE, [])
    if not targets:
        raise SystemExit(f"No target cities found at {TARGETS_FILE}")
    city_index = load_json(CITIES_FILE, [])

    wanted = {x.strip().lower() for x in args.city if x.strip()}
    if wanted:
        selected = [
            c for c in targets
            if c["id"].lower() in wanted or c["name"].lower() in wanted
            or f"{c['name']}, {c['state']}".lower() in wanted
        ]
        if not selected:
            raise SystemExit("No --city values matched target-cities.json")
    else:
        selected = choose_batch(targets, args.batch_size, args.batch_index)

    log("Selected cities: " + ", ".join(c["name"] for c in selected))
    for city in selected:
        try:
            update_city(city, api_key, city_index)
        except Exception as exc:
            log(f"{city['name']}: ERROR: {exc}")

    city_index = [c for c in city_index if int(c.get("venueCount") or 0) > 0]
    city_index.sort(key=lambda c: next((t["rank"] for t in targets if t["id"] == c["id"]), 9999))
    save_json(CITIES_FILE, city_index)
    update_status(targets, city_index)


if __name__ == "__main__":
    main()
