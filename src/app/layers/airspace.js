import * as Cesium from 'cesium';
import { createAirspaceLayer } from '../../layers/airspace/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  FAA_AIRSPACE_CREDIT,
  registerDynamicCredit,
} from '../../data/dataCredits.js';

/** Wire FAA airspace (TFR, class, SUA, LAANC grid) into the application catalog. */
export function createApplicationAirspace(options = {}) {
  return createAirspaceLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    registerCredit: (viewer) =>
      registerDynamicCredit(viewer, FAA_AIRSPACE_CREDIT),
    ...options,
  });
}
