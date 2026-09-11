/**
 * Procedural tasking generator for Aus Emergency Dispatcher.
 *
 * Builds a queue of realistic Australian aviation jobs based on:
 *   - the user's live position in the sim (jobs are placed on a bearing/distance
 *     from there, within a band that suits the operation)
 *   - the class of aircraft they're flying (rotary vs fixed wing) — each op is
 *     tagged with the classes that would realistically run it
 *   - the console profile (civil "emergency" agencies vs "military")
 *
 * Text is templated with a small seeded RNG so a generated queue is stable until
 * the operator asks for new calls, but every call varies.
 */

export type Priority = 'P1' | 'P2' | 'P3';
export type AircraftClass = 'rotary' | 'fixed';
export type Profile = 'emergency' | 'military';

export type Hospital = { name: string; lat: number; lon: number };
export type Airport = { ident: string; lat: number; lon: number; altFt: number };

export type Call = {
  id: string;
  lat: number;
  lon: number;
  kind: string;
  category: string;
  place: string;
  latLon: string;
  sector: string;
  brief: string;
  detail: string;
  source: string;
  informant: string;
  hazards: string;
  persons: string;
  access: string;
  lz: string;
  units: string[];
  nearestAsset: string;
  weather: string;
  priority: Priority;
  bearing: number;
  distanceNm: number;
  receivedOffsetSec: number;
  /** medivac jobs: after "on scene", the crew transports the patient here */
  transportTo?: Hospital;
  /** RAAFv tasking: the aircraft, squadron and base the job was written for */
  tasked?: {
    type: string;
    squadron: string;
    registration?: string;
    /** where the sortie launches from — not necessarily the squadron's home */
    homeBase: string;
    /** the squadron is deployed there rather than based there */
    detachment?: boolean;
    source: 'crew-centre' | 'roster';
  };
};

// --- seeded RNG ----------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const pick = <T>(r: Rng, arr: readonly T[]): T => arr[Math.floor(r() * arr.length) % arr.length]!;
const range = (r: Rng, lo: number, hi: number) => lo + r() * (hi - lo);
const int = (r: Rng, lo: number, hi: number) => Math.floor(range(r, lo, hi + 1));
const chance = (r: Rng, p: number) => r() < p;

// --- geo --------------------------------------------------------------------

const R_NM = 3440.065;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (brg: number) => COMPASS[Math.round(brg / 22.5) % 16]!;

/** Point `distNm` on `bearingDeg` from (lat,lon). */
function project(lat: number, lon: number, distNm: number, bearingDeg: number): { lat: number; lon: number } {
  const d = distNm / R_NM;
  const brg = toRad(bearingDeg);
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
  const lon2 =
    lon1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: toDeg(lat2), lon: ((toDeg(lon2) + 540) % 360) - 180 };
}

function dmsString(lat: number, lon: number): string {
  const fmt = (v: number, pos: string, neg: string) => {
    const hemi = v >= 0 ? pos : neg;
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = (a - d) * 60;
    return `${d}°${m.toFixed(1)}'${hemi}`;
  };
  return `${fmt(lat, 'N', 'S')} ${fmt(lon, 'E', 'W')}`;
}

// --- agencies --------------------------------------------------------------

type Agency = { name: string; callsign: string; base: string };

const AGENCIES: Record<string, Agency> = {
  av: { name: 'Ambulance Victoria', callsign: 'HEMS', base: 'Essendon Fields' },
  nswa: { name: 'NSW Ambulance', callsign: 'Rescue', base: 'the regional rescue base' },
  lifeflight: { name: 'LifeFlight', callsign: 'Rescue', base: 'the LifeFlight base' },
  racq: { name: 'RACQ LifeFlight Rescue', callsign: 'Rescue', base: 'the RACQ Rescue base' },
  westpac: { name: 'Westpac Life Saver Rescue', callsign: 'Lifesaver', base: 'the Westpac base' },
  careflight: { name: 'CareFlight', callsign: 'CareFlight', base: 'the CareFlight base' },
  sarescue: { name: 'SA Ambulance MedSTAR', callsign: 'MedSTAR', base: 'Adelaide' },
  racwa: { name: 'RAC Rescue (WA)', callsign: 'Rescue', base: 'the RAC Rescue base' },
  ntcf: { name: 'CareFlight NT', callsign: 'CareFlight', base: 'Darwin' },
  rfds: { name: 'Royal Flying Doctor Service', callsign: 'Flying Doctor', base: 'the RFDS base' },
  polair: { name: 'Police Aviation', callsign: 'PolAir', base: 'the police air wing' },
  rfs: { name: 'NSW RFS Aviation', callsign: 'Firebird', base: 'the aviation staging area' },
  cfa: { name: 'CFA / FRV Aircraft', callsign: 'Firebird', base: 'the air base' },
  naffc: { name: 'National Aerial Firefighting', callsign: 'Bomber', base: 'the air tanker base' },
  amsa: { name: 'AMSA / JRCC Australia', callsign: 'Rescue', base: 'the SAR forward base' },
  abf: { name: 'Australian Border Force', callsign: 'Border', base: 'the surveillance base' },
  mrnsw: { name: 'Marine Rescue', callsign: 'Marine Rescue', base: 'the marine base' },
  ses: { name: 'State Emergency Service', callsign: 'SES Air', base: 'the SES staging area' },
  parks: { name: 'National Parks / DBCA', callsign: 'Ranger', base: 'the ranger station' },
  survey: { name: 'Aerial Survey Operations', callsign: 'Survey', base: 'the aerial work base' },
  // military
  raaf: { name: 'Royal Australian Air Force', callsign: 'Aussie', base: 'RAAF Base' },
  army: { name: 'Australian Army Aviation', callsign: 'Angel', base: 'the Army Aviation FOB' },
  navy: { name: 'RAN Fleet Air Arm', callsign: 'Tiger', base: 'HMAS Albatross' },
  jrcc: { name: 'JRCC Australia', callsign: 'Rescue', base: 'the JRCC forward base' },
};

