import { catalogControlServices } from './catalog.js';
import { StyleManager } from '../ui/composition.js';
import { flyToAustin } from '../camera.js';
import { initCockpitCloudEffects } from '../cockpitCloudEffects.js';
import { createSiteBoundary } from '../services/siteBoundary.js';
import { createSiteOrbit } from '../services/siteOrbit.js';
import { createSiteContours } from '../services/siteContours.js';
import { createSiteBuildings } from '../services/siteBuildings.js';
import { createLocationResearch } from '../tools/locationResearch.js';
import { createPopoutPanels } from '../ui/popoutPanels.js';
import { openDossier } from '../ui/dossierPanel.js';
import { mountFeaturesCode } from '../ui/featuresCode.js';
import { mountSiteTray } from '../ui/siteTray.js';

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
  // Pop-out panels any feature can request (dossiers today). Building mode
  // turns a click on a building, road or park into a dossier panel.
  const popoutPanels = createPopoutPanels();
  defer(() => popoutPanels.destroy());
  // No crawler yet: the research stub shows the planned searches only.
  const locationResearch = createLocationResearch();
  const siteBuildings = createSiteBuildings(viewer, {
    boundary: siteBoundary,
    contours: siteContours,
    onPick: (record) =>
      openDossier({
        panels: popoutPanels,
        record,
        buildings: siteBuildings,
        research: locationResearch,
      }),
  });
  defer(() => siteBuildings.destroy());
  const site = Object.freeze({
    boundary: siteBoundary,
    orbit: siteOrbit,
    contours: siteContours,
    buildings: siteBuildings,
  });
  defer(() => siteContours.destroy());
  defer(() => siteOrbit.destroy());
  defer(() => siteBoundary.destroy());
  const featuresCode = mountFeaturesCode({
    viewer,
    site,
    // The data manager attaches after controls start; resolve it lazily.
    getDataManager: () => styleManager._dataManager ?? null,
    panels: popoutPanels,
  });
  defer(() => featuresCode.destroy());
  const siteTray = mountSiteTray({
    site,
    panels: popoutPanels,
    onOpenFeaturesCode: () => featuresCode.open(),
  });
  defer(() => siteTray.destroy());
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
    popoutPanels,
  };
}
