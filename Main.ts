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

function atisUrl(icao: string): string {
  const direct = `https://datis.clowd.io/api/${encodeURIComponent(icao)}`;
  return isDev ? `/api/atis/${encodeURIComponent(icao)}` : corsProxy(direct);
}


// ── Module-level state ───────────────────────────────────────

let activeBridge: EvenAppBridge | null = null;
let appState: 'menu' | 'weather' = 'menu';
let currentTab: TabIndex = 1;
let currentStations1: string[] = [];
let currentIncludeTaf1 = false;
let currentStations2: string[] = [];
let currentIncludeTaf2 = false;
let currentIncludeTafNearby = false;
let cachedNearbyStations: string[] = [];
let glassesInitialised = false;
let cachedPages: string[][] = [[], [], []];
let currentPageIndex = 0;

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
  currentStations1 = rawS1 ? parseStations(rawS1) : [];
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

async function fetchMetars(stations: string[]): Promise<Map<string, { raw: string; fltCat?: string }>> {
  const ids = stations.join(',');
  const res = await fetch(metarUrl(ids));
  if (!res.ok) throw new Error(`METAR fetch failed: ${res.status}`);
  const data = await res.json();
  const map = new Map<string, { raw: string; fltCat?: string }>();
  if (Array.isArray(data)) {
    for (const entry of data) {
      map.set(entry.icaoId as string, {
        raw: entry.rawOb as string,
        fltCat: entry.fltCat as string | undefined
      });
    }
  }
  return map;
}

function formatTaf(taf: string): string {
  if (!taf) return taf;
  let formatted = taf.replace(/\s+/g, ' ').trim();
  formatted = formatted.replace(/ (FM\d{6})/g, '\n$1');
  formatted = formatted.replace(/ (PROB30|PROB40|TEMPO|BECMG)\b/g, '\n  $1');
  formatted = formatted.replace(/\b(RMK)\b/g, '\n$1');
  return formatted;
}

async function fetchTafs(stations: string[]): Promise<Map<string, string>> {
  const ids = stations.join(',');
  const res = await fetch(tafUrl(ids));
  if (!res.ok) throw new Error(`TAF fetch failed: ${res.status}`);
  const data = await res.json();
  const map = new Map<string, string>();
  if (Array.isArray(data)) {
    for (const entry of data) map.set(entry.icaoId as string, formatTaf(entry.rawTAF as string));
  }
  return map;
}

async function fetchAtisMap(stations: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await Promise.all(
    stations.map(async (s) => {
      try {
        const res = await fetch(atisUrl(s));
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            const rawAtis = data.map((d: any) => d.datis).join('\n\n');
            if (rawAtis.trim()) {
              map.set(s, rawAtis);
            }
          }
        }
      } catch (err) {
        console.warn(`ATIS fetch failed for ${s}:`, err);
      }
    })
  );
  return map;
}

// Returns the user's location: GPS first, then two-step IP lookup.
interface UserLocation { lat: number; lon: number; label: string; }

function getGpsPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation API not available'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 300000, // cache for 5 minutes
    });
  });
}