// --- operation templates -------------------------------------------------

type OpTemplate = {
  id: string;
  kind: string;
  category: string;
  classes: AircraftClass[];
  agencies: string[];
  distNm: [number, number];
  /** weighted priority: fraction P1 / P2 (rest P3) */
  p1: number;
  p2: number;
  transport?: boolean; // medivac leg to a hospital
  offshore?: boolean;
  /** the aircraft has to land at the job site — for fixed wing, only at a real airfield */
  needsRunway?: boolean;
  settings: string[];
  brief: (c: Ctx) => string;
  detail: (c: Ctx) => string;
  hazards: string[];
  persons: string[];
  access: string[];
  lz: string[];
};

type Ctx = {
  r: Rng;
  agency: Agency;
  setting: string;
  distNm: number;
  bearing: number;
  town: string;
};

const TOWNS = [
  'Bathurst', 'Wagga', 'Dubbo', 'Orange', 'Tamworth', 'Bega', 'Cooma', 'Sale', 'Shepparton',
  'Mildura', 'Warrnambool', 'Horsham', 'Roma', 'Emerald', 'Charleville', 'Longreach', 'Mount Isa',
  'Broken Hill', 'Port Augusta', 'Kalgoorlie', 'Geraldton', 'Katherine', 'Karratha',
];

const ROTARY_SETTINGS = [
  'the highway corridor', 'a cattle station homestead', 'the range escarpment', 'a coastal reserve',
  'a state forest fire trail', 'a vineyard access track', 'a river red gum floodplain', 'a quarry haul road',
  'a rural showground', 'a national park walking track', 'a beach access ramp', 'a mine site ROM pad',
];
const FIXED_SETTINGS = [
  'a station airstrip', 'a regional aerodrome', 'a remote community airstrip', 'a mine aerodrome',
  'an offshore search datum', 'a coastal surveillance box', 'a fire ground sector', 'a pipeline easement',
  'a survey grid', 'an inter-hospital route',
];

const wx = (r: Rng) => {
  const dir = int(r, 0, 35) * 10 || 360;
  const spd = int(r, 4, 28);
  const gust = chance(r, 0.3) ? ` G${spd + int(r, 6, 15)}` : '';
  const vis = pick(r, ['10 km', '10 km', '8 km', '6 km HZ', '30 km', '4000 m']);
  const cloud = pick(r, ['FEW030', 'SCT025', 'BKN012', 'SCT040', 'BKN008', 'CAVOK']);
  const qnh = int(r, 1004, 1027);
  return `Wind ${String(dir).padStart(3, '0')}/${spd}${gust} kt · Vis ${vis} · ${cloud} · QNH ${qnh}`;
};

