import { GoogleGenAI, Type } from '@google/genai';
import {
  buildSplitRouteMetrics,
  computeFIndexForecast,
  decodePolyline6,
  haversineMeters,
  windDegreesToLabel,
} from '../lib/fishLogic.ts';
import type {
  BiteForecastResponse,
  FishSpecies,
  LatLng,
  RouteMultiResult,
  WaterBody,
  WaterBodyAccessPoint,
  WaterBodyType,
  WeatherSnapshot,
} from '../lib/types.ts';
import { store } from './store.ts';

function computeMoonPhase(date: Date): { label: string; illumination: number } {
  // Simple synodic calculation (new moon reference Jan 11 2024)
  const synodic = 29.53058867;
  const ref = new Date('2024-01-11T11:57:00Z').getTime();
  const days = (date.getTime() - ref) / 86400000;
  const phase = ((days % synodic) + synodic) % synodic;
  const frac = phase / synodic;
  const illumination = Math.round((1 - Math.cos(frac * 2 * Math.PI)) * 50);

  if (frac < 0.06 || frac > 0.94) return { label: 'Новолуние', illumination };
  if (frac < 0.22) return { label: 'Растущий серп', illumination };
  if (frac < 0.28) return { label: 'Первая четверть', illumination };
  if (frac < 0.47) return { label: 'Растущая луна', illumination };
  if (frac < 0.53) return { label: 'Полнолуние', illumination };
  if (frac < 0.72) return { label: 'Убывающая луна', illumination };
  if (frac < 0.78) return { label: 'Последняя четверть', illumination };
  return { label: 'Стареющий серп', illumination };
}

