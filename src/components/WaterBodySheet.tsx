import React, { useMemo, useState } from 'react';
import {
  Anchor,
  Bell,
  Car,
  CheckCircle2,
  Compass,
  ExternalLink,
  Fish,
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
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  buildBathymetryProfile,
  getExpectedFishForWaterBody,
  waterBodyTypeRu,
  type BathymetryProfileLineMode,
  type BathymetryProfilePoint,
} from '../lib/fishLogic';
import type {
  BathymetryPoint,
  BiteForecastResponse,
  BiteForecastSlot,
  CatchReport,
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
  reports?: CatchReport[];
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
type ChartSlotPoint = BiteForecastSlot & { slotKey: string; chartLabel: string };

const SOURCE_LABELS: Record<WaterBody['source'], string> = {
  registry: 'Госводреестр',
  osm: 'OpenStreetMap',
  satellite: 'Sentinel-2 NDWI',
  user: 'Краудсорсинг',
};

const ABUNDANCE_LABELS: Record<'common' | 'regular' | 'rare', string> = {
  common: 'основная',
  regular: 'обычная',
  rare: 'редко',
};

export const WaterBodySheet: React.FC<WaterBodySheetProps> = ({
  waterBody,
  weather,
  forecast,
  forecastLoading,
  speciesList,
  reports = [],
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
  const [selectedDay, setSelectedDay] = useState<'Ближ. 24ч' | 'Завтра' | 'Послезавтра'>('Ближ. 24ч');
  const [selectedSlotKey, setSelectedSlotKey] = useState<string | null>(null);
  const [profileLineMode, setProfileLineMode] = useState<BathymetryProfileLineMode>('transect');
  const [depthVal, setDepthVal] = useState('4.5');
  const [depthSource, setDepthSource] = useState<'manual' | 'sonar'>('manual');
  const [depthError, setDepthError] = useState<string | null>(null);
  const [depthSavedMsg, setDepthSavedMsg] = useState<string | null>(null);

  const expectedFish = useMemo(
    () => getExpectedFishForWaterBody({ waterBody, speciesList, reports }),
    [waterBody, speciesList, reports]
  );

  const selectedExpectedFish = useMemo(
    () => expectedFish.find((f) => f.species_id === selectedFishId) ?? null,
    [expectedFish, selectedFishId]
  );

  const selectedSpeciesObj = useMemo(
    () => speciesList.find((s) => s.id === selectedFishId) ?? speciesList[0],
    [speciesList, selectedFishId]
  );

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

  const chartSlots = useMemo<ChartSlotPoint[]>(() => {
    const allSlots = forecast?.slots ?? [];
    if (allSlots.length === 0) return [];

    let rawSlice: BiteForecastSlot[];
    if (selectedDay === 'Ближ. 24ч') {
      const currentBlock = Math.floor(new Date().getHours() / 3) * 3;
      const targetHour = `${currentBlock.toString().padStart(2, '0')}:00`;
      const startIdx = allSlots.findIndex(
        (s) => s.day_label === 'Сегодня' && s.hour_interval === targetHour
      );
      if (startIdx >= 0 && startIdx + 8 <= allSlots.length) {
        rawSlice = allSlots.slice(startIdx, startIdx + 8);
      } else {
        rawSlice = allSlots.filter((s) => s.day_label === 'Сегодня').slice(0, 8);
      }
    } else {
      rawSlice = allSlots.filter((s) => s.day_label === selectedDay).slice(0, 8);
    }

    const firstDate = rawSlice[0]?.date;
    return rawSlice.map((s) => ({
      ...s,
      slotKey: `${s.date}_${s.hour_interval}`,
      chartLabel:
        selectedDay === 'Ближ. 24ч' && s.date !== firstDate && s.hour_interval === '00:00'
          ? '00:00*'
          : s.hour_interval,
    }));
  }, [forecast?.slots, selectedDay]);

  const peakSlot: ChartSlotPoint = chartSlots.reduce(
    (best, cur) => (cur.f_index > best.f_index ? cur : best),
    chartSlots[0] ?? {
      date: '',
      day_label: 'Сегодня',
      hour_interval: '06:00',
      f_index: 0,
      probability_label: 'средняя вероятность' as const,
      factors: [],
      slotKey: '_06:00',
      chartLabel: '06:00',
    }
  );
  const activeSlot =
    chartSlots.find((s) => s.slotKey === selectedSlotKey) ?? peakSlot;

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
                <div className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
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
                    <div className="text-[11px] text-slate-500 whitespace-nowrap tabular-nums">
                      {typeof weather.pressure_delta_6h === 'number'
                        ? `Δ6ч ${weather.pressure_delta_6h > 0 ? '+' : ''}${weather.pressure_delta_6h} гПа`
                        : weather.pressure_trend === 'steady'
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
                      {forecast?.estimated_water_temp_c ?? weather.water_temp_c}° / {weather.air_temp_c}°
                    </div>
                    <div className="text-[11px] text-slate-500 whitespace-nowrap">
                      {typeof weather.cloud_cover_pct === 'number'
                        ? `Облачн. ${weather.cloud_cover_pct}%`
                        : `Осадки ${weather.precipitation_mm} мм`}
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
                    <div className="text-[11px] text-slate-500 whitespace-nowrap tabular-nums">
                      {weather.wind_direction_label}
                      {typeof weather.wind_gusts_ms === 'number' && weather.wind_gusts_ms >= weather.wind_speed_ms + 3
                        ? ` · пор. ${Math.round(weather.wind_gusts_ms)}`
                        : weather.precipitation_mm > 0
                          ? ` · ${weather.precipitation_mm} мм`
                          : ''}
                    </div>
                  </div>
                </div>
                {(forecast?.sunrise || forecast?.regime || typeof weather.air_temp_delta_48h_c === 'number') && (
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-400">
                    {forecast?.sunrise && forecast?.sunset && (
                      <span className="font-mono tabular-nums">
                        Восход {forecast.sunrise} · Закат {forecast.sunset}
                      </span>
                    )}
                    <span className="font-semibold text-slate-700 dark:text-slate-300">
                      {forecast?.regime === 'ice'
                        ? forecast.ice_phase === 'first_ice'
                          ? 'Первый лёд'
                          : forecast.ice_phase === 'last_ice'
                            ? 'Последний лёд'
                            : 'Глухозимье (лёд)'
                        : 'Открытая вода'}
                      {typeof weather.air_temp_delta_48h_c === 'number' && Math.abs(weather.air_temp_delta_48h_c) >= 4
                        ? ` · ΔT48ч ${weather.air_temp_delta_48h_c > 0 ? '+' : ''}${weather.air_temp_delta_48h_c}°`
                        : ''}
                    </span>
                  </div>
                )}

                {/* Ecological, Hydrological & Windward Shore Insights */}
                {(forecast?.bio_phase_label ||
                  forecast?.hydrology_label ||
                  forecast?.oxygen_label ||
                  forecast?.windward_shore_hint ||
                  forecast?.adaptive_factors_note) && (
                  <div
                    data-testid="forecast-eco-insights"
                    className="mt-2.5 space-y-1 border-t border-slate-200/80 pt-2 text-[11px] leading-snug text-slate-600 dark:border-slate-700/80 dark:text-slate-300"
                  >
                    {forecast.bio_phase_label && (
                      <div>
                        <span className="font-semibold text-slate-800 dark:text-slate-100">Биофаза: </span>
                        <span>{forecast.bio_phase_label}</span>
                      </div>
                    )}
                    {forecast.hydrology_label && (
                      <div>
                        <span className="font-semibold text-slate-800 dark:text-slate-100">Гидрология: </span>
                        <span>{forecast.hydrology_label}</span>
                      </div>
                    )}
                    {forecast.oxygen_label && (
                      <div
                        className={
                          forecast.oxygen_risk === 'high'
                            ? 'font-medium text-amber-800 dark:text-amber-300'
                            : undefined
                        }
                      >
                        <span className="font-semibold">Кислород / сезон: </span>
                        <span>{forecast.oxygen_label}</span>
                      </div>
                    )}
                    {forecast.windward_shore_hint && (
                      <div>
                        <span className="font-semibold text-slate-800 dark:text-slate-100">Берег: </span>
                        <span>{forecast.windward_shore_hint}</span>
                      </div>
                    )}
                    {forecast.adaptive_factors_note && (
                      <div className="text-sky-800 dark:text-sky-300">
                        <span>{forecast.adaptive_factors_note}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Expected Fish Species in this Water Body */}
            {expectedFish.length > 0 && (
              <div
                data-testid="water-body-inhabiting-species"
                className="rounded-2xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-slate-100">
                    <Fish className="h-4 w-4 text-sky-700 dark:text-sky-400" aria-hidden="true" />
                    Какая рыба водится в водоёме
                  </h3>
                  <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                    {expectedFish.length} вид.
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  Нажмите на вид, чтобы построить график клёва и приманки именно под него.
                </p>

                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {expectedFish.map((item) => {
                    const isSelected = item.species_id === selectedFishId;
                    return (
                      <button
                        key={item.species_id}
                        type="button"
                        onClick={() => onSelectFishId(item.species_id)}
                        title={
                          item.note
                            ? `${item.species_name} (${ABUNDANCE_LABELS[item.abundance]}): ${item.note}`
                            : `${item.species_name} (${ABUNDANCE_LABELS[item.abundance]})`
                        }
                        className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                          isSelected
                            ? 'border-sky-700 bg-sky-700 text-white'
                            : item.abundance === 'common'
                              ? 'border-slate-200 bg-slate-50 text-slate-800 hover:border-sky-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
                              : 'border-slate-200/80 bg-white text-slate-600 hover:border-sky-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
                        }`}
                      >
                        {item.source === 'confirmed_report' && (
                          <CheckCircle2
                            className={`h-3 w-3 shrink-0 ${isSelected ? 'text-sky-100' : 'text-teal-600 dark:text-teal-400'}`}
                            aria-hidden="true"
                          />
                        )}
                        <span>{item.species_name}</span>
                        <span
                          className={`text-[10px] ${
                            isSelected ? 'text-sky-100' : 'text-slate-400 dark:text-slate-500'
                          }`}
                        >
                          · {ABUNDANCE_LABELS[item.abundance]}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {selectedExpectedFish?.note ? (
                  <p className="mt-2 text-[11px] text-slate-600 dark:text-slate-300">
                    <span className="font-semibold text-slate-800 dark:text-slate-100">
                      {selectedExpectedFish.species_name}:
                    </span>{' '}
                    {selectedExpectedFish.note}
                    {selectedExpectedFish.source === 'confirmed_report' ? ' · подтверждено уловами' : ''}
                  </p>
                ) : !selectedExpectedFish && selectedSpeciesObj ? (
                  <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                    «{selectedSpeciesObj.name}» нетипичен для этого водоёма — выберите один из обитающих видов выше.
                  </p>
                ) : null}
              </div>
            )}

            {/* F-Index Bite Forecast */}
            <div>
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="wb-fish-select" className="text-xs font-bold text-slate-900 dark:text-slate-100">
                  Прогноз клёва на 24 часа (F-Индекс)
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
                {(['Ближ. 24ч', 'Завтра', 'Послезавтра'] as const).map((day) => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => {
                      setSelectedDay(day);
                      setSelectedSlotKey(null);
                    }}
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
                  <span className="font-mono text-sm font-bold text-teal-700 dark:text-teal-400 tabular-nums">
                    пик F-{peakSlot.f_index} в {peakSlot.hour_interval}
                  </span>
                </div>

                {/* Model confidence & Bayesian calibration bar */}
                {forecast?.confidence_label && (
                  <div
                    data-testid="forecast-confidence-bar"
                    className="mt-2 flex flex-wrap items-center justify-between gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] dark:bg-slate-800/70"
                  >
                    <span
                      className={`font-semibold ${
                        forecast.confidence_level === 'high'
                          ? 'text-teal-700 dark:text-teal-400'
                          : forecast.confidence_level === 'medium'
                            ? 'text-sky-700 dark:text-sky-400'
                            : 'text-amber-700 dark:text-amber-400'
                      }`}
                    >
                      {forecast.confidence_label}
                    </span>
                    {typeof forecast.calibration_delta === 'number' && forecast.calibration_delta !== 0 && (
                      <span className="font-mono font-bold text-slate-700 dark:text-slate-200 tabular-nums">
                        поправка {forecast.calibration_delta > 0 ? `+${forecast.calibration_delta}` : forecast.calibration_delta}
                      </span>
                    )}
                  </div>
                )}

                {forecastLoading ? (
                  <div className="mt-4 text-xs text-slate-500">Обновляем прогноз...</div>
                ) : chartSlots.length > 0 ? (
                  <>
                    {/* Recharts 24h F-Index Line Chart */}
                    <div className="mt-3 h-[184px] w-full" data-testid="findex-24h-chart">
                      <ResponsiveContainer width="100%" height={180}>
                        <LineChart
                          data={chartSlots}
                          margin={{ top: 12, right: 12, left: -20, bottom: 2 }}
                          onClick={(state) => {
                            const idx = typeof state?.activeTooltipIndex === 'number' ? state.activeTooltipIndex : -1;
                            if (idx >= 0 && chartSlots[idx]) {
                              setSelectedSlotKey(chartSlots[idx].slotKey);
                            }
                          }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#CBD5E1" strokeOpacity={0.45} />
                          <XAxis
                            dataKey="chartLabel"
                            tick={{ fontSize: 10, fill: '#64748B' }}
                            axisLine={{ stroke: '#CBD5E1' }}
                            tickLine={false}
                          />
                          <YAxis
                            domain={[0, 100]}
                            ticks={[0, 40, 66, 100]}
                            tick={{ fontSize: 10, fill: '#64748B' }}
                            axisLine={false}
                            tickLine={false}
                          />
                          <ReferenceLine
                            y={66}
                            stroke="#0D9488"
                            strokeDasharray="4 3"
                            strokeOpacity={0.75}
                          />
                          <Tooltip
                            content={({ active, payload }) => {
                              if (!active || !payload || payload.length === 0) return null;
                              const pt = payload[0].payload as ChartSlotPoint;
                              return (
                                <div className="rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-[11px] shadow-md dark:border-slate-700 dark:bg-slate-900/95">
                                  <div className="flex items-center justify-between gap-3">
                                    <span className="font-mono font-bold text-slate-900 dark:text-slate-100">
                                      {pt.day_label}, {pt.hour_interval}
                                    </span>
                                    <span
                                      className={`font-mono font-bold tabular-nums ${
                                        pt.f_index >= 66
                                          ? 'text-teal-700 dark:text-teal-400'
                                          : pt.f_index >= 40
                                            ? 'text-sky-700 dark:text-sky-400'
                                            : 'text-slate-500'
                                      }`}
                                    >
                                      F-{pt.f_index}
                                    </span>
                                  </div>
                                  <div className="mt-0.5 text-slate-600 dark:text-slate-300">
                                    {pt.probability_label}
                                  </div>
                                  {typeof pt.temp_c === 'number' && (
                                    <div className="mt-1 font-mono text-[10px] text-slate-500 tabular-nums">
                                      {pt.temp_c}°C · {pt.wind_speed_ms} м/с · {pt.pressure_mmhg} мм · об.{' '}
                                      {pt.cloud_cover_pct ?? 0}%
                                    </div>
                                  )}
                                  {pt.factors.length > 0 && (
                                    <div className="mt-1 max-w-[220px] text-[10px] text-slate-500 dark:text-slate-400">
                                      {pt.factors.slice(0, 2).join(' · ')}
                                    </div>
                                  )}
                                </div>
                              );
                            }}
                          />
                          <Line
                            type="monotone"
                            dataKey="f_index"
                            stroke="#0284C7"
                            strokeWidth={2.5}
                            dot={{ r: 3.5, fill: '#0284C7', stroke: '#FFFFFF', strokeWidth: 1.5 }}
                            activeDot={{ r: 5.5, fill: '#0F172A', stroke: '#FFFFFF', strokeWidth: 2 }}
                            isAnimationActive={false}
                          />
                          <ReferenceDot
                            x={peakSlot.chartLabel}
                            y={peakSlot.f_index}
                            r={6}
                            fill="#0D9488"
                            stroke="#FFFFFF"
                            strokeWidth={2}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>

                    {/* Compact clickable 3-hour slot strip for quick touch inspection */}
                    <div className="mt-1.5 grid grid-cols-8 gap-1">
                      {chartSlots.map((slot) => {
                        const isSelected = activeSlot.slotKey === slot.slotKey;
                        const isPeak = peakSlot.slotKey === slot.slotKey;
                        return (
                          <button
                            key={slot.slotKey}
                            type="button"
                            onClick={() => setSelectedSlotKey(slot.slotKey)}
                            className={`rounded-md py-1 text-center font-mono text-[10px] tabular-nums transition-colors ${
                              isSelected
                                ? 'bg-sky-700 font-bold text-white'
                                : isPeak
                                  ? 'bg-teal-50 font-bold text-teal-800 dark:bg-teal-950/50 dark:text-teal-300'
                                  : 'bg-slate-50 text-slate-600 hover:bg-slate-100 dark:bg-slate-800/70 dark:text-slate-300'
                            }`}
                            title={`${slot.day_label} ${slot.hour_interval}: F-${slot.f_index}`}
                          >
                            {slot.hour_interval.slice(0, 2)}ч
                          </button>
                        );
                      })}
                    </div>

                    {/* Selected slot factor & hourly meteo breakdown */}
                    {activeSlot && (
                      <div className="mt-3 border-t border-slate-100 pt-2.5 text-[11px] dark:border-slate-800">
                        <div className="flex flex-wrap items-center justify-between gap-1 text-slate-700 dark:text-slate-300">
                          <span className="font-semibold">
                            Слот {activeSlot.day_label}, {activeSlot.hour_interval}: F-{activeSlot.f_index}
                          </span>
                          {typeof activeSlot.temp_c === 'number' && (
                            <span className="font-mono text-slate-500 tabular-nums">
                              {activeSlot.temp_c}°C · {activeSlot.wind_speed_ms} м/с
                              {typeof activeSlot.wind_gusts_ms === 'number' && activeSlot.wind_gusts_ms >= 10
                                ? ` (пор. ${Math.round(activeSlot.wind_gusts_ms)})`
                                : ''}
                              {' · '}
                              {activeSlot.pressure_mmhg} мм · об. {activeSlot.cloud_cover_pct ?? 0}%
                              {typeof activeSlot.radiation_wm2 === 'number' && activeSlot.radiation_wm2 > 20
                                ? ` · ${activeSlot.radiation_wm2} Вт/м²`
                                : ''}
                            </span>
                          )}
                        </div>
                        {activeSlot.factors.length > 0 && (
                          <p className="mt-1 text-slate-600 dark:text-slate-400 leading-relaxed">
                            Факторы: {activeSlot.factors.join(' · ')}
                          </p>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="mt-4 text-xs text-slate-500">Нет данных прогноза для выбранного интервала.</div>
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
