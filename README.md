# GroupPass

GroupPass is a static GitHub Pages website built in the same general pattern as TalentX.

- `index.html` contains the page structure.
- `styles.css` and `pricing.css` contain the approved design.
- `core.js`, `discovery.js`, `pricing.js`, and `ui.js` handle the browser application.
- `data/venues/*.json` contains saved city catalogs and source-backed group-rate information.
- `scripts/refresh_catalog.py` searches Overture Places and generates updated static JSON.
- GitHub Actions refreshes the catalog weekly and deploys the website.

No Render service, Node server, database, or application API key is required.

## Publish the website

Open the repository's **Settings → Pages** screen and set **Source** to **GitHub Actions**. Then open **Actions → Deploy GroupPass to GitHub Pages** and run the workflow.

The expected public address is:

`https://junejas1.github.io/GroupPass/`

## Refresh places manually

Open **Actions → Refresh GroupPass venue catalog → Run workflow**. The workflow downloads activity places for the 100-city list, commits the JSON files, and republishes the static website.

Source-backed group prices stay in the city catalog. Automatically discovered venues are included without fabricated prices and are labeled as not yet verified.
