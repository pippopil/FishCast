import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeWaterBody,
  buildSplitRouteMetrics,
  computeFIndexForecast,
  decodePolyline6,
  detectProspectiveZones,
  evaluateFIndexAlerts,
  evaluateGoodBiteWaterBodies,
  recommendLures,
  selectBestAccessPoint,
  validateCatchReportInput,
  validateDepthPointInput,
} from './fishLogic';
import {
  computeTileCoordsForBbox,
  estimateRegionTileCount,
  isPointInBbox,
  normalizeBboxSelection,
} from './offlineMapRegions';
import type { BathymetryPoint, CatchReport, FishSpecies, GoodBiteWaterBodyItem, WaterBody, WaterBodyAccessPoint, WeatherSnapshot } from './types';

const sampleSpecies: FishSpecies = {
  id: 'pike',
  name: 'Щука',
  latin_name: 'Esox lucius',
  category: 'predator',
  water_types: ['reservoir', 'river', 'lake', 'pond', 'oxbow'],
  depth_range_m: [1.5, 6.0],
  optimal_water_temp_c: [8, 16],
  time_of_day: 'Утро, сумерки',
  season_activity: { 1: 40, 2: 35, 3: 65, 4: 80, 5: 75, 6: 65, 7: 50, 8: 60, 9: 85, 10: 92, 11: 78, 12: 50 },
  min_legal_size_cm: 32,
  release_note: 'Проверьте правила рыболовства вашего региона (не является юридической консультацией).',
  lures: [
    {
      id: 'jig-vibro',
      lure_type: 'Силиконовый виброхвост 10–12 см',
      category: 'джиг',
      depth_min_m: 2.0,
      depth_max_m: 8.0,
      best_seasons: [9, 10, 11, 4, 5],
      best_clarity: ['clear', 'moderate', 'murky'],
      water_types: ['reservoir', 'river', 'lake'],
      retrieve: 'Ступенчатая проводка 2 оборота — пауза 2 сек',
      rationale: 'Классика по осенним бровкам',
      source: 'editorial',
      base_rank: 9,
    },
    {
      id: 'topwater-popper',
      lure_type: 'Поппер 70 мм',
      category: 'воблер',
      depth_min_m: 0.2,
      depth_max_m: 1.2,
      best_seasons: [6, 7, 8],
      best_clarity: ['clear', 'moderate'],
      water_types: ['pond', 'oxbow', 'lake'],
      retrieve: 'Короткие рывки с паузами',
      rationale: 'Работает по летнему мелководью',
      source: 'lurepassion',
      base_rank: 6,
    },
  ],
};

const sampleWeather: WeatherSnapshot = {
  lat: 55.975,
  lng: 36.825,
  captured_at: '2026-11-13T09:00:00Z',
  pressure_hpa: 1016,
  pressure_mmhg: 762,
  pressure_trend: 'steady',
  air_temp_c: 5,
  water_temp_c: 7.5,
  wind_speed_ms: 3.5,
  wind_direction_deg: 240,
  wind_direction_label: 'ЮЗ',
  precipitation_mm: 0,
  moon_phase: 'Растущая луна',
  moon_illumination: 64,
  source: 'open-meteo',
};

const sampleWaterBody: WaterBody = {
  id: 'wb-1',
  name: 'Пруд у ручья',
  display_label: 'Пруд у ручья',
  type: 'pond',
  center: { lat: 55.98, lng: 36.83 },
  polygon: [[36.829, 55.979], [36.831, 55.979], [36.831, 55.981], [36.829, 55.981], [36.829, 55.979]],
  area_ha: 0.8,
  source: 'satellite',
  confidence: 0.72,
  moderation_status: 'verified',
  connected_to: 'wb-river',
  connected_name: 'р. Истра',
  has_bathymetry: true,
  max_depth_m: 3.2,
  avg_depth_m: 2.2,
  region: 'Московская область',
  ndwi_stability: 'year_round',
  vegetation_index: 'moderate',
  water_clarity: 'moderate',
  target_zone: { lat: 55.9805, lng: 36.8305 },
};