export async function fetchWeatherViaProxy(lat: number, lng: number): Promise<WeatherSnapshot> {
  const key = `${lat.toFixed(2)}:${lng.toFixed(2)}`;
  const cached = store.weatherCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.data, source: 'open-meteo-cached' };
  }

  const now = new Date();
  const moon = computeMoonPhase(now);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current=temperature_2m,precipitation,surface_pressure,wind_speed_10m,wind_direction_10m&hourly=surface_pressure&forecast_days=1&wind_speed_unit=ms`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const json = (await res.json()) as {
        current?: {
          temperature_2m?: number;
          precipitation?: number;
          surface_pressure?: number;
          wind_speed_10m?: number;
          wind_direction_10m?: number;
        };
        hourly?: { surface_pressure?: number[] };
      };
      const cur = json.current;
      if (cur && typeof cur.temperature_2m === 'number') {
        const pressureHpa = Math.round(cur.surface_pressure ?? 1014);
        const pressureMmhg = Math.round(pressureHpa * 0.75006);
        const hourlyP = json.hourly?.surface_pressure ?? [];
        let trend: WeatherSnapshot['pressure_trend'] = 'steady';
        if (hourlyP.length >= 6) {
          const delta = hourlyP[hourlyP.length - 1] - hourlyP[0];
          if (delta > 2.5) trend = 'rising';
          else if (delta < -2.5) trend = 'falling';
        }
        const airTemp = Number(cur.temperature_2m.toFixed(1));
        const waterTemp = Number(Math.max(1.5, airTemp * 0.72 + 2.4).toFixed(1));
        const windDeg = Math.round(cur.wind_direction_10m ?? 220);

        const snapshot: WeatherSnapshot = {
          lat,
          lng,
          captured_at: now.toISOString(),
          pressure_hpa: pressureHpa,
          pressure_mmhg: pressureMmhg,
          pressure_trend: trend,
          air_temp_c: airTemp,
          water_temp_c: waterTemp,
          wind_speed_ms: Number((cur.wind_speed_10m ?? 3.2).toFixed(1)),
          wind_direction_deg: windDeg,
          wind_direction_label: windDegreesToLabel(windDeg),
          precipitation_mm: Number((cur.precipitation ?? 0).toFixed(1)),
          moon_phase: moon.label,
          moon_illumination: moon.illumination,
          source: 'open-meteo',
        };
        store.weatherCache.set(key, { data: snapshot, expiresAt: Date.now() + 30 * 60 * 1000 });
        return snapshot;
      }
    }
  } catch {
    // Graceful fallback below if Open-Meteo unreachable in sandbox or offline
  }

  const fallback: WeatherSnapshot = {
    lat,
    lng,
    captured_at: now.toISOString(),
    pressure_hpa: 1015,
    pressure_mmhg: 761,
    pressure_trend: 'steady',
    air_temp_c: 4.5,
    water_temp_c: 5.8,
    wind_speed_ms: 3.8,
    wind_direction_deg: 235,
    wind_direction_label: 'ЮЗ',
    precipitation_mm: 0.0,
    moon_phase: moon.label,
    moon_illumination: moon.illumination,
    source: 'offline-fallback',
  };
  store.weatherCache.set(key, { data: fallback, expiresAt: Date.now() + 10 * 60 * 1000 });
  return fallback;
}

export async function fetchBiteForecastViaProxy(params: {
  lat: number;
  lng: number;
  species: FishSpecies;
  dateStr?: string;
}): Promise<BiteForecastResponse> {
  const { lat, lng, species, dateStr } = params;
  const baseDate = dateStr ? new Date(dateStr) : new Date();
  const dayKey = baseDate.toISOString().slice(0, 10);
  const cacheKey = `${lat.toFixed(2)}:${lng.toFixed(2)}:${species.id}:${dayKey}`;

  const cached = store.forecastCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.data, cached: true };
  }

  // Attempt Actigator API if key is configured on server
  const actigatorKey = process.env.ACTIGATOR_API_KEY;
  if (actigatorKey && actigatorKey.trim().length > 5) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(
        `https://api.actigator.com/v1/forecast?lat=${lat}&lng=${lng}&species=${species.id}&date=${dayKey}`,
        {
          headers: { Authorization: `Bearer ${actigatorKey}` },
          signal: controller.signal,
        }
      );
      clearTimeout(timeout);
      if (res.ok) {
        const external = (await res.json()) as Partial<BiteForecastResponse>;
        if (Array.isArray(external.slots) && external.slots.length > 0) {
          const response: BiteForecastResponse = {
            lat,
            lng,
            fish_id: species.id,
            fish_name: species.name,
            source: 'actigator',
            cached: false,
            disclaimer:
              'Прогноз рассчитан моделью Actigator. Результат носит вероятностный характер и не гарантирует клёв.',
            slots: external.slots,
          };
          store.forecastCache.set(cacheKey, { data: response, expiresAt: Date.now() + 65 * 60 * 1000 });
          return response;
        }
      }
    } catch {
      // Fallback to Open-Meteo model below
    }
  }

  const weather = await fetchWeatherViaProxy(lat, lng);
  const slots = computeFIndexForecast({ species, weather, baseDate });
  const response: BiteForecastResponse = {
    lat,
    lng,
    fish_id: species.id,
    fish_name: species.name,
    source: 'open-meteo-fallback',
    cached: false,
    disclaimer:
      'Сервис Actigator недоступен или не настроен — применён расчёт на базе метеоданных Open-Meteo. Прогноз носит вероятностный характер.',
    slots,
  };
  store.forecastCache.set(cacheKey, { data: response, expiresAt: Date.now() + 65 * 60 * 1000 });
  return response;
}

