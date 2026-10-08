# OMNI Portal (phone app)

The phone side of OSINT OMNI: an Android/iOS app that will be the portal to
your OMNI host from any network. Secure pairing and the encrypted connection
to the host come later; the first tab is **Maps**.

## Maps tab

- **Offline maps.** Every place you look at is kept on the phone (up to the
  browsing budget, 512 MB by default, least recently used dropped first).
  **Download this map area** (the download button) keeps an area to zoom 14,
  pinned until you delete it, along with its mapped cameras. Downloads wait
  for Wi-Fi unless you turn that off.
- **Routes with turn-by-turn.** Search a place (or type `lat, lon`, or
  long-press the map), pick Car, Bike or Walk, and press **Route**. **Start**
  follows your position with the next turn, distance left, a heads-up when a
  mapped camera is within a mile, and an off-route warning with **Reroute**.
- **Avoid cameras.** With *Avoid cameras* on, the app asks for a normal route,
  finds every mapped ALPR camera (Flock and others) within 40 m of it, bans
  those road segments, and asks again until the route is clear. Cameras on the
  start or destination street, or with no way around them, are reported
  instead. The card says how many cameras the direct route passed, how many
  remain, and how much time the detour adds; the direct route stays on the map
  as a dashed line.
- **Routes cached to save cellular data.** Every route is kept. Asking for the
  same trip again (start and end within 200 m, same mode and camera setting)
  reuses it: always when offline, always on cellular with *Cellular saver* on,
  and otherwise for 24 hours. **Save offline** keeps a route until you delete
  it. Camera data is kept for a week. The data counter in the download panel
  shows cellular vs Wi-Fi bytes and how much the cache saved.

## Data sources

| What | Default | Notes |
| --- | --- | --- |
| Basemap | [OpenFreeMap](https://openfreemap.org) vector tiles (OpenStreetMap) | Free, no key, allows offline caching. Google and Apple tiles can't be stored offline under their terms, so they aren't used. |
| Routing | [Valhalla](https://github.com/valhalla/valhalla) public OSM instance | Supports `exclude_locations`, which camera avoidance needs. Fair-use server; point **Router** at your own Valhalla (or the OMNI host later) for heavy use. |
| Place search | Nominatim (OpenStreetMap) | Results are cached on the phone. |
| Cameras | The OpenStreetMap ALPR extract (`surveillance:type=ALPR`, ODbL), same tiles as the desktop ALPR layer | With a host set in the **Host** tab, tiles come through the host's cached `/api/alpr` proxy. |

Avoidance only knows cameras someone has mapped in OpenStreetMap. A route
with no mapped cameras is not proof there are none.

## Run and build

```bash
cd mobile
npm install
npm test          # unit tests (routing, avoidance, caches, tile math)
npm run dev       # browser preview at http://localhost:5180
```

**Android APK:** every push touching `mobile/` runs the *Phone app* workflow,
which uploads `omni-portal-debug-apk` (Actions › the run › Artifacts). Unzip
and install it on the phone (allow installs from your browser or file app).
Locally: `npm run android` opens Android Studio (JDK 21, Android SDK 36).

**iOS:** needs a Mac with Xcode. `npm run ios` opens the project; pick your
team under Signing and run it on a connected iPhone.

## Layout

- `src/lib/` pure logic: `valhalla.js` (router client), `avoid.js` (camera
  avoidance loop), `cameras.js` (camera tiles + week-long cache),
  `tileCache.js` (cache-first map storage with pins and LRU budget),
  `mapStyle.js` (routes every map URL through the cache, plans area
  downloads), `routeCache.js`, `planner.js` (one trip end to end), `nav.js`
  (turn-by-turn progress), `geo.js`, `tiles.js`, `polyline.js`.
- `src/services.js` creates the services once; `src/ui/` only calls them.
- `android/`, `ios/` are the Capacitor native projects.

## Known limits

- Map and route storage is IndexedDB inside the app's web view. The app asks
  for persistent storage, but iOS can still clear it under heavy storage
  pressure. Moving the tile store to native files is a planned follow-up.
- The public Valhalla server caps excludes at 50 per request, so a very long
  trip through a dense camera area may keep some cameras.
- Search and routing need a signal. Offline, kept routes and places searched
  before still work, and `lat, lon` always does.
