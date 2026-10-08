import { catalogControlServices } from './catalog.js';
import { StyleManager } from '../ui/composition.js';
import { flyToAustin } from '../camera.js';
import { initCockpitCloudEffects } from '../cockpitCloudEffects.js';
import { createSiteBoundary } from '../services/siteBoundary.js';
import { createSiteOrbit } from '../services/siteOrbit.js';
import { createSiteContours } from '../services/siteContours.js';
import { createSiteRoutes } from '../services/siteRoutes.js';
import { geocodeKeyless } from '../keylessGeocoder.js';
import { mountFeaturesCode } from '../ui/featuresCode.js';
import { mountSiteTray } from '../ui/siteTray.js';
import { mountRoutesTray } from '../ui/routesTray.js';

/** Construct the existing controls and camera presentation. */
export function createApplicationControls({
  scene: { viewer, mapStackController, operations },
  loaderStatus,
  Controls = StyleManager,
  services,
  catalog,
  placeSearch,
  defer,
}) {
  // Initialize the style manager (post-processing, HUD, locations, share links)
  const styleManager = new Controls(viewer, {
    services: {
      ...services,
      ...operations.surface.controlServices,
      searchAndFlyTo: operations.searchAndFlyTo,
      fetchRegionalBrief: (...args) =>
        operations.requests.regional.getBrief(...args),
      ...catalogControlServices(catalog),
    },
    requestServices: operations.requests,
    mapStackController,
    placeSearch,
  });
  defer(() => styleManager.orbitController.stop());
  defer(() => styleManager.hud.destroy());
  defer(() => styleManager.dispose());
  // Site features (boundary, contours, canopy, orbit). Every feature has a
  // GUI (SITE dock popdown) and a Features Code command; both call these
  // same services, and a future local agent will call them as tools.
  const siteBoundary = createSiteBoundary(viewer);
  const siteOrbit = createSiteOrbit(viewer, {
    boundary: siteBoundary,
    beforeCameraControl: () => styleManager.orbitController?.stop(),
  });
  const siteContours = createSiteContours(viewer, { boundary: siteBoundary });
  // Camera-aware routes (ROUTES dock popdown + Features Code `route`).
  const siteRoutes = createSiteRoutes(viewer, {
    geocode: (query) => geocodeKeyless(query),
  });
  const site = Object.freeze({
    boundary: siteBoundary,
    orbit: siteOrbit,
    contours: siteContours,
    routes: siteRoutes,
  });
  defer(() => siteRoutes.destroy());
  defer(() => siteContours.destroy());
  defer(() => siteOrbit.destroy());
  defer(() => siteBoundary.destroy());
  const featuresCode = mountFeaturesCode({
    viewer,
    site,
    // The data manager attaches after controls start; resolve it lazily.
    getDataManager: () => styleManager._dataManager ?? null,
  });
  defer(() => featuresCode.destroy());
  const siteTray = mountSiteTray({
    site,
    onOpenFeaturesCode: () => featuresCode.open(),
  });
  defer(() => siteTray.destroy());
  const routesTray = mountRoutesTray({
    routes: siteRoutes,
    onOpenFeaturesCode: () => featuresCode.open(),
  });
  defer(() => routesTray.destroy());
  // The previous multi-canvas weather compositor remains disabled. Cockpit
  // clouds use a separate, capped low-resolution GPU pass that never attaches
  // Cesium fog or post-process stages and is fully stopped in map mode.
  const weatherEffects = null;
  const cockpitCloudEffects = initCockpitCloudEffects(viewer, {
    weatherService: operations.requests.weather,
  });
  defer(() => cockpitCloudEffects?.destroy());

  // If no share link state, do default fly-to Austin
  if (!styleManager.hasShareState) {
    loaderStatus.textContent = 'Flying to Austin, TX...';
    defer(flyToAustin(viewer));
  } else {
    loaderStatus.textContent = 'Restoring shared view...';
  }

  return {
    styleManager,
    weatherEffects,
    cockpitCloudEffects,
    site,
    featuresCode,
    siteTray,
    routesTray,
  };
}
