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

GOOGLE_URL = "https://places.googleapis.com/v1/places:searchText"
BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
UA = "GroupPassCatalogBot/2.0 (+https://github.com/junejas1/GroupPass)"

SEARCH_TYPES = [
    "tourist_attraction", "museum", "amusement_park", "aquarium", "zoo",
    "historical_landmark", "botanical_garden", "observation_deck", "stadium",
    "art_gallery", "performing_arts_theater", "planetarium", "water_park", "arena",
]

GROUP_TERMS = (
    "group tickets", "group ticket", "group rates", "group rate", "group admission",
    "group visits", "group visit", "group sales", "groups of", "group reservations",
    "group reservation", "field trips", "field trip", "school groups", "tour groups",
    "corporate groups", "youth groups", "group booking", "group bookings",
)
REGULAR_TERMS = ("tickets", "admission", "pricing", "prices", "plan your visit", "visit", "buy tickets")
MONEY_RE = re.compile(r"(?:(?:US)?\$|USD\s*)\s*\d{1,4}(?:\.\d{1,2})?", re.I)
MINIMUM_PATTERNS = [
    re.compile(r"(?:minimum(?:\s+group(?:\s+size)?)?|at least)\s*(?:of\s*)?(\d{1,3})", re.I),
    re.compile(r"groups?\s+(?:of\s+)?(\d{1,3})\s*(?:or more|\+)?", re.I),
    re.compile(r"(\d{1,3})\s*\+\s*(?:guests?|people|persons?|visitors?|tickets?)", re.I),
    re.compile(r"(\d{1,3})\s*(?:or more)\s*(?:guests?|people|persons?|visitors?)", re.I),
]

CATEGORY_BY_TYPE = {
    "museum": "Museums & art", "art_gallery": "Museums & art", "art_museum": "Museums & art",
    "history_museum": "Museums & art", "planetarium": "Museums & art", "aquarium": "Outdoors",
    "zoo": "Outdoors", "botanical_garden": "Outdoors", "garden": "Outdoors", "national_park": "Outdoors",
    "state_park": "Outdoors", "wildlife_park": "Outdoors", "wildlife_refuge": "Outdoors",
    "stadium": "Sports", "arena": "Sports", "sports_complex": "Sports", "golf_course": "Sports",
    "amusement_park": "Entertainment", "water_park": "Entertainment", "observation_deck": "Entertainment",
    "performing_arts_theater": "Entertainment", "concert_hall": "Entertainment", "opera_house": "Entertainment",
    "casino": "Entertainment",
}
TYPE_BONUS = {
    "tourist_attraction": 28, "museum": 24, "amusement_park": 32, "aquarium": 31, "zoo": 31,
    "historical_landmark": 22, "botanical_garden": 20, "observation_deck": 28, "stadium": 24,
    "art_gallery": 18, "performing_arts_theater": 18, "planetarium": 20, "water_park": 23, "arena": 20,
}

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
        text = clean_text(soup.get_text(" ", strip=True))[:300000]
        return soup, text, r.url
    except requests.RequestException:
        return None, "", url


def fingerprint(text: str) -> str:
    normalized = re.sub(r"\d{1,2}:\d{2}", "", text.lower())
    normalized = re.sub(r"\s+", " ", normalized)[:220000]
    return hashlib.sha256(normalized.encode("utf-8", "ignore")).hexdigest()


def google_text_search(api_key: str, city: dict, place_type: str) -> list[dict]:
    query = f"{place_type.replace('_', ' ')} attractions in {city['query']}"
    payload = {
        "textQuery": query,
        "includedType": place_type,
        "strictTypeFiltering": True,
        "pageSize": 20,
        "rankPreference": "RELEVANCE",
        "regionCode": "US",
        "languageCode": "en",
    }
    fields = ",".join([
        "places.id", "places.displayName", "places.formattedAddress", "places.location", "places.types",
        "places.primaryType", "places.rating", "places.userRatingCount", "places.websiteUri", "places.businessStatus",
    ])
    r = session.post(
        GOOGLE_URL,
        headers={"Content-Type": "application/json", "X-Goog-Api-Key": api_key, "X-Goog-FieldMask": fields},
        json=payload,
        timeout=30,
    )
    if r.status_code >= 400:
        log(f"Google Places error {r.status_code} for {city['name']} / {place_type}: {r.text[:300]}")
        return []
    return r.json().get("places", [])


