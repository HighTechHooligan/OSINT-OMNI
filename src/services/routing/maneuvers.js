import { turnDeg } from './routeGeo.js';

/**
 * Turn-by-turn steps from a path of graph edges. A new step starts where the
 * street changes or the road bends sharply; each step says what to do at its
 * start. Lengths are in the route's units (miles or kilometers), like Valhalla.
 */
const M_PER = { miles: 1609.344, kilometers: 1000 };

const streetOf = (w) => w.name || w.ref || '';
const label = (w) =>
  streetOf(w) ||
  ({
    motorway: 'the highway',
    motorway_link: 'the ramp',
    service: 'the service road',
    residential: 'the road',
  }[w.highway] ??
    'the road');

function turnPhrase(deg) {
  const a = Math.abs(deg);
  const side = deg > 0 ? 'right' : 'left';
  if (a < 20) return 'Continue';
  if (a < 45) return `Bear ${side}`;
  if (a < 135) return `Turn ${side}`;
  if (a < 170) return `Make a sharp ${side}`;
  return 'Make a U-turn';
}

const COMPASS = [
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
];

/**
 * @returns {{coords: number[][], maneuvers: object[], lengthM: number, timeS: number}}
 */
export function buildManeuvers(graph, edges, units = 'miles') {
  const coords = [];
  if (!edges.length) return { coords, maneuvers: [], lengthM: 0, timeS: 0 };
  coords.push(graph.point(graph.from[edges[0]]));
  for (const e of edges) coords.push(graph.point(graph.to[e]));

  const steps = [];
  let current = null;
  let totalM = 0;
  let totalS = 0;
  edges.forEach((e, i) => {
    const way = graph.wayInfo[graph.wayOf[e]];
    const bearing = graph.bearing(e);
    totalM += graph.length[e];
    totalS += graph.time[e];
    if (current) {
      const prevE = edges[i - 1];
      const prevWay = graph.wayInfo[graph.wayOf[prevE]];
      const turn = turnDeg(graph.bearing(prevE), bearing);
      const sameStreet = streetOf(way) && streetOf(way) === streetOf(prevWay);
      const unnamedSame =
        !streetOf(way) && !streetOf(prevWay) && way.highway === prevWay.highway;
      if ((sameStreet || unnamedSame) && Math.abs(turn) < 60) {
        current.lengthM += graph.length[e];
        current.time += graph.time[e];
        current.end = i + 1;
        return;
      }
      current = {
        begin: i,
        end: i + 1,
        lengthM: graph.length[e],
        time: graph.time[e],
        way,
        turn,
      };
      steps.push(current);
      return;
    }
    current = {
      begin: 0,
      end: 1,
      lengthM: graph.length[e],
      time: graph.time[e],
      way,
      turn: null,
      bearing,
    };
    steps.push(current);
  });

  const unitM = M_PER[units] ?? M_PER.miles;
  const maneuvers = steps.map((s, k) => {
    const onto = label(s.way);
    let instruction;
    if (k === 0)
      instruction = `Head ${COMPASS[Math.round(s.bearing / 45) % 8]} on ${onto}.`;
    else {
      const phrase = turnPhrase(s.turn);
      instruction =
        phrase === 'Continue'
          ? `Continue onto ${onto}.`
          : `${phrase} onto ${onto}.`;
    }
    return {
      type: k === 0 ? 1 : 10,
      instruction,
      verbalPre: instruction,
      street: streetOf(s.way),
      length: s.lengthM / unitM,
      time: s.time,
      begin: s.begin,
      end: s.end,
    };
  });
  maneuvers.push({
    type: 4,
    instruction: 'You have arrived at your destination.',
    verbalPre: 'You have arrived at your destination.',
    street: '',
    length: 0,
    time: 0,
    begin: coords.length - 1,
    end: coords.length - 1,
  });
  return { coords, maneuvers, lengthM: totalM, timeS: totalS };
}
