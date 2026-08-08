# GroupPass verified catalog updater

GroupPass keeps the public site static. The website reads committed JSON from `data/venues/`; no search API key is exposed to visitors.

## What the updater does

1. Searches the current web for attraction-specific results in a rotating set of U.S. cities.
2. Excludes review sites, directories, social networks, travel-booking sites, and similar aggregators from the database source list.
3. Treats search results only as transient discovery signals. Search-result snippets are not written to the GroupPass database.
4. Fetches the attraction's own website.
5. Accepts a new venue only when an official venue-domain page confirms a real group program such as group tickets, group admission, group visits, group sales, or field trips.
6. Reads regular admission, group admission, minimum group size, and important booking restrictions when those details are confidently identifiable on the official page.
7. Saves the official source URL and a fingerprint of the official group page.
8. On later runs, checks the official page again. If the page changes and a new exact price cannot be verified, GroupPass removes the old exact price instead of continuing to present it as current.

The browser also has a second safety layer: an exact dollar rate older than 14 days is hidden and replaced with a recheck message until the source has been checked again.

## Why Google Places is not the stored database source

Google Places is useful for live lookup, but its current caching policy generally does not permit permanently storing most Places content in a separate catalog. GroupPass therefore does not persist Google Places ratings, addresses, websites, or search results. The database is built from facts verified on the attractions' own official sites.

## One required secret

The updater needs a Brave Search API key for transient web discovery. Add it to GitHub as a repository Actions secret named exactly:

`BRAVE_SEARCH_API_KEY`

Repository path:

**Settings → Secrets and variables → Actions → New repository secret**

The public website never receives this secret.

## Running it

Open **Actions → Refresh verified GroupPass catalog → Run workflow**.

- Leave City blank to process a rotating batch.
- Enter a city such as `Dallas` or `dallas-tx` to refresh only that city.
- The scheduled workflow runs a 10-city rotating batch automatically.

## Data rules

- No group program found on an official venue site → do not add the venue.
- Fixed published group price → store the exact published rate.
- Dynamic/date-based price → store a non-exact current-rate message and link the official source.
- Quote required → label it as a current official group program requiring confirmation.
- Source cannot be rechecked → mark the record as needing recheck and do not continue showing an old exact price as current.
- Official source changes → compare the source fingerprint and refresh the stored fields.

The existing manually researched records remain the trusted seed database and are rechecked by the same verifier.