const CIVIL_OPS: OpTemplate[] = [
  {
    id: 'mva-entrapment',
    kind: 'MVA with entrapment',
    category: 'HEMS / trauma',
    classes: ['rotary'],
    agencies: ['av', 'nswa', 'lifeflight', 'racq', 'westpac', 'careflight', 'sarescue', 'racwa'],
    distNm: [8, 45],
    p1: 0.9,
    p2: 0.1,
    transport: true,
    settings: ROTARY_SETTINGS,
    brief: (c) =>
      `Vehicle vs ${pick(c.r, ['truck', 'tree', 'guard rail', 'second vehicle'])}, one trapped. ${
        pick(c.r, ['CFA', 'FRNSW', 'QFES', 'DFES'])
      } effecting extrication. HLS on ${c.setting}.`,
    detail: (c) =>
      `Road crash on ${c.setting} ~${c.distNm.toFixed(0)} NM ${compass(c.bearing)} of your position. One patient trapped with ` +
      `${pick(c.r, ['suspected chest and pelvic injuries', 'head and limb injuries', 'crush injuries to the lower limbs'])}; ` +
      `road ambulance MICA/ICP on scene requesting rapid air transport to ${c.town}. Fire service cutting the vehicle. ` +
      `Traffic management in place. Nearest suitable HLS is the road carriageway, marked by a fire appliance.`,
    hazards: ['Live traffic, fuel spill, powerlines nearby', 'Unstable vehicle, sharp metal, crowd', 'Wet carriageway, poor lighting'],
    persons: ['1 trapped (critical), 1 walking wounded', '1 critical, 2 minor', '1 trapped (serious)'],
    access: ['Road carriageway; ground crews via the nearest on-ramp', 'Farm gate then 800 m gravel track'],
    lz: ['Closed carriageway ~200 m, marked by appliance — powerlines to one side', 'Adjacent paddock, stock cleared, slight slope'],
  },
  {
    id: 'remote-retrieval',
    kind: 'Medical retrieval',
    category: 'Aeromedical',
    classes: ['rotary'],
    agencies: ['nswa', 'lifeflight', 'racq', 'careflight', 'sarescue', 'racwa', 'ntcf'],
    distNm: [15, 70],
    p1: 0.7,
    p2: 0.3,
    transport: true,
    settings: ROTARY_SETTINGS,
    brief: (c) =>
      `${pick(c.r, ['Fall from height', 'Machinery entanglement', 'Cardiac event', 'Horse fall', 'Snake bite'])} on a ` +
      `remote property. Single patient, road ambulance ${int(c.r, 25, 55)} min away by road.`,
    detail: (c) =>
      `A worker has ${pick(c.r, ['fallen from a hay shed', 'been struck by machinery', 'collapsed with chest pain', 'been thrown from a horse'])} ` +
      `on a property ${c.distNm.toFixed(0)} NM ${compass(c.bearing)}. Conscious and breathing, ${pick(c.r, ['back and leg pain', 'query internal injuries', 'reduced GCS'])}. ` +
      `Property owner can mark a paddock and move stock. Nearest road crew is well delayed; retrieval requested for transport to ${c.town}.`,
    hazards: ['Uneven terrain, livestock, single-wire earth-return powerline', 'Dust, loose debris, farm dogs', 'Poor phone coverage'],
    persons: ['1 patient, ~3 bystanders', '1 patient, 1 first-aider'],
    access: ['Property gate off the main road, then 4WD track', 'Homestead airstrip 1.5 km from the scene'],
    lz: ['Home paddock beside the shed, owner to mark with a vehicle', 'Cleared stubble, marked with tape'],
  },
  {
    id: 'interhospital-heli',
    kind: 'Inter-hospital transfer',
    category: 'Critical care transfer',
    classes: ['rotary'],
    agencies: ['av', 'nswa', 'lifeflight', 'racq', 'careflight', 'sarescue'],
    distNm: [20, 90],
    p1: 0.5,
    p2: 0.5,
    transport: true,
    settings: ['a regional hospital HLS', 'a district hospital rooftop pad', 'a base hospital HLS'],
    brief: (c) => `Time-critical ICU patient at ${c.town} hospital for transfer to a tertiary centre. Retrieval team on board.`,
    detail: (c) =>
      `${c.town} Health Service requests urgent transfer of a ventilated patient (${pick(c.r, ['STEMI for cath lab', 'severe TBI for neurosurgery', 'obstetric haemorrhage', 'paediatric sepsis'])}) ` +
      `to a tertiary hospital ~${c.distNm.toFixed(0)} NM ${compass(c.bearing)}. Receiving unit has a bed. Plan for a hot on-load and a pad-to-pad run.`,
    hazards: ['Confined rooftop pad, surrounding structures', 'Wires on the approach, tight HLS', 'Night pad, limited lighting'],
    persons: ['1 ventilated patient + retrieval team of 2'],
    access: ['Hospital HLS, escorted airside by hospital staff'],
    lz: ['Marked hospital HLS', 'Sports oval adjacent to the hospital, ambulance shuttle'],
  },
  {
    id: 'surf-cliff-rescue',
    kind: 'Coastal / cliff rescue',
    category: 'Rescue / winch',
    classes: ['rotary'],
    agencies: ['westpac', 'nswa', 'lifeflight', 'careflight', 'racwa', 'mrnsw'],
    distNm: [6, 40],
    p1: 0.8,
    p2: 0.2,
    transport: true,
    settings: ['coastal cliffs', 'a headland walking track', 'a surf beach', 'rock platforms below the escarpment'],
    brief: (c) => `${pick(c.r, ['Fallen climber', 'Injured rock fisher', 'Cut-off bushwalkers', 'Surfer, suspected spinal'])} on ${c.setting}. Winch job.`,
    detail: (c) =>
      `Report of ${pick(c.r, ['a person who has fallen ~10 m onto rock platforms', 'walkers cut off by the tide', 'a swimmer pulled from the surf, not moving'])} ` +
      `on ${c.setting} ${c.distNm.toFixed(0)} NM ${compass(c.bearing)}. Police Rescue and SLS on the cliff top. No vehicle access to the casualty; ` +
      `winch recovery required, then transport to ${c.town}.`,
    hazards: ['Cliff edge, loose rock, swell and spray', 'Rising tide, slippery platforms', 'Turbulence off the headland'],
    persons: ['1 casualty (serious), rescuers on scene', '2 casualties, cold and exhausted'],
    access: ['No ground access to the casualty — winch only', 'Cliff-top car park for the land party'],
    lz: ['Winch to the casualty, transfer on the cliff-top reserve', 'Beach at low tide, firm sand'],
  },
  {
    id: 'police-search',
    kind: 'Search / offender containment',
    category: 'Police aviation',
    classes: ['rotary'],
    agencies: ['polair'],
    distNm: [4, 35],
    p1: 0.4,
    p2: 0.5,
    settings: ['a suburban perimeter', 'bushland behind an industrial estate', 'a rail corridor', 'a rural block'],
    brief: (c) => `${pick(c.r, ['Armed offenders fled a vehicle stop', 'High-risk missing person', 'Break-and-enter offenders on foot', 'Pursuit terminated'])} near ${c.setting}. Provide airborne observation.`,
    detail: (c) =>
      `Ground units request PolAir for ${pick(c.r, ['a containment of offenders who ran from a stolen vehicle', 'an urgent search for a missing person with medical concerns', 'overwatch of a premises pending a warrant'])} ` +
      `around ${c.setting}, ${c.distNm.toFixed(0)} NM ${compass(c.bearing)}. Dog unit and general duties establishing a cordon. Relay movement and coordinate the cordon; downlink if available.`,
    hazards: ['Powerlines, towers, other aircraft', 'Built-up area, noise abatement', 'Offenders possibly armed'],
    persons: ['N/A — observation and coordination', 'Missing person: adult, last seen on foot'],
    access: ['N/A — airborne task', 'Staging at the local police station car park'],
    lz: ['Recovery to base', 'Sports ground for a hot refuel if required'],
  },
  {
    id: 'marine-rescue',
    kind: 'Marine rescue',
    category: 'Marine / SAR',
    classes: ['rotary', 'fixed'],
    agencies: ['westpac', 'mrnsw', 'amsa', 'nswa', 'racq'],
    distNm: [8, 90],
    p1: 0.7,
    p2: 0.3,
    offshore: true,
    transport: true,
    settings: ['the harbour approaches', 'open water off the coast', 'a reef passage', 'the bay'],
    brief: (c) => `${pick(c.r, ['Vessel disabled, POB aboard', 'Person overboard reported', 'Yacht aground and taking water', 'EPIRB activation'])} ${c.distNm.toFixed(0)} NM offshore.`,
    detail: (c) =>
      `${pick(c.r, ['A 6 m runabout with engine failure', 'A yacht that has run onto rocks', 'A vessel reporting a person overboard'])} ` +
      `${c.distNm.toFixed(0)} NM ${compass(c.bearing)} of your position. ${AGENCIES.mrnsw.name} launching by sea. ` +
      `Aircraft requested for overwatch, to mark the position and be ready to winch a casualty to ${c.town}.`,
    hazards: ['Swell, spray, salt on the windscreen', 'Rocks close aboard, other vessels', 'Reducing light, cold water'],
    persons: ['3 POB, lifejackets worn', '2 POB, one injured', '1 person in the water'],
    access: ['N/A — overwater', 'N/A — overwater winch'],
    lz: ['N/A — overwater', 'Boat ramp reserve for a casualty transfer'],
  },
  {
    id: 'fire-recon-heli',
    kind: 'Fire reconnaissance / crew insertion',
    category: 'Firefighting support',
    classes: ['rotary'],
    agencies: ['rfs', 'cfa', 'parks'],
    distNm: [10, 60],
    p1: 0.3,
    p2: 0.5,
    settings: ['the fire ground', 'a containment line', 'a ridge above the fire', 'a plantation edge'],
    brief: (c) => `${pick(c.r, ['Insert a remote area crew to a ridge', 'Line-scan the northern flank', 'Air attack supervision over a new start', 'Assess spot fires ahead of the head'])} on ${c.setting}.`,
    detail: (c) =>
      `Incident control requests a helicopter for ${pick(c.r, ['winching a remote area firefighting crew onto a ridge to hold a break', 'an intelligence run over the active flank with a line-scanner', 'air attack supervision coordinating bombers on a new ignition'])} ` +
      `${c.distNm.toFixed(0)} NM ${compass(c.bearing)}. Expect smoke, reduced visibility and other aircraft on the fire ground frequency.`,
    hazards: ['Dense smoke, poor visibility, other firebombing aircraft, terrain', 'Turbulence and downdrafts near the fire', 'Spot fires, ember attack'],
    persons: ['Remote area crew of 4 + equipment', 'N/A — supervision and intelligence'],
    access: ['N/A — winch / hover exit', 'Staging area on the containment line'],
    lz: ['Ridge-top hover exit, marked by the crew', 'Cleared paddock at the staging area'],
  },
  {
    id: 'flood-storm',
    kind: 'Flood / storm rescue',
    category: 'Rescue',
    classes: ['rotary'],
    agencies: ['ses', 'westpac', 'nswa', 'polair', 'careflight'],
    distNm: [5, 45],
    p1: 0.6,
    p2: 0.4,
    settings: ['a cut-off rural road', 'a low-lying township', 'a caravan park by the river', 'a flooded causeway'],
    brief: (c) => `${pick(c.r, ['People on a car roof in floodwater', 'Residents isolated by rising water', 'Storm damage assessment', 'Person clinging to a tree in the current'])} at ${c.setting}.`,
    detail: (c) =>
      `Rising water has ${pick(c.r, ['stranded a vehicle on a causeway with people on the roof', 'isolated several properties with medical needs', 'brought trees down across a township'])} ` +
      `${c.distNm.toFixed(0)} NM ${compass(c.bearing)}. SES flood rescue tasked by boat but access is limited; aircraft requested for winch rescue and an aerial damage assessment.`,
    hazards: ['Fast-moving water, submerged debris and fences, powerlines', 'Debris in the air, unstable trees', 'Rapidly changing conditions'],
    persons: ['3 on a vehicle roof', 'Multiple isolated residents', '1 in the water'],
    access: ['No safe ground access — boat or air only', 'Higher ground on the town side'],
    lz: ['Sports oval on high ground', 'Road on the levee bank'],
  },
  {
    id: 'rfds-primary',
    kind: 'RFDS primary evacuation',
    category: 'Aeromedical (fixed wing)',
    classes: ['fixed'],
    agencies: ['rfds'],
    distNm: [40, 240],
    p1: 0.7,
    p2: 0.3,
    transport: true,
    needsRunway: true,
    settings: FIXED_SETTINGS,
    brief: (c) => `Primary evacuation from ${c.town} district — ${pick(c.r, ['acute abdomen', 'chest pain', 'obstetric emergency', 'serious farm injury', 'paediatric respiratory'])}. Strip lit on request.`,
    detail: (c) =>
      `A patient at ${pick(c.r, ['a cattle station', 'a remote community clinic', 'a mine site medical centre', 'a roadhouse'])} ` +
      `${c.distNm.toFixed(0)} NM ${compass(c.bearing)} requires evacuation to ${c.town} Base Hospital. Local strip is ${pick(c.r, ['gravel, 1200 m, edge lighting on request', 'red dirt, 1400 m, no lighting — plan a day arrival', 'sealed, 1600 m, PAL on frequency'])}. ` +
      `Nurse or clinic staff will meet the aircraft. Fuel is ${pick(c.r, ['available', 'not available — tanker to the destination'])}.`,
    hazards: ['Kangaroos and stock on the strip, no lighting, remote', 'Dust on landing, crosswind', 'Long duty, single strip, weather at the destination'],
    persons: ['1 patient + escort', '1 patient (serious)'],
    access: ['Station strip, road transfer to the clinic', 'Community airstrip beside the clinic'],
    lz: ['Unsealed strip — inspect on a low pass', 'Sealed regional strip'],
  },
  {
    id: 'rfds-transfer',
    kind: 'Inter-hospital transfer (fixed wing)',
    category: 'Critical care transfer',
    classes: ['fixed'],
    agencies: ['rfds', 'av', 'nswa'],
    distNm: [60, 300],
    p1: 0.5,
    p2: 0.5,
    transport: true,
    needsRunway: true,
    settings: ['a regional aerodrome', 'a base hospital airport', 'a coastal regional airport'],
    brief: (c) => `Non-urgent to urgent transfer between ${c.town} and a tertiary centre. Retrieval team and stretcher fit.`,
    detail: (c) =>
      `Bed-to-bed transfer of a ${pick(c.r, ['stable ICU', 'cardiac', 'stroke for thrombectomy', 'burns'])} patient from ${c.town} to a tertiary hospital ` +
      `~${c.distNm.toFixed(0)} NM ${compass(c.bearing)}. Road ambulance both ends. Runway and lighting standard; plan an IFR arrival.`,
    hazards: ['Weather en route, icing in cloud', 'Night arrival, minima at the destination', 'Long tasking'],
    persons: ['1 patient + retrieval team + escort'],
    access: ['Regional airport, ambulance airside', 'Terminal apron, ambulance escort'],
    lz: ['Sealed runway', 'Regional airport, RPT traffic'],
  },
  {
    id: 'sar-fixed',
    kind: 'Search and rescue',
    category: 'SAR',
    classes: ['fixed', 'rotary'],
    agencies: ['amsa', 'jrcc', 'westpac', 'polair'],
    distNm: [30, 260],
    p1: 0.7,
    p2: 0.3,
    offshore: true,
    settings: ['a search datum', 'the last known position', 'an expanding-square pattern', 'a coastal track datum'],
    brief: (c) => `${pick(c.r, ['Overdue vessel', 'ELT / EPIRB activation', 'Overdue aircraft', 'Overdue bushwalker'])} — proceed to the datum and run a search.`,
    detail: (c) =>
      `${pick(c.r, ['A registered EPIRB has activated', 'A vessel is overdue on passage', 'An aircraft has failed to close its flight plan'])} ` +
      `${c.distNm.toFixed(0)} NM ${compass(c.bearing)} of your position. ${AGENCIES.jrcc.name} is coordinating. Tasking is to reach the datum, ` +
      `run a ${pick(c.r, ['creeping line', 'expanding square', 'track line'])} search, report sightings and remain on scene as on-scene coordinator until relieved.`,
    hazards: ['Sea state and swell, reducing light, night recovery likely', 'Terrain and smoke, other search aircraft', 'Fatigue on a long pattern'],
    persons: ['2 POB reported', '1 missing person', 'Unknown — 4 SOB'],
    access: ['N/A — search area', 'N/A — overwater'],
    lz: ['Recovery to a coastal aerodrome', 'Recovery to base'],
  },
  {
    id: 'firescan-fixed',
    kind: 'Fire mapping / air attack',
    category: 'Firefighting (fixed wing)',
    classes: ['fixed'],
    agencies: ['naffc', 'rfs', 'cfa', 'survey'],
    distNm: [20, 180],
    p1: 0.2,
    p2: 0.5,
    settings: ['a going fire', 'a lightning-strike area', 'a fire complex', 'a total fire ban district'],
    brief: (c) => `${pick(c.r, ['Line-scan the fire complex and downlink imagery', 'Bird-dog for the air tankers', 'Retardant line on the eastern flank', 'Recon new lightning starts'])}.`,
    detail: (c) =>
      `State air desk requests ${pick(c.r, ['a line-scanning run over the fire complex with imagery to the IMT by a set time', 'lead-plane / air attack supervision for a retardant campaign', 'a reconnaissance sortie for new starts after a dry lightning event'])} ` +
      `${c.distNm.toFixed(0)} NM ${compass(c.bearing)}. Expect heavy traffic on the fire ground and smoke to several thousand feet.`,
    hazards: ['Smoke, poor visibility, mountainous terrain, multiple aircraft', 'Turbulence, density altitude', 'Congested frequency'],
    persons: ['N/A — mapping / supervision'],
    access: ['N/A — task area', 'Air base for reload'],
    lz: ['Recovery to the air tanker base', 'Recovery to the nearest suitable aerodrome'],
  },
  {
    id: 'coastal-patrol',
    kind: 'Maritime surveillance patrol',
    category: 'Border / fisheries',
    classes: ['fixed'],
    agencies: ['abf', 'amsa'],
    distNm: [40, 320],
    p1: 0.1,
    p2: 0.4,
    offshore: true,
    settings: ['a surveillance box', 'the fisheries management area', 'the northern approaches', 'a shipping lane'],
    brief: (c) => `Patrol the assigned surveillance box — ${pick(c.r, ['report foreign fishing activity', 'check a contact of interest', 'pollution / oil sheen survey', 'vessel monitoring'])}.`,
    detail: (c) =>
      `Tasked to patrol a surveillance box ${c.distNm.toFixed(0)} NM ${compass(c.bearing)} of your position and ` +
      `${pick(c.r, ['photograph and report any foreign fishing vessels', 'investigate a radar contact passed by the coordination centre', 'survey a reported oil sheen and estimate its extent'])}. ` +
      `Log all contacts with position, course and speed. Remain outside 500 ft of vessels unless directed.`,
    hazards: ['Low-level over water, birds, fatigue', 'Weather building offshore', 'Long transit, single-engine considerations'],
    persons: ['N/A — surveillance'],
    access: ['N/A — patrol area'],
    lz: ['Recovery to the surveillance base'],
  },
  {
    id: 'aerial-survey',
    kind: 'Aerial survey / observation',
    category: 'Aerial work',
    classes: ['fixed', 'rotary'],
    agencies: ['survey', 'parks', 'polair'],
    distNm: [15, 160],
    p1: 0.05,
    p2: 0.35,
    settings: ['a survey grid', 'a powerline easement', 'a pipeline route', 'a catchment', 'a wildlife count transect'],
    brief: (c) => `${pick(c.r, ['Fly the survey grid at height', 'Powerline condition inspection', 'Pipeline patrol', 'Aerial wildlife count', 'Photo run for the mapping agency'])} over ${c.setting}.`,
    detail: (c) =>
      `Client requests ${pick(c.r, ['a photographic survey grid flown at a set height and line spacing', 'a low-level powerline inspection with an observer', 'a pipeline integrity patrol', 'an aerial count of feral animals along transects'])} ` +
      `${c.distNm.toFixed(0)} NM ${compass(c.bearing)}. Weather must be suitable for the required imagery/observation. No landing at the site.`,
    hazards: ['Low-level, wires, towers, terrain', 'Turbulence and thermals, sun angle', 'Other traffic in the training area'],
    persons: ['N/A — survey + observer'],
    access: ['N/A — task area'],
    lz: ['Recovery to the aerial work base'],
  },
];

