import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  DeviceConnectType,
  OsEventTypeList,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';

// ── Constants ────────────────────────────────────────────────

const TAB_NAMES = ['Nearby', 'Stations 1', 'Stations 2'] as const;
type TabIndex = 0 | 1 | 2;

const STORAGE_KEY_STATIONS_1 = 'wx_stations_1';
const STORAGE_KEY_TAF_1 = 'wx_taf_1';
const STORAGE_KEY_STATIONS_2 = 'wx_stations_2';
const STORAGE_KEY_TAF_2 = 'wx_taf_2';
const STORAGE_KEY_TAF_NEARBY = 'wx_taf_nearby';

const NEARBY_RADIUS_NM = 75;
const NEARBY_MAX_STATIONS = 5;

// ── API URL helpers (proxy in dev, CORS proxy in prod) ───────

const isDev = import.meta.env.DEV;

/** In production, route through a CORS proxy since aviationweather.gov blocks cross-origin requests. */
function corsProxy(url: string): string {
  return `https://corsproxy.io/?${encodeURIComponent(url)}`;
}

function metarUrl(ids: string): string {
  const direct = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(ids)}&format=json`;
  return isDev ? `/api/metar?ids=${encodeURIComponent(ids)}&format=json` : corsProxy(direct);
}

function tafUrl(ids: string): string {
  const direct = `https://aviationweather.gov/api/data/taf?ids=${encodeURIComponent(ids)}&format=json`;
  return isDev ? `/api/taf?ids=${encodeURIComponent(ids)}&format=json` : corsProxy(direct);
}

function stationsUrl(bbox: string): string {
  const direct = `https://aviationweather.gov/api/data/stationInfo?bbox=${encodeURIComponent(bbox)}&format=json`;
  return isDev ? `/api/stations?bbox=${encodeURIComponent(bbox)}&format=json` : corsProxy(direct);
}

function ipUrl(): string {
  return isDev
    ? '/api/ip'
    : corsProxy('http://ip-api.com/json');
}

// ── Module-level state ───────────────────────────────────────

let activeBridge: EvenAppBridge | null = null;
let appState: 'menu' | 'weather' = 'menu';
let currentTab: TabIndex = 1;
let currentStations1: string[] = ['CYPQ'];
let currentIncludeTaf1 = false;
let currentStations2: string[] = [];
let currentIncludeTaf2 = false;
let currentIncludeTafNearby = false;
let cachedNearbyStations: string[] = [];
let glassesInitialised = false;
let cachedContent: [string, string, string] = ['', '', ''];

// ── Settings persistence ─────────────────────────────────────

async function loadSettings(): Promise<void> {
  if (!activeBridge) return;
  const [rawS1, rawT1, rawS2, rawT2, rawTN] = await Promise.all([
    activeBridge.getLocalStorage(STORAGE_KEY_STATIONS_1),
    activeBridge.getLocalStorage(STORAGE_KEY_TAF_1),
    activeBridge.getLocalStorage(STORAGE_KEY_STATIONS_2),
    activeBridge.getLocalStorage(STORAGE_KEY_TAF_2),
    activeBridge.getLocalStorage(STORAGE_KEY_TAF_NEARBY),
  ]);
  currentStations1 = rawS1 ? parseStations(rawS1) : ['CYPQ'];
  currentIncludeTaf1 = rawT1 === 'true';
  currentStations2 = rawS2 ? parseStations(rawS2) : [];
  currentIncludeTaf2 = rawT2 === 'true';
  currentIncludeTafNearby = rawTN === 'true';
}

async function saveTabSettings(tab: 1 | 2, stations: string[], includeTaf: boolean): Promise<void> {
  if (!activeBridge) return;
  const stationsKey = tab === 1 ? STORAGE_KEY_STATIONS_1 : STORAGE_KEY_STATIONS_2;
  const tafKey = tab === 1 ? STORAGE_KEY_TAF_1 : STORAGE_KEY_TAF_2;
  await activeBridge.setLocalStorage(stationsKey, stations.join(','));
  await activeBridge.setLocalStorage(tafKey, String(includeTaf));
}

// ── Station parsing ──────────────────────────────────────────

function parseStations(input: string): string[] {
  return input
    .toUpperCase()
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3 && s.length <= 4);
}

// ── API helpers ──────────────────────────────────────────────

async function fetchMetars(stations: string[]): Promise<Map<string, string>> {
  const ids = stations.join(',');
  const res = await fetch(metarUrl(ids));
  if (!res.ok) throw new Error(`METAR fetch failed: ${res.status}`);
  const data = await res.json();
  const map = new Map<string, string>();
  if (Array.isArray(data)) {
    for (const entry of data) map.set(entry.icaoId as string, entry.rawOb as string);
  }
  return map;
}

