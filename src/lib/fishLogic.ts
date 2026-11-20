import type {
  BathymetryPoint,
  BiteAlertEvent,
  BiteAlertSettings,
  BiteForecastSlot,
  CatchReport,
  FishSpecies,
  GoodBiteWaterBodyItem,
  LatLng,
  LureRecommendationResult,
  ProspectiveZone,
  RouteMultiResult,
  WaterBody,
  WaterBodyAccessPoint,
  WaterBodyAnalysis,
  WeatherSnapshot,
} from './types';

export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function pointInRing(point: LatLng, ring: [number, number][]): boolean {
  if (!ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi || 1e-16) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInWaterBody(
  point: LatLng,
  wb: Pick<WaterBody, 'polygon' | 'polygon_rings'>
): boolean {
  const rings = wb.polygon_rings && wb.polygon_rings.length > 0 ? wb.polygon_rings : [wb.polygon];
  if (rings.length === 0 || !pointInRing(point, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(point, rings[i])) return false;
  }
  return true;
}

export function distToWaterBoundaryMeters(
  point: LatLng,
  rings: [number, number][][]
): number {
  const cosLat = Math.cos((point.lat * Math.PI) / 180) || 1;
  const kx = 111320 * cosLat;
  const ky = 110540;
  let minSq = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const ax = (ring[i][0] - point.lng) * kx;
      const ay = (ring[i][1] - point.lat) * ky;
      const bx = (ring[i + 1][0] - point.lng) * kx;
      const by = (ring[i + 1][1] - point.lat) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      const t = lenSq > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq)) : 0;
      const px = ax + t * dx;
      const py = ay + t * dy;
      const dSq = px * px + py * py;
      if (dSq < minSq) minSq = dSq;
    }
  }
  return Math.sqrt(minSq);
}

export function findInteriorWaterPoint(
  rings: [number, number][][],
  prefer?: LatLng
): LatLng {
  const outer = rings[0];
  if (!outer || outer.length === 0) {
    return prefer ?? { lat: 55.975, lng: 36.825 };
  }
  if (prefer && pointInWaterBody(prefer, { polygon: outer, polygon_rings: rings })) {
    if (distToWaterBoundaryMeters(prefer, rings) >= 40) {
      return { lat: Number(prefer.lat.toFixed(5)), lng: Number(prefer.lng.toFixed(5)) };
    }
  }
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of outer) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const grid = 28;
  let best: { lat: number; lng: number; score: number } | null = null;
  for (let i = 0; i <= grid; i++) {
    for (let j = 0; j <= grid; j++) {
      const lng = minLng + (maxLng - minLng) * (i / grid);
      const lat = minLat + (maxLat - minLat) * (j / grid);
      const candidate = { lat, lng };
      if (!pointInWaterBody(candidate, { polygon: outer, polygon_rings: rings })) continue;
      const clearance = distToWaterBoundaryMeters(candidate, rings);
      const prefPenalty = prefer ? haversineMeters(candidate, prefer) * 0.04 : 0;
      const score = clearance - prefPenalty;
      if (!best || score > best.score) {
        best = { lat, lng, score };
      }
    }
  }
  if (best) {
    return { lat: Number(best.lat.toFixed(5)), lng: Number(best.lng.toFixed(5)) };
  }
  if (prefer) return prefer;
  return { lat: Number(outer[0][1].toFixed(5)), lng: Number(outer[0][0].toFixed(5)) };
}

export function windDegreesToLabel(deg: number): string {
  const dirs = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return dirs[idx];
}

export function formatWaterBodyTitle(wb: Pick<WaterBody, 'name' | 'type' | 'moderation_status'>): string {
  if (wb.name && wb.name.trim().length > 0) {
    return wb.name.trim();
  }
  if (wb.type === 'pond') return 'Пруд (предположительно)';
  if (wb.type === 'oxbow') return 'Безымянная старица';
  if (wb.type === 'quarry') return 'Безымянный карьер';
  return 'Безымянный водоём';
}

export function probabilityLabelFromScore(score: number): BiteForecastSlot['probability_label'] {
  if (score >= 66) return 'высокая вероятность';
  if (score >= 40) return 'средняя вероятность';
  return 'низкая вероятность';
}

