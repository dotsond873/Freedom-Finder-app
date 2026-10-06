# Freedom-Finder-app
finished version of freedom finder

## Performance and service limits

The static page uses system serif fonts and loads Leaflet and `app.js` with ordered deferred scripts. Route searches show the fastest route before camera checks and alternatives finish. Unchecked and incomplete results are labeled explicitly, and previously found routes remain visible if a later service fails.

Address requests have a 10-second deadline, routing requests 15 seconds, and each camera-data endpoint 12 seconds. A search has a 60-second overall deadline. Camera matching yields periodically, and route-related camera markers are rendered in batches instead of drawing every camera in the queried area. Status messages occupy a fixed-height, scrollable area to avoid moving the map.

Nominatim requests are sequential and paced at least 1.1 seconds apart within a tab. This does not enforce the public service's application-wide one-request-per-second limit across visitors or tabs. Before increasing traffic, use a geocoding provider with suitable capacity or an appropriately rate-limited shared service. No addresses or location responses are persisted by the application.

Netlify's existing static hosting and caching remain unchanged. No framework, build step, image pipeline, or extra CDN is required for this page.
