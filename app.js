if (!window.L) {
  document.getElementById("status").textContent = "The map couldn't load. Refresh to try again.";
  document.getElementById("status").className = "err";
  throw new Error("Map library unavailable.");
}

// ---------------------------------------------------------------------------
// <pure> — no DOM or network; unit-tested separately
// ---------------------------------------------------------------------------

// Valhalla returns route shapes as a polyline with 6 decimal places of precision.
function decodePolyline(str, precision) {
  const factor = Math.pow(10, precision);
  let index = 0, lat = 0, lng = 0;
  const out = [];
  while (index < str.length) {
    let shift = 0, result = 0, byte;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    out.push([lat / factor, lng / factor]);
  }
  return out;
}

function bboxOf(shape) {
  let s = 90, n = -90, w = 180, e = -180;
  for (const [lat, lon] of shape) {
    if (lat < s) s = lat;
    if (lat > n) n = lat;
    if (lon < w) w = lon;
    if (lon > e) e = lon;
  }
  return { s, n, w, e };
}

function makeProjector(lat0) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180);
  const ky = 110540;
  return (lat, lon) => [lon * kx, lat * ky];
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
}

// Cameras within maxM meters of the route, ordered by where they appear along it.
async function camerasNear(shape, camList, maxM, signal) {
  if (shape.length < 2) return [];
  const proj = makeProjector(shape[0][0]);
  const pts = shape.map(p => proj(p[0], p[1]));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const res = [];
  let comparisons = 0;
  for (const c of camList) {
    const [px, py] = proj(c.lat, c.lon);
    if (px < minX - maxM || px > maxX + maxM || py < minY - maxM || py > maxY + maxM) continue;
    let best = Infinity, bi = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      if (++comparisons % 2048 === 0) await wait(0, signal);
      const d = distToSegment(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (d < best) { best = d; bi = i; }
    }
    if (best <= maxM) res.push({ cam: c, idx: bi });
  }
  res.sort((a, b) => a.idx - b.idx);
  return res.map(r => r.cam);
}

function metersBetween(lat1, lon1, lat2, lon2) {
  const proj = makeProjector((lat1 + lat2) / 2);
  const [x1, y1] = proj(lat1, lon1);
  const [x2, y2] = proj(lat2, lon2);
  return Math.sqrt((x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2));
}

function fmtTime(min) {
  const m = Math.round(min);
  if (m < 60) return m + " min";
  return Math.floor(m / 60) + " h " + (m % 60) + " min";
}
// </pure>

// ---------------------------------------------------------------------------
// Config — all free public services. Fine for a prototype; a real launch with
// many users will need its own routing/Overpass servers (see notes).
// ---------------------------------------------------------------------------
const VALHALLA = "https://valhalla1.openstreetmap.de/route";
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
const NOMINATIM = "https://nominatim.openstreetmap.org/search";

const NEAR_M = 25;          // a camera "counts" if it's within this many meters of the route
const MAX_EXCLUDES = 50;    // public Valhalla server cap on avoided points
const MAX_PASSES = 4;       // reroute attempts
const ENDPOINT_SKIP_M = 120; // can't avoid cameras right at the start/end points
const BBOX_PAD = 0.01;      // ~1 km padding when loading cameras
const MAX_SPAN_DEG = 3;     // keep camera queries reasonably small

// ---------------------------------------------------------------------------
// State + map
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);
const map = L.map("map", { preferCanvas: true, zoomControl: false }).setView([39.5, -98.35], 4);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap contributors · Cameras: DeFlock/OSM community · Routing: Valhalla"
}).addTo(map);

let camMap = new Map();   // id -> {id, lat, lon, tags}
let loadedBox = null;
let myLoc = null;
let nextGeocodeAt = 0;
let displayedResult = null;
let layers = [];
let routes = {};          // { fast: {line, info}, priv: {line, info} }

function setStatus(msg, isErr) {
  const el = $("status");
  el.textContent = msg || "";
  el.className = isErr ? "err" : "";
}