export function computeFIndexForecast(params: {
  species: FishSpecies;
  weather: WeatherSnapshot;
  baseDate: Date;
}): BiteForecastSlot[] {
  const { species, weather, baseDate } = params;
  const slots: BiteForecastSlot[] = [];
  const month = baseDate.getMonth() + 1;
  const seasonScore = species.season_activity[month] ?? 55;
  const [optMin, optMax] = species.optimal_water_temp_c;
  const optMid = (optMin + optMax) / 2;
  const tempDiff = Math.abs(weather.water_temp_c - optMid);
  const tempFactor = Math.max(0, 22 - tempDiff * 1.8);

  const pressurePenalty =
    weather.pressure_trend === 'steady'
      ? 14
      : weather.pressure_trend === 'rising'
        ? 9
        : 3;

  const windPenalty = weather.wind_speed_ms > 9 ? -14 : weather.wind_speed_ms >= 2 && weather.wind_speed_ms <= 5 ? 8 : 2;
  const dayNames = ['Сегодня', 'Завтра', 'Послезавтра'];
  const intervals = ['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00'];

  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const d = new Date(baseDate.getTime() + dayOffset * 86400000);
    const dateStr = d.toISOString().slice(0, 10);

    for (let i = 0; i < intervals.length; i++) {
      const hour = i * 3;
      const isNocturnal = species.id === 'nalim' || species.id === 'som';
      let timeBoost = 0;
      if (isNocturnal) {
        if (hour === 0 || hour === 21) timeBoost = 13;
        else if (hour === 18 || hour === 3) timeBoost = 8;
        else timeBoost = -10;
      } else {
        if (hour === 6 || hour === 9) timeBoost = 15;
        else if (hour === 18 || hour === 21) timeBoost = 13;
        else if (hour === 12 || hour === 15) timeBoost = species.category === 'peaceful' ? 4 : 2;
        else timeBoost = species.id === 'sudak' ? 10 : -10;
      }

      // Subtle deterministic variation across the 3 days
      const wave = Math.round(Math.sin((dayOffset * 8 + i) * 0.65) * 5);
      const raw = seasonScore * 0.45 + tempFactor + pressurePenalty + windPenalty + timeBoost + wave;
      const f_index = Math.max(8, Math.min(94, Math.round(raw)));

      const factors: string[] = [];
      if (weather.pressure_trend === 'steady') factors.push('Стабильное давление');
      else if (weather.pressure_trend === 'falling') factors.push('Снижение давления (−)');
      else factors.push('Рост давления');

      if (hour === 6 || hour === 18) factors.push('Сумеречная активность');
      if (weather.wind_speed_ms <= 5) factors.push('Умеренный ветер');
      else if (weather.wind_speed_ms > 9) factors.push('Сильный ветер (−)');

      slots.push({
        date: dateStr,
        day_label: dayNames[dayOffset],
        hour_interval: intervals[i],
        f_index,
        probability_label: probabilityLabelFromScore(f_index),
        factors,
      });
    }
  }
  return slots;
}

