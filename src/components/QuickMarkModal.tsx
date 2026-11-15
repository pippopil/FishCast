import React, { useState } from 'react';
import { LocateFixed, Radio, X } from 'lucide-react';
import type { FishSpecies, LatLng, ReportVisibility, WaterBody } from '../lib/types';

interface QuickMarkModalProps {
  isOpen: boolean;
  onClose: () => void;
  speciesList: FishSpecies[];
  waterBodies: WaterBody[];
  selectedWaterBody: WaterBody | null;
  currentCoords: LatLng | null;
  onSubmit: (payload: {
    lat: number | null;
    lng: number | null;
    fish_species_id: string;
    water_body_id: string | null;
    bait: string;
    notes: string;
    visibility: ReportVisibility;
    photo_url: string | null;
    photo_size_bytes?: number;
    photo_mime?: string;
  }) => Promise<string | null>;
}

export const QuickMarkModal: React.FC<QuickMarkModalProps> = ({
  isOpen,
  onClose,
  speciesList,
  waterBodies,
  selectedWaterBody,
  currentCoords,
  onSubmit,
}) => {
  const [speciesId, setSpeciesId] = useState(speciesList[0]?.id ?? 'pike');
  const [waterBodyId, setWaterBodyId] = useState(selectedWaterBody?.id ?? '');
  const [latInput, setLatInput] = useState(
    selectedWaterBody?.center.lat.toFixed(5) ?? currentCoords?.lat.toFixed(5) ?? ''
  );
  const [lngInput, setLngInput] = useState(
    selectedWaterBody?.center.lng.toFixed(5) ?? currentCoords?.lng.toFixed(5) ?? ''
  );
  const [bait, setBait] = useState('');
  const [notes, setNotes] = useState('');
  const [visibility, setVisibility] = useState<ReportVisibility>('public');
  const [photoData, setPhotoData] = useState<{ url: string; size: number; mime: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleUseGps = () => {
    setError(null);
    if (!navigator.geolocation) {
      if (currentCoords) {
        setLatInput(currentCoords.lat.toFixed(5));
        setLngInput(currentCoords.lng.toFixed(5));
      } else {
        setError('Геолокация браузера недоступна — введите координаты или выберите водоём.');
      }
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLatInput(pos.coords.latitude.toFixed(5));
        setLngInput(pos.coords.longitude.toFixed(5));
      },
      () => {
        if (currentCoords) {
          setLatInput(currentCoords.lat.toFixed(5));
          setLngInput(currentCoords.lng.toFixed(5));
        } else {
          setError('Не удалось получить координаты GPS. Разрешите доступ или укажите их вручную.');
        }
      },
      { timeout: 4000 }
    );
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError('Размер фото превышает лимит 5 МБ.');
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Допустимые форматы: JPEG, PNG, WebP.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setError(null);
      setPhotoData({ url: String(reader.result), size: file.size, mime: file.type });
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsedLat = latInput.trim() === '' ? null : Number(latInput);
    const parsedLng = lngInput.trim() === '' ? null : Number(lngInput);

    setSubmitting(true);
    const errMsg = await onSubmit({
      lat: parsedLat !== null && !Number.isNaN(parsedLat) ? parsedLat : null,
      lng: parsedLng !== null && !Number.isNaN(parsedLng) ? parsedLng : null,
      fish_species_id: speciesId,
      water_body_id: waterBodyId || null,
      bait,
      notes,
      visibility,
      photo_url: photoData?.url ?? null,
      photo_size_bytes: photoData?.size,
      photo_mime: photoData?.mime,
    });
    setSubmitting(false);

    if (errMsg) {
      setError(errMsg);
      return;
    }
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-mark-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <div className="w-full max-w-lg rounded-t-3xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900 sm:rounded-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="quick-mark-title" className="text-lg font-bold text-slate-900 dark:text-slate-100">
              Метка «Клюёт здесь сейчас»
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Отметка появится у других рыбаков на карте в реальном времени.
            </p>
          </div>
          <button
            type="button"
            aria-label="Закрыть окно отметки"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 space-y-4">
          {error && (
            <div
              role="alert"
              className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-medium text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-200"
            >
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="qm-species" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                Вид рыбы
              </label>
              <select
                id="qm-species"
                value={speciesId}
                onChange={(e) => setSpeciesId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                {speciesList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="qm-wb" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                Водоём (опционально)
              </label>
              <select
                id="qm-wb"
                value={waterBodyId}
                onChange={(e) => {
                  const id = e.target.value;
                  setWaterBodyId(id);
                  const found = waterBodies.find((w) => w.id === id);
                  if (found) {
                    setLatInput(found.center.lat.toFixed(5));
                    setLngInput(found.center.lng.toFixed(5));
                  }
                }}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                <option value="">По координатам</option>
                {waterBodies.map((wb) => (
                  <option key={wb.id} value={wb.id}>
                    {wb.display_label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Координаты геолокации (обязательно)
              </span>
              <button
                type="button"
                onClick={handleUseGps}
                className="inline-flex items-center gap-1 text-xs font-semibold text-sky-700 hover:underline dark:text-sky-400"
              >
                <LocateFixed className="h-3.5 w-3.5" aria-hidden="true" />
                Определить по GPS
              </button>
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-2.5">
              <div>
                <label htmlFor="qm-lat" className="sr-only">
                  Широта
                </label>
                <input
                  id="qm-lat"
                  type="text"
                  inputMode="decimal"
                  placeholder="Широта (56.0120)"
                  value={latInput}
                  onChange={(e) => setLatInput(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="qm-lng" className="sr-only">
                  Долгота
                </label>
                <input
                  id="qm-lng"
                  type="text"
                  inputMode="decimal"
                  placeholder="Долгота (36.8220)"
                  value={lngInput}
                  onChange={(e) => setLngInput(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="qm-bait" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                Приманка / наживка
              </label>
              <input
                id="qm-bait"
                type="text"
                placeholder="Например: виброхвост 10 см"
                value={bait}
                onChange={(e) => setBait(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </div>
            <div>
              <label htmlFor="qm-vis" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                Приватность точки
              </label>
              <select
                id="qm-vis"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as ReportVisibility)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                <option value="public">Видна всем на карте</option>
                <option value="friends">Только друзьям</option>
                <option value="private">Скрыть точку (в дневник)</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="qm-notes" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Короткий комментарий
            </label>
            <input
              id="qm-notes"
              type="text"
              placeholder="Глубина, поклёвки, условия у берега"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </div>

          <div>
            <label htmlFor="qm-photo" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Фото улова (до 5 МБ, опционально)
            </label>
            <input
              id="qm-photo"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFileChange}
              className="mt-1 block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-slate-800 hover:file:bg-slate-200 dark:text-slate-400 dark:file:bg-slate-800 dark:file:text-slate-200"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-sky-700 px-5 py-2 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-60"
            >
              <Radio className="h-4 w-4" aria-hidden="true" />
              {submitting ? 'Отправка...' : 'Отправить отметку'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