async function fetchValhallaRoute(params: {
  from: LatLng;
  to: LatLng;
  costing: 'auto' | 'pedestrian';
  avoidUnpaved?: boolean;
  timeoutMs?: number;
}): Promise<{ distance_m: number; duration_s: number; geometry: [number, number][] } | null> {
  const { from, to, costing, avoidUnpaved = true, timeoutMs = 4500 } = params;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body =
      costing === 'auto'
        ? {
            locations: [
              { lat: from.lat, lon: from.lng },
              { lat: to.lat, lon: to.lng },
            ],
            costing: 'auto',
            costing_options: {
              auto: {
                exclude_unpaved: avoidUnpaved,
                use_tracks: avoidUnpaved ? 0 : 0.6,
              },
            },
            directions_options: { units: 'km' },
          }
        : {
            locations: [
              { lat: from.lat, lon: from.lng },
              { lat: to.lat, lon: to.lng },
            ],
            costing: 'pedestrian',
            directions_options: { units: 'km' },
          };

    const res = await fetch('https://valhalla1.openstreetmap.de/route', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'FishCastAI/1.0',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      trip?: {
        summary?: { length?: number; time?: number };
        legs?: Array<{ shape?: string }>;
      };
    };
    const shape = data.trip?.legs?.[0]?.shape;
    const lengthKm = data.trip?.summary?.length;
    const durationS = data.trip?.summary?.time;
    if (!shape || typeof lengthKm !== 'number' || typeof durationS !== 'number') return null;
    const coords = decodePolyline6(shape, 320);
    if (coords.length < 2) return null;
    return {
      distance_m: Math.max(20, Math.round(lengthKm * 1000)),
      duration_s: Math.max(10, Math.round(durationS)),
      geometry: coords,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOsrmDrivingRoute(params: {
  from: LatLng;
  to: LatLng;
  timeoutMs?: number;
}): Promise<{ distance_m: number; duration_s: number; geometry: [number, number][] } | null> {
  const { from, to, timeoutMs = 4000 } = params;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=simplified&geometries=geojson`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'FishCastAI/1.0' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      code?: string;
      routes?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: [number, number][] };
      }>;
    };
    const route = data.routes?.[0];
    const coords = route?.geometry?.coordinates;
    if (
      data.code !== 'Ok' ||
      !route ||
      typeof route.distance !== 'number' ||
      typeof route.duration !== 'number' ||
      !Array.isArray(coords) ||
      coords.length < 2
    ) {
      return null;
    }
    return {
      distance_m: Math.max(50, Math.round(route.distance)),
      duration_s: Math.max(15, Math.round(route.duration)),
      geometry: coords,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOrsDrivingRoute(params: {
  apiKey: string;
  from: LatLng;
  to: LatLng;
  avoidUnpaved: boolean;
  timeoutMs?: number;
}): Promise<{ distance_m: number; duration_s: number; geometry: [number, number][] } | null> {
  const { apiKey, from, to, avoidUnpaved, timeoutMs = 4000 } = params;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        coordinates: [
          [from.lng, from.lat],
          [to.lng, to.lat],
        ],
        ...(avoidUnpaved ? { options: { avoid_features: ['unpavedroads'] } } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      features?: Array<{
        properties?: { summary?: { distance?: number; duration?: number } };
        geometry?: { coordinates?: [number, number][] };
      }>;
    };
    const feature = data.features?.[0];
    const summary = feature?.properties?.summary;
    const coords = feature?.geometry?.coordinates;
    if (
      !summary ||
      typeof summary.distance !== 'number' ||
      typeof summary.duration !== 'number' ||
      !Array.isArray(coords) ||
      coords.length < 2
    ) {
      return null;
    }
    return {
      distance_m: Math.max(50, Math.round(summary.distance)),
      duration_s: Math.max(15, Math.round(summary.duration)),
      geometry: coords,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function computeMultiRouteViaProxy(params: {
  origin: LatLng;
  waterBody: WaterBody;
  accessPoints: WaterBodyAccessPoint[];
  avoidUnpaved: boolean;
  simulateQuotaExceeded?: boolean;
}): Promise<RouteMultiResult> {
  const { origin, waterBody, accessPoints, avoidUnpaved, simulateQuotaExceeded } = params;
  const cacheKey = `${origin.lat.toFixed(3)},${origin.lng.toFixed(3)}->${waterBody.id}:unpaved=${avoidUnpaved}`;

  if (!simulateQuotaExceeded) {
    const cached = store.routeCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
  }

  const quotaOk = !simulateQuotaExceeded && store.trackYandexQuota('route');
  const orsKey = process.env.ORS_API_KEY;
  const yandexRoutingKey = process.env.YANDEX_ROUTING_API_KEY;

  // Deterministic split route calculation baseline
  const baseResult = buildSplitRouteMetrics({
    origin,
    waterBody,
    accessPoints,
    avoidUnpaved,
    quotaExceeded: !quotaOk,
  });

  if (quotaOk && baseResult.driving_available && baseResult.access_point && baseResult.driving_segment) {
    const ap = baseResult.access_point;
    let resolved = false;

    // 1) Optional free-tier OpenRouteService key (supports avoid_features: unpavedroads)
    if (orsKey && orsKey.trim().length > 5) {
      const orsRoute = await fetchOrsDrivingRoute({
        apiKey: orsKey.trim(),
        from: origin,
        to: ap,
        avoidUnpaved,
      });
      if (orsRoute) {
        baseResult.driving_segment.distance_m = orsRoute.distance_m;
        baseResult.driving_segment.duration_s = orsRoute.duration_s;
        baseResult.driving_segment.geometry = orsRoute.geometry;
        baseResult.source = 'ors-osm';
        resolved = true;
      }
    }

    // 2) Completely free zero-key Valhalla FOSSGIS (OSM + unpaved avoidance)
    if (!resolved) {
      const valhallaDrive = await fetchValhallaRoute({
        from: origin,
        to: ap,
        costing: 'auto',
        avoidUnpaved,
      });
      if (valhallaDrive) {
        baseResult.driving_segment.distance_m = valhallaDrive.distance_m;
        baseResult.driving_segment.duration_s = valhallaDrive.duration_s;
        baseResult.driving_segment.geometry = valhallaDrive.geometry;
        baseResult.source = 'valhalla-osm';
        resolved = true;
      }
    }

    // 3) Completely free zero-key OSRM Public backup
    if (!resolved) {
      const osrmDrive = await fetchOsrmDrivingRoute({
        from: origin,
        to: ap,
      });
      if (osrmDrive) {
        baseResult.driving_segment.distance_m = osrmDrive.distance_m;
        baseResult.driving_segment.duration_s = osrmDrive.duration_s;
        baseResult.driving_segment.geometry = osrmDrive.geometry;
        baseResult.source = 'osrm-public';
        resolved = true;
      }
    }

    // 4) Optional Yandex Routing fallback only if key explicitly provided
    if (!resolved && yandexRoutingKey && yandexRoutingKey.trim().length > 5) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);
        const waypoints = `${origin.lat},${origin.lng}|${ap.lat},${ap.lng}`;
        const yUrl = `https://api.routing.yandex.net/v2/route?apikey=${encodeURIComponent(yandexRoutingKey)}&waypoints=${encodeURIComponent(waypoints)}&mode=driving&avoid_unpaved=${avoidUnpaved}`;
        const res = await fetch(yUrl, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          const yData = (await res.json()) as {
            route?: { legs?: Array<{ steps?: Array<{ length?: number; duration?: number; polyline?: { points?: [number, number][] } }> }> };
          };
          const legs = yData.route?.legs;
          if (legs && legs.length > 0) {
            let totalDist = 0;
            let totalDur = 0;
            const pts: [number, number][] = [];
            for (const leg of legs) {
              for (const step of leg.steps ?? []) {
                totalDist += step.length ?? 0;
                totalDur += step.duration ?? 0;
                for (const p of step.polyline?.points ?? []) {
                  pts.push([p[1], p[0]]);
                }
              }
            }
            if (totalDist > 0) {
              baseResult.driving_segment.distance_m = Math.round(totalDist);
              baseResult.driving_segment.duration_s = Math.round(totalDur);
              if (pts.length >= 2) baseResult.driving_segment.geometry = pts;
              baseResult.source = 'yandex-routing';
              resolved = true;
            }
          }
        }
      } catch {
        // Keep deterministic fallback
      }
    }

    // Also enrich walking trail geometry via free Valhalla pedestrian if within 12 km
    if (resolved && baseResult.walking_segment.distance_m <= 12000) {
      const walkRoute = await fetchValhallaRoute({
        from: ap,
        to: baseResult.target_point,
        costing: 'pedestrian',
        timeoutMs: 2500,
      });
      if (walkRoute && walkRoute.distance_m <= 20000) {
        baseResult.walking_segment.distance_m = walkRoute.distance_m;
        baseResult.walking_segment.duration_s = walkRoute.duration_s;
        baseResult.walking_segment.geometry = walkRoute.geometry;
      }
    }
  }

  if (quotaOk) {
    store.routeCache.set(cacheKey, { data: baseResult, expiresAt: Date.now() + 20 * 60 * 1000 });
  }
  return baseResult;
}