export function evaluateGoodBiteWaterBodies(params: {
  origin: LatLng;
  waterBodies: WaterBody[];
  speciesList: FishSpecies[];
  weather: WeatherSnapshot;
  reports: CatchReport[];
  baseDate: Date;
  radiusKm?: number;
  fishId?: string;
  dayLabel?: 'Сегодня' | 'Завтра';
  minFIndex?: number;
}): GoodBiteWaterBodyItem[] {
  const {
    origin,
    waterBodies,
    speciesList,
    weather,
    reports,
    baseDate,
    radiusKm = 100,
    fishId = 'all',
    dayLabel = 'Сегодня',
    minFIndex = 66,
  } = params;

  if (speciesList.length === 0 || waterBodies.length === 0) return [];

  const targetSpeciesPool =
    fishId !== 'all'
      ? speciesList.filter((s) => s.id === fishId)
      : speciesList;
  if (targetSpeciesPool.length === 0) return [];

  // Precompute meteorological peak F-Index per species for the chosen day
  const speciesPeakMap = new Map<string, { peak: BiteForecastSlot; species: FishSpecies }>();
  for (const sp of targetSpeciesPool) {
    const slots = computeFIndexForecast({ species: sp, weather, baseDate }).filter(
      (s) => s.day_label === dayLabel
    );
    const peak = slots.reduce(
      (best, cur) => (cur.f_index > best.f_index ? cur : best),
      slots[0]
    );
    if (peak) {
      speciesPeakMap.set(sp.id, { peak, species: sp });
    }
  }

  const recentThresholdMs = baseDate.getTime() - 14 * 86400000;
  const results: GoodBiteWaterBodyItem[] = [];

  for (const wb of waterBodies) {
    const distKm = Number((haversineMeters(origin, wb.center) / 1000).toFixed(1));
    if (distKm > radiusKm) continue;

    let bestCandidate: GoodBiteWaterBodyItem | null = null;

    for (const sp of targetSpeciesPool) {
      const entry = speciesPeakMap.get(sp.id);
      if (!entry) continue;

      let modifier = 0;
      const reasons: string[] = [];

      // Habitat type match
      if (sp.water_types.includes(wb.type)) {
        modifier += 3;
        reasons.push(`подходящий тип (${waterBodyTypeRu(wb.type).toLowerCase()})`);
      } else {
        modifier -= 18;
      }

      // Depth compatibility
      if (wb.max_depth_m !== null) {
        if (
          wb.max_depth_m >= sp.depth_range_m[0] &&
          (wb.avg_depth_m ?? wb.max_depth_m * 0.5) <= sp.depth_range_m[1] + 2.5
        ) {
          modifier += 2;
          if (wb.has_bathymetry) {
            reasons.push('глубины и бровки');
          }
        } else if (wb.max_depth_m < 0.7 && sp.depth_range_m[0] >= 0.8) {
          modifier -= 18;
        }
      }

      // Hydrological & NDWI stability
      if (wb.ndwi_stability === 'year_round') {
        modifier += 1;
      } else if (wb.ndwi_stability === 'seasonal_low') {
        modifier -= 9;
      } else {
        modifier -= 26;
      }

      if (wb.connected_to) {
        modifier += 2;
        reasons.push('проточный водоём');
      }

      if (wb.vegetation_index === 'algal_bloom') {
        modifier -= 12;
      }

      if (wb.has_bathymetry) {
        modifier += 2;
      }

      if (wb.confidence < 0.7 || wb.moderation_status === 'unverified') {
        modifier -= 8;
      }

      // Depth & water clarity synergy
      if (sp.id === 'nalim' || sp.id === 'sudak') {
        if ((wb.max_depth_m ?? 0) >= 6) {
          modifier += 2;
        } else if ((wb.max_depth_m ?? 0) < 4) {
          modifier -= 7;
        }
      }
      if (wb.water_clarity === 'clear' && (sp.id === 'okun' || sp.id === 'pike' || sp.id === 'golavl')) {
        modifier += 1;
      } else if (wb.water_clarity === 'murky' && sp.id === 'sudak') {
        modifier -= 4;
      }

      // Large open-water affinity vs wind shelter
      if (wb.area_ha >= 1000 && (sp.id === 'sudak' || sp.id === 'pike' || sp.id === 'lesh')) {
        modifier += 2;
      } else if (wb.area_ha < 2 && (sp.id === 'sudak' || sp.id === 'nalim')) {
        modifier -= 12;
      }

      if (wb.area_ha > 800 && weather.wind_speed_ms > 7) {
        modifier -= 4;
      } else if (wb.area_ha <= 25 && weather.wind_speed_ms > 5) {
        modifier += 2;
        reasons.push('укрыт от ветра');
      }

      // Subtle deterministic micro-relief adjustment (-3..+2) from water body geometry
      const microRelief = (Math.round((wb.center.lat * 100 + wb.center.lng * 100) % 6) - 3);
      modifier += microRelief;

      // Recent crowd reports on this water body
      const wbReports = reports.filter(
        (r) =>
          r.water_body_id === wb.id &&
          r.visibility !== 'private' &&
          new Date(r.created_at).getTime() >= recentThresholdMs
      );
      const matchingSpeciesReports = wbReports.filter((r) => r.fish_species_id === sp.id);
      if (matchingSpeciesReports.length > 0) {
        modifier += Math.min(8, matchingSpeciesReports.length * 4);
        reasons.push(`свежие отчёты (${matchingSpeciesReports.length})`);
      } else if (wbReports.length > 0 && fishId === 'all') {
        modifier += Math.min(3, wbReports.length * 1);
      }

      if (weather.pressure_trend === 'steady') {
        reasons.push('стабильное давление');
      } else if (weather.pressure_trend === 'rising') {
        reasons.push('рост давления');
      }

      const finalScore = Math.max(8, Math.min(94, Math.round(entry.peak.f_index + modifier)));
      const candidate: GoodBiteWaterBodyItem = {
        water_body: wb,
        distance_km: distKm,
        f_index: finalScore,
        probability_label: probabilityLabelFromScore(finalScore),
        best_species_id: sp.id,
        best_species_name: sp.name,
        peak_hour: entry.peak.hour_interval,
        day_label: dayLabel,
        recent_reports_count: matchingSpeciesReports.length,
        reasons: reasons.slice(0, 3),
      };

      if (!bestCandidate || candidate.f_index > bestCandidate.f_index) {
        bestCandidate = candidate;
      }
    }

    if (bestCandidate && bestCandidate.f_index >= minFIndex) {
      results.push(bestCandidate);
    }
  }

  return results.sort((a, b) => {
    if (b.f_index !== a.f_index) return b.f_index - a.f_index;
    return a.distance_km - b.distance_km;
  });
}