const MIL_OPS: OpTemplate[] = [
  {
    id: 'qra-intercept',
    kind: 'QRA intercept',
    category: 'Air defence',
    classes: ['fixed'],
    agencies: ['raaf'],
    distNm: [60, 260],
    p1: 0.9,
    p2: 0.1,
    settings: ['a warning area', 'the air defence identification zone', 'a coastal track', 'an oceanic sector'],
    brief: (c) => `Unresponsive contact, ${pick(c.r, ['FL280', 'FL340', 'low level'])}. Identify, shadow and report intentions.`,
    detail: (c) =>
      `Air defence holds an unresponsive contact ${c.distNm.toFixed(0)} NM ${compass(c.bearing)} of your position with no flight plan and no radio. ` +
      `QRA to intercept, visually identify, establish a shadow and pass a running commentary. ROE: identification and shadow only pending higher authority.`,
    hazards: ['Unknown intentions, civil traffic in the block, weather', 'High closure speed, fuel state', 'Radio congestion'],
    persons: ['N/A'],
    access: ['N/A — airborne intercept'],
    lz: ['Recovery to the fighter base'],
  },
  {
    id: 'army-medevac',
    kind: 'MEDEVAC (Army)',
    category: 'Casualty evacuation',
    classes: ['rotary'],
    agencies: ['army'],
    distNm: [10, 80],
    p1: 0.9,
    p2: 0.1,
    transport: true,
    settings: ['a field training area', 'a live-fire range', 'a bivouac site', 'a vehicle harbour'],
    brief: (c) => `${pick(c.r, ['Training injury', 'Vehicle rollover', 'Heat casualty', 'Gunshot wound (range accident)'])} at ${c.setting}. Priority 1, litter.`,
    detail: (c) =>
      `A ${pick(c.r, ['soldier with a lower-limb fracture from a vehicle rollover', 'heat casualty with a reduced conscious state', 'range accident casualty with a penetrating injury'])} ` +
      `at ${c.setting} ${c.distNm.toFixed(0)} NM ${compass(c.bearing)}. Ground call sign has marked an HLS with smoke and will pass a 9-liner. ` +
      `Transport to the field hospital / civilian ED at ${c.town}.`,
    hazards: ['Range activity — confirm check fire, dust, wires', 'Uneven ground at the HLS', 'Night, limited lighting'],
    persons: ['1 litter urgent, 1 ambulatory', '1 litter (priority 1)'],
    access: ['Ground call sign secures and marks the HLS', 'Vehicle track to the HLS'],
    lz: ['Field HLS, smoke marked, wind called by the ground party', 'Cleared area, one-ship'],
  },
  {
    id: 'mil-sar',
    kind: 'Search and rescue (military)',
    category: 'SAR',
    classes: ['rotary', 'fixed'],
    agencies: ['navy', 'raaf', 'jrcc'],
    distNm: [30, 220],
    p1: 0.8,
    p2: 0.2,
    offshore: true,
    transport: true,
    settings: ['a datum passed by JRCC', 'a man-overboard position', 'a ditching datum', 'an EPIRB position'],
    brief: (c) => `${pick(c.r, ['Man overboard from a warship', 'Ditched aircraft', 'Civilian vessel in distress'])} — proceed to the datum, search and recover.`,
    detail: (c) =>
      `${pick(c.r, ['A sailor is missing overboard', 'An aircraft is believed to have ditched', 'A civilian yacht is taking water with injured aboard'])} ` +
      `${c.distNm.toFixed(0)} NM ${compass(c.bearing)}. Tasked as SAR asset under JRCC coordination: reach the datum, run the pattern, ` +
      `recover survivors by winch and transfer to ${c.town} or the ship's flight deck.`,
    hazards: ['Sea state, spray, night winching, fuel state', 'Deck motion if recovering to a ship', 'Cold water survival time'],
    persons: ['1 in the water', '2 survivors, injuries unknown', 'Up to 4 SOB'],
    access: ['N/A — overwater winch'],
    lz: ["Ship's flight deck or nearest coastal aerodrome"],
  },
  {
    id: 'isr-recon',
    kind: 'Reconnaissance / ISR',
    category: 'ISR',
    classes: ['fixed', 'rotary'],
    agencies: ['raaf', 'army'],
    distNm: [20, 200],
    p1: 0.2,
    p2: 0.5,
    settings: ['a task box', 'a named area of interest', 'a route of advance', 'a disaster-affected district'],
    brief: (c) => `${pick(c.r, ['Imagery run over the task box', 'Route recon ahead of a convoy', 'Post-event damage imagery for the emergency operations centre', 'Pattern-of-life over the NAI'])}.`,
    detail: (c) =>
      `Tasked to provide ${pick(c.r, ['a photographic run over the task box with imagery to the headquarters by a set time', 'a route reconnaissance identifying obstacles and choke points', 'aerial imagery of flood/fire damage for the state control centre'])} ` +
      `${c.distNm.toFixed(0)} NM ${compass(c.bearing)}. Deconflict with other aircraft and civil traffic; remain at the assigned block.`,
    hazards: ['Terrain, wires at low level, other aircraft', 'Weather and smoke haze', 'Congested airspace near the event'],
    persons: ['N/A — imagery / observation'],
    access: ['N/A — task area'],
    lz: ['Recovery to base or a forward arming and refuelling point'],
  },
  {
    id: 'airlift-resupply',
    kind: 'Airlift / resupply',
    category: 'Air mobility',
    classes: ['fixed', 'rotary'],
    agencies: ['raaf', 'army'],
    distNm: [40, 300],
    p1: 0.2,
    p2: 0.5,
    needsRunway: true,
    settings: ['a forward operating base', 'a cut-off community', 'an island station', 'a field location'],
    brief: (c) => `Move ${pick(c.r, ['priority freight and two passengers', 'emergency stores to an isolated community', 'a team and equipment forward'])} to ${c.setting}.`,
    detail: (c) =>
      `Air mobility tasking: carry ${pick(c.r, ['1.2 t of freight and two passengers', 'emergency rations and water to a flood-isolated community', 'a small team with equipment'])} ` +
      `to ${c.setting} ${c.distNm.toFixed(0)} NM ${compass(c.bearing)}. ${pick(c.r, ['Strip is short and unsealed — inspect on arrival', 'Marginal weather at the destination — plan a hold and a divert', 'Confined HLS — one-ship, tight approach'])}.`,
    hazards: ['Short/soft strip, obstacles, density altitude', 'Weather at the destination, single approach', 'Confined area, dust or whiteout on landing'],
    persons: ['2 passengers + 3 crew', 'N/A — freight'],
    access: ['Unsealed strip / confined HLS', 'Community airstrip'],
    lz: ['Inspect on a low pass before committing', 'Marked HLS at the FOB'],
  },
  {
    id: 'maritime-patrol',
    kind: 'Maritime patrol',
    category: 'Maritime ISR',
    classes: ['fixed'],
    agencies: ['raaf', 'navy'],
    distNm: [80, 350],
    p1: 0.15,
    p2: 0.45,
    offshore: true,
    settings: ['a patrol area', 'a shipping lane', 'an exclusive economic zone sector', 'a chokepoint'],
    brief: (c) => `Patrol the assigned area — ${pick(c.r, ['surface picture compilation', 'contact of interest investigation', 'anti-submarine sweep', 'fisheries and border support'])}.`,
    detail: (c) =>
      `Tasked to build the surface picture in a patrol area ${c.distNm.toFixed(0)} NM ${compass(c.bearing)} of your position, ` +
      `${pick(c.r, ['classifying and reporting all contacts', 'investigating a contact of interest passed by the operations centre', 'conducting an anti-submarine search of the box'])}. ` +
      `Log contacts with position, course and speed; comply with the coordinating authority.`,
    hazards: ['Long transit, weather, fatigue, low level over water', 'Bird strike risk at low level', 'Congested lane traffic'],
    persons: ['N/A — patrol'],
    access: ['N/A — patrol area'],
    lz: ['Recovery to the maritime patrol base'],
  },
];

