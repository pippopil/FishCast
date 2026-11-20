import type { WeatherSnapshot } from './types';

function readEnvApiBase(): string {
  try {
    const raw = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL;
    return typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

export function getApiBaseUrl(): string {
  return readEnvApiBase();
}

export function apiUrl(path: string): string {
  const base = getApiBaseUrl();
  if (!base) return path;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function isCapacitorNative(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (cap?.isNativePlatform?.()) return true;
  return window.location.protocol === 'capacitor:' || window.location.protocol === 'file:';
}

export function getRealtimeWsUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const base = getApiBaseUrl();
  if (base) {
    try {
      const parsed = new URL(base);
      const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProto}//${parsed.host}/ws`;
    } catch {
      return null;
    }
  }
  if (isCapacitorNative()) {
    // Standalone APK without configured backend URL skips local WS reconnect loop
    return null;
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

function compassDirection(deg: number): string {
  const dirs = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8] ?? 'З';
}

function computeMoonIllumination(): { phase: string; illum: number } {
  const knownNewMoon = Date.UTC(2025, 0, 29, 12, 36, 0);
  const synodicMs = 29.53058867 * 86400000;
  const age = ((((Date.now() - knownNewMoon) % synodicMs) + synodicMs) % synodicMs) / synodicMs;
  const illum = Math.round(((1 - Math.cos(age * 2 * Math.PI)) / 2) * 100);
  if (age < 0.06 || age > 0.94) return { phase: 'Новолуние', illum };
  if (age < 0.22) return { phase: 'Растущий серп', illum };
  if (age < 0.28) return { phase: 'Первая четверть', illum };
  if (age < 0.47) return { phase: 'Растущая луна', illum };
  if (age < 0.53) return { phase: 'Полнолуние', illum };
  if (age < 0.72) return { phase: 'Убывающая луна', illum };
  if (age < 0.78) return { phase: 'Последняя четверть', illum };
  return { phase: 'Стареющий серп', illum };
}

export function buildFallbackWeather(lat = 55.975, lng = 36.825): WeatherSnapshot {
  const month = new Date().getMonth() + 1;
  const air = month >= 6 && month <= 8 ? 21 : month === 5 || month === 9 ? 14 : month === 4 || month === 10 ? 7 : 3;
  const water = Number(Math.max(1.5, air - 1.2).toFixed(1));
  const moon = computeMoonIllumination();
  return {
    lat,
    lng,
    captured_at: new Date().toISOString(),
    pressure_hpa: 1013,
    pressure_mmhg: 760,
    pressure_trend: 'steady',
    pressure_delta_6h: 0,
    pressure_stability_48h: 0.8,
    air_temp_c: air,
    water_temp_c: water,
    avg_air_temp_7d_c: air,
    avg_air_temp_14d_c: air,
    wind_speed_ms: 2.8,
    wind_direction_deg: 225,
    wind_direction_label: 'ЮЗ',
    cloud_cover_pct: 55,
    precipitation_mm: 0,
    recent_rain_72h_mm: 0,
    moon_phase: moon.phase,
    moon_illumination: moon.illum,
    source: 'offline-fallback',
  };
}

export async function fetchOpenMeteoWeatherDirect(lat: number, lng: number): Promise<WeatherSnapshot> {
  const moon = computeMoonIllumination();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
      `&current=temperature_2m,precipitation,pressure_msl,surface_pressure,cloud_cover,wind_speed_10m,wind_direction_10m` +
      `&hourly=temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,cloud_cover,precipitation` +
      `&past_days=14&forecast_days=3&wind_speed_unit=ms&timezone=auto`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return buildFallbackWeather(lat, lng);
    const data = (await res.json()) as {
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
    const cur = data.current;
    if (!cur || typeof cur.temperature_2m !== 'number') return buildFallbackWeather(lat, lng);

    const hTime = data.hourly?.time ?? [];
    const hTemp = data.hourly?.temperature_2m ?? [];
    const hPres = data.hourly?.pressure_msl ?? [];
    const hWind = data.hourly?.wind_speed_10m ?? [];
    const hWDir = data.hourly?.wind_direction_10m ?? [];
    const hCloud = data.hourly?.cloud_cover ?? [];
    const hPrecip = data.hourly?.precipitation ?? [];

    const curPrefix = (cur.time ?? new Date().toISOString()).slice(0, 13);
    let curIdx = hTime.findIndex((t) => t.startsWith(curPrefix));
    if (curIdx < 0) curIdx = Math.max(0, Math.min(hTime.length - 1, 14 * 24));

    const meanRange = (arr: number[], start: number, end: number): number | undefined => {
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

    const avg7d = meanRange(hTemp, curIdx - 7 * 24, curIdx + 1);
    const avg14d = meanRange(hTemp, curIdx - 14 * 24, curIdx + 1);
    let rain72h = 0;
    for (let i = Math.max(0, curIdx - 72); i <= Math.min(hPrecip.length - 1, curIdx); i++) {
      rain72h += Number(hPrecip[i] ?? 0);
    }

    const pressureHpa = Math.round(cur.pressure_msl ?? cur.surface_pressure ?? hPres[curIdx] ?? 1013);
    const pressureMmhg = Math.round(pressureHpa * 0.750062);
    const p6 = curIdx >= 6 && typeof hPres[curIdx - 6] === 'number' ? hPres[curIdx - 6] : pressureHpa;
    const delta6h = Number((pressureHpa - p6).toFixed(1));
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

    const hourlyCompact = [];
    const winStart = Math.max(0, curIdx - 48);
    const winEnd = Math.min(hTime.length, curIdx + 76);
    for (let i = winStart; i < winEnd; i++) {
      hourlyCompact.push({
        time: hTime[i],
        temp_c: Number((hTemp[i] ?? cur.temperature_2m).toFixed(1)),
        pressure_hpa: Number((hPres[i] ?? pressureHpa).toFixed(1)),
        wind_speed_ms: Number((hWind[i] ?? cur.wind_speed_10m ?? 3.0).toFixed(1)),
        wind_direction_deg: Math.round(hWDir[i] ?? cur.wind_direction_10m ?? 210),
        cloud_cover_pct: Math.round(hCloud[i] ?? cur.cloud_cover ?? 55),
        precipitation_mm: Number((hPrecip[i] ?? 0).toFixed(1)),
      });
    }

    const air = Number(cur.temperature_2m.toFixed(1));
    const windDeg = Math.round(cur.wind_direction_10m ?? 210);
    return {
      lat,
      lng,
      captured_at: new Date().toISOString(),
      pressure_hpa: pressureHpa,
      pressure_mmhg: pressureMmhg,
      pressure_trend: trend,
      pressure_delta_6h: delta6h,
      pressure_stability_48h: stability48h,
      air_temp_c: air,
      water_temp_c: Number(Math.max(1.0, (avg14d ?? air) * 0.78 + 1.4).toFixed(1)),
      avg_air_temp_7d_c: avg7d,
      avg_air_temp_14d_c: avg14d,
      wind_speed_ms: Number((cur.wind_speed_10m ?? 3.0).toFixed(1)),
      wind_direction_deg: windDeg,
      wind_direction_label: compassDirection(windDeg),
      cloud_cover_pct: Math.round(cur.cloud_cover ?? hCloud[curIdx] ?? 55),
      precipitation_mm: Number((cur.precipitation ?? 0).toFixed(1)),
      recent_rain_72h_mm: Number(rain72h.toFixed(1)),
      moon_phase: moon.phase,
      moon_illumination: moon.illum,
      hourly: hourlyCompact,
      source: 'open-meteo',
    };
  } catch {
    return buildFallbackWeather(lat, lng);
  }
}