export function analyzeWaterBody(params: {
  waterBody: WaterBody;
  crowdReportCount: number;
  snapshotDate?: string;
}): WaterBodyAnalysis {
  const { waterBody, crowdReportCount, snapshotDate = '2026-10-18' } = params;
  const reasons: WaterBodyAnalysis['reasons'] = [];
  let score = 45;

  if (waterBody.connected_to) {
    score += 22;
    reasons.push({
      factor: 'Связь с водотоком',
      impact: '+',
      detail: `связан с ${waterBody.connected_name ?? 'ручьём / рекой'} (+)`,
    });
  } else {
    score -= 14;
    reasons.push({
      factor: 'Изолированность',
      impact: '-',
      detail: 'изолированный водоём без протоки (−)',
    });
  }

  if (waterBody.area_ha >= 0.5) {
    score += 14;
    reasons.push({
      factor: 'Площадь акватории',
      impact: '+',
      detail: `площадь ${waterBody.area_ha.toFixed(2).replace('.', ',')} га (+)`,
    });
  } else if (waterBody.area_ha < 0.1) {
    score -= 22;
    reasons.push({
      factor: 'Малая площадь',
      impact: '-',
      detail: `площадь ${waterBody.area_ha.toFixed(2).replace('.', ',')} га < 0,1 га (−)`,
    });
  } else {
    score -= 5;
    reasons.push({
      factor: 'Площадь акватории',
      impact: '-',
      detail: `площадь ${waterBody.area_ha.toFixed(2).replace('.', ',')} га (−)`,
    });
  }

  if (waterBody.ndwi_stability === 'year_round') {
    score += 12;
    reasons.push({
      factor: 'Стабильность воды (NDWI)',
      impact: '+',
      detail: 'вода круглый год (+)',
    });
  } else if (waterBody.ndwi_stability === 'seasonal_low') {
    score -= 6;
    reasons.push({
      factor: 'Сезонное обмеление',
      impact: '-',
      detail: 'снижение уровня в межень (−)',
    });
  } else {
    score -= 26;
    reasons.push({
      factor: 'Пересыхание',
      impact: '-',
      detail: 'пересыхает летом по Sentinel-2 (−)',
    });
  }

  if (waterBody.max_depth_m !== null) {
    if (waterBody.max_depth_m >= 1.5) {
      score += 10;
      reasons.push({
        factor: 'Глубина котловины',
        impact: '+',
        detail: `глубина до ${waterBody.max_depth_m.toFixed(1).replace('.', ',')} м (+)`,
      });
    } else if (waterBody.max_depth_m < 0.5) {
      score -= 18;
      reasons.push({
        factor: 'Мелководье',
        impact: '-',
        detail: `глубина < 0,5 м (−)`,
      });
    }
  }

  if (waterBody.vegetation_index === 'moderate') {
    score += 6;
    reasons.push({
      factor: 'Кормовая база (индекс растительности)',
      impact: '+',
      detail: 'умеренная продуктивность (+)',
    });
  } else if (waterBody.vegetation_index === 'algal_bloom') {
    score -= 12;
    reasons.push({
      factor: 'Цветение / заморный риск',
      impact: '-',
      detail: 'избыточный хлорофилл (−)',
    });
  }

  if (crowdReportCount > 0) {
    score += Math.min(12, crowdReportCount * 4);
    reasons.push({
      factor: 'Исторические отметки',
      impact: '+',
      detail: `отметок уловов: ${crowdReportCount} (+)`,
    });
  }

  const clamped = Math.max(5, Math.min(95, Math.round(score)));
  const fish_probability: WaterBodyAnalysis['fish_probability'] =
    clamped >= 65 ? 'high' : clamped >= 40 ? 'medium' : 'low';

  const recommendation =
    fish_probability === 'high'
      ? 'Рекомендуем проверить бровки у втока, прибрежную растительность и русловые перепады.'
      : fish_probability === 'medium'
        ? 'Рекомендуем проверить бровки у втока и более глубокие участки у плотины/выхода.'
        : 'Вероятность стабильной популяции низкая; возможен лишь неприхотливый карась или ротан. Проверьте уровень воды на месте.';

  return {
    id: `analysis-${waterBody.id}`,
    water_body_id: waterBody.id,
    analyzed_at: new Date().toISOString(),
    fish_probability,
    score: clamped,
    reasons,
    recommendation,
    disclaimer:
      'Оценка носит вероятностный характер, не гарантирует наличие рыбы и не заменяет разведку на месте.',
    satellite_snapshot_date: snapshotDate,
    model_version: 'rules-v1.0-ndwi-dem',
  };
}

