# Phone remote (OMNI Phone)

A phone on the same Wi-Fi drives OSINT OMNI running on a computer. The phone
is the remote: it asks questions and sends commands. The computer does the
work: it runs the tools against its own `/api` data routes, keeps their answers
in a short cache, and runs commands in the open desktop app.

```
phone (/phone/)  ──token──>  computer server (/remote/api/*)  ──>  tools + 60 s cache
                                     │
                                     └─ command queue ──long-poll──> desktop app (Features Code)
```

## Try it

1. Start the server so other devices can reach it:
   `HOST=0.0.0.0 npm run dev` (or `npm run build && HOST=0.0.0.0 npm run preview`).
2. Open the app on the computer at `http://localhost:4173`.
3. Press **PHONE** in the dock, then **Pair a phone**. It shows a six-digit
   code and the address to open on the phone, e.g. `http://192.168.1.20:4173/phone/`.
   (Features Code: `phone pair`.)
4. On the phone, open that address, type the code and a name. Add it to the
   home screen if you like; it opens full screen.

## What the phone has

- **Job**: type a site (place name, or `lat, lon`) and a radius, then
  **Check this site**. It runs the drone-job checks at once: weather, 10 m
  wind, aircraft nearby, military installations, ground elevation (with
  coordinates) and active fires. **Show on computer** flies the desktop globe
  there (`goto`, the same search as the LOCATION bar).
- **Computer**: buttons for the site features (Hyland preset, zoom, orbit,
  contours, canopy, elevation datum, OSM streets), **See the screen** (a JPEG
  of the desktop globe), and a box for any Features Code command.
- **Tools**: every tool the computer offers, run with JSON arguments.
- **Settings**: text size and high contrast, for readability testing.

Each answer card shows whether it came fresh or from the computer's cache, a
readable summary, a **Details** table, and **Easy to read / Hard to read**
buttons. Ratings (with an optional note, the screen and the text size) are
appended to `.gev-cache/phone-feedback.jsonl` on the computer for the test
write-up.

## Security model

- Pairing codes are made only from the computer itself (the `/remote/desk/*`
  routes use the same loopback gate as `/mcp`). A code lasts five minutes,
  works once, and is burned after five wrong guesses.
- A paired phone holds a random 256-bit bearer token; the server keeps only
  its SHA-256. Tokens live in memory, so restarting the server unpairs every
  phone. Revoke one from PHONE or with `phone revoke <id|all>`.
- Phones can never run `js` or `phone` commands, or start a boundary drawing;
  both the server and the desktop app refuse them.
- The whole phone remote is off while Pinokio sharing is on.
- The LAN traffic is plain HTTP unless the server runs with TLS
  (`npm run dev:secure`). Use it on a network you trust.

## For the future AI host

The phone API is a thin, authenticated door onto the same tool catalog `/mcp`
serves (`src/tools`) plus the Features Code command table. A self-hosted AI
host can reuse the pairing and token scheme to reach a running app the same
way.

Code: `server/remote/` (hub, HTTP plugin, phone app), `src/services/phoneLink.js`
(desktop bridge), `src/ui/phoneTray.js` (PHONE dock popdown). Tests:
`src/tools/phoneRemote.test.mjs`, `src/services/phoneLink.test.mjs`.
