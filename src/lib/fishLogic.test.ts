import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeBarometricWindow,
  analyzeWaterBody,
  buildBiteForecastMetadata,
  buildSplitRouteMetrics,
  computeFIndexForecast,
  computeReportCalibration,
  computeSunTimes,
  computeWaterBodyHabitatModifier,
  decodePolyline6,
  detectProspectiveZones,
  estimateWaterTempC,
  evaluateFIndexAlerts,
  evaluateGoodBiteWaterBodies,
  pointInWaterBody,
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
import type {
  BathymetryPoint,
  CatchReport,
  FishSpecies,
  GoodBiteWaterBodyItem,
  HourlyWeatherPoint,
  WaterBody,
  WaterBodyAccessPoint,
  WeatherSnapshot,
} from './types';

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

test('pointInWaterBody excludes interior island holes from open water', () => {
  const wbWithIsland: Pick<WaterBody, 'polygon' | 'polygon_rings'> = {
    polygon: [
      [36.0, 56.0],
      [36.2, 56.0],
      [36.2, 56.2],
      [36.0, 56.2],
      [36.0, 56.0],
    ],
    polygon_rings: [
      [
        [36.0, 56.0],
        [36.2, 56.0],
        [36.2, 56.2],
        [36.0, 56.2],
        [36.0, 56.0],
      ],
      [
        [36.06, 56.06],
        [36.14, 56.06],
        [36.14, 56.14],
        [36.06, 56.14],
        [36.06, 56.06],
      ],
    ],
  };

  assert.equal(pointInWaterBody({ lat: 56.02, lng: 36.02 }, wbWithIsland), true);
  assert.equal(pointInWaterBody({ lat: 56.1, lng: 36.1 }, wbWithIsland), false);
  assert.equal(pointInWaterBody({ lat: 56.5, lng: 36.5 }, wbWithIsland), false);
});

test('all seed water bodies, contours, bathymetry points, reports, and access points obey real water/shore invariants', async () => {
  const {
    SEED_ACCESS_POINTS,
    SEED_BATHYMETRY_POINTS,
    SEED_DATA_VERSION,
    SEED_REPORTS,
    SEED_WATER_BODIES,
  } = await import('../data/seedData');

  assert.ok(SEED_DATA_VERSION >= 2);

  const retiredIds = [
    'wb-unnamed-pesochnaya',
    'wb-unnamed-rodnik',
    'wb-buzharovo-pond',
    'wb-crowd-unverified',
  ];
  for (const id of retiredIds) {
    assert.equal(SEED_WATER_BODIES.some((w) => w.id === id), false, `Retired ${id} must not exist`);
    assert.equal(
      SEED_ACCESS_POINTS.some((ap) => ap.water_body_id === id),
      false,
      `Access point for retired ${id} must not exist`
    );
    assert.equal(
      SEED_BATHYMETRY_POINTS.some((bp) => bp.water_body_id === id),
      false,
      `Bathymetry for retired ${id} must not exist`
    );
    assert.equal(
      SEED_REPORTS.some((r) => r.water_body_id === id),
      false,
      `Report for retired ${id} must not exist`
    );
  }

  const wbMap = new Map(SEED_WATER_BODIES.map((w) => [w.id, w]));

  for (const wb of SEED_WATER_BODIES) {
    assert.ok(wb.polygon.length >= 4, `${wb.id} must have closed polygon`);
    const first = wb.polygon[0];
    const last = wb.polygon[wb.polygon.length - 1];
    assert.equal(first[0], last[0], `${wb.id} polygon lng must be closed`);
    assert.equal(first[1], last[1], `${wb.id} polygon lat must be closed`);

    assert.equal(pointInWaterBody(wb.center, wb), true, `${wb.id} center must be inside water`);
    if (wb.target_zone) {
      assert.equal(
        pointInWaterBody(wb.target_zone, wb),
        true,
        `${wb.id} target_zone must be inside water`
      );
    }

    if (wb.contours) {
      for (const c of wb.contours) {
        assert.ok(c.coordinates.length >= 4, `${wb.id} contour ${c.depth_m}m must be closed`);
        for (const [lng, lat] of c.coordinates) {
          assert.equal(
            pointInWaterBody({ lat, lng }, wb),
            true,
            `${wb.id} contour ${c.depth_m}m vertex must be inside water`
          );
        }
      }
    }
  }

  for (const bp of SEED_BATHYMETRY_POINTS) {
    const wb = wbMap.get(bp.water_body_id);
    assert.ok(wb, `Bathymetry ${bp.id} missing water body ${bp.water_body_id}`);
    assert.equal(
      pointInWaterBody({ lat: bp.lat, lng: bp.lng }, wb),
      true,
      `Bathymetry ${bp.id} must be inside water of ${wb.id}`
    );
  }

  for (const rep of SEED_REPORTS) {
    assert.ok(rep.water_body_id, `Report ${rep.id} must reference a water body`);
    const wb = wbMap.get(rep.water_body_id);
    assert.ok(wb, `Report ${rep.id} missing water body ${rep.water_body_id}`);
    assert.equal(
      pointInWaterBody({ lat: rep.lat, lng: rep.lng }, wb),
      true,
      `Report ${rep.id} must be inside water of ${wb.id}`
    );
  }

  for (const ap of SEED_ACCESS_POINTS) {
    const wb = wbMap.get(ap.water_body_id);
    assert.ok(wb, `Access point ${ap.id} missing water body ${ap.water_body_id}`);
    assert.equal(
      pointInWaterBody({ lat: ap.lat, lng: ap.lng }, wb),
      false,
      `Shore access point ${ap.id} should stay on shore outside water of ${wb.id}`
    );
  }
});