export function detectProspectiveZones(points: BathymetryPoint[]): ProspectiveZone[] {
  if (points.length < 2) return [];
  const zones: ProspectiveZone[] = [];
  const usedIds = new Set<string>();

  // 1. Detect local maxima in depth (ямы / local depth minima in elevation)
  const sortedByDepth = [...points].sort((a, b) => b.depth_m - a.depth_m);
  for (const pt of sortedByDepth) {
    if (pt.depth_m < 3.0) break;
    const neighbors = points.filter(
      (other) => other.id !== pt.id && haversineMeters(pt, other) < 450
    );
    const isDeepestLocal =
      neighbors.length === 0 || neighbors.every((n) => pt.depth_m >= n.depth_m - 0.1);
    if (isDeepestLocal && !usedIds.has(pt.id)) {
      const tooCloseToExistingHole = zones.some(
        (z) => z.kind === 'hole' && haversineMeters(z, pt) < 350
      );
      if (!tooCloseToExistingHole) {
        usedIds.add(pt.id);
        zones.push({
          id: `hole-${pt.id}`,
          kind: 'hole',
          label: `Яма ${pt.depth_m.toFixed(1)} м`,
          lat: pt.lat,
          lng: pt.lng,
          depth_m: pt.depth_m,
        });
      }
    }
    if (zones.filter((z) => z.kind === 'hole').length >= 4) break;
  }

  // 2. Detect sharp depth drop-offs (бровки) between adjacent points
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i];
      const b = points[j];
      const dist = haversineMeters(a, b);
      if (dist < 15 || dist > 350) continue;
      const diff = Math.abs(a.depth_m - b.depth_m);
      const gradientPer10m = (diff / dist) * 10;
      if (diff >= 1.8 && gradientPer10m >= 0.08) {
        const mid: LatLng = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
        const tooClose = zones.some(
          (z) => z.kind === 'dropoff' && haversineMeters(z, mid) < 300
        );
        if (!tooClose) {
          const minD = Math.min(a.depth_m, b.depth_m).toFixed(1);
          const maxD = Math.max(a.depth_m, b.depth_m).toFixed(1);
          zones.push({
            id: `dropoff-${a.id}-${b.id}`,
            kind: 'dropoff',
            label: `Бровка ${minD}→${maxD} м`,
            lat: mid.lat,
            lng: mid.lng,
            depth_m: Number(((a.depth_m + b.depth_m) / 2).toFixed(1)),
            gradient_m_per_10m: Number(gradientPer10m.toFixed(2)),
          });
        }
      }
    }
  }

  return zones.slice(0, 8);
}

