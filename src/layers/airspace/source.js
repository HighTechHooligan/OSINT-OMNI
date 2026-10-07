import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { bboxKey } from './records.js';

/** Normalized FAA airspace rows through the bounded, same-origin /api/airspace proxy. */
export function createAirspaceSource({
  base = '/api/airspace',
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function get(path, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(`${base}/${path}`, { signal });
    if (!response.ok) throw new Error(`Airspace HTTP ${response.status}`);
    const payload = await readResponseJsonCapped(
      response,
      64 * 1024 * 1024,
      signal,
    );
    signal?.throwIfAborted();
    if (!Array.isArray(payload?.rows))
      throw new Error('Malformed airspace payload');
    return {
      rows: payload.rows,
      partial: Boolean(payload.partial),
      stale: Boolean(payload.stale),
    };
  }
  return {
    /** National TFR list. */
    getTfrs({ signal } = {}) {
      return get('tfr', signal);
    },
    /** One quantized box of 'class' | 'sua' | 'laanc'. */
    getArea(kind, bbox, { signal } = {}) {
      return get(`${kind}?bbox=${encodeURIComponent(bboxKey(bbox))}`, signal);
    },
  };
}
