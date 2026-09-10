import { app } from 'electron';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Procedural scene dressing. A "scene" is a cluster of injected SimObjects that
 * dresses a job location. Each scene is GENERATED per job (seeded by the job id
 * so every unit in a session gets the same layout) so two MVAs never look alike:
 * the flavour (head-on / rollover / pile-up / …), the vehicle models and damage
 * states, the number and pose of casualties, the responders, debris and the
 * cordon all vary.
 *
 * Object titles are drawn from named GROUPS. The preferred titles are from the
 * 30West HEMS Objects and 68ponyGT / HPG "H145 Action Pack" object packs (each
 * prop is an AIRCRAFT SimObject, spawned via AICreateNonATCAircraft). If those
 * aren't installed the chain falls to the app's own AED_* models, then base-game
 * titles, then Windsock. Override any group without a rebuild with a
 * `scene-titles.json` in %APPDATA%\aus-emergency-dispatcher\ or
 * Documents\Aus Emergency Dispatcher\.
 */

const WINDSOCK = 'Windsock';

// ---- title groups (from the installed HEMS object packs) -----------------
const G: Record<string, string[]> = {
  // --- wrecked / crashed road vehicles ---
  wreckCar: ['Wrecked Sedan', 'Wrecked Hatchback', 'WreckedCar01-D2', 'WreckedCar03-D2', 'WreckedCar04-D2', 'Renault Clio Wrecked', 'Peugeot 307 Wrecked', 'Mercedes A45 Wrecked Front Right', '30West wreck'],
  wreckCarHeavy: ['WreckedCar01-D9', 'WreckedCar03-D9', 'WreckedCar04-D9', 'WreckedSUV01-D9', 'Wrecked Audi S4 Front', '30West wreck'],
  wreckCarLight: ['WreckedCar01-D1', 'WreckedCar03-D1', 'WreckedCar04-D1', 'WreckedSUV01-D1', 'Wrecked Audi S4 Rear', 'Renault Clio Wrecked'],
  wreckSuv: ['WreckedSUV01-D2', 'WreckedSUV01-D1', 'Wrecked Audi S4 Left'],
  wreckBus: ['WreckedBus01-D2', 'WreckedBus01-D1', 'WreckedBus01-D8', 'WreckedBus01-D9'],
  wreckTruck: ['Wrecked Fuel Truck', 'Wrecked Fuel Tanker', 'EU Tanker Truck 1 Wrecked Front Right'],
  wreckBike: ['30West Bike Crashed 1', '30West Bike Crashed 2', '30West Motocyc2'],
  // the collision partner at an MVA — must be the WRECKED tanker, not the intact one
  tanker: ['Wrecked Fuel Tanker', 'EU Tanker Truck 1 Wrecked Front Right', 'Wrecked Fuel Truck'],
  // --- responding / intact vehicles ---
  carIntact: ['Mercedes A45', '30West A45'],
  ambulance: ['30West Ambu Berlin', '30West Ambu Johanniter'],
  ambulanceLit: ['30West Ambu Berlin lights', '30West Ambu Johanniter lights', '30West Ambu Berlin'],
  /** fire appliance — the packs have no pumper, so MSFS 2024's own wins (see BASE_FIRST) */
  fireAppliance: ['30West Fueltruck'],
  /** police patrol — no marked car in any pack; a plain sedan stands in */
  policeCar: ['30West A45', 'Mercedes A45'],
  towTruck: ['TowTruck1', 'TowTruck2'],
  atv: ['ATV1 Red', 'ATV1 Blue', 'ATV1 Yellow'],
  golfCart: ['Golf Cart 1'],
  tractor: ['NewHolland-Tractor', 'Zetor-Tractor', 'JohnDeere-Combine'],
  plant: ['Excavator1', 'FrontLoader1', 'Bulldozer1', 'Dumptruck1', 'Forklift1', 'FrontLoaderSM1', 'Crawler Crane 1'],
  // --- marine ---
  boat: ['Cabin Boat 1', 'Fishing Boat 1', 'Fishing Boat 2', 'Sea Ray', 'Pontoon Boat 1'],
  boatDisabled: ['Sea Ray Listing', 'Pontoon Boat 1 Damaged', 'Fishing Boat 2', 'Cabin Boat 1'],
  boatFire: ['Cabin Boat 1 Fire', 'Pontoon Boat 1 Fire'],
  rescueBoat: ['USCG Rescue Boat 1', 'USPD Rescue Boat 1', 'Lifeboat1'],
  liferaft: ['Lifeboat1', 'USPD Rescue Boat 1'],
  ship: ['Cargo Ship 1', 'Container Ship 1', 'Oil Tanker 1', 'Cruise Ship Small'],
  oilRig: ['Oil Rig 1'],
  // level-crossing furniture — these ship in the 30West pack and were unused
  railCrossing: ['30West RR', '30West US RR'],
  // a pitched ladder at a structure fire (the fallen one lives in `debris`)
  ladder: ['30West Ladder'],
  // no stretcher in any pack — MSFS 2024's own wins (see BASE_FIRST)
  stretcher: ['30West bag', '30West ParamedicBox'],
  // --- aircraft / rail wrecks ---
  heliWreck: ['Helicopter Crash 1', 'HeliCrash01-D2', 'HeliCrash02-D2', 'HeliCrash01-D1'],
  planeWreckLight: ['Plane Crash 1', 'Plane Crash Med 1'],
  planeWreck: ['Plane Crash Med 1', 'Plane Crash LG 1', 'Plane Crash 1'],
  trainCar: ['TGV Train Carriage Bleu', 'TGV Train Center Gris', 'TGV Train Full Orange', 'TGV Train Carriage DB'],
  trainPower: ['TGV Train Power Unit DB', 'TGV Train Power Unit Bleu', 'TGV Train Power Unit Gris'],
  // --- people: casualties ---
  casLying: ['Female_lying', 'Female_lying_blanket', 'Female_lying_blanket2', 'Female_30deg', 'Worker_lying', '30West dazed', '30West dying bald'],
  casBlanket: ['Female_lying_blanket', 'Female_lying_blanket2', 'Female_30deg_blanket', 'Female_legs_up_blanket', 'Female_recovery_pose_blanket'],
  casSitting: ['Worker_sitting', '30West dazed', 'Female_recovery_pose', '30West dyWorker'],
  casShock: ['Female_legs_up', 'Female_legs_up_blanket', 'Female_30deg'],
  casRescueBag: ['Female_lying_rescuebag', '30West bag', '30West bag female', '30West bag worker', '30West bag grandpa'],
  /** an injured hi-vis worker — the casualty at an industrial/rural job */
  casWorker: ['30West Worker injured', '30West dyWorker', 'Worker_lying', 'Worker_sitting'],
  /**
   * Crew ON THEIR FEET. Every generator uses `worker` for fire crew, rail staff,
   * clinic staff, a dive buddy or the property owner — it must NOT resolve to
   * the injured/lying figures (which is what it used to do, so every
   * "firefighter" at a fire was a body face-down on the ground).
   */
  worker: ['30West sam 5', '30West sam 6', '30West mac1', '30West hhop', '30West bald'],
  // --- people: responders / bystanders ---
  paramedic: ['30West paramedic', '30West cpr'],
  cpr: ['30West cpr', '30West paramedic'],
  officer: ['30West off', '30West sam 5', '30West sam 6'],
  bystander: ['30West Eve', '30West hhop', '30West mac1', '30West mac3', '30West Grandpa', '30West Mother', '30West bald'],
  family: ['30West Mother', '30West Grandpa', '30West Eve'],
  // --- fire / smoke ---
  fireSmall: ['Fire with Light 1', 'Fire with Light 2', 'Signal Flare'],
  fireBig: ['Fire with Light 3', 'Fire with Light 2'],
  smoke: ['Smoke Effects', '30West smoke', 'Smoke_Grey_MED', 'Smoke_Grey_LG'],
  smokeBig: ['Smoke_Grey_LG', 'Smoke Effects', '30West smoke'],
  flare: ['Signal Flare', 'Signal_Smoke_Orange'],
  // --- markers / props ---
  cone: ['30West marker post 6m', '30West marker post 5m', '30West marker post 4m', '30West IT marker post 6m', '30West US marker post 6m'],
  beacon: ['Heliport Beacon 30m', '30West constr_light'],
  debris: ['30West Ladder fallen', '30West Stone1', '30West Stone2', '30West Stone3', '30West constr_light'],
  fence: ['30West Fence', '30West QR-Fence', '30West Fence2 blue', '30West Fence4'],
  scaffold: ['30West scaffold', '30West construction'],
  // no pylon or genset in any pack — these come from MSFS 2024's own SimObjects
  powerline: [],
  generator: [],
  carseat: ['30West Carseat'],
  medkit: ['30West ParamedicBox', '30West cooler red'],
  deer: ['30West Deer dead', '30West Deer'],
  horse: ['30West Horse'],
  dog: ['30West Dog'],
  paraglider: ['30West Paraglider green crashed', '30West Paraglider redblue crashed', '30West Paraglider rb tree'],
};