export async function recognizeFishPhotoViaGemini(params: {
  base64Data: string;
  mimeType: string;
}): Promise<{
  recognized: boolean;
  species_id: string | null;
  species_name: string | null;
  confidence: number;
  release_advice: string;
  requires_manual_choice: boolean;
}> {
  const apiKey = process.env.GEMINI_API_KEY;
  const knownNames = store.species.map((s) => `${s.id}: ${s.name}`).join(', ');

  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim().length < 10) {
    return {
      recognized: false,
      species_id: null,
      species_name: null,
      confidence: 0,
      release_advice:
        'Автоматическое распознавание недоступно без серверного ключа vision-сервиса. Выберите вид рыбы вручную.',
      requires_manual_choice: true,
    };
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: params.mimeType,
              data: params.base64Data,
            },
          },
          {
            text: `Определи вид пресноводной рыбы на фото из списка: ${knownNames}. Верни confidence от 0 до 1. Если на фото не рыба или уверенность низкая, поставь confidence ниже 0.5.`,
          },
        ],
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            species_id: { type: Type.STRING },
            species_name: { type: Type.STRING },
            confidence: { type: Type.NUMBER },
          },
          required: ['species_id', 'species_name', 'confidence'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim()) as {
      species_id?: string;
      species_name?: string;
      confidence?: number;
    };
    const conf = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
    const matched = store.species.find((s) => s.id === parsed.species_id) ?? null;

    if (!matched || conf < 0.65) {
      return {
        recognized: false,
        species_id: matched?.id ?? null,
        species_name: matched?.name ?? parsed.species_name ?? null,
        confidence: conf,
        release_advice:
          'Уверенность распознавания ниже порога. Пожалуйста, подтвердите или выберите вид рыбы вручную.',
        requires_manual_choice: true,
      };
    }

    return {
      recognized: true,
      species_id: matched.id,
      species_name: matched.name,
      confidence: conf,
      release_advice: `${matched.release_note} (Не является юридической консультацией.)`,
      requires_manual_choice: false,
    };
  } catch {
    return {
      recognized: false,
      species_id: null,
      species_name: null,
      confidence: 0,
      release_advice: 'Не удалось распознать фото. Пожалуйста, выберите вид рыбы вручную.',
      requires_manual_choice: true,
    };
  }
}

