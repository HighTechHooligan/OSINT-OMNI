import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Network } from '@capacitor/network';
import { Geolocation } from '@capacitor/geolocation';

/** Thin wrappers over Capacitor plugins with browser fallbacks. */
export const isNative = () => Capacitor.isNativePlatform();

let connection = { connected: navigator.onLine, connectionType: 'unknown' };
const listeners = new Set();

export async function startNetworkWatch() {
  try {
    connection = await Network.getStatus();
    Network.addListener('networkStatusChange', (status) => {
      connection = status;
      for (const fn of listeners) fn(status);
    });
  } catch {
    const update = () => {
      const type = navigator.connection?.type;
      connection = {
        connected: navigator.onLine,
        connectionType: !navigator.onLine ? 'none' : type === 'cellular' ? 'cellular' : type === 'wifi' ? 'wifi' : 'unknown',
      };
      for (const fn of listeners) fn(connection);
    };
    update();
    addEventListener('online', update);
    addEventListener('offline', update);
    navigator.connection?.addEventListener?.('change', update);
  }
  return connection;
}

export const getConnection = () => connection;
export const onConnectionChange = (fn) => listeners.add(fn);

/**
 * Fetch raw bytes. On the phone this goes through the native HTTP stack, which
 * isn't bound by browser CORS (the camera extract host doesn't send CORS
 * headers for app origins).
 */
export async function fetchBytes(url) {
  if (!isNative()) {
    const res = await fetch(url);
    return { status: res.status, body: res.ok ? await res.arrayBuffer() : new ArrayBuffer(0) };
  }
  const res = await CapacitorHttp.get({ url, responseType: 'arraybuffer' });
  const data = typeof res.data === 'string' ? base64ToBytes(res.data) : new ArrayBuffer(0);
  return { status: res.status, body: data };
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function currentPosition() {
  if (isNative()) {
    await Geolocation.requestPermissions().catch(() => null);
    const p = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
    return [p.coords.longitude, p.coords.latitude];
  }
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve([p.coords.longitude, p.coords.latitude]),
      reject,
      { enableHighAccuracy: true, timeout: 15000 },
    ),
  );
}

/** Watch position; returns a stop function. Callback gets {lonLat, accuracy, heading}. */
export async function watchPosition(callback) {
  if (isNative()) {
    await Geolocation.requestPermissions().catch(() => null);
    const id = await Geolocation.watchPosition({ enableHighAccuracy: true }, (p) => {
      if (p) callback({ lonLat: [p.coords.longitude, p.coords.latitude], accuracy: p.coords.accuracy, heading: p.coords.heading });
    });
    return () => Geolocation.clearWatch({ id });
  }
  const id = navigator.geolocation.watchPosition(
    (p) => callback({ lonLat: [p.coords.longitude, p.coords.latitude], accuracy: p.coords.accuracy, heading: p.coords.heading }),
    () => {},
    { enableHighAccuracy: true },
  );
  return () => navigator.geolocation.clearWatch(id);
}