/** App-shipped fallback models by the kind of thing the group represents. */
function fallbacksFor(group: string): string[] {
  if (/^(wreckBus|trainCar|trainPower|heliWreck|planeWreck)/.test(group)) return ['AED_Wreck', 'AED_Truck'];
  if (/wreck|^car|truck|tanker|tow|atv|tractor|plant|golf|bike/i.test(group)) return ['AED_Wreck', 'AED_Car', 'AED_Car4x4', 'Generic_Vehicle'];
  if (/^fireAppliance/.test(group)) return ['AED_FireTruck', 'AED_Ambulance', 'FuelTruck'];
  if (/^policeCar/.test(group)) return ['AED_PoliceCar', 'AED_Car', 'AED_Ambulance'];
  if (/^stretcher/.test(group)) return ['AED_Casualty', 'AED_Medic'];
  if (/ambulance/i.test(group)) return ['AED_Ambulance', 'AED_FireTruck', 'FuelTruck'];
  if (/boat|raft|ship|rig/i.test(group)) return ['AED_Boat'];
  if (/^(cas|worker|paramedic|cpr|officer|bystander|family)/.test(group))
    return ['AED_Casualty', 'AED_Medic', 'Marshaller', 'Tarmac_Male_Summer_Caucasian'];
  if (/fire|smoke|flare/i.test(group)) return ['AED_SpotFire', 'AED_FireSeat'];
  if (/deer|horse|dog/i.test(group)) return ['AED_Casualty'];
  return ['AED_Cordon'];
}

// ---- overrides -----------------------------------------------------------
let overrideCache: Partial<Record<string, string[]>> | null = null;

function loadOverrides(): Partial<Record<string, string[]>> {
  if (overrideCache) return overrideCache;
  const out: Partial<Record<string, string[]>> = {};
  const dirs: string[] = [];
  try {
    dirs.push(app.getPath('userData'));
  } catch {
    /* not ready */
  }
  try {
    dirs.push(path.join(app.getPath('documents'), 'Aus Emergency Dispatcher'));
  } catch {
    /* ignore */
  }
  for (const dir of dirs) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, 'scene-titles.json'), 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (Array.isArray(v)) out[k] = v.filter((t) => typeof t === 'string' && t.trim());
        }
      }
    } catch {
      /* no override file here */
    }
  }
  overrideCache = out;
  return out;
}

/** Reload the override file on the next resolve. */
export function reloadSceneTitleOverrides(): void {
  overrideCache = null;
}

// ---- MSFS version profile ----------------------------------------------
// Fire and smoke are the sim's own particle effects — they come from a
// VisualEffectLib SimObject (30West / 68ponyGT VFX packs on MSFS 2024, which
// ARE 2024-native). MSFS 2020 can't load those 2024-built effect objects, so on
// 2020 we drop the 2024-only titles and lean on the app's AED_* fallbacks.
let simProfile = { msfs2024: false };

/** Called by the SimConnect bridge once it knows which sim connected. */
export function setSceneSimProfile(p: { msfs2024: boolean }): void {
  simProfile = { ...simProfile, ...p };
}

/** 2024-native visual-effect object titles, in preference order, per FX group. */
const FX_NATIVE_2024: Record<string, string[]> = {
  fireSmall: ['Fire with Light 1', 'Fire with Light 2', '30West smoke', 'Smoke_Grey_SM'],
  fireBig: ['Fire with Light 3', 'Fire with Light 2', 'Smoke_Grey_MED'],
  smoke: ['Smoke_Grey_MED', 'Smoke_Grey_SM', 'EngineSmoke', 'Smoke Effects', '30West smoke'],
  smokeBig: ['Smoke_Grey_LG', 'Smoke_Grey_MED', 'Smoke Effects', '30West smoke'],
  flare: ['Signal_Smoke_Orange', 'Signal Flare'],
  boatFire: ['Cabin Boat 1 Fire', 'Pontoon Boat 1 Fire', 'Smoke_Grey_MED'],
};

/** Titles that only exist in MSFS-2024-built VFX packs — skip them on MSFS 2020. */
const FX_2024_ONLY = /^(Smoke_(Grey|White)_(SM|MED|LG)|Signal_Smoke_Orange|EngineSmoke)$/i;

const FX_GROUP = new Set(Object.keys(FX_NATIVE_2024));

/**
 * Base-game MSFS 2024 SimObjects, by group — a free fallback so every scene has
 * a real object even with NO add-on packs installed. Titles were read straight
 * from the streamed base packages:
 *   fs24-microsoft-simobjects-vehicles  (category GroundVehicle)
 *   fs24-asobo-simobjects-characters    (Human / AircraftPilot)
 *   fs24-asobo-simobjects-misc          (SimpleObjectSim / StaticObject)
 *   fs24-asobo-simobjects-animals / fs24-microsoft-simobjects-animals-*
 * They spawn through AICreateSimulatedObject (single-token names, no space).
 * There is NO base-game stand-alone fire/smoke object, so the FX groups get
 * nothing here (they fall to the VFX packs / AED_SpotFire / Windsock).
 */
const BASE_2024: Record<string, string[]> = {
  // road vehicles — wrecked & intact both draw from the same base cars/trucks
  wreckCar: ['Microsoft_Car_EUR_03', 'Microsoft_Car_NA_02', 'Microsoft_Car_EUR_01', 'Microsoft_MiniCar_01'],
  wreckCarHeavy: ['Microsoft_SUV_NA_01', 'Microsoft_Car_NA_02', 'Microsoft_Truck_NA'],
  wreckCarLight: ['Microsoft_MiniCar_01', 'Microsoft_Car_EUR_01', 'Microsoft_Car_JPN_01'],
  wreckSuv: ['Microsoft_SUV_NA_01', 'Microsoft_SUV_NA_Vintage'],
  wreckBus: ['Microsoft_Bus_Modern', 'Microsoft_Bus_NA_Vintage', 'Microsoft_MiniBus_ASIA_01'],
  wreckTruck: ['Microsoft_Truck_NA', 'Microsoft_Truck_EUR_Vintage', 'Microsoft_Truck_Military_01'],
  wreckBike: ['Microsoft_Motorbike_01', 'Microsoft_Motorbike_02', 'Microsoft_Motorbike_03'],
  tanker: ['Microsoft_Truck_Fuel_Long_02', 'Microsoft_Truck_Water_02'],
  carIntact: ['Microsoft_Car_EUR_03', 'Microsoft_SUV_NA_01', 'Microsoft_Car_NA_02'],
  // base game has no ambulance — a box van reads far closer than a fire truck
  ambulance: ['Microsoft_Van_NA_Modern', 'Microsoft_Van_EUR', 'Microsoft_Truck_NA_Boarding'],
  ambulanceLit: ['Microsoft_Van_NA_Modern', 'Microsoft_Van_EUR', 'Microsoft_Truck_NA_Boarding'],
  towTruck: ['Microsoft_Truck_Crane_Small', 'Microsoft_Truck_NA'],
  atv: ['Microsoft_Quad'],
  golfCart: ['Microsoft_Quad', 'Microsoft_MiniCar_01'],
  tractor: ['Microsoft_Tractor', 'Microsoft_Harvester'],
  plant: ['Microsoft_Bulldozer', 'Microsoft_Forklift_Large', 'Microsoft_Truck_Crane_Small', 'Microsoft_Loader_Ramp_02'],
  // marine
  liferaft: ['LifeRaft', 'LifeRaft_Characters'],
  rescueBoat: ['LifeRaft_Characters', 'LifeRaft'],
  // aircraft / rail wrecks — a parked heli is the nearest base object
  heliWreck: ['Microsoft_Helicopter_Aerial'],
  // people — casualties become stretcher props; responders/bystanders base humans
  casLying: ['Stretcher01_orange', 'Rescue_Copter_Stretcher02', 'Stretcher_RTC_Medic'],
  casBlanket: ['Stretcher01_orange', 'Stretcher_RTC_Medic', 'Rescue_Copter_Stretcher02'],
  casSitting: ['Stretcher_RTC_Medic', 'Tarmac_Male_Summer_Caucasian', 'CharacterSim_Male_PassengerThin'],
  casShock: ['Stretcher01_orange', 'Stretcher_RTC_Medic'],
  casRescueBag: ['Rescue_Copter_Stretcher02', 'Stretcher01_orange'],
  worker: ['Tarmac_Male_Summer_Caucasian', 'Tarmac_Male_Winter_Caucasian', 'Marshaller_Male_Summer_Caucasian'],
  paramedic: ['Tarmac_Female_Summer_Caucasian', 'Tarmac_Male_Summer_Caucasian', 'Marshaller_Male_Summer_Caucasian'],
  cpr: ['Tarmac_Male_Summer_Caucasian', 'Marshaller_Male_Summer_Caucasian'],
  officer: ['Marshaller_Male_Summer_Caucasian', 'Tarmac_Male_Summer_Caucasian'],
  bystander: ['CharacterSim_Male_PassengerAverage', 'CharacterSim_Female_PassengerAverage', 'Tarmac_Male_Summer_Caucasian'],
  family: ['CharacterSim_Female_PassengerAverage', 'CharacterSim_Male_PassengerAverage'],
  // markers / props
  cone: ['Cone_Medium'],
  beacon: ['Cone_Medium', 'Optical_Landing_System'],
  debris: ['Log_01', 'Cardboard', 'Pallet', 'BuildingMaterial01', 'Rice_Bag_50'],
  scaffold: ['BuildingMaterial01', 'Pallet01_01', 'Compressor01'],
  generator: ['PowerGenerator', 'GeneracPowerSystems01', 'Compressor01'],
  powerline: ['PowerPylon_Base', 'PowerPylon_Top'],
  medkit: ['Rice_Bag_50', 'Cardboard'],
  // animals (each is its own streamed package: title == capitalised species).
  // Australia: an animal strike is a roo, not a deer.
  deer: ['Kangaroo', 'Deer', 'Elk'],
  horse: ['Horse', 'Cow'],
  // emergency vehicles the packs don't have at all
  fireAppliance: ['Microsoft_Truck_Fire_Long', 'Microsoft_Truck_Fire_Medium_Red', 'Microsoft_Truck_Fire_Short_02'],
  policeCar: ['Microsoft_Car_EUR_03', 'Microsoft_SUV_NA_01', 'Microsoft_Car_NA_02'],
  casWorker: ['Stretcher01_orange', 'Stretcher_RTC_Medic'],
  stretcher: ['Stretcher01_orange', 'Rescue_Copter_Stretcher02', 'Stretcher_RTC_Medic'],
};

