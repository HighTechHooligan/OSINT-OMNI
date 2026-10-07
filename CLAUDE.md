# OSINT OMNI (fork of God's Eye View)

Standing rules for this fork:

- **Every feature ships two ways: a GUI control and a Features Code command.**
  Both call the same service (no logic in the UI). The Features Code command
  table (`src/ui/featuresCode.js`) is also the tool surface the future local
  AI agent will call, so keep command names short and stable, and never route
  agent text to the dev-only `js` command.
- Site features live in `src/services/` (`siteBoundary`, `siteOrbit`,
  `siteContours`, pure math in `siteGeometry` / `contourMath`); their GUI is
  the SITE dock popdown (`src/ui/siteTray.js`).
- Theme colors come from `src/ui/styles/foundation.css` accent tokens
  (`--accent`, `--accent-rgb`, `--accent-fade`); do not hardcode accent colors.
- AI-placed GCPs and other agent output are suggestions (hypothesis tier) until
  a person confirms them.

Upstream contributor rules still apply: see CONTRIBUTING.md (format, boundary
checks, `npm test`, `npm run build`, `npm run test:track`).