export function inferWaterBodyTypeFromOsm(
  tags: Record<string, string | undefined>,
  name?: string | null
): WaterBodyType {
  const lower = (name ?? '').toLowerCase();
  const water = (tags.water ?? '').toLowerCase();
  const waterway = (tags.waterway ?? '').toLowerCase();

  if (water === 'reservoir' || lower.includes('водохранилище') || lower.includes('вдхр')) return 'reservoir';
  if (water === 'oxbow' || lower.includes('старица')) return 'oxbow';
  if (water === 'quarry' || tags.landuse === 'quarry' || lower.includes('карьер')) return 'quarry';
  if (water === 'lake' || lower.includes('озеро') || lower.startsWith('оз.')) return 'lake';
  if (water === 'pond' || lower.includes('пруд')) return 'pond';
  if (waterway === 'river' || waterway === 'canal' || waterway === 'stream' || water === 'river' || lower.includes('река') || lower.startsWith('р.')) {
    return 'river';
  }
  return 'lake';
}

function defaultDepthForType(type: WaterBodyType): { max: number; avg: number; area: number } {
  switch (type) {
    case 'reservoir':
      return { max: 14, avg: 5.5, area: 950 };
    case 'lake':
      return { max: 6.5, avg: 2.8, area: 140 };
    case 'quarry':
      return { max: 9.5, avg: 4.5, area: 18 };
    case 'river':
      return { max: 4.2, avg: 1.8, area: 75 };
    case 'oxbow':
      return { max: 2.6, avg: 1.3, area: 3.5 };
    case 'pond':
    default:
      return { max: 2.8, avg: 1.4, area: 2.2 };
  }
}

function buildPolygonFromLineNodes(nodes: Array<{ lat: number; lon: number }>): [number, number][] {
  const sampled: Array<{ lat: number; lon: number }> = [];
  const step = Math.max(1, Math.floor(nodes.length / 12));
  for (let i = 0; i < nodes.length; i += step) {
    sampled.push(nodes[i]);
  }
  if (nodes.length > 0 && sampled[sampled.length - 1] !== nodes[nodes.length - 1]) {
    sampled.push(nodes[nodes.length - 1]);
  }
  if (sampled.length < 2) {
    const pt = nodes[0] ?? { lat: 55.975, lon: 36.825 };
    return [
      [pt.lon - 0.002, pt.lat - 0.0012],
      [pt.lon + 0.002, pt.lat - 0.0012],
      [pt.lon + 0.002, pt.lat + 0.0012],
      [pt.lon - 0.002, pt.lat + 0.0012],
      [pt.lon - 0.002, pt.lat - 0.0012],
    ];
  }
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (const pt of sampled) {
    left.push([Number((pt.lon - 0.0014).toFixed(6)), Number((pt.lat + 0.0009).toFixed(6))]);
    right.unshift([Number((pt.lon + 0.0014).toFixed(6)), Number((pt.lat - 0.0009).toFixed(6))]);
  }
  const ring = [...left, ...right];
  ring.push(ring[0]);
  return ring;
}