/**
 * Groups where MSFS 2024's own SimObject is a better match than anything in the
 * add-on packs, so the base title goes to the FRONT of the chain: the packs have
 * no fire appliance, no pylon and no genset, and an Australian animal strike
 * should be a kangaroo.
 */
const BASE_FIRST = new Set(['fireAppliance', 'powerline', 'generator', 'deer', 'stretcher']);

/** Legacy pool ids kept so old `scene-titles.json` keys still map to a group. */
const LEGACY_ALIAS: Record<string, string> = {
  car: 'wreckCar',
  carAlt: 'wreckSuv',
  truck: 'wreckTruck',
  emergency: 'ambulanceLit',
  police: 'ambulanceLit',
  boat: 'boat',
  debris: 'debris',
  marker: 'cone',
  person: 'casLying',
  medic: 'paramedic',
  patient: 'casBlanket',
  spotfire: 'fireSmall',
  fireseat: 'fireBig',
};

/** Candidate container titles for a group: override + pack titles + AED_* + Windsock. */
export function groupTitles(group: string): string[] {
  const ov = loadOverrides();
  const g = G[group] ? group : (LEGACY_ALIAS[group] ?? group);
  // Fire/smoke: on MSFS 2024 use the sim's own particle-effect objects first;
  // on MSFS 2020 drop the 2024-only effect titles (they'd fail-and-substitute).
  const isFx = FX_GROUP.has(g);
  const fxHead = isFx && simProfile.msfs2024 ? (FX_NATIVE_2024[g] ?? []) : [];
  // On MSFS 2024, real base-game SimObjects beat the app's AED_* box meshes —
  // and for BASE_FIRST groups they beat the packs' stand-ins too.
  const base2024 = simProfile.msfs2024 ? (BASE_2024[g] ?? []) : [];
  const baseWins = base2024.length > 0 && BASE_FIRST.has(g);
  let merged = [
    ...(ov[group] ?? []),
    ...(ov[g] ?? []),
    ...fxHead,
    ...(baseWins ? base2024 : []),
    ...(G[g] ?? []),
    ...(baseWins ? [] : base2024),
    ...fallbacksFor(g),
    WINDSOCK,
  ];
  if (isFx && !simProfile.msfs2024) merged = merged.filter((t) => !FX_2024_ONLY.test(String(t).trim()));
  const seen = new Set<string>();
  const outArr: string[] = [];
  for (const t of merged) {
    const v = String(t).trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      outArr.push(v);
    }
  }
  return outArr;
}

// ---- scene object spec + rng -------------------------------------------
export type SceneObjectSpec = {
  role: string;
  /** which title group to draw from */
  group: string;
  forwardM: number;
  rightM: number;
  headingOffsetDeg: number;
};

type Rng = {
  f: () => number;
  int: (lo: number, hi: number) => number;
  sub: (lo: number, hi: number) => number;
  chance: (p: number) => boolean;
  pick: <T>(arr: readonly T[]) => T;
};

function makeRng(seedStr: string): Rng {
  let s = 0x811c9dc5;
  for (let i = 0; i < seedStr.length; i++) {
    s ^= seedStr.charCodeAt(i);
    s = Math.imul(s, 0x01000193) >>> 0;
  }
  let a = s || 1;
  const f = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    f,
    int: (lo, hi) => lo + Math.floor(f() * (hi - lo + 1)),
    sub: (lo, hi) => lo + f() * (hi - lo),
    chance: (p) => f() < p,
    pick: (arr) => arr[Math.floor(f() * arr.length)]!,
  };
}

const spec = (group: string, fwd: number, right: number, hdg = 0): SceneObjectSpec => ({
  role: group,
  group,
  forwardM: Math.round(fwd * 10) / 10,
  rightM: Math.round(right * 10) / 10,
  headingOffsetDeg: Math.round(((hdg % 360) + 360) % 360),
});

/**
 * Roughly how much ground an object of this group takes up, and how hard it is
 * to shove. Used to stop props spawning inside each other — before this, an MVA
 * averaged ~8 overlapping pairs per scene (people standing inside cars, cars
 * inside trucks, up to 6 m of interpenetration).
 */
function footprint(group: string): { r: number; mass: number } {
  if (/^(wreckBus|trainCar|trainPower|ship|oilRig)/.test(group)) return { r: 6.0, mass: 40 };
  if (/^(wreckTruck|tanker|plant|tractor|planeWreck|heliWreck|scaffold|powerline|fireAppliance)/.test(group))
    return { r: 3.6, mass: 20 };
  if (/^(wreck|car|policeCar|tow|ambulance|atv|golf|boat|rescueBoat|liferaft|trainC)/i.test(group))
    return { r: 2.3, mass: 10 };
  if (/^(cas|worker|paramedic|cpr|officer|bystander|family|deer|horse|dog|paraglider)/.test(group))
    return { r: 0.55, mass: 1 };
  if (/(fire|smoke|flare)/i.test(group)) return { r: 1.6, mass: 3 };
  return { r: 0.6, mass: 2 }; // cones, debris, beacons, medkit, fence…
}

/** What survives the object cap: 3 = hero content … 0 = pure decoration. */
function priority(group: string): number {
  if (/^(cone|debris|fence|beacon|medkit|carseat|flare)/.test(group)) return 0;
  if (/^(bystander|family|officer|paraglider|deer|horse|dog|scaffold|generator|ladder|stretcher)/.test(group)) return 1;
  if (/^(cas|worker|paramedic|cpr)/.test(group)) return 2;
  return 3; // vehicles, trains, boats, fire & smoke
}

/** Crashed vehicles are meant to be touching, so allow them to interpenetrate. */
const SLACK_VEHICLE = 1.2;
const SLACK = 0.15;

/**
 * Push overlapping objects apart. Object 0 is the scene's hero (every generator
 * pushes it first) and never moves, so the cluster stays pinned on the job's
 * lat/lon; everything else gives way in inverse proportion to its mass, which
 * is what puts casualties and crew in a ring *around* a wreck instead of inside it.
 */