// --- generator ----------------------------------------------------------

export type GenOpts = {
  lat: number;
  lon: number;
  aircraftClass: AircraftClass;
  profile: Profile;
  count?: number;
  seed?: number;
  /** running index so trickled-in calls keep unique ids */
  startIndex?: number;
  /** real airfields near the operator (fixed wing only lands at these) */
  airports?: Airport[];
};

function priorityFrom(r: Rng, t: OpTemplate): Priority {
  const x = r();
  if (x < t.p1) return 'P1';
  if (x < t.p1 + t.p2) return 'P2';
  return 'P3';
}

const rrng = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const dLat = (lat2 - lat1) * 60;
  const dLon = (lon2 - lon1) * 60 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
};

/** Pick a real airfield within [min,max] NM of (lat,lon); widen the band if needed. */
function pickAirport(
  r: Rng,
  airports: Airport[],
  lat: number,
  lon: number,
  minNm: number,
  maxNm: number,
  exclude?: string,
): Airport | null {
  if (!airports.length) return null;
  for (const [lo, hi] of [
    [minNm, maxNm],
    [Math.max(3, minNm * 0.5), maxNm * 1.6],
    [3, 600],
  ] as const) {
    const cand = airports.filter(
      (a) => a.ident !== exclude && rrng(lat, lon, a.lat, a.lon) >= lo && rrng(lat, lon, a.lat, a.lon) <= hi,
    );
    if (cand.length) return pick(r, cand);
  }
  return null;
}