def place_score(place: dict) -> float:
    ratings = max(0, int(place.get("userRatingCount") or 0))
    rating = float(place.get("rating") or 0)
    types = set(place.get("types") or [])
    primary = place.get("primaryType")
    score = math.log10(ratings + 1) * 42 + rating * 8
    score += max([TYPE_BONUS.get(t, 0) for t in types | ({primary} if primary else set())] or [0])
    if place.get("websiteUri"):
        score += 15
    if place.get("businessStatus") == "OPERATIONAL":
        score += 8
    return score


def discover_candidates(api_key: str, city: dict, desired_pool: int = 50) -> list[dict]:
    by_id: dict[str, dict] = {}
    for place_type in SEARCH_TYPES:
        for p in google_text_search(api_key, city, place_type):
            if p.get("businessStatus") not in (None, "", "OPERATIONAL"):
                continue
            pid = p.get("id")
            name = (p.get("displayName") or {}).get("text")
            if not pid or not name:
                continue
            existing = by_id.get(pid)
            if existing:
                existing["types"] = sorted(set(existing.get("types", [])) | set(p.get("types", [])))
                continue
            by_id[pid] = p
        if len(by_id) >= desired_pool and place_type in {"historical_landmark", "botanical_garden"}:
            break
        time.sleep(0.15)
    return sorted(by_id.values(), key=place_score, reverse=True)


def score_anchor(label: str, href: str, group: bool) -> int:
    text = f"{label} {href}".lower()
    score = 0
    terms = GROUP_TERMS if group else REGULAR_TERMS
    for term in terms:
        if term in text:
            score += 8 if "group" in term or "field" in term else 4
    if any(x in text for x in ("privacy", "terms", "careers", "donate", "membership", "login", "press")):
        score -= 20
    if group and any(x in text for x in ("group sales", "group tickets", "group visit", "field trip", "/groups", " groups ")):
        score += 12
    return score


def links_from_home(website: str, group: bool) -> list[tuple[int, str]]:
    soup, _, final = fetch_html(website)
    if not soup:
        return []
    out = []
    for a in soup.find_all("a", href=True):
        href = urljoin(final or website, a["href"])
        if not same_site(href, website):
            continue
        label = clean_text(a.get_text(" ", strip=True))
        score = score_anchor(label, href, group)
        if score > 0:
            out.append((score, href))
    seen, ranked = set(), []
    for score, href in sorted(out, reverse=True):
        key = href.split("#")[0].rstrip("/")
        if key in seen:
            continue
        seen.add(key)
        ranked.append((score, key))
    return ranked[:8]


def brave_search(api_key: str, q: str) -> list[dict]:
    r = session.get(
        BRAVE_URL,
        headers={"Accept": "application/json", "X-Subscription-Token": api_key},
        params={"q": q, "count": 10, "country": "US", "search_lang": "en", "safesearch": "moderate", "extra_snippets": "true"},
        timeout=30,
    )
    if r.status_code >= 400:
        log(f"Brave Search error {r.status_code}: {r.text[:250]}")
        return []
    return (r.json().get("web") or {}).get("results") or []


def search_official_page(brave_key: str, website: str, venue_name: str, group: bool) -> str:
    domain = host(website)
    if not domain:
        return ""
    keywords = "groups group tickets group admission rates field trips group sales" if group else "tickets admission pricing visit"
    q = f'site:{domain} "{venue_name}" {keywords}'
    results = brave_search(brave_key, q)
    best_url, best_score = "", -999
    for result in results:
        url = result.get("url") or ""
        if not same_site(url, website):
            continue
        blob = clean_text(" ".join([
            result.get("title") or "", result.get("description") or "",
            " ".join(result.get("extra_snippets") or []), url,
        ]))
        s = score_anchor(blob, url, group)
        if group and any(term in blob.lower() for term in GROUP_TERMS):
            s += 12
        if s > best_score:
            best_url, best_score = url, s
    return best_url if best_score > 0 else ""


def find_official_page(brave_key: str, website: str, venue_name: str, group: bool) -> str:
    home_links = links_from_home(website, group)
    if home_links and home_links[0][0] >= (12 if group else 6):
        return home_links[0][1]
    return search_official_page(brave_key, website, venue_name, group)


def split_sentences(text: str) -> list[str]:
    text = clean_text(text)
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\s*[|•]\s*", text) if 8 <= len(s.strip()) <= 500]


