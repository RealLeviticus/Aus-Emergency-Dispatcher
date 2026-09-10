import { useEffect, useRef } from 'react';
import L from 'leaflet';
import type { InjectedObject, PeerPresence, SimPosition } from '../lib/sim';

type LatLng = { lat: number; lon: number };

function dot(color: string, label?: string): L.DivIcon {
  return L.divIcon({
    className: '',
    iconSize: [12, 12],
    iconAnchor: [6, 6],
    html: `<div style="display:flex;align-items:center;gap:4px">
      <span style="width:12px;height:12px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 1px #0006"></span>
      ${label ? `<span style="font:700 11px Tahoma,sans-serif;color:#000;background:#ffffffcc;padding:0 3px;white-space:nowrap">${label}</span>` : ''}
    </div>`,
  });
}

function aircraftIcon(headingDeg: number, color: string, label?: string): L.DivIcon {
  return L.divIcon({
    className: '',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    html: `<div style="position:relative">
      <div style="transform:rotate(${headingDeg}deg);width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;border-bottom:16px solid ${color};filter:drop-shadow(0 0 1px #000)"></div>
      ${label ? `<span style="position:absolute;left:14px;top:0;font:700 11px Tahoma,sans-serif;color:#000;background:#ffffffcc;padding:0 3px;white-space:nowrap">${label}</span>` : ''}
    </div>`,
  });
}

/**
 * The scene marker. A plain 12px dot disappears into map detail the moment you
 * zoom out far enough to see the base as well, which is exactly when you most
 * need to know where you're going — so this one is a haloed crosshair with a
 * high-contrast label chip.
 */
function sceneIcon(label: string, color = '#e00000'): L.DivIcon {
  return L.divIcon({
    className: '',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    html: `<div style="position:relative;width:30px;height:30px">
      <span style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.18"></span>
      <span style="position:absolute;inset:8px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 1px #0009"></span>
      <span style="position:absolute;left:14px;top:-4px;width:2px;height:9px;background:${color};box-shadow:0 0 0 1px #fff9"></span>
      <span style="position:absolute;left:14px;bottom:-4px;width:2px;height:9px;background:${color};box-shadow:0 0 0 1px #fff9"></span>
      <span style="position:absolute;top:14px;left:-4px;height:2px;width:9px;background:${color};box-shadow:0 0 0 1px #fff9"></span>
      <span style="position:absolute;top:14px;right:-4px;height:2px;width:9px;background:${color};box-shadow:0 0 0 1px #fff9"></span>
      <span style="position:absolute;left:20px;top:8px;max-width:150px;overflow:hidden;text-overflow:ellipsis;font:700 11px Tahoma,sans-serif;color:#000;background:#ffffffe6;border:1px solid ${color};padding:0 3px;white-space:nowrap">${label}</span>
    </div>`,
  });
}

type TargetRoute = {
  label: string;
  loop?: boolean;
  route: { lat: number; lon: number; altFt: number; speedKt: number }[];
};
type Contact = {
  lat: number;
  lon: number;
  headingDeg: number;
  label?: string;
  altFt?: number;
  speedKt?: number;
  holding?: boolean;
};