async function fetchUserLocation(): Promise<UserLocation> {
  // Try GPS first
  try {
    const pos = await getGpsPosition();
    const lat = Math.round(pos.coords.latitude * 100) / 100;
    const lon = Math.round(pos.coords.longitude * 100) / 100;
    return { lat, lon, label: `${lat.toFixed(2)}°, ${lon.toFixed(2)}°` };
  } catch (gpsErr) {
    console.warn('GPS unavailable, using IP geolocation:', gpsErr);
  }

  if (isDev) {
    // Dev: use the Vite proxy which preserves the real client IP
    const res = await fetch('/api/ip');
    if (!res.ok) throw new Error(`IP geolocation failed: ${res.status}`);
    const data = await res.json();
    if (data.status !== 'success') throw new Error('Could not determine location');
    return { lat: data.lat, lon: data.lon, label: `${data.city}, ${data.regionName}` };
  }

  // Production: Secure, HTTPS-native single-step geolocation via ipapi.co
  const geoRes = await fetch('https://ipapi.co/json/');
  if (!geoRes.ok) throw new Error(`IP geolocation failed: ${geoRes.status}`);
  const geo = await geoRes.json();
  return { lat: geo.latitude, lon: geo.longitude, label: `${geo.city}, ${geo.region}` };
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

export interface NearbyStation {
  id: string;
  distNm: number;
}

async function fetchNearbyStationIds(
  lat: number,
  lon: number,
  radiusNm: number,
  maxCount: number,
): Promise<NearbyStation[]> {
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
    .sort((a, b) => a.dist - b.dist)
    .slice(0, maxCount)
    .map((s) => ({ id: s.id, distNm: s.dist }));
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

interface StationWeather {
  station: string;
  distNm?: number;
  metar: string | null;
  taf: string | null;
  fltCat?: string;
  atis?: string | null;
}

function renderResults(results: StationWeather[], includeTaf: boolean, tabLabel: string): void {
  const container = document.getElementById('results')!;
  const wrapper = document.getElementById('results-wrapper')!;
  const label = document.getElementById('results-label')!;
  container.innerHTML = '';
  label.textContent = `${tabLabel} — Last Fetched`;

  for (const r of results) {
    const card = document.createElement('div');
    const cat = (r.fltCat || 'NA').toUpperCase();
    card.className = `station-card station-card--${cat.toLowerCase()}`;

    const header = document.createElement('div');
    header.className = 'station-header';

    const title = document.createElement('div');
    title.className = 'station-title';
    title.textContent = r.station;

    if (r.distNm !== undefined) {
      const distSpan = document.createElement('span');
      distSpan.className = 'station-dist';
      distSpan.textContent = ` (${r.distNm.toFixed(1)} NM)`;
      title.appendChild(distSpan);
    }

    const badge = document.createElement('span');
    badge.className = 'flt-badge';
    badge.textContent = cat;

    header.appendChild(title);
    header.appendChild(badge);
    card.appendChild(header);

    const metarSection = document.createElement('div');
    metarSection.className = 'wx-section';

    const metarLabel = document.createElement('div');
    metarLabel.className = 'wx-label';
    metarLabel.textContent = 'METAR';
    metarSection.appendChild(metarLabel);

    const metarPre = document.createElement('pre');
    metarPre.textContent = r.metar ?? 'No METAR available';
    metarSection.appendChild(metarPre);

    card.appendChild(metarSection);

    if (includeTaf) {
      const tafSection = document.createElement('div');
      tafSection.className = 'wx-section';

      const tafLabel = document.createElement('div');
      tafLabel.className = 'wx-label';
      tafLabel.textContent = 'TAF';
      tafSection.appendChild(tafLabel);

      const tafPre = document.createElement('pre');
      tafPre.textContent = r.taf ?? 'No TAF available';
      tafSection.appendChild(tafPre);

      card.appendChild(tafSection);
    }

    if (r.atis) {
      const atisSection = document.createElement('div');
      atisSection.className = 'wx-section';

      const atisLabel = document.createElement('div');
      atisLabel.className = 'wx-label';
      atisLabel.textContent = 'ATIS';
      atisSection.appendChild(atisLabel);

      const atisPre = document.createElement('pre');
      atisPre.textContent = r.atis;
      atisSection.appendChild(atisPre);

      card.appendChild(atisSection);
    }

    container.appendChild(card);
  }

  wrapper.classList.remove('hidden');
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

function wrapText(text: string, maxCharsPerLine = 46): string {
  const paragraphs = text.split('\n');
  const allLines: string[] = [];

  for (const para of paragraphs) {
    if (para.trim() === '') {
      allLines.push('');
      continue;
    }
    
    // Capture leading indentation spaces (e.g. TAF segment indents)
    const leadingSpacesMatch = para.match(/^( +)/);
    const indent = leadingSpacesMatch ? leadingSpacesMatch[1] : '';
    
    const words = para.trim().split(/\s+/);
    let currentLine = '';
    
    for (const word of words) {
      if (currentLine === '') {
        currentLine = indent + word;
      } else if (currentLine.length + 1 + word.length <= maxCharsPerLine) {
        currentLine += ' ' + word;
      } else {
        allLines.push(currentLine);
        currentLine = indent + word;
      }
    }
    if (currentLine) {
      allLines.push(currentLine);
    }
  }
  return allLines.join('\n');
}

function chunkText(text: string, limit: number, header: string): string[] {
  const chunks: string[] = [];
  let index = 0;

  while (index < text.length) {
    const isContinuation = chunks.length > 0;
    const currentHeader = isContinuation ? `${header} (cont.)` : header;
    const pageCapacity = limit - currentHeader.length - 2;

    if (pageCapacity <= 10) {
      break;
    }

    let chunkBody = text.slice(index, index + pageCapacity);

    if (index + pageCapacity < text.length) {
      // Split at a clean space or newline boundary in the last 100 characters
      let splitIdx = -1;
      const lookbackLimit = Math.min(100, chunkBody.length);
      for (let i = chunkBody.length - 1; i >= chunkBody.length - lookbackLimit; i--) {
        const char = chunkBody[i];
        if (char === ' ' || char === '\n' || char === '\r') {
          splitIdx = i;
          break;
        }
      }

      if (splitIdx > 0) {
        chunkBody = chunkBody.slice(0, splitIdx);
        index += splitIdx + 1;
      } else {
        index += chunkBody.length;
      }
    } else {
      index += chunkBody.length;
    }

    const h = isContinuation ? `${header} (cont.)` : header;
    chunks.push(`${h}\n\n${chunkBody.trim()}`);
  }

  return chunks;
}

function generateStationPages(r: StationWeather, includeTaf: boolean, isNearby: boolean): string[] {
  const RAW_CONTENT_LIMIT = 650; // Max characters of raw body text before dynamic page-split is triggered
  const fltCatStr = r.fltCat ? ` [${r.fltCat}]` : '';
  const distStr = (isNearby && r.distNm !== undefined) ? ` (${r.distNm.toFixed(1)} NM)` : '';
  const baseHeader = `${r.station}${fltCatStr}${distStr}`;

  const sections: string[] = [];
  if (r.metar) sections.push(r.metar);
  if (includeTaf && r.taf) sections.push(r.taf);
  if (r.atis) sections.push(r.atis);

  if (sections.length === 0) {
    return [baseHeader];
  }

  // 1. Try to fit everything on one page
  const singlePageBody = sections.join('\n\n');
  const singlePageFull = `${baseHeader}\n\n${singlePageBody}`;
  if (singlePageFull.length <= RAW_CONTENT_LIMIT) {
    return [singlePageFull];
  }

  // 2. If it exceeds limit, split into METAR/TAF (Page 1) and ATIS (Page 2)
  const pages: string[] = [];

  const p1Sections: string[] = [];
  if (r.metar) p1Sections.push(r.metar);
  if (includeTaf && r.taf) p1Sections.push(r.taf);

  if (p1Sections.length > 0) {
    const p1Body = p1Sections.join('\n\n');
    const p1Full = `${baseHeader}\n\n${p1Body}`;
    if (p1Full.length <= RAW_CONTENT_LIMIT) {
      pages.push(p1Full);
    } else {
      // Split METAR and TAF onto separate pages if combined they are too long
      if (r.metar) {
        pages.push(`${baseHeader}\n\n${r.metar}`);
      }
      if (includeTaf && r.taf) {
        const tafHeader = `${r.station}${fltCatStr}${distStr} TAF`;
        const tafPages = chunkText(r.taf, RAW_CONTENT_LIMIT, tafHeader);
        pages.push(...tafPages);
      }
    }
  }

  if (r.atis) {
    const atisHeader = `${r.station}${fltCatStr}${distStr} D-ATIS`;
    const atisFull = `${atisHeader}\n\n${r.atis}`;
    if (atisFull.length <= RAW_CONTENT_LIMIT) {
      pages.push(atisFull);
    } else {
      const atisPages = chunkText(r.atis, RAW_CONTENT_LIMIT, atisHeader);
      pages.push(...atisPages);
    }
  }

  return pages;
}

function buildGlassesPages(tab: TabIndex, stationContents: string[]): string[] {
  const name = TAB_NAMES[tab].toUpperCase();
  const sepLine = `  ${'─'.repeat(26)}`;

  // Format current local time as HH:MM
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  if (stationContents.length === 0) {
    const headerLine = `  ${name} · Fetched at ${timeStr}`;
    return [
      `${headerLine}\n${sepLine}\n\n  No data available.`
    ];
  }

  return stationContents.map((rawContent, idx) => {
    // Format: NEARBY · Fetched at HH:MM · Page X/X
    let headerLine = `  ${name} · Fetched at ${timeStr}`;
    if (stationContents.length > 0) {
      headerLine += ` · Page ${idx + 1}/${stationContents.length}`;
    }

    // Word wrap the entire content to 46 characters
    const wrappedContent = wrapText(rawContent, 46);

    // Indent each line by two spaces (excluding blank lines)
    const contentLines = wrappedContent
      .split('\n')
      .map((line) => (line.trim() === '' ? '' : `  ${line}`))
      .join('\n');

    const lines: string[] = [];
    lines.push(headerLine);
    lines.push(sepLine);
    lines.push(``);
    lines.push(contentLines);

    const fullText = lines.join('\n');
    if (fullText.length > 950) {
      return fullText.slice(0, 920) + '\n  ... [TRUNCATED]';
    }
    return fullText;
  });
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
    borderRadius: 0,
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
    borderRadius: 0,
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
      setNearbyState('loading', `Finding stations near ${loc.label}...`);
      setStatus(`Finding stations near ${loc.label}...`);

      const nearbyStations = await fetchNearbyStationIds(loc.lat, loc.lon, NEARBY_RADIUS_NM, NEARBY_MAX_STATIONS);
      const stations = nearbyStations.map(s => s.id);
      cachedNearbyStations = stations;

      if (stations.length === 0) {
        setNearbyState('error', `No METAR stations found within ${NEARBY_RADIUS_NM} nm of ${loc.label}.`);
        setStatus('No nearby stations found');
        cachedPages[0] = buildGlassesPages(0, [`No METAR stations within\n${NEARBY_RADIUS_NM} nm of ${loc.label}.`]);
        currentPageIndex = 0;
        if (glassesInitialised && appState === 'weather' && currentTab === 0)
          await updateGlassesText(cachedPages[0][0]);
        return;
      }

      setNearbyState('loading', `Fetching weather for ${stations.join(', ')}...`);
      setStatus(`Fetching weather for ${stations.join(', ')}...`);

      const [metarMap, tafMap, atisMap] = await Promise.all([
        fetchMetars(stations),
        currentIncludeTafNearby ? fetchTafs(stations) : Promise.resolve(new Map<string, string>()),
        fetchAtisMap(stations),
      ]);

      const results: StationWeather[] = nearbyStations.map((s) => {
        const metarData = metarMap.get(s.id);
        return {
          station: s.id,
          distNm: s.distNm,
          metar: metarData ? metarData.raw : null,
          taf: tafMap.get(s.id) ?? null,
          fltCat: metarData ? metarData.fltCat : undefined,
          atis: atisMap.get(s.id) ?? null,
        };
      });

      renderResults(results, currentIncludeTafNearby, `Nearby (${loc.label})`);
      setNearbyState('ready');
      setStatus(`Nearby stations for ${loc.label}`);

      const glassesContentArray: string[] = [];
      results.forEach((r) => {
        const pages = generateStationPages(r, currentIncludeTafNearby, true);
        glassesContentArray.push(...pages);
      });

      cachedPages[0] = buildGlassesPages(0, glassesContentArray.length > 0 ? glassesContentArray : [`Nearby ${loc.label}:\nNo data.`]);
      currentPageIndex = 0;
      if (glassesInitialised && appState === 'weather' && currentTab === 0)
        await updateGlassesText(cachedPages[0][0]);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNearbyState('error', `Could not load nearby stations: ${msg}`);
      setStatus(`Error: ${msg}`);
      cachedPages[0] = buildGlassesPages(0, [`Nearby error:\n${msg}`]);
      currentPageIndex = 0;
      if (glassesInitialised && appState === 'weather' && currentTab === 0)
        await updateGlassesText(cachedPages[0][0]);
    }
    return;
  }

  const stations = tab === 1 ? currentStations1 : currentStations2;
  const includeTaf = tab === 1 ? currentIncludeTaf1 : currentIncludeTaf2;

  if (stations.length === 0) {
    const noStationsMsg = 'No stations selected.';
    setStatus(`No stations configured for ${TAB_NAMES[tab]}`);
    
    // Update glasses
    cachedPages[tab] = buildGlassesPages(tab, [noStationsMsg]);
    currentPageIndex = 0;
    if (glassesInitialised && appState === 'weather' && currentTab === tab) {
      await updateGlassesText(cachedPages[tab][0]);
    }
    
    // Update web UI
    const container = document.getElementById('results')!;
    const wrapper = document.getElementById('results-wrapper')!;
    const label = document.getElementById('results-label')!;
    container.innerHTML = `<div class="nearby-loading">${noStationsMsg}</div>`;
    label.textContent = `${TAB_NAMES[tab]}`;
    wrapper.classList.remove('hidden');
    return;
  }

  setStatus(`Fetching weather for ${stations.join(', ')}...`);

  const [metarMap, tafMap, atisMap] = await Promise.all([
    fetchMetars(stations),
    includeTaf ? fetchTafs(stations) : Promise.resolve(new Map<string, string>()),
    fetchAtisMap(stations),
  ]);

  const results: StationWeather[] = stations.map((s) => {
    const metarData = metarMap.get(s);
    return {
      station: s,
      metar: metarData ? metarData.raw : null,
      taf: tafMap.get(s) ?? null,
      fltCat: metarData ? metarData.fltCat : undefined,
      atis: atisMap.get(s) ?? null,
    };
  });

  renderResults(results, includeTaf, TAB_NAMES[tab]);

  const glassesContentArray: string[] = [];
  results.forEach((r) => {
    const pages = generateStationPages(r, includeTaf, false);
    glassesContentArray.push(...pages);
  });

  if (glassesContentArray.length > 0) {
    cachedPages[tab] = buildGlassesPages(tab, glassesContentArray);
    currentPageIndex = 0;
    if (glassesInitialised && appState === 'weather' && currentTab === tab) {
      await updateGlassesText(cachedPages[tab][0]);
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
    const placeholder = cachedPages[0].length > 0
      ? cachedPages[0][currentPageIndex] // we keep current page if they re-select? Wait, reset.
      : buildGlassesPages(0, ['Fetching nearby\nstations...'])[0];

    currentPageIndex = 0;
    const initialPage = cachedPages[0].length > 0 ? cachedPages[0][0] : placeholder;
    await pushWeatherPage(initialPage);
    await fetchAndDisplay(0);
    return;
  }

  currentPageIndex = 0;
  // Show cached content (or a loading placeholder) immediately for instant response.
  const placeholder = cachedPages[tab].length > 0
    ? cachedPages[tab][0]
    : buildGlassesPages(tab, ['Fetching...'])[0];
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
    setStatus('Loading settings...');

    await loadSettings();

    // Pre-fill UI inputs
    (document.getElementById('station-1') as HTMLInputElement).value = currentStations1.join(', ');
    (document.getElementById('include-taf-1') as HTMLInputElement).checked = currentIncludeTaf1;
    (document.getElementById('station-2') as HTMLInputElement).value = currentStations2.join(', ');
    (document.getElementById('include-taf-2') as HTMLInputElement).checked = currentIncludeTaf2;

    // Show the menu on the glasses — user navigates from there.
    await initGlassesContainers();
    setStatus('Select a tab on your glasses to view weather');

    activeBridge.onEvenHubEvent((event) => {
      console.log('[EvenHubEvent]', event);

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

      // Single tap on the weather screen (sysEvent with no eventType = click) → refresh or next page.
      if (event.sysEvent && rawEventType === undefined && appState === 'weather') {
        const pages = cachedPages[currentTab];
        if (pages.length > 1) {
          // Flip to next page
          currentPageIndex = (currentPageIndex + 1) % pages.length;
          updateGlassesText(pages[currentPageIndex]).catch((err) => {
            setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
          });
        } else {
          // Only one page, just refresh the data
          fetchAndDisplay(currentTab).catch((err) => {
            setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        return;
      }
    });

  } catch {
    setStatus('Use the browser to view weather');
    (document.getElementById('station-1') as HTMLInputElement).value = currentStations1.join(', ');
  }
}

main();
