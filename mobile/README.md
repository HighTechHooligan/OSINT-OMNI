# OMNI Portal (phone app)

The phone side of OSINT OMNI: an Android/iOS app that is the portal to your
OMNI host. Four tabs: **Maps**, **Routes**, **Computer** and **Host**.

The **Host** tab pairs the phone with the desktop using the six-digit code
from PHONE › Pair a phone (the phone-remote server, `npm run dev:lan`). On the
same Wi-Fi, use the address PHONE shows. Away from home, put the phone and
the computer on a private network such as [Tailscale](https://tailscale.com)
and pair with the computer's `100.x` address (or its `*.ts.net` name). The
tailnet encrypts the traffic. The app's own encrypted connection for the open
internet comes later; until then the app allows plain http so it can reach
the desktop's LAN or tailnet address, and it warns before pairing with a
plain-http address on the open internet.

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
- **Avoid cameras, computed on the phone.** With *Avoid cameras* on, the app
  plans the route itself on OpenStreetMap roads (A* in a worker) and counts a
  road as watched only where a mapped camera can actually read the plate
  (assumptions below). It first minimises the number of cameras that read
  you, then travel time. Roads are loaded in a corridor around the usual
  route; if a camera is still on the best route, the corridor widens once.
  The card says "No mapped camera reads your plate on this route" (and how
  many the usual route passes), or, only when there is truly no way round, that
  the destination or start is a **dead end** past N cameras. The usual route
  stays on the map as a dashed line. There is **no distance limit**.
- **Routes cached to save cellular data.** Every route is kept. Asking for the
  same trip again (start and end within 200 m, same mode and camera setting)
  reuses it: always when offline, always on cellular with *Cellular saver* on,
  and otherwise for 24 hours. Road data is kept for 30 days and camera data
  for a week. The data counter in the download panel shows cellular vs Wi-Fi
  bytes and how much the cache saved.

### My location (set by hand)

Long-press the map and pick **Set my location here**, or type a place or
`lat, lon` under **My location** at the top of the download panel. While a
location is set, every feature (routing from "My location", turn-by-turn,
the locate button, the Computer tab's **Radio at my spot**) uses it and the
app never asks the GPS, so it works with location permission denied and your
real position never leaves the phone. **Use GPS** goes back. Turn-by-turn
does not move on its own while a location is set.

### Camera assumptions

- **Read range: 40 m.** ALPR cameras such as Flock read plates reliably to
  about 30 m (roughly 100 ft); 10 m is added for where the camera is mapped
  in OpenStreetMap versus where it really stands.
- **Field of view: ±30°** around the camera's mapped `direction`. A camera
  with no mapped direction is treated as seeing all round.
- **Rear plates always, front plates too by default.** A camera reads the
  rear plate of a car driving away from it; with *Front plates* on (default,
  for states that require them) it also counts cars driving towards it.

Range and front plates can be changed in the download panel's settings.

## Routes tab

Every route you plan and every route you save, in one list. Saved routes are
kept forever with the map along them, so they work with no signal. Search,
sort (newest or by name), **Open** on the map, **Rename**, **Refresh**
(re-plan with fresh roads and cameras), **Reverse**, and **Delete** (which
also frees the stored map). Recent trips keep the last 30.

## Computer tab

Drives the desktop app through the host, with everything the desktop's
Features Code can do: a command line with history, quick buttons (screen
snapshot, help, zoom, orbit, contours, canopy, OSM streets, routes, presets),
a live screen that refreshes every 5 seconds, and every tool the host offers
(the same catalog as `/mcp`) with a form built from its inputs. Phones cannot
run the desktop's developer-only `js` command.

## Data sources

| What | Default | Notes |
| --- | --- | --- |
| Basemap | [OpenFreeMap](https://openfreemap.org) vector tiles (OpenStreetMap) | Free, no key, allows offline caching. Google and Apple tiles can't be stored offline under their terms, so they aren't used. |
| Roads for the camera-aware router | Overpass API (OpenStreetMap) | Through the host's cached `/api/overpass` proxy when the host has an upstream configured (`OVERPASS_UPSTREAMS`), else the public Overpass API (changeable under **Road data** in the download panel settings). |
| Usual route and plain routing | [Valhalla](https://github.com/valhalla/valhalla) public OSM instance | Used for the dashed "usual route" and when avoidance is off. |
| Place search | Nominatim (OpenStreetMap) | Results are cached on the phone. |
| Cameras | The OpenStreetMap ALPR extract (`surveillance:type=ALPR`, ODbL), same tiles as the desktop ALPR layer | With a host set, tiles come through the host's cached `/api/alpr` proxy. |

Avoidance only knows cameras someone has mapped in OpenStreetMap. A route
with no mapped cameras is not proof there are none.

## Run and build

```bash
cd mobile
npm install
npm test          # unit tests (routing, saved routes, caches, host link)
npm run dev       # browser preview at http://localhost:5180
```

**Android APK:** every push touching `mobile/` runs the *Phone app* workflow,
which uploads `omni-portal-debug-apk` (Actions › the run › Artifacts). Unzip
and install it on the phone (allow installs from your browser or file app).
Locally: `npm run android` opens Android Studio (JDK 21, Android SDK 36).

**iOS:** needs a Mac with Xcode. `npm run ios` opens the project; pick your
team under Signing and run it on a connected iPhone.

## Layout

- The router is shared with the desktop's ROUTES panel:
  `../src/services/routing/` (`cameraView.js` camera view cones,
  `roadGraph.js` + `pathSearch.js` the A* search, `cameraAwareRoute.js` the
  corridor plan, `roadSource.js` cached Overpass road tiles, `solveWorker.js`).
- `src/lib/` phone logic: `planner.js` (one trip end to end),
  `savedRoutes.js`, `cameras.js` (camera tiles + week-long cache),
  `tileCache.js` (cache-first map storage with pins and LRU budget),
  `mapStyle.js` (routes every map URL through the cache, plans area and
  route-corridor downloads), `hostLink.js` (pairing, commands, tools),
  `valhalla.js`, `routeCache.js`, `nav.js`, `geo.js`, `tiles.js`.
- `src/services.js` creates the services once; `src/ui/` only calls them.
- `android/`, `ios/` are the Capacitor native projects.

## Known limits

- Map and route storage is IndexedDB inside the app's web view. The app asks
  for persistent storage, but iOS can still clear it under heavy storage
  pressure. Moving the tile store to native files is a planned follow-up.
- A very long first trip downloads a lot of road data (one Overpass request
  per road tile; the corridor around a 300 km trip is a few hundred). It is
  cached afterwards, and the host's Overpass proxy caches it for every device.
- Search and routing need a signal the first time. Offline, kept routes,
  roads and places searched before still work, and `lat, lon` always does.