function buildClosedPolygonFromNodes(nodes: Array<{ lat: number; lon: number }>): [number, number][] {
  const step = Math.max(1, Math.floor(nodes.length / 22));
  const ring: [number, number][] = [];
  for (let i = 0; i < nodes.length; i += step) {
    ring.push([Number(nodes[i].lon.toFixed(6)), Number(nodes[i].lat.toFixed(6))]);
  }
  if (ring.length >= 3) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push(first);
    }
    return ring;
  }
  return buildPolygonFromLineNodes(nodes);
}

export function buildWaterBodyFromGeocodeFeature(params: {
  id: string;
  title: string;
  subtitle?: string;
  lat: number;
  lng: number;
  type: WaterBodyType;
}): WaterBody {
  const defaults = defaultDepthForType(params.type);
  const rx = params.type === 'river' ? 0.012 : params.type === 'reservoir' ? 0.018 : 0.0055;
  const ry = params.type === 'river' ? 0.004 : params.type === 'reservoir' ? 0.01 : 0.0038;
  const polygon: [number, number][] =
    params.type === 'river'
      ? buildPolygonFromLineNodes([
          { lat: params.lat - ry, lon: params.lng - rx },
          { lat: params.lat, lon: params.lng },
          { lat: params.lat + ry, lon: params.lng + rx },
        ])
      : [
          [Number((params.lng - rx).toFixed(6)), Number((params.lat - ry).toFixed(6))],
          [Number((params.lng + rx).toFixed(6)), Number((params.lat - ry).toFixed(6))],
          [Number((params.lng + rx).toFixed(6)), Number((params.lat + ry).toFixed(6))],
          [Number((params.lng - rx).toFixed(6)), Number((params.lat + ry).toFixed(6))],
          [Number((params.lng - rx).toFixed(6)), Number((params.lat - ry).toFixed(6))],
        ];

  return {
    id: params.id,
    name: params.title,
    display_label: params.title,
    type: params.type,
    center: { lat: Number(params.lat.toFixed(5)), lng: Number(params.lng.toFixed(5)) },
    polygon,
    area_ha: defaults.area,
    source: 'osm',
    confidence: 0.84,
    moderation_status: 'verified',
    connected_to: null,
    has_bathymetry: false,
    max_depth_m: defaults.max,
    avg_depth_m: defaults.avg,
    region: params.subtitle || 'OpenStreetMap',
    external_id: params.id,
    ndwi_stability: 'year_round',
    vegetation_index: 'moderate',
    water_clarity: 'moderate',
    target_zone: { lat: Number(params.lat.toFixed(5)), lng: Number(params.lng.toFixed(5)) },
  };
}

interface OverpassElement {
  type: 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
  geometry?: Array<{ lat: number; lon: number }>;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    osm_type?: string;
    osm_id?: number;
    name?: string;
    state?: string;
    county?: string;
    country?: string;
    osm_key?: string;
    osm_value?: string;
    extent?: [number, number, number, number];
  };
}

function isPhotonWaterFeature(props?: PhotonFeature['properties']): boolean {
  if (!props?.name) return false;
  const k = (props.osm_key ?? '').toLowerCase();
  const v = (props.osm_value ?? '').toLowerCase();
  if (k === 'waterway' || k === 'water') return true;
  if (k === 'natural' && ['water', 'wetland', 'bay'].includes(v)) return true;
  return ['river', 'stream', 'canal', 'lake', 'reservoir', 'pond', 'oxbow', 'basin'].includes(v);
}