/** Returns a Call, or null if the template can't be placed (e.g. fixed wing needs a runway and none is in range). */
function buildCall(r: Rng, t: OpTemplate, o: GenOpts, idx: number): Call | null {
  const agency = AGENCIES[pick(r, t.agencies)]!;
  const town = pick(r, TOWNS);
  const setting = pick(r, t.settings);
  const airports = o.airports ?? [];
  const needRunway = t.needsRunway && o.aircraftClass === 'fixed';

  let bearing: number;
  let distanceNm: number;
  let at: { lat: number; lon: number };
  let placeLabel: string;

  if (needRunway) {
    const ap = pickAirport(r, airports, o.lat, o.lon, t.distNm[0], t.distNm[1]);
    if (!ap) return null; // don't send a fixed wing where it can't land
    at = { lat: ap.lat, lon: ap.lon };
    distanceNm = rrng(o.lat, o.lon, ap.lat, ap.lon);
    bearing = (Math.atan2(ap.lon - o.lon, ap.lat - o.lat) * 180) / Math.PI;
    bearing = (bearing + 360) % 360;
    placeLabel = `${ap.ident} — ${distanceNm.toFixed(0)} NM ${compass(bearing)} of your position`;
  } else {
    bearing = Math.floor(r() * 360);
    distanceNm = range(r, t.distNm[0], t.distNm[1]);
    at = project(o.lat, o.lon, distanceNm, bearing);
    placeLabel = `≈${distanceNm.toFixed(0)} NM ${compass(bearing)} of your position, near ${setting}`;
  }

  const ctx: Ctx = { r, agency, setting, distNm: distanceNm, bearing, town };
  const priority = priorityFrom(r, t);
  const unitNo = int(r, 1, 9);
  const supporting =
    o.profile === 'military'
      ? ['Ground call sign (on scene)', 'Coordination centre', 'Standby asset']
      : ['Road ambulance (on scene)', 'Police (en route)', 'Fire service (on scene)'];
  const units = [
    `${agency.callsign} ${unitNo} (tasked)`,
    ...[...supporting].sort(() => r() - 0.5).slice(0, int(r, 1, 3)),
  ];

  let transportTo: Hospital | undefined;
  if (t.transport && chance(r, 0.9)) {
    if (needRunway) {
      // Fixed wing: the receiving end must also be a real airfield.
      const dst = pickAirport(r, airports, at.lat, at.lon, 20, 260, undefined);
      if (dst && dst.ident !== undefined && rrng(at.lat, at.lon, dst.lat, dst.lon) > 4) {
        transportTo = { name: `${dst.ident} (${town} Base Hospital)`, lat: dst.lat, lon: dst.lon };
      }
    } else {
      const hbrg = (bearing + int(r, -90, 90) + 360) % 360;
      const hdist = range(r, 10, Math.min(60, Math.max(14, distanceNm * 0.6)));
      const h = project(at.lat, at.lon, hdist, hbrg);
      transportTo = {
        name: `${town} ${pick(r, ['Base Hospital HLS', 'Health Campus HLS', 'Hospital rooftop pad', 'District Hospital HLS'])}`,
        lat: h.lat,
        lon: h.lon,
      };
    }
  }

  const idPrefix = o.profile === 'military' ? 'TSK' : 'AED';
  const idNum = `${String((idx % 90) + 10).padStart(2, '0')}${String(int(r, 10, 98)).padStart(2, '0')}`;
  return {
    id: `${idPrefix}-${idNum}`,
    lat: at.lat,
    lon: at.lon,
    kind: t.kind,
    category: t.category,
    place: placeLabel,
    latLon: dmsString(at.lat, at.lon),
    sector: `${compass(bearing)} sector · ${o.aircraftClass === 'rotary' ? 'Rotary' : 'Fixed wing'} · Block ${pick(r, ['A', 'B', 'C', 'D'])}${int(r, 1, 9)}`,
    brief: t.brief(ctx),
    detail: t.detail(ctx),
    source:
      o.profile === 'military'
        ? pick(r, ['Air operations centre', 'JRCC Australia', 'Formation headquarters'])
        : pick(r, [`${agency.name} operations`, 'State health control', 'Triple Zero (000)', 'State duty operations manager']),
    informant:
      o.profile === 'military'
        ? pick(r, ['Duty operations officer', 'Ground force commander', 'Coordination centre'])
        : pick(r, ['On-scene road crew', 'Duty operations manager', 'Incident controller', 'Reporting person (mobile)']),
    hazards: pick(r, t.hazards),
    persons: pick(r, t.persons),
    access: needRunway ? `Land at ${placeLabel.split(' — ')[0]}; road transfer from the aerodrome` : pick(r, t.access),
    lz: needRunway ? 'Sealed / gravel runway at the aerodrome' : pick(r, t.lz),
    units,
    nearestAsset: `${agency.name} — ${agency.base}, ${(distanceNm * range(r, 0.15, 0.5)).toFixed(0)} NM`,
    weather: wx(r),
    priority,
    bearing,
    distanceNm,
    receivedOffsetSec: int(r, 20, 1800),
    transportTo,
  };
}