test('computeSunTimes returns seasonal sunrise and sunset for Moscow/Istra latitude', () => {
  const nov = computeSunTimes(56.02, 36.83, new Date('2026-11-15T12:00:00Z'));
  const jun = computeSunTimes(56.02, 36.83, new Date('2026-06-21T12:00:00Z'));

  assert.ok(nov.sunriseHour >= 7.0 && nov.sunriseHour <= 9.0, `Expected Nov sunrise ~8h, got ${nov.sunriseHour}`);
  assert.ok(nov.sunsetHour >= 15.0 && nov.sunsetHour <= 17.5, `Expected Nov sunset ~16:20, got ${nov.sunsetHour}`);
  assert.ok(jun.sunriseHour >= 2.5 && jun.sunriseHour <= 5.0, `Expected Jun sunrise ~3:45, got ${jun.sunriseHour}`);
  assert.ok(jun.sunsetHour >= 20.0 && jun.sunsetHour <= 22.5, `Expected Jun sunset ~21:15, got ${jun.sunsetHour}`);
  assert.ok(jun.sunsetHour - jun.sunriseHour > nov.sunsetHour - nov.sunriseHour + 6);
  assert.match(nov.sunriseStr, /^\d{2}:\d{2}$/);
  assert.match(jun.sunsetStr, /^\d{2}:\d{2}$/);
});

test('estimateWaterTempC models deep thermal inertia and triggers under-ice regime on prolonged freeze', () => {
  const coldSnapWeather: WeatherSnapshot = {
    ...sampleWeather,
    air_temp_c: -2,
    avg_air_temp_7d_c: 6,
    avg_air_temp_14d_c: 11,
  };
  const deepRes: WaterBody = {
    ...sampleWaterBody,
    id: 'wb-deep',
    type: 'reservoir',
    avg_depth_m: 6.5,
    max_depth_m: 18,
    connected_to: null,
  };
  const shallowPond: WaterBody = {
    ...sampleWaterBody,
    id: 'wb-shallow',
    type: 'pond',
    avg_depth_m: 1.4,
    max_depth_m: 2.0,
    connected_to: null,
  };

  const deepEst = estimateWaterTempC(coldSnapWeather, deepRes);
  const shallowEst = estimateWaterTempC(coldSnapWeather, shallowPond);
  assert.equal(deepEst.isIceRegime, false);
  assert.equal(shallowEst.isIceRegime, false);
  assert.ok(
    deepEst.waterTempC > shallowEst.waterTempC + 1.5,
    `Deep reservoir (${deepEst.waterTempC}C) should hold heat better than shallow pond (${shallowEst.waterTempC}C)`
  );

  const deepFreezeWeather: WeatherSnapshot = {
    ...sampleWeather,
    air_temp_c: -11,
    avg_air_temp_7d_c: -7.5,
    avg_air_temp_14d_c: -6.0,
  };
  const iceDeep = estimateWaterTempC(deepFreezeWeather, deepRes);
  const iceShallow = estimateWaterTempC(deepFreezeWeather, shallowPond);
  assert.equal(iceDeep.isIceRegime, true);
  assert.equal(iceShallow.isIceRegime, true);
  assert.ok(iceDeep.waterTempC >= 1.2 && iceDeep.waterTempC <= 2.6);
  assert.ok(iceShallow.waterTempC >= 1.2 && iceShallow.waterTempC <= 2.6);
});

