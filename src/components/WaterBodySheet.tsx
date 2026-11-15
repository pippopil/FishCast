import React, { useMemo, useState } from 'react';
import {
  Anchor,
  Bell,
  Car,
  Compass,
  ExternalLink,
  Footprints,
  Navigation2,
  Radar,
  RefreshCw,
  ShieldAlert,
  Star,
  Thermometer,
  Waves,
  Wind,
  X,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  buildBathymetryProfile,
  waterBodyTypeRu,
  type BathymetryProfileLineMode,
  type BathymetryProfilePoint,
} from '../lib/fishLogic';
import type {
  BathymetryPoint,
  BiteForecastResponse,
  FishSpecies,
  LatLng,
  LureRecommendationResult,
  ProspectiveZone,
  RouteMultiResult,
  WaterBody,
  WaterBodyAnalysis,
  WeatherSnapshot,
} from '../lib/types';

interface WaterBodySheetProps {
  waterBody: WaterBody;
  weather: WeatherSnapshot | null;
  forecast: BiteForecastResponse | null;
  forecastLoading: boolean;
  speciesList: FishSpecies[];
  selectedFishId: string;
  onSelectFishId: (id: string) => void;
  recommendations: LureRecommendationResult[];
  depthPoints: BathymetryPoint[];
  prospectiveZones: ProspectiveZone[];
  analysis: WaterBodyAnalysis | null;
  reconRunning: boolean;
  onRunRecon: () => void;
  onAddDepthPoint: (payload: { lat: number; lng: number; depth_m: number; source: 'manual' | 'sonar' }) => Promise<string | null>;
  pickDepthMode: boolean;
  onTogglePickDepthMode: () => void;
  pickedCoords: LatLng | null;
  routeResult: RouteMultiResult | null;
  routeLoading: boolean;
  avoidUnpaved: boolean;
  onToggleAvoidUnpaved: (val: boolean) => void;
  onBuildRoute: (simulateQuota?: boolean) => void;
  onCloseMobile?: () => void;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  onOpenAlerts?: () => void;
  isOnline?: boolean;
}

type DetailSubTab = 'forecast' | 'depth' | 'route';

const SOURCE_LABELS: Record<WaterBody['source'], string> = {
  registry: 'Госводреестр',
  osm: 'OpenStreetMap',
  satellite: 'Sentinel-2 NDWI',
  user: 'Краудсорсинг',
};

