import { GoogleGenAI, Type } from '@google/genai';
import {
  buildBiteForecastMetadata,
  buildSplitRouteMetrics,
  computeFIndexForecast,
  decodePolyline6,
  estimateWaterTempC,
  findInteriorWaterPoint,
  haversineMeters,
  windDegreesToLabel,
} from '../lib/fishLogic.ts';
import type {
  BiteForecastResponse,
  CatchReport,
  FishSpecies,
  HourlyWeatherPoint,
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
    const timeout = setTimeout(() => controller.abort(), 4500);
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
      `&current=temperature_2m,precipitation,pressure_msl,surface_pressure,cloud_cover,wind_speed_10m,wind_direction_10m` +
      `&hourly=temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,cloud_cover,precipitation` +
      `&past_days=14&forecast_days=3&wind_speed_unit=ms&timezone=auto`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const json = (await res.json()) as {
        current?: {
          time?: string;
          temperature_2m?: number;
          precipitation?: number;
          pressure_msl?: number;
          surface_pressure?: number;
          cloud_cover?: number;
          wind_speed_10m?: number;
          wind_direction_10m?: number;
        };
        hourly?: {
          time?: string[];
          temperature_2m?: number[];
          pressure_msl?: number[];
          wind_speed_10m?: number[];
          wind_direction_10m?: number[];
          cloud_cover?: number[];
          precipitation?: number[];
        };
      };
      const cur = json.current;
      if (cur && typeof cur.temperature_2m === 'number') {
        const hTime = json.hourly?.time ?? [];
        const hTemp = json.hourly?.temperature_2m ?? [];
        const hPres = json.hourly?.pressure_msl ?? [];
        const hWind = json.hourly?.wind_speed_10m ?? [];
        const hWDir = json.hourly?.wind_direction_10m ?? [];
        const hCloud = json.hourly?.cloud_cover ?? [];
        const hPrecip = json.hourly?.precipitation ?? [];

        // Locate current hour index in the 17-day hourly array
        const curPrefix = (cur.time ?? now.toISOString()).slice(0, 13);
        let curIdx = hTime.findIndex((t) => t.startsWith(curPrefix));
        if (curIdx < 0) {
          curIdx = Math.max(0, Math.min(hTime.length - 1, 14 * 24));
        }

        // Compute 7-day and 14-day mean air temperatures for thermal water inertia
        const sliceMean = (arr: number[], start: number, end: number): number | undefined => {
          const s = Math.max(0, start);
          const e = Math.min(arr.length, end);
          if (e <= s) return undefined;
          let sum = 0;
          let count = 0;
          for (let i = s; i < e; i++) {
            if (typeof arr[i] === 'number' && !Number.isNaN(arr[i])) {
              sum += arr[i];
              count += 1;
            }
          }
          return count > 0 ? Number((sum / count).toFixed(1)) : undefined;
        };

        const avg7d = sliceMean(hTemp, curIdx - 7 * 24, curIdx + 1);
        const avg14d = sliceMean(hTemp, curIdx - 14 * 24, curIdx + 1);

        // Cumulative rainfall over last 72 hours (for river turbidity)
        let rain72h = 0;
        for (let i = Math.max(0, curIdx - 72); i <= Math.min(hPrecip.length - 1, curIdx); i++) {
          rain72h += Number(hPrecip[i] ?? 0);
        }

        // Current 6h barometric delta and 48h stability
        const pressureHpa = Math.round(cur.pressure_msl ?? cur.surface_pressure ?? hPres[curIdx] ?? 1014);
        const pressureMmhg = Math.round(pressureHpa * 0.75006);
        const p6Ago = curIdx >= 6 && typeof hPres[curIdx - 6] === 'number' ? hPres[curIdx - 6] : pressureHpa;
        const delta6h = Number((pressureHpa - p6Ago).toFixed(1));
        const trend: WeatherSnapshot['pressure_trend'] =
          delta6h >= 1.2 ? 'rising' : delta6h <= -1.2 ? 'falling' : 'steady';

        let stability48h = 0.75;
        const p48Start = Math.max(0, curIdx - 48);
        if (curIdx - p48Start >= 6) {
          let minP = Infinity;
          let maxP = -Infinity;
          for (let i = p48Start; i <= curIdx; i++) {
            const p = hPres[i];
            if (typeof p === 'number') {
              if (p < minP) minP = p;
              if (p > maxP) maxP = p;
            }
          }
          if (minP < Infinity) {
            stability48h = Number(Math.max(0, Math.min(1, 1 - (maxP - minP) / 18)).toFixed(2));
          }
        }

        // Keep compact window: 48h past + 72h future (~120 hourly points)
        const hourlyCompact: HourlyWeatherPoint[] = [];
        const winStart = Math.max(0, curIdx - 48);
        const winEnd = Math.min(hTime.length, curIdx + 76);
        for (let i = winStart; i < winEnd; i++) {
          hourlyCompact.push({
            time: hTime[i],
            temp_c: Number((hTemp[i] ?? cur.temperature_2m).toFixed(1)),
            pressure_hpa: Number((hPres[i] ?? pressureHpa).toFixed(1)),
            wind_speed_ms: Number((hWind[i] ?? cur.wind_speed_10m ?? 3.2).toFixed(1)),
            wind_direction_deg: Math.round(hWDir[i] ?? cur.wind_direction_10m ?? 220),
            cloud_cover_pct: Math.round(hCloud[i] ?? cur.cloud_cover ?? 55),
            precipitation_mm: Number((hPrecip[i] ?? 0).toFixed(1)),
          });
        }

        const airTemp = Number(cur.temperature_2m.toFixed(1));
        const windDeg = Math.round(cur.wind_direction_10m ?? 220);

        const baseSnapshot: WeatherSnapshot = {
          lat,
          lng,
          captured_at: now.toISOString(),
          pressure_hpa: pressureHpa,
          pressure_mmhg: pressureMmhg,
          pressure_trend: trend,
          pressure_delta_6h: delta6h,
          pressure_stability_48h: stability48h,
          air_temp_c: airTemp,
          water_temp_c: Number(Math.max(1.0, (avg14d ?? airTemp) * 0.78 + 1.4).toFixed(1)),
          avg_air_temp_7d_c: avg7d,
          avg_air_temp_14d_c: avg14d,
          wind_speed_ms: Number((cur.wind_speed_10m ?? 3.2).toFixed(1)),
          wind_direction_deg: windDeg,
          wind_direction_label: windDegreesToLabel(windDeg),
          cloud_cover_pct: Math.round(cur.cloud_cover ?? hCloud[curIdx] ?? 55),
          precipitation_mm: Number((cur.precipitation ?? 0).toFixed(1)),
          recent_rain_72h_mm: Number(rain72h.toFixed(1)),
          moon_phase: moon.label,
          moon_illumination: moon.illumination,
          hourly: hourlyCompact,
          source: 'open-meteo',
        };
        baseSnapshot.water_temp_c = estimateWaterTempC(baseSnapshot).waterTempC;

        store.weatherCache.set(key, { data: baseSnapshot, expiresAt: Date.now() + 30 * 60 * 1000 });
        return baseSnapshot;
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
    pressure_delta_6h: 0,
    pressure_stability_48h: 0.82,
    air_temp_c: 4.5,
    water_temp_c: 5.8,
    avg_air_temp_7d_c: 4.8,
    avg_air_temp_14d_c: 5.4,
    wind_speed_ms: 3.8,
    wind_direction_deg: 235,
    wind_direction_label: 'ЮЗ',
    cloud_cover_pct: 60,
    precipitation_mm: 0.0,
    recent_rain_72h_mm: 2.5,
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
  waterBody?: WaterBody | null;
  reports?: CatchReport[];
}): Promise<BiteForecastResponse> {
  const { lat, lng, species, dateStr, waterBody = null, reports } = params;
  const baseDate = dateStr ? new Date(dateStr) : new Date();
  const dayKey = baseDate.toISOString().slice(0, 10);
  const wbKey = waterBody?.id ?? 'generic';
  const cacheKey = `${lat.toFixed(2)}:${lng.toFixed(2)}:${species.id}:${wbKey}:${dayKey}`;

  const cached = store.forecastCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.data, cached: true };
  }

  const weather = await fetchWeatherViaProxy(lat, lng);
  const meta = buildBiteForecastMetadata({
    weather,
    species,
    waterBody,
    reports,
    baseDate,
  });

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
            water_body_id: waterBody?.id ?? null,
            source: 'actigator',
            cached: false,
            disclaimer:
              'Прогноз рассчитан моделью Actigator. Результат носит вероятностный характер и не гарантирует клёв.',
            slots: external.slots,
            ...meta,
          };
          store.forecastCache.set(cacheKey, { data: response, expiresAt: Date.now() + 65 * 60 * 1000 });
          return response;
        }
      }
    } catch {
      // Fallback to Open-Meteo model below
    }
  }

  const slots = computeFIndexForecast({ species, weather, baseDate, waterBody, reports });
  const response: BiteForecastResponse = {
    lat,
    lng,
    fish_id: species.id,
    fish_name: species.name,
    water_body_id: waterBody?.id ?? null,
    source: 'open-meteo-fallback',
    cached: false,
    disclaimer:
      'Расчёт на базе почасовых данных Open-Meteo (14 дн. истории + 3 дн. прогноза), барометрической динамики, инерции воды, астрономии и калибровки по отчётам. Носит вероятностный характер.',
    slots,
    ...meta,
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

function buildPolygonFromLineNodes(
  nodes: Array<{ lat: number; lon: number }>,
  halfWidthM = 28
): { polygon: [number, number][]; center: LatLng } {
  const deduped: Array<{ lat: number; lon: number }> = [];
  for (const n of nodes) {
    const prev = deduped[deduped.length - 1];
    if (!prev || haversineMeters({ lat: prev.lat, lng: prev.lon }, { lat: n.lat, lng: n.lon }) >= 35) {
      deduped.push(n);
    }
  }
  const step = Math.max(1, Math.floor(deduped.length / 55));
  const sampled: Array<{ lat: number; lon: number }> = [];
  for (let i = 0; i < deduped.length; i += step) {
    sampled.push(deduped[i]);
  }
  if (deduped.length > 0 && sampled[sampled.length - 1] !== deduped[deduped.length - 1]) {
    sampled.push(deduped[deduped.length - 1]);
  }
  if (sampled.length < 2) {
    const pt = nodes[0] ?? { lat: 55.975, lon: 36.825 };
    const r = 0.0008;
    return {
      center: { lat: Number(pt.lat.toFixed(5)), lng: Number(pt.lon.toFixed(5)) },
      polygon: [
        [Number((pt.lon - r).toFixed(6)), Number(pt.lat.toFixed(6))],
        [Number(pt.lon.toFixed(6)), Number((pt.lat - r * 0.7).toFixed(6))],
        [Number((pt.lon + r).toFixed(6)), Number(pt.lat.toFixed(6))],
        [Number(pt.lon.toFixed(6)), Number((pt.lat + r * 0.7).toFixed(6))],
        [Number((pt.lon - r).toFixed(6)), Number(pt.lat.toFixed(6))],
      ],
    };
  }

  const refLat = sampled.reduce((s, p) => s + p.lat, 0) / sampled.length;
  const kx = 111320 * (Math.cos((refLat * Math.PI) / 180) || 1);
  const ky = 110540;
  const left: [number, number][] = [];
  const right: [number, number][] = [];

  for (let i = 0; i < sampled.length; i++) {
    const pPrev = sampled[Math.max(0, i - 1)];
    const pNext = sampled[Math.min(sampled.length - 1, i + 1)];
    const dx = (pNext.lon - pPrev.lon) * kx;
    const dy = (pNext.lat - pPrev.lat) * ky;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const dLon = (nx * halfWidthM) / kx;
    const dLat = (ny * halfWidthM) / ky;
    left.push([Number((sampled[i].lon + dLon).toFixed(5)), Number((sampled[i].lat + dLat).toFixed(5))]);
    right.unshift([Number((sampled[i].lon - dLon).toFixed(5)), Number((sampled[i].lat - dLat).toFixed(5))]);
  }
  const ring = [...left, ...right, left[0]];
  const mid = sampled[Math.floor(sampled.length / 2)];
  return {
    polygon: ring,
    center: { lat: Number(mid.lat.toFixed(5)), lng: Number(mid.lon.toFixed(5)) },
  };
}

function buildClosedPolygonFromNodes(nodes: Array<{ lat: number; lon: number }>): [number, number][] {
  const step = Math.max(1, Math.floor(nodes.length / 40));
  const ring: [number, number][] = [];
  for (let i = 0; i < nodes.length; i += step) {
    ring.push([Number(nodes[i].lon.toFixed(5)), Number(nodes[i].lat.toFixed(5))]);
  }
  if (ring.length >= 3) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push(first);
    }
    return ring;
  }
  return buildPolygonFromLineNodes(nodes).polygon;
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
  // Compact octagon marker when exact shoreline geometry is unavailable (never draw fake bounding-box rectangles over dry land)
  const rLng = 0.0011;
  const rLat = 0.0007;
  const polygon: [number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    polygon.push([
      Number((params.lng + Math.cos(a) * rLng).toFixed(5)),
      Number((params.lat + Math.sin(a) * rLat).toFixed(5)),
    ]);
  }
  polygon.push(polygon[0]);

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