test('analyzeBarometricWindow and computeFIndexForecast penalize sharp 6h pressure crash vs 48h stability', () => {
  const buildHourly = (mode: 'stable' | 'crash' | 'prefontal'): HourlyWeatherPoint[] => {
    const startMs = Date.parse('2026-11-11T00:00:00Z');
    const out: HourlyWeatherPoint[] = [];
    for (let h = 0; h < 120; h++) {
      const tMs = startMs + h * 3600000;
      let pressure = 1016;
      if (mode === 'crash' && h >= 54 && h <= 72) {
        // Drop 1.2 hPa per hour -> delta6h ~ -7.2 hPa around Nov 13 09:00..15:00
        pressure = 1016 - (h - 54) * 1.2;
      } else if (mode === 'prefontal' && h >= 54 && h <= 72) {
        // Gentle pre-frontal drop ~ -0.3 hPa/h -> delta6h = -1.8 hPa
        pressure = 1016 - (h - 54) * 0.3;
      }
      out.push({
        time: new Date(tMs).toISOString().slice(0, 16) + ':00Z',
        temp_c: 5,
        pressure_hpa: Number(pressure.toFixed(1)),
        wind_speed_ms: 3.5,
        wind_direction_deg: 240,
        cloud_cover_pct: 75,
        precipitation_mm: 0,
      });
    }
    return out;
  };

  const baseDate = new Date('2026-11-13T09:00:00Z');
  const targetMs = Date.parse('2026-11-13T12:00:00Z');

  const stableHourly = buildHourly('stable');
  const crashHourly = buildHourly('crash');
  const prefrontalHourly = buildHourly('prefontal');

  const stableBaro = analyzeBarometricWindow(stableHourly, targetMs, sampleWeather);
  const crashBaro = analyzeBarometricWindow(crashHourly, targetMs, sampleWeather);
  const prefrontalBaro = analyzeBarometricWindow(prefrontalHourly, targetMs, sampleWeather);

  assert.ok(stableBaro.stability48h >= 0.9);
  assert.ok(crashBaro.delta6h <= -5.0, `Expected crash delta6h <= -5, got ${crashBaro.delta6h}`);
  assert.ok(prefrontalBaro.delta6h <= -1.2 && prefrontalBaro.delta6h >= -2.5);

  const stableSlots = computeFIndexForecast({
    species: sampleSpecies,
    weather: { ...sampleWeather, hourly: stableHourly, avg_air_temp_7d_c: 6, avg_air_temp_14d_c: 7 },
    baseDate,
  });
  const crashSlots = computeFIndexForecast({
    species: sampleSpecies,
    weather: { ...sampleWeather, hourly: crashHourly, avg_air_temp_7d_c: 6, avg_air_temp_14d_c: 7 },
    baseDate,
  });
  const prefrontalSlots = computeFIndexForecast({
    species: sampleSpecies,
    weather: { ...sampleWeather, hourly: prefrontalHourly, avg_air_temp_7d_c: 6, avg_air_temp_14d_c: 7 },
    baseDate,
  });

  const stableMidday = stableSlots.find((s) => s.day_label === 'Сегодня' && s.hour_interval === '15:00')!;
  const crashMidday = crashSlots.find((s) => s.day_label === 'Сегодня' && s.hour_interval === '15:00')!;
  const prefrontalMidday = prefrontalSlots.find((s) => s.day_label === 'Сегодня' && s.hour_interval === '15:00')!;

  assert.ok(
    stableMidday.f_index > crashMidday.f_index + 15,
    `Stable (${stableMidday.f_index}) should strongly beat pressure crash (${crashMidday.f_index})`
  );
  assert.ok(
    prefrontalMidday.f_index > crashMidday.f_index + 15,
    `Pre-frontal gentle drop (${prefrontalMidday.f_index}) should favor predator over crash (${crashMidday.f_index})`
  );
  assert.ok(crashMidday.factors.some((f) => f.includes('Резкий скачок давления')));
});