function separate(objs: SceneObjectSpec[]): void {
  const meta = objs.map((o) => footprint(o.group));
  for (let iter = 0; iter < 16; iter++) {
    let moved = false;
    for (let a = 0; a < objs.length; a++) {
      for (let b = a + 1; b < objs.length; b++) {
        if (a === 0 && b === 0) continue;
        const A = objs[a]!;
        const B = objs[b]!;
        const ma = meta[a]!;
        const mb = meta[b]!;
        const need = ma.r + mb.r - (ma.mass >= 10 && mb.mass >= 10 ? SLACK_VEHICLE : SLACK);
        const dx = B.forwardM - A.forwardM;
        const dy = B.rightM - A.rightM;
        let d = Math.hypot(dx, dy);
        if (d >= need) continue;
        let ux: number;
        let uy: number;
        if (d < 1e-3) {
          // exactly coincident (e.g. a spot fire dropped on the hero wreck) —
          // pick a deterministic direction by golden angle so repeats fan out
          const ang = (a + 1) * 2.399963;
          ux = Math.cos(ang);
          uy = Math.sin(ang);
          d = 0;
        } else {
          ux = dx / d;
          uy = dy / d;
        }
        const push = need - d;
        // index 0 is pinned; otherwise share the correction by inverse mass
        let wa: number;
        let wb: number;
        if (a === 0) {
          wa = 0;
          wb = 1;
        } else {
          const t = ma.mass + mb.mass;
          wa = mb.mass / t;
          wb = ma.mass / t;
        }
        A.forwardM -= ux * push * wa;
        A.rightM -= uy * push * wa;
        B.forwardM += ux * push * wb;
        B.rightM += uy * push * wb;
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (const o of objs) {
    o.forwardM = Math.round(o.forwardM * 10) / 10;
    o.rightM = Math.round(o.rightM * 10) / 10;
  }
}

/**
 * A stable scene orientation for a job. Derived from the job id so every crew —
 * and every re-place — lays the wreckage out the same way, instead of rotating
 * with whoever happened to place it and which base they flew from.
 */
export function sceneHeading(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 8) % 360;
}

/** Scatter `n` objects of a group around (cx,cy) within radius r. */
function scatter(rng: Rng, group: string, n: number, cx: number, cy: number, r: number, out: SceneObjectSpec[]): void {
  for (let i = 0; i < n; i++) out.push(spec(group, cx + rng.sub(-r, r), cy + rng.sub(-r, r), rng.sub(0, 360)));
}

/** A row of cones from (fwd,right) along `alongDeg` (relative to scene heading). */
function coneLine(rng: Rng, fwd: number, right: number, alongDeg: number, count: number, gap: number, out: SceneObjectSpec[]): void {
  const rad = (alongDeg * Math.PI) / 180;
  for (let i = 0; i < count; i++) {
    out.push(spec('cone', fwd + Math.cos(rad) * gap * i + rng.sub(-0.6, 0.6), right + Math.sin(rad) * gap * i + rng.sub(-0.6, 0.6), 0));
  }
}

/**
 * Park a responding vehicle the way a crew actually stages, so the scene reads
 * as a scene from 500 ft rather than as vehicles dropped at random angles:
 * everything sits UPSTREAM of the incident, the appliance slewed across the
 * carriageway to fend off traffic, the ambulance square-on with its rear
 * toward the casualties for loading.
 */
function apparatus(
  rng: Rng,
  group: string,
  out: SceneObjectSpec[],
  o: { backMin: number; backMax: number; side?: [number, number]; fend?: boolean },
): void {
  const back = -rng.sub(o.backMin, o.backMax);
  const side = o.side ? rng.sub(o.side[0], o.side[1]) : rng.sub(-1, 5);
  const hdg = o.fend
    ? (rng.chance(0.5) ? 1 : -1) * rng.sub(28, 52) // slewed across the road
    : 180 + rng.sub(-10, 10); // backed in, tail toward the job
  out.push(spec(group, back, side, hdg));
}

/**
 * A traffic taper: cones running back upstream from the scene while drifting
 * from the centre out to the shoulder — the shape you actually see from the air,
 * instead of a bar of cones sitting square across the road.
 */
function coneTaper(
  rng: Rng,
  out: SceneObjectSpec[],
  o: { from: number; side: number; count: number; gap: number; drift: number },
): void {
  const span = Math.max(1, o.count - 1);
  for (let i = 0; i < o.count; i++) {
    out.push(
      spec(
        'cone',
        o.from - i * o.gap + rng.sub(-0.5, 0.5),
        o.side + (i / span) * o.drift + rng.sub(-0.4, 0.4),
        0,
      ),
    );
  }
}

/**
 * Wreckage strewn ALONG the impact track and fanning out as it goes, which is
 * what an aircraft or high-speed crash actually leaves — a circular scatter
 * around the fuselage reads as litter, not as a debris field.
 */
function debrisTrail(
  rng: Rng,
  out: SceneObjectSpec[],
  o: { n: number; from: number; length: number; spread: number },
): void {
  const span = Math.max(1, o.n - 1);
  for (let i = 0; i < o.n; i++) {
    const t = i / span;
    out.push(
      spec(
        'debris',
        o.from + t * o.length + rng.sub(-2, 2),
        rng.sub(-o.spread, o.spread) * (0.25 + t),
        rng.sub(0, 360),
      ),
    );
  }
}

/** The casualties + responders + cordon tail most road scenes share. */
function addMedicalResponse(
  rng: Rng,
  out: SceneObjectSpec[],
  opts: { nCas: number; ambulance?: boolean; cordon?: boolean; police?: boolean },
): void {
  for (let i = 0; i < opts.nCas; i++) {
    const g = rng.chance(0.5) ? 'casLying' : rng.chance(0.55) ? 'casBlanket' : rng.chance(0.5) ? 'casSitting' : 'casShock';
    out.push(spec(g, rng.sub(-3, 6), rng.sub(-5, 5), rng.sub(0, 360)));
  }
  out.push(spec('cpr', rng.sub(-1, 3), rng.sub(-2.5, 2.5), rng.sub(0, 360)));
  out.push(spec('paramedic', rng.sub(-6, -2), rng.sub(-3.5, 3.5), rng.sub(0, 360)));
  if (rng.chance(0.35)) out.push(spec('casRescueBag', rng.sub(-2, 3), rng.sub(-3, 3), rng.sub(0, 360)));
  if (rng.chance(0.4)) out.push(spec('medkit', rng.sub(-4, 2), rng.sub(-4, 4), rng.sub(0, 360)));
  if (opts.ambulance !== false && rng.chance(0.82))
    apparatus(rng, 'ambulanceLit', out, { backMin: 12, backMax: 20, side: [0, 5] });
  if (rng.chance(0.55)) out.push(spec('bystander', rng.sub(-9, -3), rng.sub(-7, -3), rng.sub(0, 360)));
  if (opts.police && rng.chance(0.7)) {
    apparatus(rng, 'policeCar', out, { backMin: 22, backMax: 30, side: [-6, 0], fend: true });
    out.push(spec('officer', rng.sub(-7, -1), rng.sub(3, 7), rng.sub(0, 360)));
    if (rng.chance(0.4)) out.push(spec('officer', rng.sub(4, 10), rng.sub(-6, -2), rng.sub(0, 360)));
  }
  if (opts.cordon !== false) {
    // taper in from the shoulder on the approach side…
    const shoulder = rng.chance(0.5) ? 1 : -1;
    coneTaper(rng, out, {
      from: -rng.sub(12, 18),
      side: shoulder * rng.sub(1, 3),
      count: rng.int(4, 6),
      gap: rng.sub(4, 6),
      drift: shoulder * rng.sub(5, 9),
    });
    // …and a shorter one closing the far side
    if (rng.chance(0.6))
      coneTaper(rng, out, {
        from: rng.sub(12, 18),
        side: -shoulder * rng.sub(1, 3),
        count: rng.int(2, 4),
        gap: rng.sub(4, 5.5),
        drift: -shoulder * rng.sub(4, 7),
      });
  }
}

// ---- scene generators ------------------------------------------------
type SceneGen = (rng: Rng) => SceneObjectSpec[];

const GENS: Record<string, { label: string; gen: SceneGen }> = {
  mva: {
    label: 'Vehicle accident',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      const flavour = rng.pick(['headon', 'rearend', 'tbone', 'single', 'rollover', 'pileup', 'vsHeavy', 'vsBike'] as const);
      const dmg = rng.pick(['wreckCarLight', 'wreckCar', 'wreckCar', 'wreckCarHeavy'] as const);
      const bad = flavour === 'vsHeavy' || flavour === 'pileup' || flavour === 'single';

      if (flavour === 'headon') {
        out.push(spec(dmg, 0, 0, rng.sub(-15, 15)));
        out.push(spec(rng.pick(['wreckCar', 'wreckSuv']), rng.sub(4, 8), rng.sub(-1.5, 1.5), 180 + rng.sub(-15, 15)));
      } else if (flavour === 'rearend') {
        out.push(spec(dmg, 0, 0, rng.sub(-8, 8)));
        out.push(spec(rng.pick(['wreckCar', 'wreckSuv', 'wreckTruck']), rng.sub(4.5, 6.5), rng.sub(-0.6, 0.6), rng.sub(-8, 8)));
      } else if (flavour === 'tbone') {
        out.push(spec(dmg, 0, 0, 0));
        out.push(spec(rng.pick(['wreckSuv', 'wreckCar']), rng.sub(1, 3), rng.sub(2.5, 4), 90 + rng.sub(-20, 20)));
      } else if (flavour === 'single') {
        out.push(spec(rng.pick(['wreckCarHeavy', 'wreckCar']), 0, 0, rng.sub(20, 60) * (rng.chance(0.5) ? 1 : -1)));
        out.push(spec('fence', rng.sub(-3, 3), rng.sub(-4, -2), rng.sub(0, 360)));
      } else if (flavour === 'rollover') {
        out.push(spec('wreckCarHeavy', 0, 0, rng.sub(0, 360)));
        scatter(rng, 'debris', rng.int(2, 4), 0, 0, 6, out);
      } else if (flavour === 'pileup') {
        for (let i = 0, n = rng.int(3, 5); i < n; i++)
          out.push(spec(rng.pick(['wreckCar', 'wreckSuv', 'wreckCarHeavy', 'wreckCarLight']), i * rng.sub(4, 6), rng.sub(-2.5, 2.5), rng.sub(-30, 30)));
      } else if (flavour === 'vsHeavy') {
        out.push(spec('wreckCarHeavy', 0, 0, rng.sub(-20, 20)));
        out.push(spec(rng.pick(['wreckTruck', 'tanker']), rng.sub(6, 10), rng.sub(-1, 2), rng.sub(-15, 15)));
      } else {
        out.push(spec(rng.pick(['wreckCar', 'wreckSuv']), 0, 0, rng.sub(-10, 10)));
        out.push(spec('wreckBike', rng.sub(2, 4), rng.sub(1, 3), rng.sub(0, 360)));
      }

      if (rng.chance(bad ? 0.4 : 0.15)) {
        out.push(spec('fireSmall', 0, 0, 0));
        out.push(spec('smoke', rng.sub(-1, 1), rng.sub(-1, 1), 0));
      }
      scatter(rng, 'debris', rng.int(1, 3), rng.sub(-2, 4), rng.sub(-3, 3), 4.5, out);
      addMedicalResponse(rng, out, { nCas: flavour === 'pileup' ? rng.int(2, 4) : rng.int(1, 3), police: true });
      if (rng.chance(0.35)) out.push(spec('towTruck', -rng.sub(16, 26), rng.sub(-2, 3), rng.sub(-15, 15)));
      return out;
    },
  },

  entrapment: {
    label: 'MVA with entrapment',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      out.push(spec(rng.pick(['wreckCarHeavy', 'wreckCar']), 0, 0, rng.sub(-15, 15)));
      out.push(spec(rng.pick(['wreckTruck', 'tanker', 'wreckBus']), rng.sub(6, 10), rng.sub(-1, 2), rng.sub(-12, 12)));
      if (rng.chance(0.5)) {
        out.push(spec('fireSmall', rng.sub(-1, 1), rng.sub(-1, 1), 0));
        out.push(spec('smoke', rng.sub(0, 2), rng.sub(-1, 1), 0));
      }
      scatter(rng, 'debris', rng.int(2, 4), 0, 0, 6, out);
      // rescue effort right on the vehicle
      out.push(spec('cpr', rng.sub(-1, 1.5), rng.sub(0.5, 2), rng.sub(0, 360)));
      out.push(spec('paramedic', rng.sub(-2, 1), rng.sub(-2.5, -0.5), rng.sub(0, 360)));
      out.push(spec('worker', rng.sub(-3, 0), rng.sub(1, 3), rng.sub(0, 360))); // fire service cutting
      out.push(spec('casSitting', rng.sub(-5, -2), rng.sub(-3, 2), rng.sub(0, 360)));
      apparatus(rng, 'ambulanceLit', out, { backMin: 12, backMax: 20, side: [2, 6] });
      if (rng.chance(0.7)) apparatus(rng, 'ambulance', out, { backMin: 20, backMax: 30, side: [-6, -1] });
      if (rng.chance(0.6)) out.push(spec('officer', rng.sub(-8, -3), rng.sub(4, 7), rng.sub(0, 360)));
      apparatus(rng, 'fireAppliance', out, { backMin: 8, backMax: 14, side: [-7, -3], fend: true });
      out.push(spec('generator', -rng.sub(6, 10), rng.sub(3, 6), 0));
      coneLine(rng, rng.sub(10, 16), rng.sub(-2, 2), rng.chance(0.5) ? 90 : 270, rng.int(4, 6), rng.sub(4, 5.5), out);
      coneLine(rng, -rng.sub(14, 20), rng.sub(-2, 2), rng.chance(0.5) ? 90 : 270, rng.int(2, 4), rng.sub(4, 5), out);
      return out;
    },
  },

  bus: {
    label: 'Bus / coach rollover (multi-casualty)',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      out.push(spec(rng.pick(['wreckBus', 'wreckBus']), 0, 0, rng.sub(30, 90) * (rng.chance(0.5) ? 1 : -1)));
      if (rng.chance(0.4)) out.push(spec(rng.pick(['wreckCar', 'wreckSuv']), rng.sub(-8, -4), rng.sub(3, 7), rng.sub(0, 360)));
      scatter(rng, 'debris', rng.int(3, 6), 0, 0, 12, out);
      // a spread of casualties down the embankment
      for (let i = 0, n = rng.int(6, 10); i < n; i++) {
        const g = rng.pick(['casLying', 'casBlanket', 'casSitting', 'casShock', 'casLying'] as const);
        out.push(spec(g, rng.sub(-6, 14), rng.sub(-14, 14), rng.sub(0, 360)));
      }
      out.push(spec('cpr', rng.sub(-2, 4), rng.sub(-3, 3), rng.sub(0, 360)));
      out.push(spec('paramedic', rng.sub(-3, 3), rng.sub(-4, 4), rng.sub(0, 360)));
      out.push(spec('paramedic', rng.sub(-3, 6), rng.sub(-5, 5), rng.sub(0, 360)));
      out.push(spec('casRescueBag', rng.sub(-2, 4), rng.sub(-3, 3), rng.sub(0, 360)));
      out.push(spec('ambulanceLit', -rng.sub(14, 22), rng.sub(-2, 4), rng.sub(-15, 15)));
      out.push(spec('ambulance', -rng.sub(22, 32), rng.sub(2, 8), rng.sub(-15, 15)));
      out.push(spec('officer', rng.sub(-8, 8), rng.sub(6, 10), rng.sub(0, 360)));
      coneLine(rng, rng.sub(14, 20), rng.sub(-4, 4), rng.chance(0.5) ? 90 : 270, rng.int(4, 7), rng.sub(4, 6), out);
      return out;
    },
  },

  vehicleFire: {
    label: 'Vehicle fire',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      out.push(spec(rng.pick(['wreckCarHeavy', 'wreckCar']), 0, 0, rng.sub(-20, 20)));
      out.push(spec(rng.chance(0.4) ? 'fireBig' : 'fireSmall', 0, rng.sub(-0.5, 0.5), 0));
      out.push(spec('smokeBig', rng.sub(-1, 2), rng.sub(-1, 1), 0));
      if (rng.chance(0.3)) out.push(spec('fireSmall', rng.sub(2, 5), rng.sub(-2, 2), 0));
      scatter(rng, 'debris', rng.int(1, 3), rng.sub(-3, 3), rng.sub(-3, 3), 4, out);
      apparatus(rng, 'fireAppliance', out, { backMin: 14, backMax: 22, side: [2, 7], fend: true });
      out.push(spec('worker', -rng.sub(6, 10), rng.sub(1, 4), rng.sub(0, 360)));
      out.push(spec('worker', -rng.sub(5, 9), rng.sub(-4, -1), rng.sub(0, 360)));
      if (rng.chance(0.5)) out.push(spec('casSitting', -rng.sub(8, 14), rng.sub(-5, 0), rng.sub(0, 360)));
      if (rng.chance(0.4)) out.push(spec('officer', rng.sub(-6, -2), rng.sub(5, 8), rng.sub(0, 360)));
      coneLine(rng, rng.sub(8, 14), rng.sub(-2, 2), rng.chance(0.5) ? 90 : 270, rng.int(3, 5), rng.sub(4, 5.5), out);
      return out;
    },
  },

  grassfire: {
    label: 'Bush / grass fire',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      // a flame front — a line of fires across the nose, drifting
      const along = rng.chance(0.5) ? 90 : 270;
      const rad = (along * Math.PI) / 180;
      for (let i = 0, n = rng.int(3, 5); i < n; i++) {
        const t = (i - (rng.int(3, 5) - 1) / 2) * rng.sub(10, 16);
        out.push(spec(rng.chance(0.4) ? 'fireBig' : 'fireSmall', rng.sub(-4, 4) + Math.cos(rad) * t, Math.sin(rad) * t, 0));
      }
      out.push(spec('smokeBig', rng.sub(2, 8), rng.sub(-6, 6), 0));
      out.push(spec('smokeBig', rng.sub(6, 16), rng.sub(-10, 10), 0));
      scatter(rng, 'smoke', rng.int(1, 3), rng.sub(-10, 20), rng.sub(-16, 16), 8, out);
      // appliance + crew, upwind
      apparatus(rng, 'fireAppliance', out, { backMin: 30, backMax: 45, side: [2, 8], fend: true });
      out.push(spec('worker', -rng.sub(22, 30), rng.sub(-3, 3), rng.sub(0, 360)));
      out.push(spec('worker', -rng.sub(20, 28), rng.sub(-5, 1), rng.sub(0, 360)));
      if (rng.chance(0.5)) out.push(spec('atv', -rng.sub(24, 34), rng.sub(-8, -2), rng.sub(0, 360)));
      if (rng.chance(0.4)) out.push(spec('casSitting', -rng.sub(24, 32), rng.sub(3, 7), rng.sub(0, 360)));
      return out;
    },
  },

  structurefire: {
    label: 'Structure fire — persons reported',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      out.push(spec('fireBig', 0, 0, 0));
      out.push(spec('smokeBig', rng.sub(-2, 2), rng.sub(-2, 2), 0));
      out.push(spec('smokeBig', rng.sub(2, 8), rng.sub(-3, 3), 0));
      out.push(spec('scaffold', rng.sub(-4, 4), rng.sub(-6, -3), rng.sub(0, 360)));
      out.push(spec('ladder', rng.sub(-3, 2), rng.sub(2, 5), rng.sub(0, 360)));
      scatter(rng, 'debris', rng.int(2, 4), 0, 0, 8, out);
      out.push(spec('casBlanket', -rng.sub(10, 16), rng.sub(-4, 2), rng.sub(0, 360)));
      out.push(spec('casSitting', -rng.sub(9, 15), rng.sub(1, 5), rng.sub(0, 360)));
      out.push(spec('cpr', -rng.sub(11, 15), rng.sub(-2, 2), rng.sub(0, 360)));
      out.push(spec('paramedic', -rng.sub(8, 13), rng.sub(-4, 4), rng.sub(0, 360)));
      apparatus(rng, 'fireAppliance', out, { backMin: 16, backMax: 24, side: [2, 8], fend: true });
      apparatus(rng, 'ambulanceLit', out, { backMin: 24, backMax: 32, side: [-8, -3] });
      out.push(spec('worker', -rng.sub(6, 10), rng.sub(-6, 6), rng.sub(0, 360)));
      out.push(spec('family', -rng.sub(12, 18), rng.sub(-8, -4), rng.sub(0, 360)));
      if (rng.chance(0.6)) out.push(spec('officer', -rng.sub(10, 16), rng.sub(6, 9), rng.sub(0, 360)));
      return out;
    },
  },

  levelcrossing: {
    label: 'Level crossing — train vs vehicle',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      // train, roughly along the nose; a couple of carriages
      const along = rng.chance(0.5) ? 90 : 270;
      const rad = (along * Math.PI) / 180;
      out.push(spec('trainPower', 0, 0, along));
      // the crossing itself — flashing-light masts either side of the track
      out.push(spec('railCrossing', rng.sub(5, 9), Math.sin(rad) * rng.sub(6, 9), along + 90));
      out.push(spec('railCrossing', -rng.sub(5, 9), Math.sin(rad) * -rng.sub(6, 9), along + 90));
      for (let i = 1; i <= rng.int(1, 3); i++) out.push(spec('trainCar', -Math.cos(rad) * i * 22, -Math.sin(rad) * i * 22, along));
      // the vehicle, mangled, thrown clear
      out.push(spec('wreckCarHeavy', rng.sub(6, 12), rng.sub(-2, 3) + Math.sin(rad) * 4, rng.sub(0, 360)));
      if (rng.chance(0.5)) out.push(spec('fireSmall', rng.sub(6, 12), rng.sub(-1, 2), 0));
      scatter(rng, 'debris', rng.int(3, 5), rng.sub(2, 10), rng.sub(-6, 6), 6, out);
      addMedicalResponse(rng, out, { nCas: rng.int(1, 2), police: true });
      out.push(spec('worker', rng.sub(-4, 2), Math.sin(rad) * 6, rng.sub(0, 360))); // rail staff
      return out;
    },
  },

  winch: {
    label: 'Cliff / coastal rescue (winch)',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      // casualty on the rocks / at the cliff base
      out.push(spec(rng.chance(0.4) ? 'casRescueBag' : 'casLying', 0, 0, rng.sub(0, 360)));
      out.push(spec('cpr', rng.sub(0.5, 2), rng.sub(-1.5, 1.5), rng.sub(0, 360)));
      if (rng.chance(0.5)) out.push(spec('paraglider', rng.sub(-2, 3), rng.sub(-3, 3), rng.sub(0, 360)));
      scatter(rng, 'debris', rng.int(1, 3), rng.sub(-2, 3), rng.sub(-3, 3), 4, out);
      // rescuers / SLS on the cliff-top, marked
      out.push(spec('worker', -rng.sub(8, 14), rng.sub(-3, 3), rng.sub(0, 360)));
      out.push(spec('bystander', -rng.sub(10, 16), rng.sub(-6, -2), rng.sub(0, 360)));
      out.push(spec('bystander', -rng.sub(10, 16), rng.sub(2, 6), rng.sub(0, 360)));
      out.push(spec('beacon', -rng.sub(12, 18), rng.sub(-1, 1), 0));
      out.push(spec('flare', -rng.sub(11, 17), rng.sub(-2, 2), 0));
      if (rng.chance(0.5)) out.push(spec('officer', -rng.sub(9, 15), rng.sub(4, 8), rng.sub(0, 360)));
      return out;
    },
  },

  swiftwater: {
    label: 'Swiftwater / flood rescue',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      out.push(spec(rng.chance(0.5) ? 'wreckCar' : 'carIntact', 0, 0, rng.sub(0, 360))); // vehicle in the water
      for (let i = 0, n = rng.int(2, 4); i < n; i++) out.push(spec(rng.chance(0.5) ? 'casSitting' : 'casShock', rng.sub(-2, 3), rng.sub(-3, 3), rng.sub(0, 360)));
      out.push(spec('rescueBoat', -rng.sub(6, 12), rng.sub(-4, 4), rng.sub(0, 360)));
      out.push(spec('worker', -rng.sub(3, 7), rng.sub(-3, 3), rng.sub(0, 360)));
      out.push(spec('flare', -rng.sub(10, 16), rng.sub(-2, 2), 0));
      out.push(spec('ambulanceLit', -rng.sub(18, 28), rng.sub(2, 7), rng.sub(-15, 15)));
      if (rng.chance(0.5)) out.push(spec('family', -rng.sub(14, 20), rng.sub(-7, -3), rng.sub(0, 360)));
      return out;
    },
  },

  marine: {
    label: 'Marine — disabled vessel',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      out.push(spec('boatDisabled', 0, 0, rng.sub(0, 360)));
      if (rng.chance(0.5)) out.push(spec('liferaft', rng.sub(3, 8), rng.sub(-4, 4), rng.sub(0, 360)));
      out.push(spec('flare', rng.sub(-2, 2), rng.sub(-2, 2), 0));
      out.push(spec('rescueBoat', -rng.sub(10, 20), rng.sub(-6, 6), rng.sub(0, 360)));
      scatter(rng, 'debris', rng.int(1, 3), rng.sub(4, 14), rng.sub(-8, 8), 8, out);
      if (rng.chance(0.35)) out.push(spec('ship', rng.sub(80, 160), rng.sub(-60, 60), rng.sub(0, 360)));
      return out;
    },
  },

  marinefire: {
    label: 'Vessel on fire offshore',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      out.push(spec('boatFire', 0, 0, rng.sub(0, 360)));
      out.push(spec('smokeBig', rng.sub(-2, 3), rng.sub(-2, 2), 0));
      out.push(spec('liferaft', rng.sub(6, 14), rng.sub(-6, 6), rng.sub(0, 360)));
      out.push(spec('flare', rng.sub(4, 10), rng.sub(-4, 4), 0));
      out.push(spec('rescueBoat', -rng.sub(12, 22), rng.sub(-6, 6), rng.sub(0, 360)));
      if (rng.chance(0.4)) out.push(spec('oilRig', rng.sub(100, 200), rng.sub(-80, 80), rng.sub(0, 360)));
      return out;
    },
  },

  sar: {
    label: 'Search & rescue — datum',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      out.push(spec('liferaft', 0, 0, rng.sub(0, 360)));
      out.push(spec('flare', rng.sub(-3, 3), rng.sub(-3, 3), 0));
      out.push(spec('flare', rng.sub(5, 15), rng.sub(-8, 8), 0));
      scatter(rng, 'debris', rng.int(2, 4), 0, 0, 20, out);
      if (rng.chance(0.5)) out.push(spec('boatDisabled', rng.sub(20, 60), rng.sub(-40, 40), rng.sub(0, 360)));
      return out;
    },
  },

  helicrash: {
    label: 'Helicopter / aircraft crash',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      out.push(spec(rng.chance(0.6) ? 'heliWreck' : 'planeWreckLight', 0, 0, rng.sub(0, 360)));
      if (rng.chance(0.6)) {
        out.push(spec('fireBig', rng.sub(-1, 2), rng.sub(-1, 1), 0));
        out.push(spec('smokeBig', rng.sub(1, 4), rng.sub(-2, 2), 0));
      }
      debrisTrail(rng, out, { n: rng.int(4, 6), from: rng.sub(3, 6), length: rng.sub(18, 34), spread: rng.sub(4, 8) });
      addMedicalResponse(rng, out, { nCas: rng.int(1, 3), police: true, cordon: true });
      return out;
    },
  },

  rural: {
    label: 'Rural property — retrieval',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      const mech = rng.pick(['tractor', 'quad', 'silo', 'machinery'] as const);
      if (mech === 'tractor') out.push(spec('tractor', rng.sub(2, 6), rng.sub(-3, 3), rng.sub(20, 70) * (rng.chance(0.5) ? 1 : -1)));
      else if (mech === 'quad') out.push(spec('atv', rng.sub(1, 4), rng.sub(-2, 3), rng.sub(0, 360)));
      else if (mech === 'silo') out.push(spec('tractor', rng.sub(1, 4), rng.sub(-3, 3), rng.sub(0, 360))); // header/combine
      else out.push(spec('plant', rng.sub(2, 6), rng.sub(-3, 3), rng.sub(0, 360)));
      out.push(spec(rng.chance(0.5) ? 'casLying' : 'casRescueBag', 0, 0, rng.sub(0, 360)));
      out.push(spec('cpr', rng.sub(0.5, 2), rng.sub(-1.5, 1.5), rng.sub(0, 360)));
      out.push(spec('worker', rng.sub(-4, 0), rng.sub(2, 5), rng.sub(0, 360))); // property owner / mate
      if (rng.chance(0.5)) out.push(spec(rng.chance(0.5) ? 'horse' : 'dog', rng.sub(-8, -3), rng.sub(-6, -2), rng.sub(0, 360)));
      out.push(spec('carIntact', -rng.sub(12, 20), rng.sub(-4, 3), rng.sub(0, 360))); // ute
      out.push(spec('cone', -rng.sub(16, 24), rng.sub(-1, 1), 0)); // paddock marker
      out.push(spec('flare', -rng.sub(15, 23), rng.sub(-2, 2), 0));
      return out;
    },
  },

  industrial: {
    label: 'Industrial / construction incident',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      out.push(spec('plant', rng.sub(1, 5), rng.sub(-3, 3), rng.sub(0, 360)));
      if (rng.chance(0.4)) out.push(spec('plant', rng.sub(-6, -2), rng.sub(3, 7), rng.sub(0, 360)));
      out.push(spec('scaffold', rng.sub(-3, 3), rng.sub(-6, -3), rng.sub(0, 360)));
      if (rng.chance(0.3)) {
        out.push(spec('fireSmall', rng.sub(0, 3), rng.sub(-1, 1), 0));
        out.push(spec('smoke', rng.sub(1, 4), rng.sub(-1, 1), 0));
      }
      scatter(rng, 'debris', rng.int(3, 5), 0, 0, 8, out);
      out.push(spec(rng.chance(0.5) ? 'casLying' : 'casRescueBag', 0, 0, rng.sub(0, 360)));
      out.push(spec('cpr', rng.sub(0.5, 2), rng.sub(-1.5, 1.5), rng.sub(0, 360)));
      out.push(spec('worker', rng.sub(-4, 0), rng.sub(2, 5), rng.sub(0, 360)));
      out.push(spec('worker', rng.sub(-3, 1), rng.sub(-5, -2), rng.sub(0, 360)));
      out.push(spec('paramedic', -rng.sub(6, 10), rng.sub(-3, 3), rng.sub(0, 360)));
      out.push(spec('ambulanceLit', -rng.sub(14, 22), rng.sub(2, 7), rng.sub(-15, 15)));
      coneLine(rng, rng.sub(8, 14), rng.sub(-2, 2), rng.chance(0.5) ? 90 : 270, rng.int(3, 5), rng.sub(4, 5.5), out);
      return out;
    },
  },

  powerline: {
    label: 'Powerline strike / electrocution',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      // two pylons so it reads as a span, with the strike under the wires
      out.push(spec('powerline', 0, rng.sub(-2, 2), 0));
      out.push(spec('powerline', rng.sub(45, 70) * (rng.chance(0.5) ? 1 : -1), rng.sub(-3, 3), 0));
      out.push(spec(rng.chance(0.5) ? 'plant' : 'tractor', rng.sub(1, 4), rng.sub(-2, 3), rng.sub(0, 360)));
      if (rng.chance(0.4)) out.push(spec('fireSmall', rng.sub(1, 4), rng.sub(-1, 2), 0));
      out.push(spec('casLying', rng.sub(-2, 2), rng.sub(-2, 2), rng.sub(0, 360)));
      out.push(spec('cpr', rng.sub(0.5, 2), rng.sub(-1.5, 1.5), rng.sub(0, 360)));
      out.push(spec('worker', rng.sub(-4, 0), rng.sub(2, 5), rng.sub(0, 360)));
      out.push(spec('ambulanceLit', -rng.sub(14, 22), rng.sub(2, 7), rng.sub(-15, 15)));
      out.push(spec('officer', rng.sub(-6, -2), rng.sub(4, 8), rng.sub(0, 360)));
      coneLine(rng, rng.sub(9, 15), rng.sub(-2, 2), rng.chance(0.5) ? 90 : 270, rng.int(4, 6), rng.sub(4, 6), out);
      coneLine(rng, -rng.sub(12, 18), rng.sub(-2, 2), rng.chance(0.5) ? 90 : 270, rng.int(3, 5), rng.sub(4, 5.5), out);
      return out;
    },
  },

  police: {
    label: 'Police — containment / cordon',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      out.push(spec('policeCar', 0, 0, rng.sub(-15, 15)));
      out.push(spec('policeCar', -rng.sub(10, 16), rng.sub(2, 6), 20 + rng.sub(-15, 15)));
      if (rng.chance(0.6)) out.push(spec('ambulance', -rng.sub(16, 24), rng.sub(-6, -2), rng.sub(-15, 15)));
      out.push(spec(rng.chance(0.5) ? 'carIntact' : 'wreckCarLight', rng.sub(10, 18), rng.sub(-2, 3), rng.sub(30, 90))); // vehicle of interest
      for (let i = 0, n = rng.int(2, 4); i < n; i++) out.push(spec('officer', rng.sub(-8, 12), rng.sub(-8, 8), rng.sub(0, 360)));
      if (rng.chance(0.5)) out.push(spec('dog', rng.sub(-4, 6), rng.sub(3, 7), rng.sub(0, 360)));
      if (rng.chance(0.4)) out.push(spec('casSitting', rng.sub(4, 10), rng.sub(-4, 1), rng.sub(0, 360)));
      out.push(spec('bystander', -rng.sub(8, 14), rng.sub(-8, -4), rng.sub(0, 360)));
      coneLine(rng, rng.sub(6, 12), rng.sub(-3, 3), rng.chance(0.5) ? 90 : 270, rng.int(4, 7), rng.sub(3.5, 5), out);
      coneLine(rng, -rng.sub(10, 16), rng.sub(-3, 3), rng.chance(0.5) ? 90 : 270, rng.int(3, 5), rng.sub(3.5, 5), out);
      return out;
    },
  },

  search: {
    label: 'Missing person — bushland search',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      // staging: vehicle + markers + searchers heading out
      out.push(spec(rng.chance(0.5) ? 'carIntact' : 'ambulanceLit', 0, 0, rng.sub(-15, 15)));
      if (rng.chance(0.6)) out.push(spec('atv', rng.sub(-6, -2), rng.sub(2, 6), rng.sub(0, 360)));
      // searchers sweep LINE ABREAST away from the staging point, evenly spaced
      // and all facing the search direction — not milling about at random.
      const n = rng.int(4, 6);
      const lineAt = rng.sub(10, 18);
      const centre = rng.sub(-4, 4);
      const gap = rng.sub(6, 9);
      for (let i = 0; i < n; i++) {
        out.push(
          spec(
            rng.chance(0.65) ? 'worker' : 'bystander',
            lineAt + rng.sub(-2.5, 2.5),
            centre + (i - (n - 1) / 2) * gap,
            rng.sub(-25, 25),
          ),
        );
      }
      out.push(spec('officer', rng.sub(-3, 3), rng.sub(-3, 3), rng.sub(0, 360)));
      out.push(spec('beacon', rng.sub(-2, 2), rng.sub(-2, 2), 0));
      scatter(rng, 'cone', rng.int(3, 5), rng.sub(6, 16), rng.sub(-10, 10), 8, out);
      if (rng.chance(0.3)) out.push(spec('dog', rng.sub(2, 8), rng.sub(-6, 6), rng.sub(0, 360)));
      return out;
    },
  },

  airstrip: {
    label: 'Airstrip — aeromedical',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      out.push(spec(rng.chance(0.5) ? 'casRescueBag' : 'casBlanket', 0, 0, rng.sub(0, 360)));
      out.push(spec('paramedic', rng.sub(0.5, 2), rng.sub(-1.5, 1.5), rng.sub(0, 360)));
      if (rng.chance(0.5)) out.push(spec('cpr', rng.sub(-1, 2), rng.sub(-2, 2), rng.sub(0, 360)));
      out.push(spec('ambulanceLit', -rng.sub(8, 14), rng.sub(3, 8), rng.sub(-15, 15)));
      out.push(spec('worker', -rng.sub(4, 8), rng.sub(-4, 2), rng.sub(0, 360))); // clinic staff
      out.push(spec('medkit', rng.sub(-3, 2), rng.sub(-3, 3), rng.sub(0, 360)));
      out.push(spec('stretcher', rng.sub(-2, 2), rng.sub(-2, 2), rng.sub(-20, 20)));
      // strip edge markers
      const along = rng.chance(0.5) ? 90 : 270;
      coneLine(rng, -rng.sub(18, 26), rng.sub(-2, 2), along, rng.int(3, 5), rng.sub(8, 12), out);
      out.push(spec('flare', -rng.sub(20, 28), rng.sub(-2, 2), 0));
      return out;
    },
  },

  diving: {
    label: 'Diving incident — decompression illness',
    gen: (rng) => {
      const out: SceneObjectSpec[] = [];
      out.push(spec('boat', rng.sub(-2, 4), rng.sub(-6, -2), rng.sub(0, 360))); // dive charter at the ramp
      out.push(spec(rng.chance(0.5) ? 'casSitting' : 'casShock', 0, 0, rng.sub(0, 360)));
      out.push(spec('cpr', rng.sub(0.5, 2), rng.sub(-1.5, 1.5), rng.sub(0, 360)));
      out.push(spec('worker', rng.sub(-3, 1), rng.sub(2, 5), rng.sub(0, 360))); // dive buddy
      out.push(spec('medkit', rng.sub(-2, 2), rng.sub(-2, 2), rng.sub(0, 360)));
      out.push(spec('ambulanceLit', -rng.sub(10, 18), rng.sub(3, 8), rng.sub(-15, 15)));
      if (rng.chance(0.4)) out.push(spec('bystander', -rng.sub(6, 12), rng.sub(-6, -2), rng.sub(0, 360)));
      return out;
    },
  },

  marker: {
    label: 'Single marker',
    gen: (rng) => [spec('beacon', 0, 0, 0), spec('flare', rng.sub(-1, 1), rng.sub(-1, 1), 0)],
  },
};