test('computeFIndexForecast generates 24 3-hour slots for 3 days with probabilistic phrasing', () => {
  const slots = computeFIndexForecast({
    species: sampleSpecies,
    weather: sampleWeather,
    baseDate: new Date('2026-11-13T09:00:00Z'),
  });
  assert.equal(slots.length, 24);
  assert.equal(slots[0].day_label, 'Сегодня');
  assert.equal(slots[8].day_label, 'Завтра');
  assert.equal(slots[16].day_label, 'Послезавтра');
  for (const s of slots) {
    assert.ok(s.f_index >= 0 && s.f_index <= 100);
    assert.ok(s.probability_label.includes('вероятность'));
  }
});

test('analyzeWaterBody classifies connected year-round pond as high and tiny isolated dry pond as low', () => {
  const highRes = analyzeWaterBody({ waterBody: sampleWaterBody, crowdReportCount: 2 });
  assert.equal(highRes.fish_probability, 'high');
  assert.ok(highRes.reasons.some((r) => r.detail.includes('(+)')));
  assert.ok(highRes.disclaimer.includes('не гарантирует'));

  const tinyDryPond: WaterBody = {
    ...sampleWaterBody,
    id: 'wb-tiny',
    connected_to: null,
    area_ha: 0.06,
    ndwi_stability: 'dries_summer',
    max_depth_m: 0.4,
    vegetation_index: 'algal_bloom',
  };
  const lowRes = analyzeWaterBody({ waterBody: tinyDryPond, crowdReportCount: 0 });
  assert.equal(lowRes.fish_probability, 'low');
  assert.ok(lowRes.reasons.some((r) => r.detail.includes('(−)')));
});

test('detectProspectiveZones finds holes and drop-offs from bathymetry points', () => {
  const pts: BathymetryPoint[] = [
    { id: 'p1', water_body_id: 'wb-1', lat: 55.9800, lng: 36.8300, depth_m: 1.5, source: 'seascape', created_at: '', confidence: 0.9 },
    { id: 'p2', water_body_id: 'wb-1', lat: 55.9804, lng: 36.8304, depth_m: 6.2, source: 'seascape', created_at: '', confidence: 0.9 },
    { id: 'p3', water_body_id: 'wb-1', lat: 55.9810, lng: 36.8310, depth_m: 2.1, source: 'manual', created_at: '', confidence: 0.6 },
  ];
  const zones = detectProspectiveZones(pts);
  assert.ok(zones.some((z) => z.kind === 'hole' && z.depth_m === 6.2));
  assert.ok(zones.some((z) => z.kind === 'dropoff'));
});

test('recommendLures ranks seasonal deep jig above summer topwater in November', () => {
  const recs = recommendLures({
    species: sampleSpecies,
    waterBody: { ...sampleWaterBody, type: 'reservoir', avg_depth_m: 4.5 },
    month: 11,
  });
  assert.equal(recs[0].lure.id, 'jig-vibro');
  assert.ok(recs[0].score > recs[1].score);
});

test('selectBestAccessPoint respects avoidUnpaved and picks shortest walking distance', () => {
  const accessPoints: WaterBodyAccessPoint[] = [
    {
      id: 'ap-dirt',
      water_body_id: 'wb-1',
      lat: 55.9804,
      lng: 36.8302,
      type: 'road_end',
      source: 'osm',
      confidence: 0.8,
      unpaved: true,
      driving_reachable: true,
      notes: 'Грунтовка',
    },
    {
      id: 'ap-paved',
      water_body_id: 'wb-1',
      lat: 55.978,
      lng: 36.827,
      type: 'parking',
      source: 'osm',
      confidence: 0.95,
      unpaved: false,
      driving_reachable: true,
      notes: 'Асфальтовая парковка',
    },
  ];

  const pavedOnly = selectBestAccessPoint({
    accessPoints,
    targetPoint: { lat: 55.9805, lng: 36.8305 },
    avoidUnpaved: true,
  });
  assert.equal(pavedOnly.selected?.id, 'ap-paved');
  assert.equal(pavedOnly.drivingAvailable, true);

  const routeUnavailable = buildSplitRouteMetrics({
    origin: { lat: 55.9, lng: 36.7 },
    waterBody: sampleWaterBody,
    accessPoints: [{ ...accessPoints[0], driving_reachable: false }],
    avoidUnpaved: true,
  });
  assert.equal(routeUnavailable.driving_available, false);
  assert.ok(routeUnavailable.unavailable_reason?.includes('Автомобильный маршрут недоступен'));
});