export const WaterBodySheet: React.FC<WaterBodySheetProps> = ({
  waterBody,
  weather,
  forecast,
  forecastLoading,
  speciesList,
  selectedFishId,
  onSelectFishId,
  recommendations,
  depthPoints,
  prospectiveZones,
  analysis,
  reconRunning,
  onRunRecon,
  onAddDepthPoint,
  pickDepthMode,
  onTogglePickDepthMode,
  pickedCoords,
  routeResult,
  routeLoading,
  avoidUnpaved,
  onToggleAvoidUnpaved,
  onBuildRoute,
  onCloseMobile,
  isFavorite = false,
  onToggleFavorite,
  onOpenAlerts,
  isOnline = true,
}) => {
  const [subTab, setSubTab] = useState<DetailSubTab>('forecast');
  const [selectedDay, setSelectedDay] = useState<'Сегодня' | 'Завтра' | 'Послезавтра'>('Сегодня');
  const [profileLineMode, setProfileLineMode] = useState<BathymetryProfileLineMode>('transect');
  const [depthVal, setDepthVal] = useState('4.5');
  const [depthSource, setDepthSource] = useState<'manual' | 'sonar'>('manual');
  const [depthError, setDepthError] = useState<string | null>(null);
  const [depthSavedMsg, setDepthSavedMsg] = useState<string | null>(null);

  const profileData = useMemo(
    () => buildBathymetryProfile(depthPoints, profileLineMode),
    [depthPoints, profileLineMode]
  );

  const profileSummary = useMemo(() => {
    if (profileData.length === 0) return null;
    const maxD = Math.max(...profileData.map((p) => p.depth_m));
    const avgD = profileData.reduce((sum, p) => sum + p.depth_m, 0) / profileData.length;
    const spanM = profileData[profileData.length - 1].distance_m;
    const domainBottom = -Math.ceil(Math.max(2, maxD * 1.15));
    return { maxD, avgD, spanM, domainBottom };
  }, [profileData]);

  const daySlots = (forecast?.slots ?? []).filter((s) => s.day_label === selectedDay);
  const peakSlot = daySlots.reduce(
    (best, cur) => (cur.f_index > best.f_index ? cur : best),
    daySlots[0] ?? { f_index: 0, probability_label: 'средняя вероятность' as const, hour_interval: '06:00', factors: [] }
  );

  const handleDepthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDepthError(null);
    setDepthSavedMsg(null);
    const ptLat = pickedCoords?.lat ?? waterBody.center.lat;
    const ptLng = pickedCoords?.lng ?? waterBody.center.lng;
    const parsedDepth = Number(depthVal.replace(',', '.'));
    const err = await onAddDepthPoint({
      lat: ptLat,
      lng: ptLng,
      depth_m: parsedDepth,
      source: depthSource,
    });
    if (err) {
      setDepthError(err);
    } else {
      setDepthSavedMsg('Точка глубины сохранена и добавлена на карту.');
    }
  };

  return (
    <section
      aria-label={`Карточка водоёма ${waterBody.display_label}`}
      className="flex h-full flex-col bg-white dark:bg-slate-900"
    >
      {/* Header */}
      <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold text-slate-900 dark:text-slate-100">
              {waterBody.display_label}
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              <span>{waterBodyTypeRu(waterBody.type)}</span>
              <span aria-hidden="true"> · </span>
              <span>{SOURCE_LABELS[waterBody.source]}</span>
              <span aria-hidden="true"> · </span>
              <span className="font-mono tabular-nums">
                Достоверность {Math.round(waterBody.confidence * 100)}%
              </span>
              {waterBody.moderation_status === 'unverified' && (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className="font-semibold text-amber-700 dark:text-amber-400">непроверено</span>
                </>
              )}
            </p>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {onToggleFavorite && (
              <button
                type="button"
                onClick={onToggleFavorite}
                aria-pressed={isFavorite}
                aria-label={isFavorite ? 'Убрать водоём из избранного' : 'Добавить водоём в избранное'}
                title={isFavorite ? 'В избранном (уведомления F-Индекса)' : 'Добавить в избранное'}
                data-testid="toggle-favorite-wb"
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
                  isFavorite
                    ? 'bg-amber-50 text-amber-500 dark:bg-amber-950/50'
                    : 'text-slate-400 hover:bg-slate-100 hover:text-amber-500 dark:hover:bg-slate-800'
                }`}
              >
                <Star className={`h-5 w-5 ${isFavorite ? 'fill-current' : ''}`} aria-hidden="true" />
              </button>
            )}

            {onOpenAlerts && (
              <button
                type="button"
                onClick={onOpenAlerts}
                aria-label="Настроить оповещения о клёве"
                title="Оповещения F-Индекса (PWA)"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-sky-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-sky-400"
              >
                <Bell className="h-4.5 w-4.5" aria-hidden="true" />
              </button>
            )}

            {onCloseMobile && (
              <button
                type="button"
                onClick={onCloseMobile}
                aria-label="Свернуть карточку водоёма"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 lg:hidden"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>

        {/* Sub-tab segmented control */}
        <div className="mt-3 grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'forecast'}
            onClick={() => setSubTab('forecast')}
            className={`min-h-[38px] rounded-lg px-1.5 py-1.5 text-[11px] xl:text-xs font-semibold transition-colors whitespace-nowrap ${
              subTab === 'forecast'
                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400'
            }`}
          >
            Прогноз и клёв
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'depth'}
            onClick={() => setSubTab('depth')}
            className={`min-h-[38px] rounded-lg px-1.5 py-1.5 text-[11px] xl:text-xs font-semibold transition-colors whitespace-nowrap ${
              subTab === 'depth'
                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400'
            }`}
          >
            Глубины и разведка
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'route'}
            onClick={() => {
              setSubTab('route');
              if (!routeResult) onBuildRoute(false);
            }}
            className={`min-h-[38px] rounded-lg px-1.5 py-1.5 text-[11px] xl:text-xs font-semibold transition-colors whitespace-nowrap ${
              subTab === 'route'
                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400'
            }`}
          >
            Как добраться
          </button>
        </div>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {subTab === 'forecast' && (
          <>
            {/* Weather Strip */}
            {weather && (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3.5 dark:border-slate-800 dark:bg-slate-800/60">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300">
                  <span>Среда и погода (Open-Meteo)</span>
                  <span className="font-mono text-[11px] text-slate-500">
                    {weather.moon_phase} ({weather.moon_illumination}%)
                  </span>
                </div>
                <div className="mt-2.5 grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded-xl bg-white p-2.5 dark:bg-slate-900">
                    <div className="text-slate-500 whitespace-nowrap">Давление</div>
                    <div className="mt-0.5 font-mono text-xs sm:text-sm font-bold text-slate-900 dark:text-white tabular-nums whitespace-nowrap">
                      {weather.pressure_mmhg} мм
                    </div>
                    <div className="text-[11px] text-slate-500 whitespace-nowrap">
                      {weather.pressure_trend === 'steady'
                        ? 'стабильно'
                        : weather.pressure_trend === 'rising'
                          ? 'растёт'
                          : 'падает'}
                    </div>
                  </div>
                  <div className="rounded-xl bg-white p-2.5 dark:bg-slate-900">
                    <div className="flex items-center gap-1 text-slate-500 whitespace-nowrap">
                      <Thermometer className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span>Т° вода/возд</span>
                    </div>
                    <div className="mt-0.5 font-mono text-xs sm:text-sm font-bold text-slate-900 dark:text-white tabular-nums whitespace-nowrap">
                      {weather.water_temp_c}° / {weather.air_temp_c}°
                    </div>
                    <div className="text-[11px] text-slate-500 whitespace-nowrap">
                      Осадки {weather.precipitation_mm} мм
                    </div>
                  </div>
                  <div className="rounded-xl bg-white p-2.5 dark:bg-slate-900">
                    <div className="flex items-center gap-1 text-slate-500 whitespace-nowrap">
                      <Wind className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span>Ветер</span>
                    </div>
                    <div className="mt-0.5 font-mono text-xs sm:text-sm font-bold text-slate-900 dark:text-white tabular-nums whitespace-nowrap">
                      {weather.wind_speed_ms} м/с
                    </div>
                    <div className="text-[11px] text-slate-500 whitespace-nowrap">{weather.wind_direction_label}</div>
                  </div>
                </div>
              </div>
            )}

            {/* F-Index Bite Forecast */}
            <div>
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="wb-fish-select" className="text-xs font-bold text-slate-900 dark:text-slate-100">
                  AI-прогноз клёва (F-Индекс)
                </label>
                <select
                  id="wb-fish-select"
                  value={selectedFishId}
                  onChange={(e) => onSelectFishId(e.target.value)}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                >
                  {speciesList.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Day switcher */}
              <div className="mt-2.5 flex items-center gap-1.5">
                {(['Сегодня', 'Завтра', 'Послезавтра'] as const).map((day) => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => setSelectedDay(day)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                      selectedDay === day
                        ? 'bg-sky-700 text-white'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
                    }`}
                  >
                    {day}
                  </button>
                ))}
              </div>

              {/* Summary headline (probabilistic phrasing per FR-5.5) */}
              <div className="mt-3 rounded-xl border border-slate-200 p-3.5 dark:border-slate-800">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
                    Прогноз: {peakSlot.probability_label}
                  </span>
                  <span className="font-mono text-sm font-bold text-sky-700 dark:text-sky-400 tabular-nums">
                    пик F-{peakSlot.f_index} в {peakSlot.hour_interval}
                  </span>
                </div>

                {forecastLoading ? (
                  <div className="mt-4 text-xs text-slate-500">Обновляем прогноз...</div>
                ) : (
                  <div className="mt-3 grid grid-cols-8 gap-1.5 items-end h-24">
                    {daySlots.map((slot) => {
                      const barColor =
                        slot.f_index >= 66
                          ? 'bg-teal-600'
                          : slot.f_index >= 40
                            ? 'bg-sky-600'
                            : 'bg-slate-400';
                      return (
                        <div key={slot.hour_interval} className="flex flex-col items-center gap-1 h-full justify-end">
                          <span className="font-mono text-[10px] font-semibold text-slate-700 dark:text-slate-300 tabular-nums">
                            {slot.f_index}
                          </span>
                          <div
                            className={`w-full rounded-t-md transition-all ${barColor}`}
                            style={{ height: `${Math.max(12, Math.round(slot.f_index * 0.62))}px` }}
                            title={`${slot.hour_interval}: F-${slot.f_index} (${slot.probability_label})`}
                          />
                          <span className="font-mono text-[10px] text-slate-500 tabular-nums">
                            {slot.hour_interval.slice(0, 2)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                <p className="mt-2.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                  {forecast?.disclaimer ??
                    'Прогноз носит вероятностный характер и не гарантирует результат.'}
                </p>
              </div>
            </div>

            {/* Matched Lures */}
            <div>
              <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100">
                Рекомендуемые приманки для этого водоёма
              </h3>
              <div className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                {recommendations.slice(0, 3).map((rec) => (
                  <div key={rec.lure.id} className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                        {rec.lure.lure_type}
                      </span>
                      <span className="font-mono text-xs font-bold text-teal-700 dark:text-teal-400 shrink-0 tabular-nums">
                        {rec.score}%
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{rec.lure.retrieve}</p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {rec.reasons.join(' · ')}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {subTab === 'depth' && (
          <>
            {/* Bathymetry status */}
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3.5 dark:border-slate-800 dark:bg-slate-800/60">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-slate-100">
                  <Waves className="h-4 w-4 text-sky-700 dark:text-sky-400" aria-hidden="true" />
                  Батиметрия и рельеф дна
                </span>
                {waterBody.max_depth_m !== null && (
                  <span className="font-mono text-xs font-semibold text-slate-700 dark:text-slate-300 tabular-nums">
                    макс. {waterBody.max_depth_m} м
                  </span>
                )}
              </div>

              {waterBody.has_bathymetry ? (
                <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-300">
                  Доступны изобаты и {depthPoints.length} промеров глубин (Seascape + краудсорсинг).
                </p>
              ) : (
                <p className="mt-1.5 text-xs text-amber-800 dark:text-amber-300">
                  Для этого водоёма нет готовой карты глубин — вы можете добавить промер с эхолота или груза.
                </p>
              )}

              <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-slate-500">
                <ShieldAlert className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
                Не для навигации. Данные приблизительные.
              </p>
            </div>

            {/* Bathymetry Bottom Profile Chart along Selected Line (Recharts) */}
            <div
              data-testid="bathymetry-profile-card"
              className="rounded-2xl border border-slate-200 p-3.5 space-y-3 dark:border-slate-800"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100">
                    Профиль дна вдоль линии
                  </h3>
                  {profileSummary && (
                    <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                      Протяжённость ~{profileSummary.spanM} м · макс. {profileSummary.maxD.toFixed(1)} м · ср.{' '}
                      {profileSummary.avgD.toFixed(1)} м ({profileData.length} точ.)
                    </p>
                  )}
                </div>

                <select
                  aria-label="Линия профиля дна"
                  data-testid="bathymetry-line-select"
                  value={profileLineMode}
                  onChange={(e) => setProfileLineMode(e.target.value as BathymetryProfileLineMode)}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                >
                  <option value="transect">Главная ось промеров</option>
                  <option value="west_east">Линия Запад → Восток</option>
                  <option value="south_north">Линия Юг → Север</option>
                </select>
              </div>

              {profileData.length >= 2 && profileSummary ? (
                <div className="h-[190px] w-full" data-testid="bathymetry-profile-chart">
                  <ResponsiveContainer width="100%" height={186}>
                    <AreaChart data={profileData} margin={{ top: 10, right: 12, left: -14, bottom: 2 }}>
                      <defs>
                        <linearGradient id="bathymetryWaterGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#0EA5E9" stopOpacity={0.28} />
                          <stop offset="95%" stopColor="#0C4A6E" stopOpacity={0.65} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#CBD5E1" strokeOpacity={0.45} />
                      <XAxis
                        dataKey="distance_m"
                        type="number"
                        domain={['dataMin', 'dataMax']}
                        tickFormatter={(v) => `${v} м`}
                        tick={{ fontSize: 10, fill: '#64748B' }}
                        axisLine={{ stroke: '#CBD5E1' }}
                        tickLine={false}
                      />
                      <YAxis
                        domain={[profileSummary.domainBottom, 0]}
                        tickFormatter={(v) => `${Math.abs(Number(v))} м`}
                        tick={{ fontSize: 10, fill: '#64748B' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <ReferenceLine y={0} stroke="#0D9488" strokeDasharray="4 2" />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (!active || !payload || payload.length === 0) return null;
                          const pt = payload[0].payload as BathymetryProfilePoint;
                          return (
                            <div className="rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-[11px] shadow-md dark:border-slate-700 dark:bg-slate-900/95">
                              <div className="font-mono font-bold text-sky-700 dark:text-sky-400 tabular-nums">
                                Глубина: {pt.depth_m.toFixed(1)} м
                              </div>
                              <div className="mt-0.5 text-slate-600 dark:text-slate-300 tabular-nums">
                                От начала линии: {pt.distance_m} м
                              </div>
                              <div className="text-slate-500 dark:text-slate-400">
                                Источник: {pt.source_label}
                              </div>
                              <div className="mt-0.5 font-mono text-[10px] text-slate-400 tabular-nums">
                                {pt.lat.toFixed(4)}, {pt.lng.toFixed(4)}
                              </div>
                            </div>
                          );
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="bottom_elevation_m"
                        baseValue={0}
                        stroke="#0369A1"
                        strokeWidth={2.5}
                        fill="url(#bathymetryWaterGradient)"
                        dot={{ r: 3.5, fill: '#0F172A', stroke: '#FFFFFF', strokeWidth: 1.5 }}
                        activeDot={{ r: 5, fill: '#F59E0B', stroke: '#FFFFFF', strokeWidth: 2 }}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : profileData.length === 1 ? (
                <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                  Доступна 1 точка глубины (<span className="font-mono font-semibold">{profileData[0].depth_m.toFixed(1)} м</span>). Добавьте ещё хотя бы 1 промер на карте, чтобы построить профиль рельефа вдоль линии.
                </div>
              ) : (
                <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                  Для этого водоёма пока нет точек глубин. Поставьте 2 и более промеров ниже (или нажмите «Указать на карте»), чтобы увидеть срез рельефа дна.
                </div>
              )}
            </div>

            {/* Prospective Zones (Client-side calculated drop-offs & holes) */}
            {prospectiveZones.length > 0 && (
              <div>
                <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100">
                  Перспективные зоны (расчёт по изобатам)
                </h3>
                <div className="mt-2 space-y-1.5">
                  {prospectiveZones.map((z) => (
                    <div
                      key={z.id}
                      className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2 text-xs dark:border-slate-800"
                    >
                      <span className="font-semibold text-slate-800 dark:text-slate-200">{z.label}</span>
                      <span className="font-mono text-slate-500 tabular-nums">
                        {z.lat.toFixed(4)}, {z.lng.toFixed(4)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Crowdsourced Depth Point Submission (FR-2.2) */}
            <form
              onSubmit={(e) => void handleDepthSubmit(e)}
              className="rounded-2xl border border-slate-200 p-3.5 space-y-3 dark:border-slate-800"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100">
                  Добавить точку глубины
                </h3>
                <button
                  type="button"
                  onClick={onTogglePickDepthMode}
                  className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                    pickDepthMode
                      ? 'bg-amber-600 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
                  }`}
                >
                  {pickDepthMode ? 'Режим выбора на карте' : 'Указать на карте'}
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label htmlFor="depth-input" className="block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                    Глубина, м
                  </label>
                  <input
                    id="depth-input"
                    type="text"
                    inputMode="decimal"
                    value={depthVal}
                    onChange={(e) => setDepthVal(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  />
                </div>
                <div>
                  <label htmlFor="depth-source" className="block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                    Источник
                  </label>
                  <select
                    id="depth-source"
                    value={depthSource}
                    onChange={(e) => setDepthSource(e.target.value as 'manual' | 'sonar')}
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs font-medium text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  >
                    <option value="manual">Ручной промер</option>
                    <option value="sonar">Эхолот / сонар</option>
                  </select>
                </div>
              </div>

              <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                Координаты: {(pickedCoords?.lat ?? waterBody.center.lat).toFixed(5)},{' '}
                {(pickedCoords?.lng ?? waterBody.center.lng).toFixed(5)}
              </div>

              {depthError && <p className="text-xs font-medium text-rose-700">{depthError}</p>}
              {depthSavedMsg && <p className="text-xs font-medium text-teal-700 dark:text-teal-400">{depthSavedMsg}</p>}

              <button
                type="submit"
                className="inline-flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 dark:bg-sky-700 dark:hover:bg-sky-800"
              >
                <Anchor className="h-3.5 w-3.5" aria-hidden="true" />
                Сохранить промер глубины
              </button>
            </form>

            {/* Unknown Water Body Recon (FR-4) */}
            <div className="rounded-2xl border border-slate-200 p-3.5 space-y-3 dark:border-slate-800">
              <div className="flex items-center justify-between gap-2">
                <h3 className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-slate-100">
                  <Radar className="h-4 w-4 text-sky-700 dark:text-sky-400" aria-hidden="true" />
                  Разведка водоёма (Sentinel-2 + DEM)
                </h3>
                <button
                  type="button"
                  disabled={reconRunning}
                  onClick={onRunRecon}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <RefreshCw className={`h-3 w-3 ${reconRunning ? 'animate-spin' : ''}`} aria-hidden="true" />
                  {reconRunning ? 'Анализ...' : 'Запустить анализ'}
                </button>
              </div>

              {analysis && (
                <div className="space-y-2 text-xs">
                  <div className="font-bold text-slate-900 dark:text-slate-100">
                    Вероятность наличия рыбы:{' '}
                    <span
                      className={
                        analysis.fish_probability === 'high'
                          ? 'text-teal-700 dark:text-teal-400'
                          : analysis.fish_probability === 'medium'
                            ? 'text-amber-700 dark:text-amber-400'
                            : 'text-rose-700 dark:text-rose-400'
                      }
                    >
                      {analysis.fish_probability === 'high'
                        ? 'высокая'
                        : analysis.fish_probability === 'medium'
                          ? 'средняя'
                          : 'низкая'}
                    </span>
                    <span className="ml-2 font-mono text-slate-500">({analysis.score}/100)</span>
                  </div>
                  <p className="text-slate-600 dark:text-slate-300">
                    Причины: {analysis.reasons.map((r) => r.detail).join(', ')}.
                  </p>
                  <p className="font-medium text-slate-800 dark:text-slate-200">{analysis.recommendation}</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">{analysis.disclaimer}</p>
                </div>
              )}
            </div>
          </>
        )}

        {subTab === 'route' && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3.5 dark:border-slate-800 dark:bg-slate-800/60">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-slate-100">
                  <Compass className="h-4 w-4 text-sky-700 dark:text-sky-400" aria-hidden="true" />
                  Навигация «от дома до лунки»
                </span>
                <button
                  type="button"
                  onClick={() => onBuildRoute(false)}
                  className="text-xs font-semibold text-sky-700 hover:underline dark:text-sky-400"
                >
                  Пересчитать
                </button>
              </div>

              <label className="mt-3 flex items-center justify-between gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <span>Избегать грунтовок без покрытия (avoid_unpaved)</span>
                <input
                  type="checkbox"
                  checked={avoidUnpaved}
                  onChange={(e) => onToggleAvoidUnpaved(e.target.checked)}
                  className="h-4 w-4 accent-sky-700"
                />
              </label>
            </div>

            {!isOnline && (
              <div className="rounded-xl border border-teal-200 bg-teal-50 p-3 text-xs font-medium text-teal-900 dark:border-teal-900/60 dark:bg-teal-950/40 dark:text-teal-200">
                Офлайн-навигация: маршрут строится локально по сохранённым точкам подъезда и загруженному кэшу карты.
              </div>
            )}

            {routeLoading && (
              <div className="text-xs text-slate-500">Строим составной маршрут (авто + пешком)...</div>
            )}

            {routeResult && (
              <div className="space-y-3">
                {routeResult.quota_warning && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-medium text-amber-900">
                    {routeResult.quota_warning}
                  </div>
                )}

                {routeResult.driving_available && routeResult.driving_segment ? (
                  <div className="rounded-xl border border-slate-200 p-3.5 dark:border-slate-800">
                    <div className="flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-slate-100">
                        <Car className="h-4 w-4 text-sky-700 dark:text-sky-400" aria-hidden="true" />
                        На машине до точки подъезда
                      </span>
                      <span className="font-mono text-xs font-bold text-slate-900 dark:text-white tabular-nums">
                        {(routeResult.driving_segment.distance_m / 1000).toFixed(1)} км, ~
                        {Math.max(1, Math.round(routeResult.driving_segment.duration_s / 60))} мин
                      </span>
                    </div>
                    {routeResult.access_point && (
                      <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-400">
                        Точка прибытия: {routeResult.access_point.notes}
                      </p>
                    )}
                  </div>
                ) : (
                  <div
                    data-testid="driving-unavailable-msg"
                    className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs font-medium text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
                  >
                    {routeResult.unavailable_reason}
                  </div>
                )}

                <div className="rounded-xl border border-slate-200 p-3.5 dark:border-slate-800">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-slate-100">
                      <Footprints className="h-4 w-4 text-amber-600" aria-hidden="true" />
                      Пешком от парковки до точки ловли
                    </span>
                    <span className="font-mono text-xs font-bold text-slate-900 dark:text-white tabular-nums">
                      {(routeResult.walking_segment.distance_m / 1000).toFixed(2)} км, ~
                      {Math.max(1, Math.round(routeResult.walking_segment.duration_s / 60))} мин
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                  <a
                    href={routeResult.yandex_maps_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white hover:bg-slate-800 dark:bg-sky-700"
                  >
                    <Navigation2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Открыть в Картах
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>

                  <button
                    type="button"
                    onClick={() => onBuildRoute(true)}
                    className="text-[11px] font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-300 underline"
                  >
                    Проверить fallback квоты
                  </button>
                </div>

                <p className="text-[11px] text-slate-500">
                  {routeResult.source === 'valhalla-osm'
                    ? 'Маршрут построен бесплатно через OpenStreetMap (Valhalla) · навигация без сохранения трека.'
                    : routeResult.source === 'osrm-public'
                      ? 'Маршрут построен бесплатно через OpenStreetMap (OSRM) · навигация без сохранения трека.'
                      : routeResult.source === 'ors-osm'
                        ? 'Маршрут построен через OpenRouteService (OSM) · навигация без сохранения трека.'
                        : routeResult.source === 'yandex-routing'
                          ? '© Яндекс Карты. Маршрутные данные не сохраняются в постоянную базу приложения.'
                          : 'Локальный расчёт маршрута по точкам подъезда (офлайн/резервный режим).'}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