function clearResults() {
  layers.forEach(l => map.removeLayer(l));
  layers = [];
  routes = {};
  displayedResult = null;
  $("card").hidden = true;
  $("card").innerHTML = "";
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------
function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchJSON(url, options, timeout, signal, message) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) throw signal.reason;
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(message)), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(message);
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw new Error(message);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function geocode(q, signal) {
  await wait(Math.max(0, nextGeocodeAt - Date.now()), signal);
  nextGeocodeAt = Date.now() + 1100;
  const url = NOMINATIM + "?format=json&limit=1&countrycodes=us&q=" + encodeURIComponent(q);
  const j = await fetchJSON(url, {}, 10000, signal, "Address search is busy or timed out — try again.");
  if (!j.length) throw new Error('Couldn\'t find "' + q + '". Try adding the city and state.');
  return { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon) };
}

async function resolvePoint(id, signal) {
  const q = $(id).value.trim();
  if (!q) throw new Error("Enter both a start and a destination.");
  if (id === "from" && q === "My location" && myLoc) return myLoc;
  return geocode(q, signal);
}

async function valhallaRoute(from, to, excludes, signal) {
  const body = {
    locations: [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }],
    costing: "auto",
    directions_options: { units: "miles" }
  };
  if (excludes.length) {
    body.exclude_locations = excludes.map(c => ({ lat: c.lat, lon: c.lon }));
  }
  const j = await fetchJSON(VALHALLA + "?json=" + encodeURIComponent(JSON.stringify(body)),
    {}, 15000, signal, "The routing server is busy or timed out — try again.");
  if (j.error) throw new Error(j.error);
  const leg = j.trip.legs[0];
  return {
    shape: decodePolyline(leg.shape, 6),
    miles: j.trip.summary.length,
    minutes: j.trip.summary.time / 60
  };
}

async function overpassCameras(b, signal) {
  const q = '[out:json][timeout:10];node["man_made"="surveillance"]["surveillance:type"="ALPR"](' +
    b.s + "," + b.w + "," + b.n + "," + b.e + ");out body;";
  let lastErr;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      const j = await fetchJSON(ep, { method: "POST", body: new URLSearchParams({ data: q }) },
        12000, signal, "Camera data service is busy or timed out.");
      return (j.elements || []).map(e => ({ id: e.id, lat: e.lat, lon: e.lon, tags: e.tags || {} }));
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      lastErr = e;
    }
  }
  throw new Error("Camera data service is busy — try again in a minute. (" + lastErr.message + ")");
}

// Make sure camera data covers the whole route; reload a bigger box if it doesn't.
async function ensureCameras(shape, signal) {
  const b = bboxOf(shape);
  if (loadedBox && b.s >= loadedBox.s && b.n <= loadedBox.n && b.w >= loadedBox.w && b.e <= loadedBox.e) return;
  const nb = loadedBox
    ? { s: Math.min(b.s, loadedBox.s) - BBOX_PAD, n: Math.max(b.n, loadedBox.n) + BBOX_PAD,
        w: Math.min(b.w, loadedBox.w) - BBOX_PAD, e: Math.max(b.e, loadedBox.e) + BBOX_PAD }
    : { s: b.s - BBOX_PAD, n: b.n + BBOX_PAD, w: b.w - BBOX_PAD, e: b.e + BBOX_PAD };
  if (nb.n - nb.s > MAX_SPAN_DEG || nb.e - nb.w > MAX_SPAN_DEG) {
    throw new Error("This prototype handles trips up to roughly 150 miles. Try a shorter one.");
  }
  const cams = await overpassCameras(nb, signal);
  camMap = new Map(cams.map(c => [c.id, c]));
  loadedBox = nb;
}

