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
    pressure_hpa: 999,
    pressure_mmhg: 749,
    pressure_trend: 'steady',
    air_temp_c: air,
    water_temp_c: water,
    wind_speed_ms: 2.8,
    wind_direction_deg: 225,
    wind_direction_label: 'ЮЗ',
    precipitation_mm: 0,
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
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current=temperature_2m,precipitation,surface_pressure,wind_speed_10m,wind_direction_10m&hourly=surface_pressure&forecast_days=2&timezone=auto`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return buildFallbackWeather(lat, lng);
    const data = (await res.json()) as {
      current?: {
        temperature_2m?: number;
        precipitation?: number;
        surface_pressure?: number;
        wind_speed_10m?: number;
        wind_direction_10m?: number;
      };
      hourly?: { surface_pressure?: number[] };
    };
    const cur = data.current;
    if (!cur || typeof cur.temperature_2m !== 'number') return buildFallbackWeather(lat, lng);
    const pressureHpa = Math.round(cur.surface_pressure ?? 1013);
    const pressureMmhg = Math.round(pressureHpa * 0.750062);
    const pressures = data.hourly?.surface_pressure ?? [];
    const pNow = pressures[12] ?? pressureHpa;
    const pPrev = pressures[6] ?? pNow;
    const diff = pNow - pPrev;
    const trend: WeatherSnapshot['pressure_trend'] = diff > 1.2 ? 'rising' : diff < -1.2 ? 'falling' : 'steady';
    const air = Number(cur.temperature_2m.toFixed(1));
    const windDeg = Math.round(cur.wind_direction_10m ?? 210);
    return {
      lat,
      lng,
      captured_at: new Date().toISOString(),
      pressure_hpa: pressureHpa,
      pressure_mmhg: pressureMmhg,
      pressure_trend: trend,
      air_temp_c: air,
      water_temp_c: Number(Math.max(1.2, air + (air < 10 ? 1.1 : -1.8)).toFixed(1)),
      wind_speed_ms: Number(((cur.wind_speed_10m ?? 10) / 3.6).toFixed(1)),
      wind_direction_deg: windDeg,
      wind_direction_label: compassDirection(windDeg),
      precipitation_mm: Number((cur.precipitation ?? 0).toFixed(1)),
      moon_phase: moon.phase,
      moon_illumination: moon.illum,
      source: 'open-meteo',
    };
  } catch {
    return buildFallbackWeather(lat, lng);
  }
}