export const SCENE_LIST = Object.entries(GENS).map(([id, s]) => ({ id, label: s.label }));

const MAX_OBJECTS = 22;

/** Build a randomised scene layout for `id`, seeded by `seed` (so all units in a
 *  session get the same one). */
export function getSceneObjects(id: string, seed: string): SceneObjectSpec[] {
  const g = GENS[id] ?? GENS.marker!;
  const rng = makeRng(`${id}|${seed || 'x'}`);
  let objs = g.gen(rng);
  // Over the cap, drop decoration (cones, debris) before incident content —
  // a blind slice used to delete the cordon, and most of a bus MCI's response.
  if (objs.length > MAX_OBJECTS) {
    const keep = objs
      .map((o, i) => ({ i, p: i === 0 ? 9 : priority(o.group) }))
      .sort((a, b) => b.p - a.p || a.i - b.i)
      .slice(0, MAX_OBJECTS)
      .map((x) => x.i)
      .sort((a, b) => a - b);
    objs = keep.map((i) => objs[i]!);
  }
  separate(objs);
  return objs;
}

/** Legacy — a fixed 3-object version, still used if something calls getScene(). */
export function getScene(id: string): { id: string; label: string; objects: SceneObjectSpec[] } {
  return { id, label: GENS[id]?.label ?? id, objects: getSceneObjects(id, 'legacy') };
}