export function recommendLures(params: {
  species: FishSpecies;
  waterBody: WaterBody | null;
  month: number;
  clarity?: WaterBody['water_clarity'];
}): LureRecommendationResult[] {
  const { species, waterBody, month, clarity = waterBody?.water_clarity ?? 'moderate' } = params;
  const wbDepth = waterBody?.avg_depth_m ?? ((species.depth_range_m[0] + species.depth_range_m[1]) / 2);

  return species.lures
    .map((lure) => {
      let score = lure.base_rank * 10;
      const reasons: string[] = [];

      if (lure.best_seasons.includes(month)) {
        score += 18;
        reasons.push('подходит для текущего сезона');
      } else {
        score -= 8;
      }

      if (wbDepth >= lure.depth_min_m && wbDepth <= lure.depth_max_m) {
        score += 16;
        reasons.push(`рабочий горизонт ${lure.depth_min_m}–${lure.depth_max_m} м`);
      } else {
        score -= 10;
      }

      if (lure.best_clarity.includes(clarity)) {
        score += 10;
        reasons.push(
          clarity === 'clear'
            ? 'для прозрачной воды'
            : clarity === 'murky'
              ? 'заметна в мутной воде'
              : 'универсальная прозрачность'
        );
      }

      if (waterBody && lure.water_types.includes(waterBody.type)) {
        score += 12;
        reasons.push(`эффективна на типе «${waterBodyTypeRu(waterBody.type)}»`);
      }

      return {
        lure,
        score: Math.max(10, Math.min(99, Math.round(score))),
        reasons: reasons.length > 0 ? reasons : [lure.rationale],
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function waterBodyTypeRu(t: WaterBody['type']): string {
  switch (t) {
    case 'reservoir':
      return 'Водохранилище';
    case 'river':
      return 'Река';
    case 'lake':
      return 'Озеро';
    case 'pond':
      return 'Пруд';
    case 'quarry':
      return 'Карьер';
    case 'oxbow':
      return 'Старица';
  }
}

export function selectBestAccessPoint(params: {
  accessPoints: WaterBodyAccessPoint[];
  targetPoint: LatLng;
  avoidUnpaved: boolean;
}): {
  selected: WaterBodyAccessPoint | null;
  nearestRoadDistanceM: number;
  drivingAvailable: boolean;
} {
  const { accessPoints, targetPoint, avoidUnpaved } = params;
  if (accessPoints.length === 0) {
    return { selected: null, nearestRoadDistanceM: 3200, drivingAvailable: false };
  }

  const drivable = accessPoints.filter((ap) => {
    if (!ap.driving_reachable) return false;
    if (avoidUnpaved && ap.unpaved) return false;
    return true;
  });

  if (drivable.length === 0) {
    // Pick nearest road_end/settlement even if unreachable by car for walking distance estimate
    const sortedAll = [...accessPoints].sort(
      (a, b) => haversineMeters(a, targetPoint) - haversineMeters(b, targetPoint)
    );
    const nearest = sortedAll[0];
    return {
      selected: nearest,
      nearestRoadDistanceM: Math.round(haversineMeters(nearest, targetPoint)),
      drivingAvailable: false,
    };
  }

  const sortedDrivable = [...drivable].sort(
    (a, b) => haversineMeters(a, targetPoint) - haversineMeters(b, targetPoint)
  );
  const best = sortedDrivable[0];
  return {
    selected: best,
    nearestRoadDistanceM: Math.round(haversineMeters(best, targetPoint)),
    drivingAvailable: true,
  };
}

export function buildSplitRouteMetrics(params: {
  origin: LatLng;
  waterBody: WaterBody;
  accessPoints: WaterBodyAccessPoint[];
  avoidUnpaved: boolean;
  quotaExceeded?: boolean;
}): RouteMultiResult {
  const { origin, waterBody, accessPoints, avoidUnpaved, quotaExceeded } = params;
  const targetPoint = waterBody.target_zone ?? waterBody.center;
  const { selected, nearestRoadDistanceM, drivingAvailable } = selectBestAccessPoint({
    accessPoints,
    targetPoint,
    avoidUnpaved,
  });

  const walkStart: LatLng = selected
    ? { lat: selected.lat, lng: selected.lng }
    : { lat: targetPoint.lat - 0.022, lng: targetPoint.lng - 0.02 };

  const walkMeters = Math.max(40, Math.round(haversineMeters(walkStart, targetPoint) * 1.18));
  const walkSeconds = Math.round(walkMeters / 1.15); // ~4.1 km/h trail speed

  const walkingSegment = {
    mode: 'walking' as const,
    distance_m: walkMeters,
    duration_s: walkSeconds,
    geometry: [
      [walkStart.lng, walkStart.lat] as [number, number],
      [
        (walkStart.lng + targetPoint.lng) / 2 + 0.0007,
        (walkStart.lat + targetPoint.lat) / 2 - 0.0005,
      ] as [number, number],
      [targetPoint.lng, targetPoint.lat] as [number, number],
    ],
  };

  const yandexMapsUrl = `https://yandex.ru/maps/?rtext=${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}~${walkStart.lat.toFixed(5)},${walkStart.lng.toFixed(5)}&rtt=auto`;

  if (!drivingAvailable || !selected) {
    const distKm = (nearestRoadDistanceM / 1000).toFixed(1).replace('.', ',');
    const walkMin = Math.max(1, Math.round(walkSeconds / 60));
    return {
      water_body_id: waterBody.id,
      access_point: selected,
      target_point: targetPoint,
      driving_available: false,
      driving_segment: null,
      walking_segment: walkingSegment,
      unavailable_reason: `Автомобильный маршрут недоступен. Ближайшая дорога — в ${distKm} км. Пеший подход — ${walkMin} мин.`,
      yandex_maps_url: yandexMapsUrl,
      avoid_unpaved: avoidUnpaved,
      source: 'yandex-fallback-osrm',
      quota_warning: quotaExceeded
        ? 'Дневной лимит API маршрутизации исчерпан — показан резервный расчёт.'
        : undefined,
    };
  }

  const straightDrive = haversineMeters(origin, walkStart);
  const driveFactor = avoidUnpaved ? 1.32 : 1.24;
  const driveMeters = Math.max(250, Math.round(straightDrive * driveFactor));
  const avgSpeedMs = avoidUnpaved ? 13.8 : 11.5; // paved highway is faster than dirt tracks
  const driveSeconds = Math.round(driveMeters / avgSpeedMs);

  // Midpoint deflection to simulate road curve and difference when avoidUnpaved is active
  const curveOffset = avoidUnpaved ? 0.009 : -0.005;
  const midLng = (origin.lng + walkStart.lng) / 2 + curveOffset;
  const midLat = (origin.lat + walkStart.lat) / 2 + (avoidUnpaved ? 0.006 : -0.004);

  return {
    water_body_id: waterBody.id,
    access_point: selected,
    target_point: targetPoint,
    driving_available: true,
    driving_segment: {
      mode: 'driving',
      distance_m: driveMeters,
      duration_s: driveSeconds,
      geometry: [
        [origin.lng, origin.lat],
        [midLng, midLat],
        [walkStart.lng, walkStart.lat],
      ],
    },
    walking_segment: walkingSegment,
    yandex_maps_url: yandexMapsUrl,
    avoid_unpaved: avoidUnpaved,
    source: 'yandex-fallback-osrm',
    quota_warning: quotaExceeded
      ? 'Дневной лимит API маршрутизации исчерпан — показан резервный расчёт.'
      : undefined,
  };
}

export function decodePolyline6(encoded: string, maxPoints = 320): [number, number][] {
  if (!encoded || typeof encoded !== 'string') return [];
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let b = 0;
    do {
      if (index >= encoded.length) return coords;
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dLat;

    shift = 0;
    result = 0;
    do {
      if (index >= encoded.length) return coords;
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dLng;

    coords.push([Number((lng / 1e6).toFixed(6)), Number((lat / 1e6).toFixed(6))]);
  }

  if (coords.length <= maxPoints || maxPoints < 3) return coords;
  const step = (coords.length - 1) / (maxPoints - 1);
  const sampled: [number, number][] = [];
  for (let i = 0; i < maxPoints - 1; i++) {
    sampled.push(coords[Math.round(i * step)]);
  }
  sampled.push(coords[coords.length - 1]);
  return sampled;
}

export function validateCoordinates(lat: unknown, lng: unknown): string | null {
  if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
    return 'Требуются корректные координаты геолокации.';
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return 'Координаты выходят за допустимый диапазон.';
  }
  return null;
}

export function validateCatchReportInput(input: {
  lat?: number | null;
  lng?: number | null;
  fish_species_id?: string;
  source?: 'quick_mark' | 'diary';
  photo_size_bytes?: number;
  photo_mime?: string;
}): string | null {
  const coordErr = validateCoordinates(input.lat, input.lng);
  if (coordErr) return coordErr;
  if (!input.fish_species_id || input.fish_species_id.trim().length === 0) {
    return 'Выберите вид рыбы.';
  }
  if (input.photo_size_bytes !== undefined && input.photo_size_bytes > 5 * 1024 * 1024) {
    return 'Размер фото превышает лимит 5 МБ.';
  }
  if (
    input.photo_mime !== undefined &&
    !['image/jpeg', 'image/png', 'image/webp'].includes(input.photo_mime)
  ) {
    return 'Допустимые форматы фото: JPEG, PNG, WebP.';
  }
  return null;
}

export function validateDepthPointInput(input: {
  lat?: number | null;
  lng?: number | null;
  depth_m?: number | null;
}): string | null {
  const coordErr = validateCoordinates(input.lat, input.lng);
  if (coordErr) return coordErr;
  if (typeof input.depth_m !== 'number' || Number.isNaN(input.depth_m)) {
    return 'Укажите глубину в метрах.';
  }
  if (input.depth_m < 0.1 || input.depth_m > 200) {
    return 'Глубина должна быть от 0.1 до 200 м.';
  }
  return null;
}

export function evaluateFIndexAlerts(params: {
  items: GoodBiteWaterBodyItem[];
  favoriteIds: string[];
  settings: BiteAlertSettings;
  now?: Date;
  force?: boolean;
}): BiteAlertEvent[] {
  const { items, favoriteIds, settings, now = new Date(), force = false } = params;
  if (!settings.enabled && !force) return [];

  const favSet = new Set(favoriteIds);
  const cooldownMs = 6 * 60 * 60 * 1000;
  const events: BiteAlertEvent[] = [];

  for (const item of items) {
    if (item.f_index < settings.threshold) continue;
    const isFav = favSet.has(item.water_body.id);
    const isNearby = item.distance_km <= settings.nearby_radius_km;

    if (settings.scope === 'favorites_only' && !isFav) continue;
    if (settings.scope === 'nearby_only' && !isNearby) continue;
    if (settings.scope === 'favorites_and_nearby' && !isFav && !isNearby) continue;

    if (!force) {
      const prev = settings.last_notified[item.water_body.id];
      if (prev) {
        const elapsed = now.getTime() - new Date(prev.notified_at).getTime();
        const jumpedSignificantly = item.f_index >= prev.f_index + 5;
        if (elapsed < cooldownMs && !jumpedSignificantly) {
          continue;
        }
      }
    }

    const label = isFav ? 'Избранный водоём' : `Рядом (${item.distance_km.toFixed(1)} км)`;
    events.push({
      water_body_id: item.water_body.id,
      water_body_name: item.water_body.display_label,
      is_favorite: isFav,
      distance_km: item.distance_km,
      f_index: item.f_index,
      best_species_id: item.best_species_id,
      best_species_name: item.best_species_name,
      peak_hour: item.peak_hour,
      title: `Клёв F-${item.f_index}: ${item.water_body.display_label}`,
      body: `${label} · ${item.best_species_name}, пик в ${item.peak_hour} (порог F ≥ ${settings.threshold})`,
    });
  }

  events.sort((a, b) => {
    if (a.is_favorite !== b.is_favorite) return a.is_favorite ? -1 : 1;
    if (b.f_index !== a.f_index) return b.f_index - a.f_index;
    return a.distance_km - b.distance_km;
  });

  return events;
}

export type BathymetryProfileLineMode = 'transect' | 'west_east' | 'south_north';

export interface BathymetryProfilePoint {
  id: string;
  distance_m: number;
  distance_label: string;
  depth_m: number;
  bottom_elevation_m: number;
  source: BathymetryPoint['source'];
  source_label: string;
  lat: number;
  lng: number;
}

const DEPTH_SOURCE_LABELS: Record<BathymetryPoint['source'], string> = {
  seascape: 'Seascape',
  sonar: 'Эхолот / сонар',
  manual: 'Ручной промер',
};

export function buildBathymetryProfile(
  depthPoints: BathymetryPoint[],
  lineMode: BathymetryProfileLineMode = 'transect'
): BathymetryProfilePoint[] {
  if (depthPoints.length === 0) return [];

  const refLat = depthPoints[0].lat;
  const refLng = depthPoints[0].lng;
  const cosLat = Math.cos((refLat * Math.PI) / 180) || 1;
  const toXY = (pt: Pick<BathymetryPoint, 'lat' | 'lng'>) => ({
    x: (pt.lng - refLng) * 111320 * cosLat,
    y: (pt.lat - refLat) * 110540,
  });

  const coords = depthPoints.map((pt) => ({ pt, ...toXY(pt) }));

  let ux = 1;
  let uy = 0;
  if (lineMode === 'south_north') {
    ux = 0;
    uy = 1;
  } else if (lineMode === 'transect' && coords.length >= 2) {
    let bestDistSq = -1;
    let ax = coords[0].x;
    let ay = coords[0].y;
    let bx = coords[0].x;
    let by = coords[0].y;
    for (let i = 0; i < coords.length; i++) {
      for (let j = i + 1; j < coords.length; j++) {
        const dx = coords[j].x - coords[i].x;
        const dy = coords[j].y - coords[i].y;
        const dSq = dx * dx + dy * dy;
        if (dSq > bestDistSq) {
          bestDistSq = dSq;
          ax = coords[i].x;
          ay = coords[i].y;
          bx = coords[j].x;
          by = coords[j].y;
        }
      }
    }
    const len = Math.sqrt(bestDistSq);
    if (len >= 1) {
      ux = (bx - ax) / len;
      uy = (by - ay) / len;
      // Keep canonical left-to-right (or south-to-north when vertical) orientation
      if (ux < -0.001 || (Math.abs(ux) <= 0.001 && uy < 0)) {
        ux = -ux;
        uy = -uy;
      }
    }
  }

  const projected = coords.map((c) => ({
    pt: c.pt,
    proj: c.x * ux + c.y * uy,
  }));
  const minProj = Math.min(...projected.map((p) => p.proj));

  return projected
    .map((p) => {
      const distance_m = Math.max(0, Math.round(p.proj - minProj));
      const depth_m = Number(p.pt.depth_m.toFixed(2));
      return {
        id: p.pt.id,
        distance_m,
        distance_label: `${distance_m} м`,
        depth_m,
        bottom_elevation_m: Number((-depth_m).toFixed(2)),
        source: p.pt.source,
        source_label: DEPTH_SOURCE_LABELS[p.pt.source] ?? p.pt.source,
        lat: p.pt.lat,
        lng: p.pt.lng,
      };
    })
    .sort((a, b) => a.distance_m - b.distance_m);
}