test('computeWaterBodyHabitatModifier penalizes river flood turbidity after heavy 72h rain', () => {
  const riverWb: WaterBody = {
    ...sampleWaterBody,
    id: 'wb-river-test',
    type: 'river',
    connected_to: 'wb-main',
  };
  const dryMod = computeWaterBodyHabitatModifier({
    waterBody: riverWb,
    species: sampleSpecies,
    weather: { ...sampleWeather, recent_rain_72h_mm: 2 },
  });
  const floodMod = computeWaterBodyHabitatModifier({
    waterBody: riverWb,
    species: sampleSpecies,
    weather: { ...sampleWeather, recent_rain_72h_mm: 40 },
  });

  assert.ok(floodMod.modifier <= dryMod.modifier - 7);
  assert.ok(floodMod.reasons.some((r) => r.includes('паводковая мутность')));
});

test('computeReportCalibration applies Bayesian shrinkage, weights weather similarity, and handles no_bite reports', () => {
  const baseDate = new Date('2026-11-13T12:00:00Z');
  const makeReport = (
    id: string,
    outcome: 'catch' | 'no_bite',
    pressureHpa: number,
    waterTempC: number
  ): CatchReport => ({
    id,
    client_event_id: id,
    user_id: 'u-1',
    author_nickname: 'Тест',
    author_verified: true,
    water_body_id: sampleWaterBody.id,
    water_body_name: sampleWaterBody.display_label,
    lat: sampleWaterBody.center.lat,
    lng: sampleWaterBody.center.lng,
    created_at: '2026-11-13T08:00:00Z',
    updated_at: '2026-11-13T08:00:00Z',
    fish_species_id: sampleSpecies.id,
    fish_species_name: sampleSpecies.name,
    weight_kg: outcome === 'catch' ? 1.8 : null,
    length_cm: outcome === 'catch' ? 54 : null,
    bait: 'Джиг',
    retrieve: 'Ступенька',
    weather_summary: '762 мм',
    photo_url: null,
    notes: '',
    visibility: 'public',
    source: 'diary',
    outcome,
    weather_snapshot: {
      pressure_hpa: pressureHpa,
      pressure_trend: 'steady',
      air_temp_c: 5,
      water_temp_c: waterTempC,
      wind_speed_ms: 3.5,
      wind_direction_label: 'ЮЗ',
      cloud_cover_pct: 60,
      precipitation_mm: 0,
    },
  });

  // Single catch report should be shrunk modestly (not an extreme +12 swing)
  const singleCatch = computeReportCalibration({
    waterBody: sampleWaterBody,
    species: sampleSpecies,
    weather: sampleWeather,
    reports: [makeReport('r1', 'catch', 1016, 7.5)],
    baseDate,
  });
  assert.ok(singleCatch.delta > 0 && singleCatch.delta <= 6, `Single report delta should be shrunk, got ${singleCatch.delta}`);
  assert.equal(singleCatch.catchCount, 1);

  // Weather-similar reports should yield stronger delta than weather-mismatched reports
  const similarMulti = computeReportCalibration({
    waterBody: sampleWaterBody,
    species: sampleSpecies,
    weather: sampleWeather,
    reports: [
      makeReport('s1', 'catch', 1016, 7.5),
      makeReport('s2', 'catch', 1017, 7.6),
      makeReport('s3', 'catch', 1015, 7.4),
    ],
    baseDate,
  });
  const mismatchedMulti = computeReportCalibration({
    waterBody: sampleWaterBody,
    species: sampleSpecies,
    weather: sampleWeather,
    reports: [
      makeReport('m1', 'catch', 990, 22),
      makeReport('m2', 'catch', 988, 23),
      makeReport('m3', 'catch', 992, 21),
    ],
    baseDate,
  });
  assert.ok(
    similarMulti.delta > mismatchedMulti.delta,
    `Weather-similar (${similarMulti.delta}) should outweigh weather-mismatched (${mismatchedMulti.delta})`
  );

  // Multiple no_bite reports should yield negative calibration delta
  const noBiteCal = computeReportCalibration({
    waterBody: sampleWaterBody,
    species: sampleSpecies,
    weather: sampleWeather,
    reports: [
      makeReport('nb1', 'no_bite', 1016, 7.5),
      makeReport('nb2', 'no_bite', 1016, 7.4),
      makeReport('nb3', 'no_bite', 1015, 7.6),
    ],
    baseDate,
  });
  assert.ok(noBiteCal.delta <= -4, `Expected negative delta for no_bite cluster, got ${noBiteCal.delta}`);
  assert.equal(noBiteCal.noBiteCount, 3);
  assert.ok(noBiteCal.summaryReason?.includes('без клёва'));
});

