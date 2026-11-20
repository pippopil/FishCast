import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { createServer as createViteServer } from 'vite';
import {
  analyzeWaterBody,
  evaluateGoodBiteWaterBodies,
  formatWaterBodyTitle,
  haversineMeters,
  recommendLures,
  selectBestAccessPoint,
  validateCatchReportInput,
  validateDepthPointInput,
} from './src/lib/fishLogic.ts';
import type {
  BathymetryPoint,
  CatchReport,
  NearbyWaterBody,
  WaterBody,
  WaterBodyType,
} from './src/lib/types.ts';
import { store } from './src/server/store.ts';
import {
  buildWaterBodyFromGeocodeFeature,
  computeMultiRouteViaProxy,
  discoverOsmWaterBodies,
  fetchBiteForecastViaProxy,
  fetchWeatherViaProxy,
  inferWaterBodyTypeFromOsm,
  recognizeFishPhotoViaGemini,
} from './src/server/proxies.ts';

const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'fishcast-dev-session-secret';

function signSession(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ uid: userId, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token: string | undefined): string | null {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as { uid?: string };
    return data.uid ?? null;
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '8mb' }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = (request.url || '').split('?')[0];
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (process.env.DISABLE_HMR === 'true' || process.env.NODE_ENV === 'production') {
      socket.destroy();
    }
  });

  interface WsClientMeta {
    ws: WebSocket;
    bbox?: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
  }
  const wsClients = new Set<WsClientMeta>();

  wss.on('connection', (ws) => {
    const meta: WsClientMeta = { ws };
    wsClients.add(meta);

    ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; bbox?: number[] };
        if (msg.type === 'subscribe' && Array.isArray(msg.bbox) && msg.bbox.length === 4) {
          meta.bbox = msg.bbox as [number, number, number, number];
        }
      } catch {
        // Ignore malformed client message
      }
    });

    ws.on('close', () => {
      wsClients.delete(meta);
    });
  });

  function broadcastEvent(event: { type: string; data: unknown; lat?: number; lng?: number }) {
    const payload = JSON.stringify(event);
    for (const client of wsClients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (client.bbox && typeof event.lat === 'number' && typeof event.lng === 'number') {
        const [minLng, minLat, maxLng, maxLat] = client.bbox;
        if (event.lng < minLng || event.lng > maxLng || event.lat < minLat || event.lat > maxLat) {
          continue;
        }
      }
      client.ws.send(payload);
    }
  }

  function getAuthUser(req: express.Request) {
    const cookies = parseCookies(req.headers.cookie);
    const uid = verifySession(cookies.fishcast_session);
    if (!uid) return null;
    return store.db.users.find((u) => u.id === uid) ?? null;
  }

  // --- Auth endpoints ---
  app.post('/api/v1/auth/register', async (req, res) => {
    const ip = req.ip || 'local';
    if (!store.checkRateLimit(`reg:${ip}`, 15, 60_000)) {
      return res.status(429).json({ error: 'Слишком много попыток регистрации. Подождите минуту.' });
    }
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(6),
      nickname: z.string().min(2).max(32),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Проверьте корректность email, пароля (от 6 символов) и ника.' });
    }
    const exists = store.db.users.some((u) => u.email.toLowerCase() === parsed.data.email.toLowerCase());
    if (exists) {
      return res.status(409).json({ error: 'Пользователь с таким email уже зарегистрирован.' });
    }
    const user = {
      id: `user-${crypto.randomUUID().slice(0, 8)}`,
      email: parsed.data.email.toLowerCase(),
      password_hash: await bcrypt.hash(parsed.data.password, 8),
      nickname: parsed.data.nickname.trim(),
      verified: false,
      privacy_default: 'public' as const,
      created_at: new Date().toISOString(),
    };
    store.db.users.push(user);
    store.persist();

    const token = signSession(user.id);
    res.cookie('fishcast_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400 * 1000 });
    const { password_hash: _, ...safeUser } = user;
    return res.status(201).json({ user: safeUser });
  });

  app.post('/api/v1/auth/login', async (req, res) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Введите корректный email и пароль.' });
    }
    const user = store.db.users.find((u) => u.email.toLowerCase() === parsed.data.email.toLowerCase());
    if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
      return res.status(401).json({ error: 'Неверный email или пароль.' });
    }
    const token = signSession(user.id);
    res.cookie('fishcast_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400 * 1000 });
    const { password_hash: _, ...safeUser } = user;
    return res.json({ user: safeUser });
  });

  app.post('/api/v1/auth/logout', (_req, res) => {
    res.clearCookie('fishcast_session');
    return res.json({ ok: true });
  });

  app.get('/api/v1/auth/me', (req, res) => {
    const user = getAuthUser(req);
    if (!user) return res.json({ user: null });
    const { password_hash: _, ...safeUser } = user;
    return res.json({ user: safeUser });
  });

  app.patch('/api/v1/auth/profile', (req, res) => {
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Требуется авторизация.' });
    const schema = z.object({
      nickname: z.string().min(2).max(32).optional(),
      privacy_default: z.enum(['public', 'friends', 'private']).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные профиля.' });
    if (parsed.data.nickname) user.nickname = parsed.data.nickname.trim();
    if (parsed.data.privacy_default) user.privacy_default = parsed.data.privacy_default;
    store.persist();
    const { password_hash: _, ...safeUser } = user;
    return res.json({ user: safeUser });
  });

  // --- Water bodies & Bathymetry ---
  app.get('/api/v1/water-bodies/nearby', (req, res) => {
    const lat = Number(req.query.lat ?? 55.975);
    const lng = Number(req.query.lng ?? 36.825);
    const radiusKm = Math.min(150, Math.max(1, Number(req.query.radius ?? 35)));
    const includeUnnamed = req.query.include_unnamed !== 'false';

    const origin = { lat, lng };
    const list: NearbyWaterBody[] = store.db.waterBodies
      .filter((wb) => includeUnnamed || (wb.name !== null && wb.name.trim().length > 0))
      .map((wb) => {
        const straightDist = Math.round(haversineMeters(origin, wb.center));
        const aps = store.db.accessPoints.filter((ap) => ap.water_body_id === wb.id);
        const target = wb.target_zone ?? wb.center;
        const { selected, drivingAvailable } = selectBestAccessPoint({
          accessPoints: aps,
          targetPoint: target,
          avoidUnpaved: true,
        });
        const walkStart = selected ?? { lat: target.lat - 0.02, lng: target.lng - 0.02 };
        const walkDist = Math.max(50, Math.round(haversineMeters(walkStart, target) * 1.15));
        const driveDist = drivingAvailable ? Math.max(300, Math.round(haversineMeters(origin, walkStart) * 1.28)) : null;

        return {
          water_body: wb,
          straight_distance_m: straightDist,
          driving_distance_m: driveDist,
          driving_duration_s: driveDist !== null ? Math.round(driveDist / 13.5) : null,
          walking_distance_m: walkDist,
          walking_duration_s: Math.round(walkDist / 1.15),
          driving_available: drivingAvailable,
        };
      })
      .filter((item) => item.straight_distance_m <= radiusKm * 1000)
      .sort((a, b) => a.straight_distance_m - b.straight_distance_m);

    return res.json({ origin, radius_km: radiusKm, items: list });
  });

  app.get('/api/v1/water-bodies', (req, res) => {
    const includeUnnamed = req.query.include_unnamed !== 'false';
    const bboxParam = typeof req.query.bbox === 'string' ? req.query.bbox.split(',').map(Number) : null;
    const lat = req.query.lat ? Number(req.query.lat) : null;
    const lng = req.query.lng ? Number(req.query.lng) : null;
    const radiusKm = req.query.radius ? Number(req.query.radius) : null;

    let items = store.db.waterBodies.filter((wb) => {
      if (!includeUnnamed && (!wb.name || wb.name.trim().length === 0)) return false;
      if (bboxParam && bboxParam.length === 4 && bboxParam.every((n) => !Number.isNaN(n))) {
        const [minLng, minLat, maxLng, maxLat] = bboxParam;
        if (wb.center.lng < minLng || wb.center.lng > maxLng || wb.center.lat < minLat || wb.center.lat > maxLat) {
          return false;
        }
      }
      if (lat !== null && lng !== null && radiusKm !== null && !Number.isNaN(lat) && !Number.isNaN(lng)) {
        if (haversineMeters({ lat, lng }, wb.center) > radiusKm * 1000) return false;
      }
      return true;
    });

    items = items.map((wb) => ({ ...wb, display_label: formatWaterBodyTitle(wb) }));
    return res.json({ items });
  });

  app.post('/api/v1/water-bodies', (req, res) => {
    const schema = z.object({
      name: z.string().max(80).nullable().optional(),
      type: z.enum(['reservoir', 'river', 'lake', 'pond', 'quarry', 'oxbow']),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      area_ha: z.number().min(0.02).max(50000).default(0.5),
      connected_to: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Проверьте координаты и тип водоёма.' });
    }
    const { lat, lng, type, area_ha, name, connected_to } = parsed.data;
    const id = `wb-user-${crypto.randomUUID().slice(0, 8)}`;
    const r = Math.min(0.008, Math.max(0.001, Math.sqrt(area_ha) * 0.0014));
    const poly: [number, number][] = [
      [lng - r, lat - r * 0.7],
      [lng + r, lat - r * 0.7],
      [lng + r, lat + r * 0.7],
      [lng - r, lat + r * 0.7],
      [lng - r, lat - r * 0.7],
    ];
    const wb: WaterBody = {
      id,
      name: name && name.trim().length > 0 ? name.trim() : null,
      display_label: name && name.trim().length > 0 ? name.trim() : 'Безымянный водоём',
      type,
      center: { lat, lng },
      polygon: poly,
      area_ha,
      source: 'user',
      confidence: 0.45,
      moderation_status: 'unverified',
      connected_to: connected_to ?? null,
      has_bathymetry: false,
      max_depth_m: null,
      avg_depth_m: null,
      region: 'Пользовательская отметка',
      ndwi_stability: 'seasonal_low',
      vegetation_index: 'moderate',
      water_clarity: 'moderate',
      target_zone: { lat, lng },
    };
    wb.display_label = formatWaterBodyTitle(wb);
    store.db.waterBodies.push(wb);
    store.nearbyCache.clear();
    store.persist();
    return res.status(201).json({ water_body: wb });
  });

  app.post('/api/v1/water-bodies/discover', async (req, res) => {
    const schema = z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      radius_km: z.number().min(3).max(25).optional(),
      query: z.string().max(80).optional(),
      select_title: z.string().max(120).optional(),
      select_type: z.enum(['reservoir', 'river', 'lake', 'pond', 'quarry', 'oxbow']).optional(),
      select_region: z.string().max(120).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Проверьте координаты для поиска водоёмов в OSM.' });
    }
    const { lat, lng, radius_km, query, select_title, select_type, select_region } = parsed.data;

    const discoveredFromOsm = await discoverOsmWaterBodies({
      lat,
      lng,
      radiusKm: radius_km ?? 12,
      queryText: query ?? select_title,
    });

    const added: WaterBody[] = [];
    const registerWaterBody = (candidate: WaterBody): WaterBody => {
      const existing = store.db.waterBodies.find(
        (w) =>
          w.id === candidate.id ||
          (w.display_label.toLowerCase() === candidate.display_label.toLowerCase() &&
            haversineMeters(w.center, candidate.center) < 4000)
      );
      if (existing) return existing;

      store.db.waterBodies.push(candidate);
      const hasAp = store.db.accessPoints.some((ap) => ap.water_body_id === candidate.id);
      if (!hasAp) {
        store.db.accessPoints.push({
          id: `ap-${candidate.id}`,
          water_body_id: candidate.id,
          lat: Number((candidate.center.lat - 0.002).toFixed(5)),
          lng: Number((candidate.center.lng - 0.002).toFixed(5)),
          type: 'road_end',
          source: 'osm',
          confidence: 0.78,
          unpaved: false,
          driving_reachable: true,
          notes: `Ориентир подъезда по OpenStreetMap (${candidate.display_label})`,
        });
      }
      added.push(candidate);
      return candidate;
    };

    const syncedList = discoveredFromOsm.map(registerWaterBody);
    let selected: WaterBody | null = null;

    if (select_title && select_title.trim().length > 0) {
      const lowerTitle = select_title.trim().toLowerCase();
      selected =
        syncedList.find(
          (w) =>
            w.display_label.toLowerCase().includes(lowerTitle) ||
            lowerTitle.includes(w.display_label.toLowerCase())
        ) ??
        store.db.waterBodies.find(
          (w) =>
            (w.display_label.toLowerCase().includes(lowerTitle) ||
              (w.name && w.name.toLowerCase().includes(lowerTitle))) &&
            haversineMeters(w.center, { lat, lng }) < 12000
        ) ??
        null;

      if (!selected) {
        const type: WaterBodyType =
          select_type ?? inferWaterBodyTypeFromOsm({}, select_title);
        const slug = `${lat.toFixed(3)}-${lng.toFixed(3)}-${lowerTitle.slice(0, 12).replace(/[^a-zа-я0-9]/gi, '')}`;
        selected = registerWaterBody(
          buildWaterBodyFromGeocodeFeature({
            id: `wb-osm-pin-${slug}`,
            title: select_title.trim(),
            subtitle: select_region || 'OpenStreetMap',
            lat,
            lng,
            type,
          })
        );
        syncedList.unshift(selected);
      }
    }

    if (added.length > 0) {
      store.nearbyCache.clear();
      store.persist();
    }

    return res.json({
      discovered: syncedList,
      items: syncedList,
      added_count: added.length,
      selected,
      source: discoveredFromOsm.length > 0 ? 'osm-photon-overpass' : selected ? 'photon-osm' : 'local-cache',
    });
  });

  app.get('/api/v1/water-bodies/:id', (req, res) => {
    const wb = store.db.waterBodies.find((w) => w.id === req.params.id);
    if (!wb) return res.status(404).json({ error: 'Водоём не найден.' });
    const accessPoints = store.db.accessPoints.filter((ap) => ap.water_body_id === wb.id);
    const depthPoints = store.db.bathymetryPoints.filter((bp) => bp.water_body_id === wb.id);
    const crowdReports = store.db.catchReports.filter((r) => r.water_body_id === wb.id);
    const analysis =
      store.db.analyses[wb.id] ??
      analyzeWaterBody({ waterBody: wb, crowdReportCount: crowdReports.length });
    return res.json({
      water_body: wb,
      access_points: accessPoints,
      depth_points: depthPoints,
      analysis,
    });
  });

  app.get('/api/v1/water-bodies/:id/bathymetry/tiles', (req, res) => {
    const wb = store.db.waterBodies.find((w) => w.id === req.params.id);
    if (!wb) return res.status(404).json({ error: 'Водоём не найден.' });
    const points = store.db.bathymetryPoints.filter((bp) => bp.water_body_id === wb.id);
    return res.json({
      water_body_id: wb.id,
      has_bathymetry: wb.has_bathymetry || points.length > 0,
      source_attribution: 'Seascape (openwaters.io) + краудсорсинг глубин',
      disclaimer: 'Не для навигации. Данные приблизительные.',
      contours: wb.contours ?? [],
      points,
    });
  });

  app.post('/api/v1/water-bodies/:id/depth-points', (req, res) => {
    const wb = store.db.waterBodies.find((w) => w.id === req.params.id);
    if (!wb) return res.status(404).json({ error: 'Водоём не найден.' });
    const err = validateDepthPointInput(req.body);
    if (err) return res.status(400).json({ error: err });

    const user = getAuthUser(req);
    const source: BathymetryPoint['source'] = req.body.source === 'sonar' ? 'sonar' : 'manual';
    const pt: BathymetryPoint = {
      id: `bp-${crypto.randomUUID().slice(0, 8)}`,
      water_body_id: wb.id,
      lat: Number(req.body.lat),
      lng: Number(req.body.lng),
      depth_m: Number(Number(req.body.depth_m).toFixed(1)),
      source,
      user_id: user?.id ?? 'guest',
      created_at: new Date().toISOString(),
      confidence: source === 'sonar' ? 0.72 : 0.5,
    };
    store.db.bathymetryPoints.push(pt);
    if (wb.max_depth_m === null || pt.depth_m > wb.max_depth_m) {
      wb.max_depth_m = pt.depth_m;
    }
    store.persist();
    broadcastEvent({ type: 'depth:new', data: pt, lat: pt.lat, lng: pt.lng });
    return res.status(201).json({ point: pt });
  });

  app.get('/api/v1/water-bodies/:id/fish-probability', (req, res) => {
    const wb = store.db.waterBodies.find((w) => w.id === req.params.id);
    if (!wb) return res.status(404).json({ error: 'Водоём не найден.' });
    const crowdCount = store.db.catchReports.filter((r) => r.water_body_id === wb.id).length;
    const analysis =
      store.db.analyses[wb.id] ?? analyzeWaterBody({ waterBody: wb, crowdReportCount: crowdCount });
    return res.json({ analysis });
  });

  app.post('/api/v1/water-bodies/:id/analyze', (req, res) => {
    const wb = store.db.waterBodies.find((w) => w.id === req.params.id);
    if (!wb) return res.status(404).json({ error: 'Водоём не найден.' });

    const jobId = `job-${crypto.randomUUID().slice(0, 8)}`;
    store.reconJobs.set(jobId, { status: 'queued', water_body_id: wb.id });

    // Async job queue simulation (~1.2s)
    setTimeout(() => {
      const crowdCount = store.db.catchReports.filter((r) => r.water_body_id === wb.id).length;
      const result = analyzeWaterBody({ waterBody: wb, crowdReportCount: crowdCount });
      store.db.analyses[wb.id] = result;
      store.persist();
      store.reconJobs.set(jobId, { status: 'completed', water_body_id: wb.id, result });
    }, 1100);

    return res.status(202).json({ job_id: jobId, status: 'queued' });
  });

  app.get('/api/v1/jobs/:jobId', (req, res) => {
    const job = store.reconJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Задача не найдена.' });
    return res.json(job);
  });

  app.get('/api/v1/water-bodies/:id/access', (req, res) => {
    const wb = store.db.waterBodies.find((w) => w.id === req.params.id);
    if (!wb) return res.status(404).json({ error: 'Водоём не найден.' });
    const accessPoints = store.db.accessPoints.filter((ap) => ap.water_body_id === wb.id);
    return res.json({ water_body_id: wb.id, access_points: accessPoints });
  });

  // --- Species, Knots & Recommendations ---
  app.get('/api/v1/species', (_req, res) => {
    return res.json({ species: store.species, knots: store.knots });
  });

  app.get('/api/v1/knots', (_req, res) => {
    return res.json({
      items: store.knots,
      total: store.knots.length,
      updated_at: new Date().toISOString(),
    });
  });

  app.get('/api/v1/recommendations', (req, res) => {
    const fishId = String(req.query.fish_id || 'pike');
    const wbId = req.query.water_body_id ? String(req.query.water_body_id) : null;
    const dateParam = req.query.date ? new Date(String(req.query.date)) : new Date();
    const month = Number.isNaN(dateParam.getTime()) ? new Date().getMonth() + 1 : dateParam.getMonth() + 1;

    const species = store.species.find((s) => s.id === fishId) ?? store.species[0];
    const wb = wbId ? store.db.waterBodies.find((w) => w.id === wbId) ?? null : null;
    const recommendations = recommendLures({ species, waterBody: wb, month });

    return res.json({
      fish_id: species.id,
      fish_name: species.name,
      water_body_id: wb?.id ?? null,
      water_body_name: wb?.display_label ?? null,
      month,
      recommendations,
    });
  });

  // --- Forecast & Weather ---
  app.get('/api/v1/weather', async (req, res) => {
    const lat = Number(req.query.lat ?? 55.975);
    const lng = Number(req.query.lng ?? 36.825);
    if (Number.isNaN(lat) || Number.isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Некорректные координаты для погоды.' });
    }
    const weather = await fetchWeatherViaProxy(lat, lng);
    return res.json({ weather });
  });

  app.get('/api/v1/forecast', async (req, res) => {
    const lat = Number(req.query.lat ?? 55.975);
    const lng = Number(req.query.lng ?? 36.825);
    const fishId = String(req.query.fish_id || 'pike');
    const waterBodyId = req.query.water_body_id ? String(req.query.water_body_id) : null;
    const dateStr = req.query.date ? String(req.query.date) : undefined;
    const species = store.species.find((s) => s.id === fishId) ?? store.species[0];
    const waterBody = waterBodyId
      ? store.db.waterBodies.find((w) => w.id === waterBodyId) ?? null
      : null;
    const forecast = await fetchBiteForecastViaProxy({
      lat,
      lng,
      species,
      dateStr,
      waterBody,
      reports: store.db.catchReports,
    });
    return res.json(forecast);
  });

  app.get('/api/v1/forecast/good-bite', async (req, res) => {
    const lat = Number(req.query.lat ?? 55.975);
    const lng = Number(req.query.lng ?? 36.825);
    const radiusKm = Math.min(200, Math.max(5, Number(req.query.radius ?? 100)));
    const fishId = req.query.fish_id ? String(req.query.fish_id) : 'all';
    const dayLabel = req.query.day === 'Завтра' ? 'Завтра' : 'Сегодня';
    const minFIndex = Math.min(95, Math.max(0, Number(req.query.min_f ?? 66)));
    const weather = await fetchWeatherViaProxy(lat, lng);
    const items = evaluateGoodBiteWaterBodies({
      origin: { lat, lng },
      waterBodies: store.db.waterBodies,
      speciesList: store.species,
      weather,
      reports: store.db.catchReports,
      baseDate: new Date(),
      radiusKm,
      fishId,
      dayLabel,
      minFIndex,
    });
    return res.json({
      origin: { lat, lng },
      radius_km: radiusKm,
      fish_id: fishId,
      day_label: dayLabel,
      items,
    });
  });

  // --- Reports & Diary ---
  app.get('/api/v1/reports', (req, res) => {
    const user = getAuthUser(req);
    const speciesFilter = req.query.species ? String(req.query.species) : null;
    const since = req.query.since ? String(req.query.since) : null; // 'hour' | 'today' | 'week' | 'all'
    const verifiedOnly = req.query.verified_only === 'true';
    const sourceFilter = req.query.source ? String(req.query.source) : null;
    const bboxParam = typeof req.query.bbox === 'string' ? req.query.bbox.split(',').map(Number) : null;

    const nowMs = Date.now();
    const items = store.db.catchReports
      .filter((r) => {
        if (r.visibility === 'private' && r.user_id !== user?.id) return false;
        if (speciesFilter && speciesFilter !== 'all' && r.fish_species_id !== speciesFilter) return false;
        if (verifiedOnly && !r.author_verified) return false;
        if (sourceFilter && r.source !== sourceFilter) return false;
        if (since && since !== 'all') {
          const ageMs = nowMs - new Date(r.created_at).getTime();
          if (since === 'hour' && ageMs > 3600 * 1000) return false;
          if (since === 'today' && ageMs > 24 * 3600 * 1000) return false;
          if (since === 'week' && ageMs > 7 * 24 * 3600 * 1000) return false;
        }
        if (bboxParam && bboxParam.length === 4 && bboxParam.every((n) => !Number.isNaN(n))) {
          const [minLng, minLat, maxLng, maxLat] = bboxParam;
          if (r.lng < minLng || r.lng > maxLng || r.lat < minLat || r.lat > maxLat) return false;
        }
        return true;
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return res.json({ items });
  });

  app.post('/api/v1/reports', (req, res) => {
    const ip = req.ip || 'local';
    if (!store.checkRateLimit(`rep:${ip}`, 30, 60_000)) {
      return res.status(429).json({ error: 'Слишком частая отправка отметок. Повторите через минуту.' });
    }

    const validationErr = validateCatchReportInput(req.body);
    if (validationErr) {
      return res.status(400).json({ error: validationErr });
    }

    const clientEventId =
      typeof req.body.client_event_id === 'string' && req.body.client_event_id.trim().length > 0
        ? req.body.client_event_id.trim()
        : crypto.randomUUID();

    // Idempotency guard against duplicate reconnect submissions
    if (store.db.seenClientEventIds.includes(clientEventId)) {
      const existing = store.db.catchReports.find((r) => r.client_event_id === clientEventId);
      if (existing) {
        return res.status(200).json({ report: existing, deduplicated: true });
      }
    }

    const user = getAuthUser(req);
    const species =
      store.species.find((s) => s.id === req.body.fish_species_id) ?? store.species[0];
    const wb = req.body.water_body_id
      ? store.db.waterBodies.find((w) => w.id === req.body.water_body_id) ?? null
      : null;

    // Validate optional inline base64 photo size
    let safePhotoUrl: string | null = null;
    if (typeof req.body.photo_url === 'string' && req.body.photo_url.length > 0) {
      if (req.body.photo_url.length > 7 * 1024 * 1024) {
        return res.status(400).json({ error: 'Размер фото превышает допустимый лимит 5 МБ.' });
      }
      safePhotoUrl = req.body.photo_url;
    }

    const nowIso = new Date().toISOString();
    const outcome = req.body.outcome === 'no_bite' ? 'no_bite' : 'catch';
    const rawWs = req.body.weather_snapshot;
    const weatherSnapshot =
      rawWs &&
      typeof rawWs === 'object' &&
      typeof rawWs.pressure_hpa === 'number' &&
      typeof rawWs.water_temp_c === 'number'
        ? {
            pressure_hpa: Number(rawWs.pressure_hpa),
            pressure_trend:
              rawWs.pressure_trend === 'rising' || rawWs.pressure_trend === 'falling'
                ? rawWs.pressure_trend
                : ('steady' as const),
            pressure_delta_6h:
              typeof rawWs.pressure_delta_6h === 'number' ? Number(rawWs.pressure_delta_6h) : undefined,
            water_temp_c: Number(rawWs.water_temp_c),
            air_temp_c: typeof rawWs.air_temp_c === 'number' ? Number(rawWs.air_temp_c) : Number(rawWs.water_temp_c),
            wind_speed_ms: typeof rawWs.wind_speed_ms === 'number' ? Number(rawWs.wind_speed_ms) : 3.0,
            wind_direction_label:
              typeof rawWs.wind_direction_label === 'string' ? rawWs.wind_direction_label : 'ЮЗ',
            cloud_cover_pct:
              typeof rawWs.cloud_cover_pct === 'number' ? Number(rawWs.cloud_cover_pct) : undefined,
            precipitation_mm: typeof rawWs.precipitation_mm === 'number' ? Number(rawWs.precipitation_mm) : 0,
            hour_local: typeof rawWs.hour_local === 'number' ? Number(rawWs.hour_local) : new Date().getHours(),
          }
        : undefined;

    const predictedFIndex =
      typeof req.body.predicted_f_index === 'number' && Number.isFinite(req.body.predicted_f_index)
        ? Math.max(0, Math.min(100, Math.round(req.body.predicted_f_index)))
        : null;

    const report: CatchReport = {
      id: `rep-${crypto.randomUUID().slice(0, 8)}`,
      client_event_id: clientEventId,
      user_id: user?.id ?? 'guest-local',
      author_nickname: user?.nickname ?? (req.body.author_nickname || 'Гость_Рыбак'),
      author_verified: user?.verified ?? false,
      water_body_id: wb?.id ?? null,
      water_body_name: wb?.display_label ?? (req.body.water_body_name || 'Точка на карте'),
      lat: Number(req.body.lat),
      lng: Number(req.body.lng),
      created_at: req.body.created_at || nowIso,
      updated_at: nowIso,
      fish_species_id: species.id,
      fish_species_name: species.name,
      outcome,
      weight_kg: outcome === 'no_bite' ? null : typeof req.body.weight_kg === 'number' ? req.body.weight_kg : null,
      length_cm: outcome === 'no_bite' ? null : typeof req.body.length_cm === 'number' ? req.body.length_cm : null,
      bait: typeof req.body.bait === 'string' ? req.body.bait.trim() : '',
      retrieve: typeof req.body.retrieve === 'string' ? req.body.retrieve.trim() : '',
      weather_summary: typeof req.body.weather_summary === 'string' ? req.body.weather_summary : '',
      weather_snapshot: weatherSnapshot,
      predicted_f_index: predictedFIndex,
      photo_url: safePhotoUrl,
      notes: typeof req.body.notes === 'string' ? req.body.notes.trim() : '',
      visibility: req.body.visibility ?? user?.privacy_default ?? 'public',
      source: req.body.source === 'diary' ? 'diary' : 'quick_mark',
    };

    store.db.catchReports.unshift(report);
    store.db.seenClientEventIds.push(clientEventId);
    if (store.db.seenClientEventIds.length > 2000) {
      store.db.seenClientEventIds = store.db.seenClientEventIds.slice(-1000);
    }
    store.forecastCache.clear();
    store.persist();

    if (report.visibility !== 'private') {
      broadcastEvent({ type: 'reports:new', data: report, lat: report.lat, lng: report.lng });
    }

    return res.status(201).json({ report, deduplicated: false });
  });

  app.patch('/api/v1/reports/:id', (req, res) => {
    const idx = store.db.catchReports.findIndex((r) => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Запись не найдена.' });
    const existing = store.db.catchReports[idx];
    const updated: CatchReport = {
      ...existing,
      outcome: req.body.outcome === 'no_bite' ? 'no_bite' : req.body.outcome === 'catch' ? 'catch' : existing.outcome,
      weight_kg: req.body.weight_kg !== undefined ? req.body.weight_kg : existing.weight_kg,
      length_cm: req.body.length_cm !== undefined ? req.body.length_cm : existing.length_cm,
      bait: typeof req.body.bait === 'string' ? req.body.bait : existing.bait,
      notes: typeof req.body.notes === 'string' ? req.body.notes : existing.notes,
      visibility: req.body.visibility ?? existing.visibility,
      updated_at: new Date().toISOString(),
    };
    store.db.catchReports[idx] = updated;
    store.forecastCache.clear();
    store.persist();
    return res.json({ report: updated });
  });

  app.delete('/api/v1/reports/:id', (req, res) => {
    const idx = store.db.catchReports.findIndex((r) => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Запись не найдена.' });
    store.db.catchReports.splice(idx, 1);
    store.forecastCache.clear();
    store.persist();
    return res.json({ ok: true });
  });

  app.get('/api/v1/me/stats', (req, res) => {
    const user = getAuthUser(req);
    const relevant = store.db.catchReports.filter((r) =>
      user ? r.user_id === user.id : r.source === 'diary' || r.user_id === 'guest-local'
    );
    const total = relevant.length;
    const weights = relevant.map((r) => r.weight_kg).filter((w): w is number => typeof w === 'number');
    const avgWeight = weights.length > 0 ? Number((weights.reduce((a, b) => a + b, 0) / weights.length).toFixed(2)) : 0;

    const baitCount = new Map<string, number>();
    const speciesCount = new Map<string, number>();
    for (const r of relevant) {
      if (r.bait) baitCount.set(r.bait, (baitCount.get(r.bait) ?? 0) + 1);
      speciesCount.set(r.fish_species_name, (speciesCount.get(r.fish_species_name) ?? 0) + 1);
    }
    const topBait = [...baitCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Виброхвост 12 см';
    const topSpecies = [...speciesCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Щука';

    return res.json({
      total_catches: total,
      avg_weight_kg: avgWeight,
      top_bait: topBait,
      top_species: topSpecies,
      best_weather: 'Стабильное давление 758–764 мм рт. ст., слабый ЮЗ ветер',
    });
  });

  // --- Navigation & Geocoding (Yandex Proxy) ---
  app.post('/api/v1/route-multi', async (req, res) => {
    const schema = z.object({
      from: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
      water_body_id: z.string(),
      avoid_unpaved: z.boolean().default(true),
      simulate_quota_exceeded: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Некорректные параметры маршрута.' });
    }
    const wb = store.db.waterBodies.find((w) => w.id === parsed.data.water_body_id);
    if (!wb) return res.status(404).json({ error: 'Водоём не найден.' });
    const accessPoints = store.db.accessPoints.filter((ap) => ap.water_body_id === wb.id);

    const route = await computeMultiRouteViaProxy({
      origin: parsed.data.from,
      waterBody: wb,
      accessPoints,
      avoidUnpaved: parsed.data.avoid_unpaved,
      simulateQuotaExceeded: parsed.data.simulate_quota_exceeded,
    });
    return res.json({ route });
  });

  const geocodeCache = new Map<
    string,
    {
      expiresAt: number;
      items: Array<{
        id: string;
        title: string;
        subtitle: string;
        lat: number;
        lng: number;
        water_body_id: string | null;
        is_water_body?: boolean;
        water_type?: WaterBodyType;
      }>;
    }
  >();

  app.get('/api/v1/geocode/search', async (req, res) => {
    const rawText = String(req.query.text ?? '').trim();
    const text = rawText.toLowerCase();
    if (!text) return res.json({ items: [] });

    const tokens = text.split(/\s+/).filter((t) => t.length >= 2);
    const localMatches: Array<{
      id: string;
      title: string;
      subtitle: string;
      lat: number;
      lng: number;
      water_body_id: string | null;
      is_water_body?: boolean;
      water_type?: WaterBodyType;
    }> = store.db.waterBodies
      .filter((wb) => {
        const hay = `${wb.name ?? ''} ${wb.display_label} ${wb.region}`.toLowerCase();
        if (tokens.length > 1) {
          return tokens.every((t) => hay.includes(t));
        }
        return hay.includes(text);
      })
      .slice(0, 8)
      .map((wb) => ({
        id: wb.id,
        title: wb.display_label,
        subtitle: `${wb.region} · ${wb.area_ha} га`,
        lat: wb.center.lat,
        lng: wb.center.lng,
        water_body_id: wb.id,
        is_water_body: true,
        water_type: wb.type,
      }));

    if (localMatches.length >= 6 || rawText.length < 2) {
      return res.json({ items: localMatches, source: 'hydro-index' });
    }

    const cached = geocodeCache.get(text);
    if (cached && cached.expiresAt > Date.now()) {
      const merged = [...localMatches, ...cached.items.filter((r) => !localMatches.some((l) => l.title === r.title))].slice(0, 10);
      return res.json({ items: merged, source: cached.items.length > 0 ? 'hydro+photon' : 'hydro-index' });
    }

    const remoteItems: typeof localMatches = [];
    try {
      const fetchPhoton = async (url: string) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        try {
          const pRes = await fetch(url, {
            headers: { 'User-Agent': 'FishCastAI/1.0' },
            signal: controller.signal,
          });
          if (!pRes.ok) return [];
          const pJson = (await pRes.json()) as {
            features?: Array<{
              geometry?: { coordinates?: [number, number] };
              properties?: {
                osm_id?: number;
                name?: string;
                state?: string;
                county?: string;
                country?: string;
                osm_key?: string;
                osm_value?: string;
              };
            }>;
          };
          return pJson.features ?? [];
        } finally {
          clearTimeout(timer);
        }
      };

      const encoded = encodeURIComponent(rawText);
      const [waterFeatures, generalFeatures] = await Promise.all([
        fetchPhoton(
          `https://photon.komoot.io/api/?q=${encoded}&limit=5&lat=55.975&lon=36.825&osm_tag=waterway&osm_tag=natural:water`
        ).catch(() => []),
        fetchPhoton(`https://photon.komoot.io/api/?q=${encoded}&limit=5&lat=55.975&lon=36.825`).catch(() => []),
      ]);

      const seenRemote = new Set<string>();
      for (const feat of [...waterFeatures, ...generalFeatures]) {
        const coords = feat.geometry?.coordinates;
        const props = feat.properties;
        if (!coords || coords.length < 2 || !props?.name) continue;
        const id = `photon-${props.osm_id ?? `${coords[1].toFixed(4)}-${coords[0].toFixed(4)}`}`;
        if (seenRemote.has(id)) continue;
        seenRemote.add(id);

        const osmKey = (props.osm_key ?? '').toLowerCase();
        const osmVal = (props.osm_value ?? '').toLowerCase();
        const lowerName = props.name.toLowerCase();
        const isWater =
          osmKey === 'waterway' ||
          (osmKey === 'natural' && osmVal === 'water') ||
          osmKey === 'water' ||
          ['river', 'stream', 'canal', 'lake', 'reservoir', 'pond', 'oxbow', 'basin'].includes(osmVal) ||
          /^(река|р\.|озеро|оз\.|водохранилище|вдхр|пруд|карьер|старица)\b/i.test(lowerName);
        const waterType = isWater
          ? inferWaterBodyTypeFromOsm({ waterway: osmKey === 'waterway' ? osmVal : undefined, water: osmVal }, props.name)
          : undefined;
        const sub = [props.county, props.state, props.country].filter(Boolean).slice(0, 2).join(' · ') || 'OpenStreetMap';
        remoteItems.push({
          id,
          title: props.name,
          subtitle: isWater ? `${sub} · открыть водоём` : `${sub} · найти водоёмы рядом`,
          lat: coords[1],
          lng: coords[0],
          water_body_id: null,
          is_water_body: isWater,
          water_type: waterType,
        });
      }
      remoteItems.sort((a, b) => Number(Boolean(b.is_water_body)) - Number(Boolean(a.is_water_body)));
    } catch {
      // Keep local matches if Photon is offline
    }

    geocodeCache.set(text, { expiresAt: Date.now() + 15 * 60 * 1000, items: remoteItems });
    const merged = [...localMatches, ...remoteItems.filter((r) => !localMatches.some((l) => l.title === r.title))].slice(0, 10);
    return res.json({ items: merged, source: remoteItems.length > 0 ? 'hydro+photon' : 'hydro-index' });
  });

  // --- Fish photo recognition (FR-10) ---
  app.post('/api/v1/vision/recognize', async (req, res) => {
    const schema = z.object({
      base64Data: z.string().min(10).max(7 * 1024 * 1024),
      mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Некорректное изображение (допустимы JPEG/PNG/WebP до 5 МБ).' });
    }
    const result = await recognizeFishPhotoViaGemini(parsed.data);
    return res.json(result);
  });

  // --- Vite middleware or static dist ---
  if (process.env.NODE_ENV !== 'production') {
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      plugins: hmrDisabled
        ? [
            {
              name: 'fishcast-disable-hmr-client-ws',
              enforce: 'post',
              transform(code, id) {
                const cleanId = id.split('?')[0].replace(/\\/g, '/');
                if (cleanId.endsWith('vite/dist/client/client.mjs') || cleanId.endsWith('/@vite/client')) {
                  return {
                    code: code.replace(
                      'let wsTransport = createWebSocketModuleRunnerTransport({',
                      'if (true) return { async connect() {}, async disconnect() {}, send() {} }; let wsTransport = createWebSocketModuleRunnerTransport({'
                    ),
                    map: null,
                  };
                }
              },
            },
          ]
        : [],
      server: {
        middlewareMode: true,
        hmr: hmrDisabled ? false : { server },
        ...(hmrDisabled ? { ws: false } : {}),
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`FishCast AI server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server error:', err);
  process.exit(1);
});