function buildWaterBodyFromPhotonFeature(feat: PhotonFeature): WaterBody | null {
  const coords = feat.geometry?.coordinates;
  const props = feat.properties;
  if (!coords || coords.length < 2 || !props?.name || !isPhotonWaterFeature(props)) return null;

  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const osmKey = (props.osm_key ?? '').toLowerCase();
  const osmVal = (props.osm_value ?? '').toLowerCase();
  const type = inferWaterBodyTypeFromOsm(
    { waterway: osmKey === 'waterway' ? osmVal : undefined, water: osmVal },
    props.name
  );
  const defaults = defaultDepthForType(type);

  let areaHa = defaults.area;
  let polygon: [number, number][] | null = null;
  if (Array.isArray(props.extent) && props.extent.length === 4) {
    const [minLon, maxLat, maxLon, minLat] = props.extent;
    const spanLon = Math.min(0.28, Math.max(0.004, Math.abs(maxLon - minLon)));
    const spanLat = Math.min(0.18, Math.max(0.003, Math.abs(maxLat - minLat)));
    const dLatKm = spanLat * 111;
    const dLngKm = spanLon * 111 * Math.cos((lat * Math.PI) / 180);
    const approxHa = Math.round(dLatKm * dLngKm * (type === 'river' ? 12 : 45));
    if (approxHa >= 1 && approxHa <= 50000) areaHa = approxHa;

    const halfLon = Math.min(0.035, Math.max(0.0035, spanLon / 2));
    const halfLat = Math.min(0.022, Math.max(0.0022, spanLat / 2));
    if (type === 'river') {
      polygon = buildPolygonFromLineNodes([
        { lat: lat - halfLat * 0.7, lon: lng - halfLon * 0.8 },
        { lat, lon: lng },
        { lat: lat + halfLat * 0.7, lon: lng + halfLon * 0.8 },
      ]);
    } else {
      polygon = [
        [Number((lng - halfLon).toFixed(6)), Number((lat - halfLat).toFixed(6))],
        [Number((lng + halfLon).toFixed(6)), Number((lat - halfLat).toFixed(6))],
        [Number((lng + halfLon).toFixed(6)), Number((lat + halfLat).toFixed(6))],
        [Number((lng - halfLon).toFixed(6)), Number((lat + halfLat).toFixed(6))],
        [Number((lng - halfLon).toFixed(6)), Number((lat - halfLat).toFixed(6))],
      ];
    }
  }

  const region = [props.state, props.county].filter(Boolean).slice(0, 2).join(' · ') || 'OpenStreetMap';
  const osmTagId = `${props.osm_type ?? 'W'}${props.osm_id ?? `${lat.toFixed(4)}-${lng.toFixed(4)}`}`;
  const base = buildWaterBodyFromGeocodeFeature({
    id: `wb-osm-${osmTagId}`,
    title: props.name.trim(),
    subtitle: region,
    lat,
    lng,
    type,
  });

  return {
    ...base,
    polygon: polygon ?? base.polygon,
    area_ha: areaHa,
    external_id: `OSM-${osmTagId}`,
    confidence: 0.85,
  };
}

