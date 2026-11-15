# Клёвый прогноз (FishCast AI)

Мобильное и веб-приложение рыбака (PWA + Capacitor Android): база водоёмов, виджет хорошего клёва в радиусе 100 км, прогноз клёва (`F-Индекс`), батиметрия, справочник «рыба ↔ приманка ↔ условия», дневник уловов и навигация до берега.

## Быстрый старт (веб + сервер)

```bash
npm install
npm run dev
```

Проверка тестов, типов и сборки:

```bash
npm run test
npm run lint
npm run build
```

## Сборка Android APK через GitHub Actions

В репозитории настроен workflow `.github/workflows/android-apk-release.yml`:
1. Запускается автоматически при `push` в ветку `main`/`master`, при создании тега `v*` или вручную во вкладке **Actions → Build & Release Android APK → Run workflow**.
2. Прогоняет unit-тесты и `tsc --noEmit`, собирает `dist/`, синхронизирует `npx cap sync android` и компилирует APK через Gradle.
3. Публикует готовый `FishCast-debug-installable.apk` (сразу устанавливается на Android) в **GitHub Releases** и в Artifacts.
   - Дополнительно: при наличии секретов `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` workflow также подписывает `FishCast-release-signed.apk`.
   - При наличии переменной репозитория `VITE_API_BASE_URL` приложение в APK подключается к вашему удалённому серверу; без неё APK работает автономно на встроенной базе водоёмов и прямых метеоданных Open-Meteo.
