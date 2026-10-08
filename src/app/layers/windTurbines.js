import { createWindTurbinesLayer } from '../../layers/windTurbines/index.js';
/** U.S. wind turbines (USWTDB) through the app server's cached proxy. */
export function createApplicationWindTurbines(options = {}) {
  return createWindTurbinesLayer(options);
}
