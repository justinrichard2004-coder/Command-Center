# Command Center Lite

A free, always-on version of the Command Center. GitHub Actions rebuilds the data every 30 minutes, and GitHub Pages serves the dashboard. It runs even when the Mac is off.

- **Spike Radar:** each topic in `watchlist.json` gets its share of world news (GDELT) and its Wikipedia views/day, last 2 days vs the 30-day median, plus the latest headlines.
- **World news:** BBC, Al Jazeera, France 24, DW and NPR.
- **Markets:** indexes, VIX, 10-year yield, oil, gold, silver and crypto (Yahoo Finance, delayed).
- **Earth:** USGS earthquakes M4.5+ and NASA EONET natural hazards.

**Install on your phone:** open the site in Safari, tap Share, then "Add to Home Screen".
**Change topics:** edit `watchlist.json` on github.com. The site rebuilds automatically.
**Refresh now:** Actions → "Refresh dashboard data" → Run workflow.