async function fetchTafs(stations: string[]): Promise<Map<string, string>> {
  const ids = stations.join(',');
  const res = await fetch(tafUrl(ids));
  if (!res.ok) throw new Error(`TAF fetch failed: ${res.status}`);
  const data = await res.json();
  const map = new Map<string, string>();
  if (Array.isArray(data)) {
    for (const entry of data) map.set(entry.icaoId as string, entry.rawTAF as string);
  }
  return map;
}

// Returns the user's approximate lat/lon from IP geolocation.
interface IpLocation { lat: number; lon: number; city: string; regionName: string; status: string; }

async function fetchUserLocation(): Promise<IpLocation> {
  const res = await fetch(ipUrl());
  if (!res.ok) throw new Error(`IP geolocation failed: ${res.status}`);
  const data = await res.json() as IpLocation;
  if (data.status !== 'success') throw new Error('IP geolocation returned failure status');
  return data;
}

// Converts nautical miles to degrees of latitude (approx).
function nmToDeg(nm: number): number { return nm / 60; }

// Haversine great-circle distance in nm.
function distNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440.065; // Earth radius in nm
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180)
    * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface StationInfo {
  icaoId: string | null;
  lat: number;
  lon: number;
  siteType: string[];
  priority: number;
}

async function fetchNearbyStationIds(
  lat: number,
  lon: number,
  radiusNm: number,
  maxCount: number,
): Promise<string[]> {
  const deg = nmToDeg(radiusNm);
  const minLat = lat - deg;
  const maxLat = lat + deg;
  // Longitude degree correction for latitude
  const lonDeg = deg / Math.max(Math.cos(lat * Math.PI / 180), 0.01);
  const minLon = lon - lonDeg;
  const maxLon = lon + lonDeg;
  const bbox = `${minLat.toFixed(4)},${minLon.toFixed(4)},${maxLat.toFixed(4)},${maxLon.toFixed(4)}`;

  const res = await fetch(stationsUrl(bbox));
  if (!res.ok) throw new Error(`Station lookup failed: ${res.status}`);
  const data = await res.json() as StationInfo[];

  return data
    .filter((s) => s.icaoId && s.siteType.includes('METAR'))
    .map((s) => ({ id: s.icaoId as string, dist: distNm(lat, lon, s.lat, s.lon), priority: s.priority }))
    .sort((a, b) => a.priority - b.priority || a.dist - b.dist)
    .slice(0, maxCount)
    .map((s) => s.id);
}

// ── DOM helpers ──────────────────────────────────────────────

/** Shows/hides the Nearby panel's loading, error, and controls areas. */
function setNearbyState(state: 'loading' | 'error' | 'ready', message = ''): void {
  const loadingEl = document.getElementById('nearby-loading')!;
  const loadingTxt = document.getElementById('nearby-loading-text')!;
  const errorEl = document.getElementById('nearby-error')!;
  const controlsEl = document.getElementById('nearby-controls')!;

  loadingEl.classList.toggle('hidden', state !== 'loading');
  errorEl.classList.toggle('hidden', state !== 'error');
  controlsEl.classList.toggle('hidden', state === 'loading');

  if (state === 'loading') loadingTxt.textContent = message || 'Locating you...';
  if (state === 'error') errorEl.textContent = message;
}

interface StationWeather { station: string; metar: string | null; taf: string | null; }

function renderResults(results: StationWeather[], includeTaf: boolean, tabLabel: string): void {
  const container = document.getElementById('results')!;
  const wrapper = document.getElementById('results-wrapper')!;
  const label = document.getElementById('results-label')!;
  container.innerHTML = '';
  label.textContent = `${tabLabel} — Last Fetched`;

  for (const r of results) {
    const block = document.createElement('div');
    block.className = 'station-block';

    const heading = document.createElement('div');
    heading.className = 'station-id';
    heading.textContent = r.station;
    block.appendChild(heading);

    const metarLabel = document.createElement('div');
    metarLabel.className = 'wx-label';
    metarLabel.textContent = 'METAR';
    block.appendChild(metarLabel);

    const metarPre = document.createElement('pre');
    metarPre.textContent = r.metar ?? 'No METAR available';
    block.appendChild(metarPre);

    if (includeTaf) {
      const tafLabel = document.createElement('div');
      tafLabel.className = 'wx-label';
      tafLabel.textContent = 'TAF';
      block.appendChild(tafLabel);

      const tafPre = document.createElement('pre');
      tafPre.textContent = r.taf ?? 'No TAF available';
      block.appendChild(tafPre);
    }

    container.appendChild(block);
  }

  wrapper.classList.remove('hidden');
}