/** Build a queue of tasking tailored to the operator's position and aircraft. */
export function generateCalls(opts: GenOpts): Call[] {
  const count = opts.count ?? 6;
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const start = opts.startIndex ?? 0;
  const r = mulberry32(seed);
  const pool = (opts.profile === 'military' ? MIL_OPS : CIVIL_OPS).filter((t) =>
    t.classes.includes(opts.aircraftClass),
  );
  const usable = pool.length ? pool : opts.profile === 'military' ? MIL_OPS : CIVIL_OPS;

  const out: Call[] = [];
  const bag: OpTemplate[] = [];
  let lastId = '';
  let guard = count * 12;
  while (out.length < count && guard-- > 0) {
    if (bag.length === 0) bag.push(...usable);
    const t = bag.splice(Math.floor(r() * bag.length), 1)[0]!;
    if (t.id === lastId) {
      bag.push(t);
      continue;
    }
    const call = buildCall(r, t, opts, start + out.length);
    if (!call) continue; // template couldn't be placed (no runway in range) — try another
    lastId = t.id;
    out.push(call);
  }
  return out.sort((a, b) => a.receivedOffsetSec - b.receivedOffsetSec);
}

/** rotary vs fixed from the sim's ENGINE TYPE (3 = helo turbine) + title hints. */
export function classifyAircraft(engineType: number | undefined, title = '', model = ''): AircraftClass {
  if (engineType === 3) return 'rotary';
  const s = `${title} ${model}`.toLowerCase();
  if (/heli|h125|h145|h160|ec13|ec35|as350|as355|bell ?4|b407|b412|aw139|aw169|r22|r44|r66|uh-|mh-|s-?76|s-?92|nh90|mrh|blackhawk|black hawk|chinook/.test(s)) {
    return 'rotary';
  }
  return 'fixed';
}