test('validation rejects missing geolocation, out-of-range coordinates, and oversized photos', () => {
  assert.ok(validateCatchReportInput({ lat: null, lng: 36.8, fish_species_id: 'pike' }) !== null);
  assert.ok(validateCatchReportInput({ lat: 95, lng: 36.8, fish_species_id: 'pike' }) !== null);
  assert.ok(
    validateCatchReportInput({
      lat: 55.9,
      lng: 36.8,
      fish_species_id: 'pike',
      photo_size_bytes: 6 * 1024 * 1024,
    }) !== null
  );
  assert.equal(
    validateCatchReportInput({
      lat: 55.9,
      lng: 36.8,
      fish_species_id: 'pike',
      photo_size_bytes: 1024 * 500,
      photo_mime: 'image/jpeg',
    }),
    null
  );
  assert.ok(validateDepthPointInput({ lat: 55.9, lng: 36.8, depth_m: 0 }) !== null);
  assert.equal(validateDepthPointInput({ lat: 55.9, lng: 36.8, depth_m: 4.5 }), null);
});

test('evaluateGoodBiteWaterBodies filters by 100 km radius, ecological suitability, species, and recent reports', () => {
  const origin = { lat: 55.975, lng: 36.825 };
  const reservoirGood: WaterBody = {
    ...sampleWaterBody,
    id: 'wb-good-res',
    display_label: 'Озернинское вдхр.',
    type: 'reservoir',
    center: { lat: 55.775, lng: 36.265 }, // ~41 km
    area_ha: 2300,
    max_depth_m: 18,
    avg_depth_m: 6.5,
  };
  const farAwayRes: WaterBody = {
    ...reservoirGood,
    id: 'wb-far',
    display_label: 'Дальнее вдхр.',
    center: { lat: 57.5, lng: 36.825 }, // ~170 km (> 100 km)
  };
  const shallowDryPond: WaterBody = {
    ...sampleWaterBody,
    id: 'wb-dry',
    display_label: 'Пересыхающий пруд',
    type: 'pond',
    center: { lat: 55.97, lng: 36.82 }, // ~0.6 km
    connected_to: null,
    area_ha: 0.08,
    max_depth_m: 0.4,
    avg_depth_m: 0.3,
    ndwi_stability: 'dries_summer',
    vegetation_index: 'algal_bloom',
  };
  const warmCarp: FishSpecies = {
    ...sampleSpecies,
    id: 'karp',
    name: 'Карп',
    category: 'peaceful',
    water_types: ['pond', 'lake', 'reservoir'],
    optimal_water_temp_c: [18, 25],
    season_activity: { ...sampleSpecies.season_activity, 11: 12 },
  };
  const recentReport: CatchReport = {
    id: 'rep-test',
    client_event_id: 'c-1',
    user_id: 'u-1',
    author_nickname: 'Тест',
    author_verified: true,
    water_body_id: 'wb-good-res',
    water_body_name: 'Озернинское вдхр.',
    lat: 55.775,
    lng: 36.265,
    created_at: '2026-11-13T07:00:00Z',
    updated_at: '2026-11-13T07:00:00Z',
    fish_species_id: 'pike',
    fish_species_name: 'Щука',
    weight_kg: 2.1,
    length_cm: 60,
    bait: 'Джиг',
    retrieve: 'Ступенька',
    weather_summary: '762 мм',
    photo_url: null,
    notes: '',
    visibility: 'public',
    source: 'quick_mark',
  };

  const goodPike = evaluateGoodBiteWaterBodies({
    origin,
    waterBodies: [reservoirGood, farAwayRes, shallowDryPond],
    speciesList: [sampleSpecies, warmCarp],
    weather: sampleWeather,
    reports: [recentReport],
    baseDate: new Date('2026-11-13T09:00:00Z'),
    radiusKm: 100,
    fishId: 'all',
  });

  assert.equal(goodPike.length, 1);
  assert.equal(goodPike[0].water_body.id, 'wb-good-res');
  assert.ok(goodPike[0].distance_km <= 100);
  assert.ok(goodPike[0].f_index >= 66);
  assert.equal(goodPike[0].recent_reports_count, 1);

  const carpOnly = evaluateGoodBiteWaterBodies({
    origin,
    waterBodies: [reservoirGood, farAwayRes, shallowDryPond],
    speciesList: [sampleSpecies, warmCarp],
    weather: sampleWeather,
    reports: [recentReport],
    baseDate: new Date('2026-11-13T09:00:00Z'),
    radiusKm: 100,
    fishId: 'karp',
  });
  assert.equal(carpOnly.length, 0);
});