function setGlassesStatus(connected: boolean): void {
  const el = document.getElementById('glasses-status')!;
  el.textContent = connected ? 'Connected' : 'Not connected';
  el.className = `glasses-status glasses-status--${connected ? 'connected' : 'disconnected'}`;
}

function setStatus(text: string): void {
  document.getElementById('status')!.textContent = text;
}

function setActiveBrowserTab(tab: TabIndex): void {
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.classList.toggle('tab-btn--active', i === tab);
  });
  document.querySelectorAll('.tab-panel').forEach((panel, i) => {
    panel.classList.toggle('hidden', i !== tab);
  });
}

// ── Glasses display helpers ──────────────────────────────────

function buildGlassesPage(tab: TabIndex, content: string): string {
  const name = TAB_NAMES[tab];
  const divider = '-'.repeat(40);
  return `${name}\n${divider}\n${content}`;
}

// ── Glasses container helpers ────────────────────────────────

function makeMenuListContainer() {
  return {
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 0,
    borderRdaius: 0,
    paddingLength: 8,
    containerID: 1,
    containerName: 'menu-list',
    itemContainer: {
      itemCount: TAB_NAMES.length,
      itemWidth: 0,
      isItemSelectBorderEn: 1,
      itemName: [...TAB_NAMES],
    },
    isEventCapture: 1,
  } as ListContainerProperty;
}

function makeWeatherTextContainer(content: string) {
  return {
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 0,
    borderRdaius: 0,
    paddingLength: 8,
    containerID: 1,
    containerName: 'wx-text',
    content: content || ' ',
    isEventCapture: 1,
  } as TextContainerProperty;
}

// Creates the base page (menu) — called exactly once.
async function initGlassesContainers(): Promise<void> {
  if (!activeBridge) return;
  const container = {
    containerTotalNum: 1,
    listObject: [makeMenuListContainer()],
  } as CreateStartUpPageContainer;
  const result = await activeBridge.createStartUpPageContainer(container);
  if (result === 0) {
    glassesInitialised = true;
    appState = 'menu';
  } else {
    throw new Error(`createStartUpPageContainer failed (code ${result})`);
  }
}

// Pushes a weather page on top of the menu in the OS navigation stack.
async function pushWeatherPage(content: string): Promise<void> {
  if (!activeBridge) return;
  const container = {
    containerTotalNum: 1,
    textObject: [makeWeatherTextContainer(content)],
  } as RebuildPageContainer;
  const success = await activeBridge.rebuildPageContainer(container);
  if (!success) console.warn('rebuildPageContainer returned false; display may still have updated');
  appState = 'weather';
}

// Updates the text on the current weather page without pushing a new one.
async function updateGlassesText(content: string): Promise<void> {
  if (!activeBridge) return;
  const upgrade = {
    containerID: 1,
    containerName: 'wx-text',
    contentOffset: 0,
    contentLength: content.length,
    content,
  } as TextContainerUpgrade;
  const success = await activeBridge.textContainerUpgrade(upgrade);
  if (!success) console.warn('textContainerUpgrade returned falsy; display may still have updated');
}

// ── Core fetch-and-display ───────────────────────────────────

