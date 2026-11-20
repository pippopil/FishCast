import type {
  BathymetryPoint,
  BiteForecastResponse,
  CatchReport,
  FishSpecies,
  KnotGuide,
  SyncQueueItem,
  WaterBody,
  WaterBodyAccessPoint,
  WaterBodyAnalysis,
  WeatherSnapshot,
} from '../lib/types';

const DB_NAME = 'fishcast_offline_v1';
const DB_VERSION = 2;

export interface StoredMapTile {
  url: string;
  z: number;
  x: number;
  y: number;
  data: ArrayBuffer;
  size_bytes: number;
  stored_at: string;
}

interface CachedWaterBodyBundle {
  water_body: WaterBody;
  access_points: WaterBodyAccessPoint[];
  depth_points: BathymetryPoint[];
  analysis: WaterBodyAnalysis;
  forecast?: BiteForecastResponse;
  cached_at: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv');
      }
      if (!db.objectStoreNames.contains('sync_queue')) {
        db.createObjectStore('sync_queue', { keyPath: 'local_id' });
      }
      if (!db.objectStoreNames.contains('local_diary')) {
        db.createObjectStore('local_diary', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('map_tiles')) {
        const tileStore = db.createObjectStore('map_tiles', { keyPath: 'url' });
        tileStore.createIndex('by_zoom', 'z', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvSet<T>(key: string, value: T): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Graceful no-op if IndexedDB blocked
  }
}

async function kvGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export const offlineDb = {
  async saveWaterBodies(items: WaterBody[]): Promise<void> {
    await kvSet('water_bodies', items);
  },
  async getWaterBodies(): Promise<WaterBody[]> {
    return (await kvGet<WaterBody[]>('water_bodies')) ?? [];
  },

  async saveSpeciesAndKnots(species: FishSpecies[], knots: KnotGuide[]): Promise<void> {
    await kvSet('species', species);
    await kvSet('knots', knots);
  },
  async getSpeciesAndKnots(): Promise<{ species: FishSpecies[]; knots: KnotGuide[] }> {
    const [species, knots] = await Promise.all([
      kvGet<FishSpecies[]>('species'),
      kvGet<KnotGuide[]>('knots'),
    ]);
    return { species: species ?? [], knots: knots ?? [] };
  },

  async saveLastOpenedWaterBody(bundle: CachedWaterBodyBundle): Promise<void> {
    await kvSet('last_water_body', bundle);
    await kvSet(`wb_bundle_${bundle.water_body.id}`, bundle);
  },
  async getLastOpenedWaterBody(id?: string): Promise<CachedWaterBodyBundle | null> {
    if (id) {
      const specific = await kvGet<CachedWaterBodyBundle>(`wb_bundle_${id}`);
      if (specific) return specific;
    }
    return kvGet<CachedWaterBodyBundle>('last_water_body');
  },

  async saveWeather(weather: WeatherSnapshot): Promise<void> {
    await kvSet('last_weather', weather);
  },
  async getWeather(): Promise<WeatherSnapshot | null> {
    return kvGet<WeatherSnapshot>('last_weather');
  },

  async saveReportsCache(reports: CatchReport[]): Promise<void> {
    await kvSet('reports_cache', reports);
  },
  async getReportsCache(): Promise<CatchReport[]> {
    return (await kvGet<CatchReport[]>('reports_cache')) ?? [];
  },

  async enqueueOperation(item: SyncQueueItem): Promise<void> {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('sync_queue', 'readwrite');
        tx.objectStore('sync_queue').put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore
    }
  },

  async getQueue(): Promise<SyncQueueItem[]> {
    try {
      const db = await openDb();
      return await new Promise<SyncQueueItem[]>((resolve, reject) => {
        const tx = db.transaction('sync_queue', 'readonly');
        const req = tx.objectStore('sync_queue').getAll();
        req.onsuccess = () => resolve((req.result as SyncQueueItem[]) ?? []);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  },

  async removeQueueItem(localId: string): Promise<void> {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('sync_queue', 'readwrite');
        tx.objectStore('sync_queue').delete(localId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore
    }
  },

  async updateQueueItem(item: SyncQueueItem): Promise<void> {
    await this.enqueueOperation(item);
  },

  async saveFavoriteIds(ids: string[]): Promise<void> {
    await kvSet('favorite_water_body_ids', ids);
  },
  async getFavoriteIds(): Promise<string[]> {
    return (await kvGet<string[]>('favorite_water_body_ids')) ?? [];
  },

  async saveAlertSettings(settings: import('../lib/types').BiteAlertSettings): Promise<void> {
    await kvSet('bite_alert_settings', settings);
  },
  async getAlertSettings(): Promise<import('../lib/types').BiteAlertSettings | null> {
    return kvGet<import('../lib/types').BiteAlertSettings>('bite_alert_settings');
  },

  async saveAlertHistory(entries: import('../lib/types').BiteAlertLogEntry[]): Promise<void> {
    await kvSet('bite_alert_history', entries.slice(0, 30));
  },
  async getAlertHistory(): Promise<import('../lib/types').BiteAlertLogEntry[]> {
    return (await kvGet<import('../lib/types').BiteAlertLogEntry[]>('bite_alert_history')) ?? [];
  },

  async saveOfflineRegions(regions: import('../lib/types').OfflineMapRegion[]): Promise<void> {
    await kvSet('offline_map_regions', regions);
  },
  async getOfflineRegions(): Promise<import('../lib/types').OfflineMapRegion[]> {
    return (await kvGet<import('../lib/types').OfflineMapRegion[]>('offline_map_regions')) ?? [];
  },

  async putMapTile(tile: StoredMapTile): Promise<void> {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('map_tiles', 'readwrite');
        tx.objectStore('map_tiles').put(tile);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Graceful no-op if IndexedDB unavailable
    }
  },

  async getMapTile(url: string): Promise<StoredMapTile | null> {
    try {
      const db = await openDb();
      return await new Promise<StoredMapTile | null>((resolve, reject) => {
        const tx = db.transaction('map_tiles', 'readonly');
        const req = tx.objectStore('map_tiles').get(url);
        req.onsuccess = () => resolve((req.result as StoredMapTile) ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  },

  async deleteMapTiles(urls: string[]): Promise<void> {
    if (urls.length === 0) return;
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('map_tiles', 'readwrite');
        const store = tx.objectStore('map_tiles');
        for (const u of urls) {
          store.delete(u);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Graceful no-op
    }
  },

  async getMapTilesStats(): Promise<{ count: number; totalBytes: number }> {
    try {
      const db = await openDb();
      return await new Promise<{ count: number; totalBytes: number }>((resolve, reject) => {
        const tx = db.transaction('map_tiles', 'readonly');
        const req = tx.objectStore('map_tiles').openCursor();
        let count = 0;
        let totalBytes = 0;
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const val = cursor.value as Partial<StoredMapTile>;
            count++;
            totalBytes += typeof val.size_bytes === 'number' ? val.size_bytes : 0;
            cursor.continue();
          } else {
            resolve({ count, totalBytes });
          }
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      return { count: 0, totalBytes: 0 };
    }
  },

  async getSeedVersion(): Promise<number | null> {
    return kvGet<number>('seed_data_version');
  },

  async setSeedVersion(version: number): Promise<void> {
    await kvSet('seed_data_version', version);
  },

  async clearStaleSeedCaches(): Promise<void> {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const key = String(cursor.key);
            if (
              key === 'water_bodies' ||
              key === 'reports_cache' ||
              key === 'last_water_body' ||
              key.startsWith('wb_bundle_')
            ) {
              cursor.delete();
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      // Graceful no-op if IndexedDB unavailable
    }
  },
};