export default function MapView({
  aircraft,
  trail,
  job,
  scene,
  base,
  peers,
  objects,
  targetRoutes,
  contacts,
}: {
  aircraft: SimPosition | null;
  trail: LatLng[];
  job: { lat: number; lon: number; name: string } | null;
  scene?: { lat: number; lon: number; name: string } | null;
  base?: { lat: number; lon: number; name: string } | null;
  peers: PeerPresence[];
  objects: InjectedObject[];
  /** RAAFv: planned track(s) of the intercept target(s) */
  targetRoutes?: TargetRoute[];
  /** RAAFv: live position of the airborne contact(s) */
  contacts?: Contact[];
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef(false);
  /** the operator has panned/zoomed by hand — stop re-framing under them */
  const userMovedRef = useRef(false);
  /** set while WE move the map, so our own moves aren't read as user intent */
  const programmaticRef = useRef(false);
  /** latest points of interest, for the re-centre control */
  const ptsRef = useRef<[number, number][]>([]);

  /** Frame a set of points without tripping the user-moved detector. */
  const frameTo = (map: L.Map, pts: [number, number][]) => {
    if (pts.length === 0) return;
    programmaticRef.current = true;
    if (pts.length >= 2) map.fitBounds(L.latLngBounds(pts).pad(0.35));
    else map.setView(pts[0]!, 13);
    // cleared after Leaflet has finished emitting move/zoom events
    setTimeout(() => {
      programmaticRef.current = false;
    }, 0);
  };

  // Re-frame when the target changes (e.g. scene -> hospital on a medivac), or
  // when an intercept target route / live contact first appears or goes away.
  // A hand-positioned map is left alone — that is the operator's choice.
  useEffect(() => {
    fittedRef.current = false;
  }, [job?.name, (targetRoutes ?? []).length, (contacts ?? []).length > 0]);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: true, attributionControl: false }).setView(
      job ? [job.lat, job.lon] : aircraft ? [aircraft.lat, aircraft.lon] : [-37.73, 144.9],
      10,
    );
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // Any hand movement pins the view. Dragging is unambiguous; zoom also fires
    // for our own fitBounds/setView, hence the programmatic guard.
    map.on('dragstart', () => {
      userMovedRef.current = true;
    });
    map.on('zoomstart', () => {
      if (!programmaticRef.current) userMovedRef.current = true;
    });

    // ...and a way back. Without this, panning away would strand the operator.
    const Recentre = L.Control.extend({
      options: { position: 'topleft' as L.ControlPosition },
      onAdd() {
        const a = L.DomUtil.create('a');
        a.href = '#';
        a.title = 'Re-centre on the scene';
        a.setAttribute('role', 'button');
        a.innerHTML = '◎';
        Object.assign(a.style, {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '30px',
          height: '30px',
          font: '700 16px Tahoma,sans-serif',
          background: '#fff',
          color: '#000',
          textDecoration: 'none',
        });
        L.DomEvent.on(a, 'click', (e) => {
          L.DomEvent.stop(e);
          userMovedRef.current = false;
          fittedRef.current = false;
          frameTo(map, ptsRef.current);
          fittedRef.current = true;
        });
        const wrap = L.DomUtil.create('div', 'leaflet-bar');
        wrap.appendChild(a);
        L.DomEvent.disableClickPropagation(wrap);
        return wrap;
      },
    });
    map.addControl(new Recentre());

    // Leaflet measures the container when it is created. In a dialog the panel
    // is often still 0-height at that moment, so the first fitBounds is
    // computed against nothing and lands off-target — which is how the job
    // marker ended up outside the view while the hospital sat centred. Re-measure
    // whenever the panel is sized, and re-frame while the map is still ours.
    const ro = new ResizeObserver(() => {
      map.invalidateSize();
      if (!userMovedRef.current && ptsRef.current.length > 0) frameTo(map, ptsRef.current);
    });
    ro.observe(elRef.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    if (trail.length > 1) {
      L.polyline(
        trail.map((p) => [p.lat, p.lon] as [number, number]),
        { color: '#1084d0', weight: 2, opacity: 0.85 },
      ).addTo(layer);
    }

    if (base && Number.isFinite(base.lat)) {
      L.marker([base.lat, base.lon], { icon: dot('#0a7', `⌂ ${base.name}`) }).addTo(layer);
      if (job) {
        L.polyline(
          [
            [base.lat, base.lon],
            [job.lat, job.lon],
          ],
          { color: '#0a7', weight: 1, dashArray: '2 5', opacity: 0.7 },
        ).addTo(layer);
      }
    }

    if (scene) {
      L.marker([scene.lat, scene.lon], { icon: sceneIcon(scene.name, '#c07000') }).addTo(layer);
    }
    if (job) {
      L.marker([job.lat, job.lon], { icon: sceneIcon(job.name) }).addTo(layer);
      // 0.5 NM ring, lightly filled — zoomed out, the fill is what you actually see.
      L.circle([job.lat, job.lon], {
        radius: 926,
        color: '#e00000',
        weight: 1,
        fill: true,
        fillColor: '#e00000',
        fillOpacity: 0.08,
      }).addTo(layer);
      if (scene) {
        L.polyline(
          [
            [scene.lat, scene.lon],
            [job.lat, job.lon],
          ],
          { color: '#e00000', weight: 1, dashArray: '4 4' },
        ).addTo(layer);
      }
    }

    for (const o of objects) {
      if (o.isAircraft) continue; // aircraft contacts are drawn below
      L.marker([o.lat, o.lon], { icon: dot(o.error ? '#808080' : '#008000') }).addTo(layer);
    }

    // RAAFv: planned target track(s) + start marker
    for (const tr of targetRoutes ?? []) {
      if (tr.route.length < 2) continue;
      const pts = tr.route.map((w) => [w.lat, w.lon] as [number, number]);
      if (tr.loop) pts.push(pts[0]!);
      L.polyline(pts, { color: '#c0179c', weight: 2, dashArray: '6 5', opacity: 0.9 }).addTo(layer);
      for (const w of tr.route) {
        L.circleMarker([w.lat, w.lon], { radius: 2.5, color: '#c0179c', weight: 1, fillOpacity: 1 }).addTo(layer);
      }
      const s = tr.route[0]!;
      L.marker([s.lat, s.lon], { icon: dot('#c0179c', `${tr.label} — start`) }).addTo(layer);
    }

    // RAAFv: live airborne contact(s)
    for (const c of contacts ?? []) {
      const meta = [
        c.altFt ? `FL${Math.round(c.altFt / 100)}` : '',
        c.speedKt ? `${Math.round(c.speedKt)}kt` : '',
        c.holding ? 'HOLDING' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      L.marker([c.lat, c.lon], {
        icon: aircraftIcon(
          c.headingDeg,
          c.holding ? '#e0a000' : '#e00000',
          `${c.label ?? 'contact'}${meta ? ` (${meta})` : ''}`,
        ),
      }).addTo(layer);
      if (aircraft) {
        L.polyline(
          [
            [aircraft.lat, aircraft.lon],
            [c.lat, c.lon],
          ],
          { color: '#e00000', weight: 1, dashArray: '2 6', opacity: 0.6 },
        ).addTo(layer);
      }
    }

    for (const p of peers) {
      L.marker([p.lat, p.lon], {
        icon: aircraftIcon(p.headingDeg, '#7a3fbf', p.callsign || 'unit'),
      }).addTo(layer);
    }

    if (aircraft) {
      L.marker([aircraft.lat, aircraft.lon], {
        icon: aircraftIcon(aircraft.headingTrueDeg, '#000080', aircraft.tailNumber || 'you'),
      }).addTo(layer);
    }

    const pts: [number, number][] = [];
    if (aircraft) pts.push([aircraft.lat, aircraft.lon]);
    if (job) pts.push([job.lat, job.lon]);
    if (scene) pts.push([scene.lat, scene.lon]);
    if (base && Number.isFinite(base.lat)) pts.push([base.lat, base.lon]);
    peers.forEach((p) => pts.push([p.lat, p.lon]));
    (contacts ?? []).forEach((c) => pts.push([c.lat, c.lon]));
    (targetRoutes ?? []).forEach((tr) => tr.route[0] && pts.push([tr.route[0].lat, tr.route[0].lon]));
    ptsRef.current = pts;

    // Fit ONCE per target, and never after the operator has moved the map.
    // The single-point branch used to skip setting fittedRef, so it re-centred
    // on every render — roughly once a second with a live position — which made
    // the map impossible to pan.
    if (!fittedRef.current && !userMovedRef.current && pts.length > 0) {
      frameTo(map, pts);
      fittedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aircraft, trail, job, scene, base, peers, objects, targetRoutes, contacts]);

  return <div ref={elRef} className="h-full w-full" style={{ minHeight: 260, background: '#aad3df' }} />;
}