// Fetches weather and updates the browser results panel.
// Also updates the glasses if they are already showing a weather page for this tab.
async function fetchAndDisplay(tab: TabIndex): Promise<void> {
  if (tab === 0) {
    setNearbyState('loading', 'Locating you...');
    setStatus('Finding your location...');
    try {
      const loc = await fetchUserLocation();
      setNearbyState('loading', `Finding stations near ${loc.city}, ${loc.regionName}...`);
      setStatus(`Finding stations near ${loc.city}, ${loc.regionName}...`);

      const stations = await fetchNearbyStationIds(loc.lat, loc.lon, NEARBY_RADIUS_NM, NEARBY_MAX_STATIONS);
      cachedNearbyStations = stations;

      if (stations.length === 0) {
        setNearbyState('error', `No METAR stations found within ${NEARBY_RADIUS_NM} nm of ${loc.city}.`);
        setStatus('No nearby stations found');
        cachedContent[0] = `No METAR stations within\n${NEARBY_RADIUS_NM} nm of ${loc.city}.`;
        if (glassesInitialised && appState === 'weather' && currentTab === 0)
          await updateGlassesText(buildGlassesPage(0, cachedContent[0]));
        return;
      }

      setNearbyState('loading', `Fetching weather for ${stations.join(', ')}...`);
      setStatus(`Fetching weather for ${stations.join(', ')}...`);

      const [metarMap, tafMap] = await Promise.all([
        fetchMetars(stations),
        currentIncludeTafNearby ? fetchTafs(stations) : Promise.resolve(new Map<string, string>()),
      ]);

      const results: StationWeather[] = stations.map((s) => ({
        station: s,
        metar: metarMap.get(s) ?? null,
        taf: tafMap.get(s) ?? null,
      }));

      renderResults(results, currentIncludeTafNearby, `Nearby (${loc.city})`);
      setNearbyState('ready');
      setStatus(`Nearby stations for ${loc.city}, ${loc.regionName}`);

      const glassesContent = results
        .flatMap((r) => {
          const parts: string[] = [];
          if (r.metar) parts.push(r.metar);
          if (currentIncludeTafNearby && r.taf) parts.push(r.taf);
          return parts;
        })
        .join('\n\n');

      cachedContent[0] = glassesContent || `Nearby ${loc.city}:\nNo data.`;
      if (glassesInitialised && appState === 'weather' && currentTab === 0)
        await updateGlassesText(buildGlassesPage(0, cachedContent[0]));

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNearbyState('error', `Could not load nearby stations: ${msg}`);
      setStatus(`Error: ${msg}`);
      cachedContent[0] = `Nearby error:\n${msg}`;
      if (glassesInitialised && appState === 'weather' && currentTab === 0)
        await updateGlassesText(buildGlassesPage(0, cachedContent[0]));
    }
    return;
  }

  const stations = tab === 1 ? currentStations1 : currentStations2;
  const includeTaf = tab === 1 ? currentIncludeTaf1 : currentIncludeTaf2;

  if (stations.length === 0) {
    setStatus(`No stations configured for ${TAB_NAMES[tab]}`);
    return;
  }

  setStatus(`Fetching weather for ${stations.join(', ')}...`);

  const [metarMap, tafMap] = await Promise.all([
    fetchMetars(stations),
    includeTaf ? fetchTafs(stations) : Promise.resolve(new Map<string, string>()),
  ]);

  const results: StationWeather[] = stations.map((s) => ({
    station: s,
    metar: metarMap.get(s) ?? null,
    taf: tafMap.get(s) ?? null,
  }));

  renderResults(results, includeTaf, TAB_NAMES[tab]);

  const glassesContent = results
    .flatMap((r) => {
      const parts: string[] = [];
      if (r.metar) parts.push(r.metar);
      if (includeTaf && r.taf) parts.push(r.taf);
      return parts;
    })
    .join('\n\n');

  if (glassesContent) {
    cachedContent[tab] = glassesContent;
    if (glassesInitialised && appState === 'weather' && currentTab === tab) {
      await updateGlassesText(buildGlassesPage(tab, glassesContent));
      setStatus('Displayed on glasses');
    } else {
      setStatus('Weather fetched');
    }
  } else {
    setStatus(`No weather data found for ${stations.join(', ')}`);
  }
}

// ── Glasses tab selection (triggered from the glasses menu) ──