async function fetchPhotonFeatures(url: string, timeoutMs = 3500): Promise<PhotonFeature[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'FishCastAI/1.0' },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { features?: PhotonFeature[] };
    return Array.isArray(json.features) ? json.features : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverOsmWaterBodies(params: {
  lat: number;
  lng: number;
  radiusKm?: number;
  queryText?: string;
}): Promise<WaterBody[]> {
  const radiusKm = Math.max(4, Math.min(25, Math.round(params.radiusKm ?? 15)));
  const cleanQuery = (params.queryText ?? '').replace(/["\\[\]]/g, '').trim();

  // 1) Fast zero-key Photon OSM discovery (waterways + natural water bodies around coords)
  const photonUrls: string[] = [
    `https://photon.komoot.io/reverse?lat=${params.lat.toFixed(4)}&lon=${params.lng.toFixed(4)}&radius=${radiusKm}&osm_tag=waterway&limit=20`,
    `https://photon.komoot.io/reverse?lat=${params.lat.toFixed(4)}&lon=${params.lng.toFixed(4)}&radius=${radiusKm}&osm_tag=natural:water&limit=20`,
  ];
  if (cleanQuery.length >= 2 && cleanQuery.length <= 50) {
    photonUrls.push(
      `https://photon.komoot.io/api/?q=${encodeURIComponent(cleanQuery)}&lat=${params.lat.toFixed(4)}&lon=${params.lng.toFixed(4)}&osm_tag=waterway&osm_tag=natural:water&limit=12`
    );
  }

  // 2) Optional Overpass exact-geometry enrichment (fast 2.8s cap so UI stays snappy)
  const overpassPromise = (async (): Promise<OverpassElement[]> => {
    const radiusM = Math.min(18000, radiusKm * 1000);
    const qlLines = [
      '[out:json][timeout:3];',
      '(',
      `  way["waterway"~"^(river|canal)$"]["name"](around:${radiusM},${params.lat.toFixed(4)},${params.lng.toFixed(4)});`,
      `  way["natural"="water"]["name"](around:${radiusM},${params.lat.toFixed(4)},${params.lng.toFixed(4)});`,
      ');',
      'out center geom 25;',
    ];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2800);
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': 'FishCastAI/1.0',
        },
        body: `data=${encodeURIComponent(qlLines.join('\n'))}`,
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { elements?: OverpassElement[] };
      return Array.isArray(json.elements) ? json.elements : [];
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  })();

  const [photonBatches, overpassElements] = await Promise.all([
    Promise.all(photonUrls.map((u) => fetchPhotonFeatures(u))),
    overpassPromise,
  ]);

  const deduped = new Map<string, { wb: WaterBody; dist: number }>();
  const addCandidate = (wb: WaterBody) => {
    const nameKey = wb.display_label.toLowerCase();
    const dist = haversineMeters({ lat: params.lat, lng: params.lng }, wb.center);
    const existing = deduped.get(nameKey);
    if (!existing || dist < existing.dist) {
      deduped.set(nameKey, { wb, dist });
    }
  };

  for (const el of overpassElements) {
    const rawName = el.tags?.name?.trim();
    if (!rawName) continue;
    const type = inferWaterBodyTypeFromOsm(el.tags ?? {}, rawName);
    const geom = el.geometry && el.geometry.length >= 2 ? el.geometry : null;

    let centerLat = el.center?.lat;
    let centerLng = el.center?.lon;
    if ((typeof centerLat !== 'number' || typeof centerLng !== 'number') && geom) {
      const mid = geom[Math.floor(geom.length / 2)];
      centerLat = mid.lat;
      centerLng = mid.lon;
    }
    if (typeof centerLat !== 'number' || typeof centerLng !== 'number') continue;

    const defaults = defaultDepthForType(type);
    let areaHa = defaults.area;
    if (el.bounds) {
      const dLatKm = Math.abs(el.bounds.maxlat - el.bounds.minlat) * 111;
      const dLngKm = Math.abs(el.bounds.maxlon - el.bounds.minlon) * 111 * Math.cos((centerLat * Math.PI) / 180);
      const approxHa = Math.round(dLatKm * dLngKm * 45);
      if (approxHa >= 1 && approxHa <= 50000) {
        areaHa = approxHa;
      }
    }

    const polygon =
      type === 'river' && geom
        ? buildPolygonFromLineNodes(geom)
        : geom && geom.length >= 4
          ? buildClosedPolygonFromNodes(geom)
          : buildWaterBodyFromGeocodeFeature({
              id: `wb-osm-${el.type}-${el.id}`,
              title: rawName,
              lat: centerLat,
              lng: centerLng,
              type,
            }).polygon;

    addCandidate({
      id: `wb-osm-${el.type}-${el.id}`,
      name: rawName,
      display_label: rawName,
      type,
      center: { lat: Number(centerLat.toFixed(5)), lng: Number(centerLng.toFixed(5)) },
      polygon,
      area_ha: areaHa,
      source: 'osm',
      confidence: 0.88,
      moderation_status: 'verified',
      connected_to: null,
      has_bathymetry: false,
      max_depth_m: defaults.max,
      avg_depth_m: defaults.avg,
      region: 'OpenStreetMap',
      external_id: `OSM-${el.type}-${el.id}`,
      ndwi_stability: 'year_round',
      vegetation_index: 'moderate',
      water_clarity: 'moderate',
      target_zone: { lat: Number(centerLat.toFixed(5)), lng: Number(centerLng.toFixed(5)) },
    });
  }

  for (const batch of photonBatches) {
    for (const feat of batch) {
      const wb = buildWaterBodyFromPhotonFeature(feat);
      if (wb) addCandidate(wb);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 20)
    .map((entry) => entry.wb);
}