// ---------------------------------------------------------------------------
// Core: fastest route, then iteratively route around known cameras
// ---------------------------------------------------------------------------
async function findRoutes(from, to, signal) {
  setStatus("Finding the fastest route…");
  const fast = await valhallaRoute(from, to, [], signal);
  await drawResults({ fast: { route: fast, cams: null }, priv: null,
    pending: "Checking known cameras — this route is not checked yet." }, signal);

  setStatus("Loading known camera locations…");
  await ensureCameras(fast.shape, signal);
  const fastCams = await camerasNear(fast.shape, [...camMap.values()], NEAR_M, signal);
  await drawResults({ fast: { route: fast, cams: fastCams }, priv: null,
    pending: fastCams.length ? "Camera check complete — looking for a quieter route…" : null }, signal);

  let best = null;
  if (fastCams.length > 0) {
    const excl = new Map();
    let current = { route: fast, cams: fastCams };
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let added = 0;
      for (const c of current.cams) {
        if (excl.has(c.id) || excl.size >= MAX_EXCLUDES) continue;
        if (metersBetween(c.lat, c.lon, from.lat, from.lon) < ENDPOINT_SKIP_M) continue;
        if (metersBetween(c.lat, c.lon, to.lat, to.lon) < ENDPOINT_SKIP_M) continue;
        excl.set(c.id, c);
        added++;
      }
      if (!added) break;
      setStatus("Searching for a quieter route (try " + (pass + 1) + " of " + MAX_PASSES + ")…");
      let r;
      try {
        r = await valhallaRoute(from, to, [...excl.values()], signal);
      } catch (e) {
        if (signal.aborted) throw signal.reason;
        return { fast: { route: fast, cams: fastCams }, priv: best,
          pending: "Alternative search unavailable — showing checked routes only." };
      }
      await ensureCameras(r.shape, signal);
      const cams = await camerasNear(r.shape, [...camMap.values()], NEAR_M, signal);
      const cand = { route: r, cams };
      if (!best || cams.length < best.cams.length ||
          (cams.length === best.cams.length && r.minutes < best.route.minutes)) best = cand;
      current = cand;
      await drawResults({ fast: { route: fast, cams: fastCams }, priv: best,
        pending: "Checking alternatives — showing the best checked routes so far." }, signal);
      if (cams.length === 0) break;
    }
  }
  return { fast: { route: fast, cams: fastCams }, priv: best };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

async function drawResults(res, signal) {
  signal?.throwIfAborted();
  const previousResult = displayedResult;
  clearResults();
  displayedResult = res;
  const privIds = new Set(res.priv ? res.priv.cams.map(c => c.id) : []);

  const fastLine = L.polyline(res.fast.route.shape, { color: "#c2503f", weight: 5, opacity: 0.9 }).addTo(map);
  layers.push(fastLine);
  routes.fast = { line: fastLine, info: res.fast };

  let group = [fastLine];
  if (res.priv && res.priv.cams.length < res.fast.cams.length) {
    const privLine = L.polyline(res.priv.route.shape, { color: "#4a8fd6", weight: 5, opacity: 0.95 }).addTo(map);
    layers.push(privLine);
    routes.priv = { line: privLine, info: res.priv };
    group.push(privLine);
  }
  if (!previousResult || previousResult.priv?.route !== res.priv?.route) {
    map.fitBounds(L.featureGroup(group).getBounds(), { padding: [30, 30], animate: false });
  }
  renderCard(res);
  selectRoute(routes.priv ? "priv" : "fast");

  const cameras = new Map([...(res.fast.cams || []), ...(res.priv?.cams || [])].map(camera => [camera.id, camera]));
  let rendered = 0;
  for (const camera of cameras.values()) {
    if (rendered++ % 50 === 0) await wait(0, signal);
    const onPriv = privIds.has(camera.id);
    const marker = L.circleMarker([camera.lat, camera.lon], {
      radius: 6,
      color: "#ece1c4",
      weight: 1.5,
      fillColor: onPriv ? "#c79a4b" : "#c2503f",
      fillOpacity: 0.95
    });
    const label = camera.tags.operator || camera.tags.brand || "ALPR camera";
    const direction = camera.tags.direction || camera.tags["camera:direction"];
    marker.bindPopup("<b>" + esc(label) + "</b>" + (direction ? "<br>Facing: " + esc(direction) + "°" : "") +
      '<br><a href="https://www.openstreetmap.org/node/' + camera.id + '" target="_blank" rel="noopener">View on OpenStreetMap</a>');
    marker.addTo(map);
    layers.push(marker);
  }
  for (const route of Object.values(routes)) route.line.bringToFront();
}