async function selectTabFromGlassesMenu(tab: TabIndex): Promise<void> {
  currentTab = tab;
  setActiveBrowserTab(tab);

  if (tab === 0) {
    // Show cached content immediately if available, then fetch fresh.
    const placeholder = cachedContent[0]
      ? buildGlassesPage(0, cachedContent[0])
      : buildGlassesPage(0, 'Fetching nearby\nstations...');
    await pushWeatherPage(placeholder);
    await fetchAndDisplay(0);
    return;
  }

  // Show cached content (or a loading placeholder) immediately for instant response.
  const placeholder = cachedContent[tab]
    ? buildGlassesPage(tab, cachedContent[tab])
    : buildGlassesPage(tab, 'Fetching...');
  await pushWeatherPage(placeholder);

  // Fetch fresh data and update the glasses in place.
  await fetchAndDisplay(tab);
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  // Browser tab bar — switches settings panel and fetches for browser results only.
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      const tab = i as TabIndex;
      setActiveBrowserTab(tab);
      fetchAndDisplay(tab).catch(console.error);
    });
  });

  // Save buttons for tabs 1 & 2
  function wireSaveBtn(tab: 1 | 2) {
    const btn = document.getElementById(`save-btn-${tab}`) as HTMLButtonElement;
    const input = document.getElementById(`station-${tab}`) as HTMLInputElement;
    const checkbox = document.getElementById(`include-taf-${tab}`) as HTMLInputElement;

    btn.addEventListener('click', async () => {
      const stations = parseStations(input.value);
      if (stations.length === 0) {
        setStatus('Enter at least one valid ICAO station code (3–4 characters)');
        return;
      }

      const includeTaf = checkbox.checked;
      btn.disabled = true;
      setStatus('Saving...');

      try {
        await saveTabSettings(tab, stations, includeTaf);
        if (tab === 1) { currentStations1 = stations; currentIncludeTaf1 = includeTaf; }
        else { currentStations2 = stations; currentIncludeTaf2 = includeTaf; }

        setActiveBrowserTab(tab);
        setStatus('Settings saved. Fetching weather...');
        await fetchAndDisplay(tab);
      } catch (err) {
        setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        btn.disabled = false;
      }
    });
  }

  wireSaveBtn(1);
  wireSaveBtn(2);

  // Nearby — Include TAF toggle
  const nearbyTafCheckbox = document.getElementById('include-taf-nearby') as HTMLInputElement;
  nearbyTafCheckbox.checked = currentIncludeTafNearby;
  nearbyTafCheckbox.addEventListener('change', async () => {
    currentIncludeTafNearby = nearbyTafCheckbox.checked;
    if (activeBridge)
      await activeBridge.setLocalStorage(STORAGE_KEY_TAF_NEARBY, String(currentIncludeTafNearby));
    if (currentTab === 0) await fetchAndDisplay(0);
  });

  // Nearby — Refresh button
  document.getElementById('refresh-nearby')?.addEventListener('click', () => {
    fetchAndDisplay(0).catch(console.error);
  });

  // Debug test button — simulates selecting a tab from the glasses menu.
  document.getElementById('test-next-tab')?.addEventListener('click', () => {
    const nextTab = ((currentTab + 1) % TAB_NAMES.length) as TabIndex;
    selectTabFromGlassesMenu(nextTab).catch(console.error);
  });

  // Initialise bridge (with timeout so the app doesn't hang if glasses aren't available)
  try {
    activeBridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Bridge timeout')), 5000)
      ),
    ]);
    setGlassesStatus(true);
    setStatus('Glasses connected. Loading settings...');

    await loadSettings();

    // Pre-fill UI inputs
    (document.getElementById('station-1') as HTMLInputElement).value = currentStations1.join(', ');
    (document.getElementById('include-taf-1') as HTMLInputElement).checked = currentIncludeTaf1;
    (document.getElementById('station-2') as HTMLInputElement).value = currentStations2.join(', ');
    (document.getElementById('include-taf-2') as HTMLInputElement).checked = currentIncludeTaf2;

    // Show the menu on the glasses — user navigates from there.
    await initGlassesContainers();
    setStatus('Select a tab on your glasses to view weather');

    activeBridge.onDeviceStatusChanged((status) => {
      setGlassesStatus(status.connectType === DeviceConnectType.Connected);
    });

    activeBridge.onEvenHubEvent((event) => {
      const raw = JSON.stringify(event);
      console.log('[EvenHubEvent]', raw);

      const debugEl = document.getElementById('event-debug-pre');
      if (debugEl) debugEl.textContent = raw;
      document.getElementById('event-debug')?.classList.remove('hidden');

      // Raw eventType from jsonData — preserves 0 correctly (parsed SDK may drop it).
      const rawEventType = event.jsonData?.eventType ?? event.jsonData?.Event_Type;

      // Double-click (eventType=3): go back to menu, or let OS exit if already on menu.
      // rebuildPageContainer replaces pages (no OS stack), so we rebuild the menu ourselves.
      if (rawEventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        if (appState === 'weather' && activeBridge && glassesInitialised) {
          appState = 'menu';
          activeBridge.rebuildPageContainer({
            containerTotalNum: 1,
            listObject: [makeMenuListContainer()],
          } as RebuildPageContainer).catch(console.error);
        }
        // appState === 'menu': do nothing — OS exits the app naturally.
        return;
      }

      // List item selected from the menu screen (listEvent with no eventType = click).
      if (event.listEvent && rawEventType === undefined && appState === 'menu') {
        const idx = (event.listEvent.currentSelectItemIndex ?? 0) as TabIndex;
        selectTabFromGlassesMenu(idx).catch((err) => {
          setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }

      // Single tap on the weather screen (sysEvent with no eventType = click) → refresh.
      if (event.sysEvent && rawEventType === undefined && appState === 'weather') {
        fetchAndDisplay(currentTab).catch((err) => {
          setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }
    });

  } catch {
    setGlassesStatus(false);
    setStatus('No glasses — use the browser to view weather');
    (document.getElementById('station-1') as HTMLInputElement).value = currentStations1.join(', ');
  }
}

main();
