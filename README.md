# GroupPass

GroupPass is a plain static GitHub Pages website, structured like TalentX:

- `index.html` contains the page structure.
- `styles.css` contains the design.
- `app.js` loads city and venue JSON files.
- `data/venues/*.json` contains the venue catalog.
- GitHub Actions refreshes venue discovery from Overture Places and republishes the site.

There is no Node server, Render service, database, or API key required for the website itself.

## Publish

In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**. Then open **Actions → Deploy GroupPass to GitHub Pages → Run workflow**.

The public URL will be:

`https://junejas1.github.io/GroupPass/`

## Refresh venue data

The `Refresh GroupPass venue catalog` workflow runs weekly and can also be run manually. It downloads relevant activity places for the 100-city list, saves static JSON files, and triggers a new Pages deployment.

Source-backed group prices are kept separate from automatically discovered places. Discovered venues are not assigned invented prices.
