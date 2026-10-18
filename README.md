# What's On Today

One page showing today's swimming and skating sessions from the City of Whitehorse booking site, plus the Polarettes open-gym drop-in schedule.

`scrape.mjs` fetches the sources and writes a static `dist/index.html`. A GitHub Action runs it every hour and publishes the result to GitHub Pages. You can't scrape from the browser because PerfectMind doesn't send CORS headers.

## Run locally

```sh
node scrape.mjs        # Node 20+, no dependencies
open dist/index.html
```

## Deploy

1. Push to a public GitHub repo on `main`.
2. Go to **Settings → Pages → Source** and pick **GitHub Actions**.
3. The workflow runs on every push, every hour, and on demand from the Actions tab.

GitHub turns off scheduled workflows in a repo after 60 days without commits. It emails you first, and you can turn it back on from the Actions tab.