def has_group_evidence(text: str) -> bool:
    low = text.lower()
    if any(term in low for term in GROUP_TERMS):
        return True
    return bool(re.search(r"\bgroups?\b.{0,100}\b(?:\d{1,3}|minimum|reservation|booking|discount|admission|ticket)", low))


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
            score = 10
            if "per person" in low or "per guest" in low or "each" in low:
                score += 4
            if "starting" in low or "from " in low:
                score -= 1
        else:
            if any(term in low for term in GROUP_TERMS):
                continue
            if not any(term in low for term in ("admission", "ticket", "general admission", "adult")):
                continue
            score = 7
            if "adult" in low or "general admission" in low:
                score += 3
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
    low = sentence.lower()
    value = values[0]
    if "per person" in low:
        return f"{value} per person"
    if "per guest" in low:
        return f"{value} per guest"
    if "adult" in low:
        return f"{value} adult"
    return value


def extract_restrictions(text: str) -> list[str]:
    out = []
    needles = (
        "advance reservation", "advance booking", "reservation required", "must be booked",
        "book at least", "reserve at least", "prepaid", "prepay", "deposit", "weekday",
        "blackout", "not valid", "tax", "gratuity", "chaperone",
    )
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


def category_for(place: dict) -> str:
    primary = place.get("primaryType")
    if primary in CATEGORY_BY_TYPE:
        return CATEGORY_BY_TYPE[primary]
    for t in place.get("types") or []:
        if t in CATEGORY_BY_TYPE:
            return CATEGORY_BY_TYPE[t]
    return "Attraction"


def build_new_record(city: dict, place: dict, brave_key: str):
    name = (place.get("displayName") or {}).get("text") or ""
    website = place.get("websiteUri") or ""
    if not name or not website:
        return None

    group_page = find_official_page(brave_key, website, name, group=True)
    if not group_page:
        return None
    _, group_text, group_final = fetch_html(group_page)
    if not group_text or not has_group_evidence(group_text):
        return None

    regular_page = find_official_page(brave_key, website, name, group=False) or website
    _, regular_text, regular_final = fetch_html(regular_page)
    regular_text = regular_text or group_text

    group_price = compact_price(choose_money_line(group_text, group=True))
    regular_price = compact_price(choose_money_line(regular_text, group=False))
    minimum = extract_minimum(group_text)
    restrictions = extract_restrictions(group_text)

    rate_status = "Published group rate" if group_price else "Group program confirmed — current rate varies or requires quote"
    if not group_price:
        group_price = "See current official group rate"
    if not regular_price:
        regular_price = "See current official admission"

    loc = place.get("location") or {}
    return {
        "id": f"auto-{city['id']}-{slug(name)}", "cityId": city["id"], "name": name,
        "category": category_for(place), "address": place.get("formattedAddress") or "",
        "lat": loc.get("latitude"), "lon": loc.get("longitude"), "website": website,
        "regularSource": regular_final or regular_page, "groupSource": group_final or group_page,
        "regularPrice": regular_price, "regularDetails": [], "groupPrice": group_price, "groupDetails": [],
        "savings": savings_text(regular_price, group_price), "minimum": minimum or "Confirm with venue",
        "eligibility": "Confirm on official group page", "bookingNotes": restrictions,
        "lastVerified": today(), "lastChecked": today(), "sourceBacked": True,
        "rateStatus": rate_status, "confidence": 0.98 if rate_status == "Published group rate" else 0.9,
        "googlePlaceId": place.get("id"), "googleRating": place.get("rating"),
        "googleUserRatingCount": place.get("userRatingCount"), "groupSourceFingerprint": fingerprint(group_text),
        "verificationStatus": "verified_current", "discoveredBy": "Google Places",
        "groupPageFoundBy": "official-site/Brave Search",
    }


def looks_exact_price(value: str) -> bool:
    return bool(MONEY_RE.search(value or ""))


def refresh_existing_record(record: dict, brave_key: str) -> dict:
    out = dict(record)
    name = out.get("name") or ""
    website = out.get("website") or out.get("groupSource") or out.get("regularSource") or ""
    group_page = out.get("groupSource") or ""
    _, group_text, group_final = fetch_html(group_page) if group_page else (None, "", "")

    if not group_text or not has_group_evidence(group_text):
        replacement = find_official_page(brave_key, website, name, group=True) if website else ""
        if replacement:
            _, group_text, group_final = fetch_html(replacement)
            if group_text and has_group_evidence(group_text):
                out["groupSource"] = group_final or replacement

    out["lastChecked"] = today()
    if not group_text or not has_group_evidence(group_text):
        out["verificationStatus"] = "official_group_page_unavailable"
        out["rateStatus"] = "Group information could not be re-verified"
        if looks_exact_price(out.get("groupPrice", "")):
            out["groupPrice"] = "Recheck official group rate"
        return out

    new_fp = fingerprint(group_text)
    old_fp = out.get("groupSourceFingerprint")
    out["groupSourceFingerprint"] = new_fp
    out["verificationStatus"] = "verified_current"
    out["lastVerified"] = today()

    # First automated check establishes a baseline and preserves manually researched rates.
    if not old_fp:
        return out
    if old_fp == new_fp:
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
        # Never leave an old exact dollar figure visible after the official source changes.
        out["groupPrice"] = "See current official group rate"
        out["rateStatus"] = "Official group page changed — current rate varies or requires confirmation"
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
            "id": city["id"], "name": city["name"],
            "region": "District of Columbia" if city["state"] == "DC" else city["state"],
            "country": "United States", "aliases": [],
        }
        city_index.append(meta)
    if meta:
        meta["venueCount"] = len(records)
        meta["lastVerified"] = today()
        meta.pop("parts", None)


