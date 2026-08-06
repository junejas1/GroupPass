#!/usr/bin/env python3
"""Build static GroupPass city venue catalogs from Overture Places.

The generated JSON is committed by GitHub Actions and read directly by app.js.
No application server is required.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
VENUE_DIR = DATA_DIR / "venues"
CENTERS_FILE = DATA_DIR / "city-centers.json"
STATUS_FILE = DATA_DIR / "refresh-status.json"
USER_AGENT = "GroupPassCatalog/1.0 (+https://github.com/junejas1/GroupPass)"

ACTIVITY_TERMS = (
    "museum", "gallery", "aquarium", "zoo", "amusement", "theme park",
    "water park", "bowling", "escape", "trampoline", "climbing", "skating",
    "ice rink", "roller rink", "cinema", "movie theater", "theatre", "theater",
    "botanical", "garden", "golf", "miniature golf", "go kart", "karting",
    "arcade", "laser tag", "sports center", "sports centre", "stadium", "arena",
    "tour", "cruise", "boat", "kayak", "rafting", "paintball", "archery",
    "horse riding", "observatory", "planetarium", "historic site", "landmark",
    "cultural center", "science center", "visitor attraction", "brewery", "winery",
)


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def city_id(city: dict) -> str:
    if city["name"] == "Washington" and city["state"] == "DC":
        return "washington-dc"
    return f"{slug(city['name'])}-{city['state'].lower()}"


def normalize_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def load_json(path: Path, fallback):
    if not path.exists():
        return fallback
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def save_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def geocode_city(city: dict, centers: dict) -> dict:
    cached = centers.get(city["id"])
    if cached and cached.get("lat") is not None and cached.get("lon") is not None:
        return cached

    response = requests.get(
        "https://nominatim.openstreetmap.org/search",
        params={
            "q": city["query"],
            "format": "jsonv2",
            "limit": 1,
            "countrycodes": "us",
        },
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        timeout=25,
    )
    response.raise_for_status()
    rows = response.json()
    if not rows:
        raise RuntimeError("No geocoding result")

    center = {"lat": float(rows[0]["lat"]), "lon": float(rows[0]["lon"])}
    centers[city["id"]] = center
    time.sleep(1.05)
    return center


def flatten_text(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, (int, float)):
        return [str(value)]
    if isinstance(value, list):
        output: list[str] = []
        for item in value:
            output.extend(flatten_text(item))
        return output
    if isinstance(value, dict):
        output: list[str] = []
        for key, item in value.items():
            output.append(str(key))
            output.extend(flatten_text(item))
        return output
    return []


def primary_name(properties: dict) -> str:
    names = properties.get("names") or {}
    if isinstance(names, dict):
        primary = names.get("primary")
        if isinstance(primary, str):
            return primary
        if isinstance(primary, dict):
            name = primary.get("name")
            if isinstance(name, str):
                return name
            for value in primary.values():
                if isinstance(value, str):
                    return value
    return str(properties.get("name") or "")


def category_blob(properties: dict) -> str:
    values: list[str] = []
    values.extend(flatten_text(properties.get("categories")))
    values.extend(flatten_text(properties.get("basic_category")))
    values.extend(flatten_text(properties.get("taxonomy")))
    return " ".join(values).replace("_", " ").lower()


def classify_activity(properties: dict) -> str:
    text = f"{primary_name(properties)} {category_blob(properties)}".lower()
    if re.search(r"museum|gallery|art|science|history|cultural|planetarium|observatory", text):
        return "Museums & art"
    if re.search(r"park|zoo|aquarium|garden|outdoor|cruise|boat|kayak|rafting|trail|nature", text):
        return "Outdoors"
    if re.search(r"sport|stadium|arena|golf|bowling|climbing|skating|archery|paintball|kart", text):
        return "Sports"
    if re.search(r"theatre|theater|cinema|amusement|theme|escape|arcade|laser|trampoline|entertainment", text):
        return "Entertainment"
    return "Attraction"


def is_relevant(properties: dict) -> bool:
    text = f"{primary_name(properties)} {category_blob(properties)}".lower()
    return any(term in text for term in ACTIVITY_TERMS)


def first_website(properties: dict) -> str:
    for key in ("websites", "website"):
        for value in flatten_text(properties.get(key)):
            if value.startswith("https://") or value.startswith("http://"):
                return value
    return ""


def address_text(properties: dict, city: dict) -> str:
    addresses = properties.get("addresses") or []
    if isinstance(addresses, dict):
        addresses = [addresses]
    if addresses and isinstance(addresses[0], dict):
        address = addresses[0]
        freeform = address.get("freeform") or address.get("address") or ""
        locality = address.get("locality") or city["name"]
        region = address.get("region") or city["state"]
        postcode = address.get("postcode") or ""
        return ", ".join(str(value) for value in (freeform, locality, region, postcode) if value)
    return city["label"]


def feature_point(feature: dict) -> tuple[float | None, float | None]:
    geometry = feature.get("geometry") or {}
    coordinates = geometry.get("coordinates") or []
    if geometry.get("type") == "Point" and len(coordinates) >= 2:
        return float(coordinates[1]), float(coordinates[0])
    return None, None


def download_city(city: dict) -> list[dict]:
    lat = float(city["lat"])
    lon = float(city["lon"])
    lat_radius = 0.13
    lon_radius = lat_radius / max(math.cos(math.radians(lat)), 0.35)
    bbox = f"{lon-lon_radius},{lat-lat_radius},{lon+lon_radius},{lat+lat_radius}"

    with tempfile.TemporaryDirectory() as temp_dir:
        output = Path(temp_dir) / "places.geojson"
        command = [
            "overturemaps", "download",
            f"--bbox={bbox}",
            "-f", "geojson",
            "--type=place",
            "-o", str(output),
        ]
        subprocess.run(
            command,
            check=True,
            timeout=600,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        payload = load_json(output, {"features": []})

    venues: list[dict] = []
    for feature in payload.get("features", []):
        properties = feature.get("properties") or {}
        operating_status = str(properties.get("operating_status") or "").lower()
        if operating_status in {"closed", "permanently_closed"} or not is_relevant(properties):
            continue

        name = primary_name(properties).strip()
        venue_lat, venue_lon = feature_point(feature)
        if not name or venue_lat is None or venue_lon is None:
            continue

        confidence = properties.get("confidence")
        try:
            confidence_number = float(confidence or 0)
        except (TypeError, ValueError):
            confidence_number = 0.0

        venues.append({
            "id": f"overture-{city['id']}-{slug(name)}",
            "cityId": city["id"],
            "name": name,
            "category": classify_activity(properties),
            "address": address_text(properties, city),
            "lat": venue_lat,
            "lon": venue_lon,
            "website": first_website(properties),
            "regularSource": "",
            "groupSource": "",
            "regularPrice": "",
            "regularDetails": [],
            "groupPrice": "",
            "groupDetails": [],
            "savings": "",
            "minimum": "",
            "eligibility": "",
            "bookingNotes": [],
            "lastVerified": time.strftime("%Y-%m-%d"),
            "sourceBacked": False,
            "rateStatus": "Venue discovered; group rate not yet verified",
            "confidence": confidence_number,
        })

    venues.sort(key=lambda item: (-item["confidence"], item["name"].lower()))
    seen: set[str] = set()
    deduplicated: list[dict] = []
    for venue in venues:
        key = normalize_name(venue["name"])
        if not key or key in seen:
            continue
        seen.add(key)
        deduplicated.append(venue)
        if len(deduplicated) >= 140:
            break
    return deduplicated


def merge_with_curated(city_identifier: str, discovered: list[dict]) -> list[dict]:
    path = VENUE_DIR / f"{city_identifier}.json"
    existing = load_json(path, [])
    curated = [venue for venue in existing if venue.get("sourceBacked")]
    curated_names = {normalize_name(venue.get("name", "")) for venue in curated}
    return curated + [
        venue for venue in discovered
        if normalize_name(venue.get("name", "")) not in curated_names
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()

    VENUE_DIR.mkdir(parents=True, exist_ok=True)
    raw_cities = load_json(ROOT / "top-100-cities.json", [])[: args.limit]
    cities = []
    for item in raw_cities:
        city = {
            **item,
            "id": city_id(item),
            "label": f"{item['name']}, {item['state']}",
        }
        cities.append(city)

    centers = load_json(CENTERS_FILE, {})
    for city in cities:
        try:
            center = geocode_city(city, centers)
            city.update(center)
            print(f"Geocoded {city['label']}")
        except Exception as error:
            print(f"Geocoding failed for {city['label']}: {error}")
    save_json(CENTERS_FILE, centers)

    ready = [city for city in cities if city.get("lat") is not None and city.get("lon") is not None]
    updated: list[dict] = []
    failures: list[dict] = []

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = {executor.submit(download_city, city): city for city in ready}
        for future in as_completed(futures):
            city = futures[future]
            try:
                discovered = future.result()
                merged = merge_with_curated(city["id"], discovered)
                save_json(VENUE_DIR / f"{city['id']}.json", merged)
                updated.append({"id": city["id"], "count": len(merged)})
                print(f"Updated {city['label']}: {len(merged)} places")
            except Exception as error:
                failures.append({"id": city["id"], "error": str(error)[:500]})
                print(f"Refresh failed for {city['label']}: {error}")

    save_json(STATUS_FILE, {
        "lastRefresh": time.strftime("%Y-%m-%d"),
        "source": "Overture Places plus source-backed group-rate records",
        "citiesAttempted": len(ready),
        "citiesUpdated": len(updated),
        "citiesFailed": len(failures),
        "updated": sorted(updated, key=lambda item: item["id"]),
        "failures": sorted(failures, key=lambda item: item["id"]),
    })

    if not updated:
        raise SystemExit("No city catalogs were updated")


if __name__ == "__main__":
    main()