test('buildBiteForecastMetadata distinguishes high-confidence live hourly+reports from low-confidence offline fallback', () => {
  const baseDate = new Date('2026-11-13T09:00:00Z');
  const hourly24: HourlyWeatherPoint[] = Array.from({ length: 48 }, (_, i) => ({
    time: new Date(Date.parse('2026-11-12T00:00:00Z') + i * 3600000).toISOString().slice(0, 16) + ':00Z',
    temp_c: 5,
    pressure_hpa: 1016,
    wind_speed_ms: 3.5,
    wind_direction_deg: 240,
    cloud_cover_pct: 60,
    precipitation_mm: 0,
  }));

  const highMeta = buildBiteForecastMetadata({
    weather: { ...sampleWeather, source: 'open-meteo', hourly: hourly24, avg_air_temp_7d_c: 6, avg_air_temp_14d_c: 7 },
    species: sampleSpecies,
    waterBody: sampleWaterBody,
    baseDate,
  });
  assert.equal(highMeta.confidence_level, 'high');
  assert.ok((highMeta.confidence_score ?? 0) >= 75);
  assert.equal(highMeta.regime, 'open_water');

  const lowMeta = buildBiteForecastMetadata({
    weather: { ...sampleWeather, source: 'offline-fallback', hourly: undefined },
    species: sampleSpecies,
    waterBody: null,
    baseDate,
  });
  assert.equal(lowMeta.confidence_level, 'low');
  assert.ok((lowMeta.confidence_score ?? 100) < 52);
});

test('recommendLures boosts ice-fishing lures (балансир/мормышка) over воблер in ice regime', () => {
  const winterSpecies: FishSpecies = {
    ...sampleSpecies,
    lures: [
      {
        id: 'wobbler-minnow',
        lure_type: 'Воблер-минноу 90 мм',
        category: 'воблер',
        depth_min_m: 1.0,
        depth_max_m: 3.5,
        best_seasons: [1, 2, 12],
        best_clarity: ['clear', 'moderate'],
        water_types: ['pond', 'lake', 'reservoir'],
        retrieve: 'Твичинг',
        rationale: 'Открытая вода',
        source: 'editorial',
        base_rank: 9,
      },
      {
        id: 'ice-balancer',
        lure_type: 'Балансир 5 см',
        category: 'балансир',
        depth_min_m: 1.0,
        depth_max_m: 6.0,
        best_seasons: [1, 2, 12],
        best_clarity: ['clear', 'moderate'],
        water_types: ['pond', 'lake', 'reservoir'],
        retrieve: 'Взмах — пауза 4 сек',
        rationale: 'Подлёдная ловля',
        source: 'editorial',
        base_rank: 8,
      },
    ],
  };

  const openWaterRecs = recommendLures({
    species: winterSpecies,
    waterBody: sampleWaterBody,
    month: 1,
    isIceRegime: false,
  });
  const iceRecs = recommendLures({
    species: winterSpecies,
    waterBody: sampleWaterBody,
    month: 1,
    isIceRegime: true,
  });

  assert.equal(openWaterRecs[0].lure.id, 'wobbler-minnow');
  assert.equal(iceRecs[0].lure.id, 'ice-balancer');
  assert.ok(iceRecs[0].reasons.some((r) => r.includes('подлёдной')));
});