test('evaluateFIndexAlerts triggers for favorite/nearby above threshold and respects scope and cooldown', () => {
  const now = new Date('2026-11-15T10:00:00Z');
  const items: GoodBiteWaterBodyItem[] = [
    {
      water_body: { ...sampleWaterBody, id: 'wb-fav', display_label: 'Озеро Сенеж' },
      distance_km: 48,
      f_index: 84,
      probability_label: 'высокая вероятность',
      best_species_id: 'pike',
      best_species_name: 'Щука',
      peak_hour: '06:00',
      day_label: 'Сегодня',
      recent_reports_count: 1,
      reasons: [],
    },
    {
      water_body: { ...sampleWaterBody, id: 'wb-near', display_label: 'Река Истра' },
      distance_km: 4.5,
      f_index: 79,
      probability_label: 'высокая вероятность',
      best_species_id: 'nalim',
      best_species_name: 'Налим',
      peak_hour: '00:00',
      day_label: 'Сегодня',
      recent_reports_count: 0,
      reasons: [],
    },
    {
      water_body: { ...sampleWaterBody, id: 'wb-below', display_label: 'Дальний пруд' },
      distance_km: 60,
      f_index: 71,
      probability_label: 'высокая вероятность',
      best_species_id: 'okun',
      best_species_name: 'Окунь',
      peak_hour: '09:00',
      day_label: 'Сегодня',
      recent_reports_count: 0,
      reasons: [],
    },
  ];

  const triggered = evaluateFIndexAlerts({
    items,
    favoriteIds: ['wb-fav'],
    settings: {
      enabled: true,
      threshold: 75,
      scope: 'favorites_and_nearby',
      nearby_radius_km: 25,
      last_notified: {
        'wb-near': { f_index: 78, notified_at: '2026-11-15T09:00:00Z' },
      },
    },
    now,
  });

  // wb-fav passes threshold & favorite; wb-near is within 6h cooldown (+1 delta < 5); wb-below < 75
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0].water_body_id, 'wb-fav');
  assert.equal(triggered[0].is_favorite, true);

  const favOnly = evaluateFIndexAlerts({
    items,
    favoriteIds: ['wb-fav'],
    settings: {
      enabled: true,
      threshold: 75,
      scope: 'favorites_only',
      nearby_radius_km: 25,
      last_notified: {},
    },
    now,
  });
  assert.equal(favOnly.length, 1);
  assert.equal(favOnly[0].water_body_id, 'wb-fav');
});

test('offlineMapRegions computes valid slippy tile coordinates and bbox membership', () => {
  const bbox = { north: 56.08, south: 55.89, east: 36.93, west: 36.68 };
  const count = estimateRegionTileCount(bbox, 10, 12);
  const tiles = computeTileCoordsForBbox(bbox, 10, 12);
  assert.equal(tiles.length, count);
  assert.ok(tiles.length > 0 && tiles.length <= 220);
  assert.ok(tiles[0].url.startsWith('https://tile.openstreetmap.org/'));
  assert.equal(isPointInBbox({ lat: 56.012, lng: 36.822 }, bbox), true);
  assert.equal(isPointInBbox({ lat: 54.0, lng: 36.822 }, bbox), false);

  const swapped = normalizeBboxSelection({ lat: 56.05, lng: 36.9 }, { lat: 55.95, lng: 36.7 });
  assert.equal(swapped.north, 56.05);
  assert.equal(swapped.south, 55.95);
  assert.equal(swapped.east, 36.9);
  assert.equal(swapped.west, 36.7);

  const pointBox = normalizeBboxSelection({ lat: 56.0, lng: 36.8 }, { lat: 56.0, lng: 36.8 });
  assert.ok(pointBox.north - pointBox.south >= 0.014);
  assert.ok(pointBox.east - pointBox.west >= 0.014);
});