function selectRoute(which) {
  for (const k of Object.keys(routes)) {
    const on = k === which;
    routes[k].line.setStyle({ weight: on ? 7 : 4, opacity: on ? 1 : 0.5 });
    if (on) routes[k].line.bringToFront();
  }
  document.querySelectorAll(".rt").forEach(el => el.classList.toggle("sel", el.dataset.r === which));
}

function plural(n) { return n + (n === 1 ? " camera" : " cameras"); }

function renderCard(res) {
  const f = res.fast;
  let html = rtRow("fast", "#c2503f", "Fastest route", f.route, f.cams?.length ?? null);
  let note;
  if (routes.priv) {
    const p = res.priv;
    html += rtRow("priv", "#4a8fd6", "Freedom route", p.route, p.cams.length);
    const dm = Math.round(p.route.minutes - f.route.minutes);
    note = "Avoids " + (f.cams.length - p.cams.length) + " of " + f.cams.length +
      " known cameras" + (dm > 0 ? " · +" + dm + " min" : "");
  } else if (f.cams?.length === 0) {
    note = "No known cameras on your fastest route.";
  } else {
    note = "No quieter route found — the fastest route is your best option here.";
  }
  html += '<p class="note">' + esc(res.pending || note) + '</p>';
  html += '<p class="fine">Known cameras only; map coverage varies by area. Drive safely and follow traffic laws.</p>';
  const card = $("card");
  card.innerHTML = html;
  card.hidden = false;
  card.querySelectorAll(".rt").forEach(el => el.addEventListener("click", () => selectRoute(el.dataset.r)));
}

function rtRow(key, color, title, route, nCams) {
  return '<div class="rt" data-r="' + key + '"><i style="background:' + color + '"></i>' +
    "<div><b>" + title + "</b><span>" + fmtTime(route.minutes) + " · " + route.miles.toFixed(1) + " mi</span></div>" +
    "<em>" + (nCams === null ? "Not checked" : plural(nCams)) + "</em></div>";
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
async function run() {
  if ($("go").disabled) return;
  clearResults();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("Search timed out — showing any routes already found. Try again.")), 60000);
  for (const id of ["go", "from", "to", "loc"]) $(id).disabled = true;
  try {
    if (!$("from").value.trim() || !$("to").value.trim()) throw new Error("Enter both a start and a destination.");
    setStatus("Looking up addresses…");
    const a = await resolvePoint("from", controller.signal);
    const b = await resolvePoint("to", controller.signal);
    const res = await findRoutes(a, b, controller.signal);
    await drawResults(res, controller.signal);
    setStatus("");
  } catch (e) {
    if (displayedResult) {
      renderCard({ ...displayedResult, pending: "Search incomplete — camera checks or alternatives may be unfinished." });
      selectRoute(routes.priv ? "priv" : "fast");
    }
    setStatus(e.message || "Something went wrong.", true);
  } finally {
    clearTimeout(deadline);
    for (const id of ["go", "from", "to", "loc"]) $(id).disabled = false;
  }
}

$("go").addEventListener("click", run);
["from", "to"].forEach(id => $(id).addEventListener("keydown", e => { if (e.key === "Enter") run(); }));

$("loc").addEventListener("click", () => {
  if (!navigator.geolocation) { setStatus("Location isn't available on this device.", true); return; }
  setStatus("Getting your location…");
  navigator.geolocation.getCurrentPosition(
    pos => {
      if ($("go").disabled) return;
      myLoc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      $("from").value = "My location";
      setStatus("");
    },
    () => { if (!$("go").disabled) setStatus("Couldn't get your location. Type an address instead.", true); },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

$("go").disabled = false;
