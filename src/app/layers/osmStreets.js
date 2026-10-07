import { createOsmStreetsLayer } from '../../layers/osmStreets/index.js';
/** Light OSM streets and building footprints (no Google API use). */
export function createApplicationOsmStreets(options = {}) {
  return createOsmStreetsLayer(options);
}