/** Resolve an object spec to its ordered title chain. */
export function sceneObjectTitles(obj: SceneObjectSpec): string[] {
  return groupTitles(obj.group);
}

export function sceneForJob(kind: string, category = ''): string {
  const s = `${kind} ${category}`.toLowerCase();
  if (/\bentrap|trapped\b/.test(s)) return 'entrapment';
  if (/\bbus|coach\b/.test(s)) return 'bus';
  if (/level crossing|train vs|vs train|rail crossing/.test(s)) return 'levelcrossing';
  if (/swiftwater|flood rescue|floodwater/.test(s)) return 'swiftwater';
  if (/vessel .*fire|boat .*fire|rig fire|marine .*fire/.test(s)) return 'marinefire';
  if (/search and rescue|distress beacon|search.*datum/.test(s)) return 'sar';
  if (/\bmarine|vessel|overboard|epirb|maritime|diving|decompression\b/.test(s)) return /diving|decompression/.test(s) ? 'diving' : 'marine';
  if (/\bcliff|abseil|rock platform|coastal .*rescue|surf\b/.test(s)) return 'winch';
  if (/heli.*crash|aircraft crash|plane crash|agricultural aircraft/.test(s)) return 'helicrash';
  if (/\boffender|containment|pursuit|police\b/.test(s)) return 'police';
  if (/missing person|bushwalker|search \/ off|dementia/.test(s)) return 'search';
  if (/structure fire|house fire|shed fire|building fire/.test(s)) return 'structurefire';
  if (/vehicle fire/.test(s)) return 'vehicleFire';
  if (/\bfire|bushfire|grass ?fire|air attack|mapping|crew insertion|reconnaissance|line ?scan\b/.test(s)) return 'grassfire';
  if (/powerline|electrocution|electrical contact/.test(s)) return 'powerline';
  if (/mine|quarry|industrial|construction|silo|machinery entangle/.test(s)) return 'industrial';
  if (/\b(mva|mvc|mvac|vehicle accident|motor vehicle|collision|crash|rta)\b/.test(s)) return 'mva';
  if (/diving|decompression|dci/.test(s)) return 'diving';
  if (/retrieval|property|farm|station|paddock|envenom|snakebite/.test(s)) return 'rural';
  if (/rfds|evacuation|inter-hospital|transfer|airstrip|aeromedical|neonatal|obstetric|burns/.test(s)) return 'airstrip';
  return 'marker';
}