def update_city(city: dict, google_key: str, brave_key: str, city_index: list[dict]) -> int:
    city_meta = next((c for c in city_index if c.get("id") == city["id"]), None)
    existing = load_existing_city(city["id"], city_meta)
    log(f"\n{city['name']}: refreshing {len(existing)} existing records")

    refreshed, seen_names = [], set()
    for record in existing:
        updated = refresh_existing_record(record, brave_key)
        key = slug(updated.get("name", ""))
        if key and key not in seen_names:
            refreshed.append(updated)
            seen_names.add(key)
        time.sleep(0.1)

    if len(refreshed) < 20:
        log(f"{city['name']}: discovering major attractions with Google Places")
        candidates = discover_candidates(google_key, city)
        for place in candidates:
            name = (place.get("displayName") or {}).get("text") or ""
            key = slug(name)
            if not key or key in seen_names:
                continue
            log(f"  checking group program: {name}")
            record = build_new_record(city, place, brave_key)
            if record:
                refreshed.append(record)
                seen_names.add(key)
                log("    accepted")
            else:
                log("    skipped: no verifiable official group program")
            if len(refreshed) >= 20:
                break
            time.sleep(0.15)

    def rank_record(r):
        manual = 1 if str(r.get("id", "")).startswith("curated-") else 0
        ratings = int(r.get("googleUserRatingCount") or 0)
        return (
            1 if r.get("verificationStatus") == "verified_current" else 0,
            manual, math.log10(ratings + 1), float(r.get("confidence") or 0),
        )

    refreshed.sort(key=rank_record, reverse=True)
    write_city(city, refreshed, city_index)
    log(f"{city['name']}: saved {min(20, len(refreshed))} verified/group-capable records")
    return min(20, len(refreshed))


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
    status = {
        "project": "GroupPass verified attraction and group-pricing database",
        "architectureVersion": "3.0-google-places-brave-official-sites",
        "targetCities": len(targets), "targetVenuesPerCity": 20,
        "targetVenueRecords": len(targets) * 20, "completedCities": len(complete),
        "completedCityIds": [c["id"] for c in complete], "completedVenueRecords": total_records,
        "method": (
            "Major attractions are discovered with Google Places and ranked using place prominence signals. "
            "Only venues with an official group-program source are accepted. Brave Search is used only to locate "
            "pages on the venue's official domain. Official pages are rechecked and stale exact prices are removed "
            "when a source changes and a new exact rate cannot be confidently extracted."
        ),
        "lastUpdated": today(),
    }
    save_json(STATUS_FILE, status)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-size", type=int, default=10)
    parser.add_argument("--batch-index", type=int)
    parser.add_argument("--city", action="append", default=[])
    args = parser.parse_args()

    google_key = os.getenv("GOOGLE_PLACES_API_KEY", "").strip()
    brave_key = os.getenv("BRAVE_SEARCH_API_KEY", "").strip()
    if not google_key or not brave_key:
        missing = []
        if not google_key:
            missing.append("GOOGLE_PLACES_API_KEY")
        if not brave_key:
            missing.append("BRAVE_SEARCH_API_KEY")
        raise SystemExit("Missing required GitHub Actions secrets: " + ", ".join(missing))

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
            update_city(city, google_key, brave_key, city_index)
        except Exception as exc:
            log(f"{city['name']}: ERROR: {exc}")

    city_index = [c for c in city_index if int(c.get("venueCount") or 0) > 0]
    city_index.sort(key=lambda c: next((t["rank"] for t in targets if t["id"] == c["id"]), 9999))
    save_json(CITIES_FILE, city_index)
    update_status(targets, city_index)


if __name__ == "__main__":
    main()