test('decodePolyline6 decodes precision-6 polylines into [lng, lat] coordinates cleanly', () => {
  // Precision-6 encoded coordinates near Moscow/Istra: (55.755800, 37.617300) -> (55.756800, 37.618300)
  const encodeCoord = (val: number) => Math.round(val * 1e6);
  const encodeSigned = (n: number) => {
    let v = n < 0 ? ~(n << 1) : n << 1;
    let out = '';
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
    return out;
  };
  const encoded =
    encodeSigned(encodeCoord(55.7558)) +
    encodeSigned(encodeCoord(37.6173)) +
    encodeSigned(encodeCoord(55.7568) - encodeCoord(55.7558)) +
    encodeSigned(encodeCoord(37.6183) - encodeCoord(37.6173));

  const pts = decodePolyline6(encoded);
  assert.equal(pts.length, 2);
  assert.ok(Math.abs(pts[0][0] - 37.6173) < 0.00001);
  assert.ok(Math.abs(pts[0][1] - 55.7558) < 0.00001);
  assert.ok(Math.abs(pts[1][0] - 37.6183) < 0.00001);
  assert.ok(Math.abs(pts[1][1] - 55.7568) < 0.00001);
  assert.deepEqual(decodePolyline6(''), []);
});

test('seed database includes Lama river near Volokolamsk with shore access point', async () => {
  const { SEED_ACCESS_POINTS, SEED_WATER_BODIES } = await import('../data/seedData');
  const lama = SEED_WATER_BODIES.find((w) => w.id === 'wb-lama-volokolamsk');
  assert.ok(lama, 'Expected wb-lama-volokolamsk in SEED_WATER_BODIES');
  assert.ok(lama.display_label.toLowerCase().includes('лама'));
  assert.ok(lama.region.toLowerCase().includes('волоколам'));
  assert.ok(lama.polygon.length >= 4);
  const access = SEED_ACCESS_POINTS.find((ap) => ap.water_body_id === 'wb-lama-volokolamsk');
  assert.ok(access, 'Expected shore access point for wb-lama-volokolamsk');
});

test('buildBathymetryProfile orders points along chosen transect line and computes underwater elevations', async () => {
  const { buildBathymetryProfile } = await import('./fishLogic');
  const pts: BathymetryPoint[] = [
    { id: 'p-east', water_body_id: 'wb-1', lat: 56.014, lng: 36.826, depth_m: 3.0, source: 'sonar', created_at: '', confidence: 0.9 },
    { id: 'p-west', water_body_id: 'wb-1', lat: 56.011, lng: 36.818, depth_m: 2.1, source: 'seascape', created_at: '', confidence: 0.9 },
    { id: 'p-mid', water_body_id: 'wb-1', lat: 56.0125, lng: 36.822, depth_m: 11.4, source: 'manual', created_at: '', confidence: 0.8 },
  ];

  const transect = buildBathymetryProfile(pts, 'transect');
  assert.equal(transect.length, 3);
  assert.equal(transect[0].id, 'p-west');
  assert.equal(transect[0].distance_m, 0);
  assert.equal(transect[1].id, 'p-mid');
  assert.equal(transect[1].bottom_elevation_m, -11.4);
  assert.equal(transect[2].id, 'p-east');
  assert.ok(transect[2].distance_m > 400);

  const southNorth = buildBathymetryProfile(pts, 'south_north');
  assert.equal(southNorth[0].id, 'p-west');
  assert.equal(southNorth[2].id, 'p-east');
  assert.deepEqual(buildBathymetryProfile([], 'transect'), []);
});