interface NominatimLookupItem {
  osm_type?: 'way' | 'relation' | 'node';
  osm_id?: number;
  lat?: string;
  lon?: string;
  geojson?: {
    type?: 'Polygon' | 'MultiPolygon' | 'LineString' | 'MultiLineString' | 'Point';
    coordinates?: unknown;
  };
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

function extractGeometryFromNominatim(
  item: NominatimLookupItem,
  anchor: LatLng,
  type: WaterBodyType
): { polygon: [number, number][]; polygon_rings?: [number, number][][]; center: LatLng } | null {
  const g = item.geojson;
  if (!g || !g.coordinates) return null;

  const ensureClosed = (ring: [number, number][]): [number, number][] => {
    const out = ring.slice(0, 250).map(([x, y]) => [Number(x.toFixed(5)), Number(y.toFixed(5))] as [number, number]);
    if (out.length >= 3) {
      const f = out[0];
      const l = out[out.length - 1];
      if (f[0] !== l[0] || f[1] !== l[1]) out.push([f[0], f[1]]);
    }
    return out;
  };

  if (g.type === 'Polygon') {
    const coords = g.coordinates as [number, number][][];
    if (!Array.isArray(coords) || coords.length === 0 || coords[0].length < 4) return null;
    const rings = coords.map(ensureClosed).filter((r) => r.length >= 4);
    if (rings.length === 0) return null;
    const center = findInteriorWaterPoint(rings, anchor);
    return {
      polygon: rings[0],
      ...(rings.length > 1 ? { polygon_rings: rings } : {}),
      center,
    };
  }

  if (g.type === 'MultiPolygon') {
    const polys = g.coordinates as [number, number][][][];
    if (!Array.isArray(polys) || polys.length === 0) return null;
    const main = polys.slice().sort((a, b) => (b[0]?.length ?? 0) - (a[0]?.length ?? 0))[0];
    if (!main || main.length === 0 || main[0].length < 4) return null;
    const rings = main.map(ensureClosed).filter((r) => r.length >= 4);
    if (rings.length === 0) return null;
    const center = findInteriorWaterPoint(rings, anchor);
    return {
      polygon: rings[0],
      ...(rings.length > 1 ? { polygon_rings: rings } : {}),
      center,
    };
  }

  if (g.type === 'LineString' || g.type === 'MultiLineString') {
    const rawLines =
      g.type === 'LineString'
        ? [g.coordinates as [number, number][]]
        : (g.coordinates as [number, number][][]);
    // Pick the segment closest to anchor, clipped within 14 km so it stays focused
    let bestLine: [number, number][] = [];
    let bestDist = Infinity;
    for (const line of rawLines) {
      const nearPts = line.filter((pt) => haversineMeters(anchor, { lat: pt[1], lng: pt[0] }) <= 14000);
      const candidate = nearPts.length >= 2 ? nearPts : line;
      for (const pt of candidate) {
        const d = haversineMeters(anchor, { lat: pt[1], lng: pt[0] });
        if (d < bestDist) {
          bestDist = d;
          bestLine = candidate;
        }
      }
    }
    if (bestLine.length >= 2) {
      const buf = buildPolygonFromLineNodes(
        bestLine.map(([lon, lat]) => ({ lat, lon })),
        type === 'river' ? 28 : 18
      );
      return { polygon: buf.polygon, center: buf.center };
    }
  }

  return null;
}

function buildWaterBodyFromPhotonFeature(
  feat: PhotonFeature,
  nomMap: Map<string, NominatimLookupItem>
): WaterBody | null {
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
  if (Array.isArray(props.extent) && props.extent.length === 4) {
    const [minLon, maxLat, maxLon, minLat] = props.extent;
    const spanLon = Math.min(0.28, Math.max(0.002, Math.abs(maxLon - minLon)));
    const spanLat = Math.min(0.18, Math.max(0.0015, Math.abs(maxLat - minLat)));
    const dLatKm = spanLat * 111;
    const dLngKm = spanLon * 111 * Math.cos((lat * Math.PI) / 180);
    const approxHa = Math.round(dLatKm * dLngKm * (type === 'river' ? 12 : 45));
    if (approxHa >= 1 && approxHa <= 50000) areaHa = approxHa;
  }

  const osmTagKey = `${(props.osm_type ?? 'W').toUpperCase()}${props.osm_id ?? ''}`;
  const nomItem = props.osm_id ? nomMap.get(osmTagKey) : undefined;
  const extracted = nomItem ? extractGeometryFromNominatim(nomItem, { lat, lng }, type) : null;

  const region = [props.state, props.county].filter(Boolean).slice(0, 2).join(' · ') || 'OpenStreetMap';
  const osmTagId = `${props.osm_type ?? 'W'}${props.osm_id ?? `${lat.toFixed(4)}-${lng.toFixed(4)}`}`;
  const center = extracted?.center ?? { lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)) };

  const base = buildWaterBodyFromGeocodeFeature({
    id: `wb-osm-${osmTagId}`,
    title: props.name.trim(),
    subtitle: region,
    lat: center.lat,
    lng: center.lng,
    type,
  });

  return {
    ...base,
    center,
    target_zone: center,
    polygon: extracted?.polygon ?? base.polygon,
    ...(extracted?.polygon_rings ? { polygon_rings: extracted.polygon_rings } : {}),
    area_ha: areaHa,
    external_id: `OSM-${osmTagId}`,
    confidence: extracted ? 0.9 : 0.8,
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

async function fetchNominatimLookup(osmIds: string[]): Promise<Map<string, NominatimLookupItem>> {
  const map = new Map<string, NominatimLookupItem>();
  if (osmIds.length === 0) return map;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3200);
  try {
    const url = `https://nominatim.openstreetmap.org/lookup?osm_ids=${osmIds.slice(0, 18).join(',')}&format=jsonv2&polygon_geojson=1&polygon_threshold=0.0005`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'FishCastAI/1.0' },
      signal: controller.signal,
    });
    if (!res.ok) return map;
    const items = (await res.json()) as NominatimLookupItem[];
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item.osm_type && item.osm_id) {
          const prefix = item.osm_type === 'relation' ? 'R' : item.osm_type === 'way' ? 'W' : 'N';
          map.set(`${prefix}${item.osm_id}`, item);
        }
      }
    }
  } catch {
    // Graceful fallback if Nominatim unreachable
  } finally {
    clearTimeout(timer);
  }
  return map;
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

  // 2) Optional Overpass exact-geometry enrichment (fast 2.8s cap)
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

  // Batch-enrich Photon water features with exact Nominatim polygon/line GeoJSONs
  const osmIdsToLookup: string[] = [];
  const seenLookupIds = new Set<string>();
  for (const batch of photonBatches) {
    for (const feat of batch) {
      const p = feat.properties;
      if (!isPhotonWaterFeature(p) || !p?.osm_id) continue;
      const t = (p.osm_type ?? '').toUpperCase();
      if (t !== 'W' && t !== 'R') continue;
      const key = `${t}${p.osm_id}`;
      if (!seenLookupIds.has(key)) {
        seenLookupIds.add(key);
        osmIdsToLookup.push(key);
      }
    }
  }
  const nomMap = await fetchNominatimLookup(osmIdsToLookup);

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

    let polygon: [number, number][];
    let interiorCenter: LatLng = { lat: Number(centerLat.toFixed(5)), lng: Number(centerLng.toFixed(5)) };

    if (type === 'river' && geom) {
      const buf = buildPolygonFromLineNodes(geom, 28);
      polygon = buf.polygon;
      interiorCenter = buf.center;
    } else if (geom && geom.length >= 4) {
      polygon = buildClosedPolygonFromNodes(geom);
      interiorCenter = findInteriorWaterPoint([polygon], interiorCenter);
    } else {
      polygon = buildWaterBodyFromGeocodeFeature({
        id: `wb-osm-${el.type}-${el.id}`,
        title: rawName,
        lat: centerLat,
        lng: centerLng,
        type,
      }).polygon;
    }

    addCandidate({
      id: `wb-osm-${el.type}-${el.id}`,
      name: rawName,
      display_label: rawName,
      type,
      center: interiorCenter,
      polygon,
      area_ha: areaHa,
      source: 'osm',
      confidence: 0.9,
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
      target_zone: interiorCenter,
    });
  }

  for (const batch of photonBatches) {
    for (const feat of batch) {
      const wb = buildWaterBodyFromPhotonFeature(feat, nomMap);
      if (wb) addCandidate(wb);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 20)
    .map((entry) => entry.wb);
}


