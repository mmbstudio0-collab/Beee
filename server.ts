import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

dotenv.config();
if (fs.existsSync(path.resolve(process.cwd(), '.env.local'))) {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: false });
}

const PORT = Number(process.env.PORT || 3000);
const EARTH_RADIUS_M = 6378137;

interface AnalyzedBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
  heightMeters?: number;
  kind?: string;
}

export interface MeterRectBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  heightMeters?: number;
  kind?: string;
}

export interface SectorTacticalBrief {
  summary: string;
  threatLevel: 'Düşük' | 'Orta' | 'Yüksek' | 'Kritik';
  evacTips: string[];
}

interface SectorAnalysisResponse {
  ok: boolean;
  cached?: boolean;
  zoom: number;
  spanMeters: number;
  metersPerPixel: number;
  buildings: AnalyzedBox[];
  trees: AnalyzedBox[];
  narrowShadows: AnalyzedBox[];
  barriers: AnalyzedBox[];
  tacticalBrief?: SectorTacticalBrief;
  meterBoxes: {
    buildings: MeterRectBox[];
    trees: MeterRectBox[];
    narrowShadows: MeterRectBox[];
    barriers: MeterRectBox[];
  };
}

const analysisCache = new Map<string, SectorAnalysisResponse>();

function metersToLatLng(
  originLat: number,
  originLng: number,
  dxM: number,
  dyM: number
): { lat: number; lng: number } {
  const cosOrigin = Math.max(0.15, Math.cos((originLat * Math.PI) / 180));
  const lng = originLng + ((dxM / (EARTH_RADIUS_M * cosOrigin)) * 180) / Math.PI;
  const originRad = Math.max(-85, Math.min(85, originLat)) * (Math.PI / 180);
  const originMerc = Math.log(Math.tan(Math.PI / 4 + originRad / 2));
  const targetMerc = originMerc - dyM / (EARTH_RADIUS_M * cosOrigin);
  const latRad = 2 * Math.atan(Math.exp(targetMerc)) - Math.PI / 2;
  const lat = (latRad * 180) / Math.PI;
  return { lat, lng };
}

function computeTileZoomForSpan(lat: number, desiredSpanMeters: number): {
  zoom: number;
  metersPerPixel: number;
  spanMeters: number;
} {
  const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
  const desiredMpp = Math.max(0.25, desiredSpanMeters) / 640;
  const rawZoom = Math.log2((2 * Math.PI * EARTH_RADIUS_M * cosLat) / (256 * desiredMpp));
  const zoom = Math.max(16, Math.min(18, Math.round(rawZoom)));
  const metersPerPixel = (2 * Math.PI * EARTH_RADIUS_M * cosLat) / (256 * Math.pow(2, zoom));
  const spanMeters = 640 * metersPerPixel;
  return { zoom, metersPerPixel, spanMeters };
}

function sanitizeBoxes(raw: unknown, maxItems = 180): AnalyzedBox[] {
  if (!Array.isArray(raw)) return [];
  const out: AnalyzedBox[] = [];
  for (let i = 0; i < raw.length && out.length < maxItems; i++) {
    const item = raw[i] as Record<string, unknown>;
    if (!item || typeof item !== 'object') continue;
    const ymin = Number(item.ymin);
    const xmin = Number(item.xmin);
    const ymax = Number(item.ymax);
    const xmax = Number(item.xmax);
    if (![ymin, xmin, ymax, xmax].every(Number.isFinite)) continue;
    const ny0 = Math.max(0, Math.min(1000, Math.min(ymin, ymax)));
    const nx0 = Math.max(0, Math.min(1000, Math.min(xmin, xmax)));
    const ny1 = Math.max(0, Math.min(1000, Math.max(ymin, ymax)));
    const nx1 = Math.max(0, Math.min(1000, Math.max(xmin, xmax)));
    if (nx1 - nx0 < 4 || ny1 - ny0 < 4) continue;
    const heightRaw = Number(item.heightMeters);
    out.push({
      ymin: ny0,
      xmin: nx0,
      ymax: ny1,
      xmax: nx1,
      heightMeters: Number.isFinite(heightRaw) ? Math.max(2, Math.min(45, heightRaw)) : undefined,
      kind: typeof item.kind === 'string' ? item.kind : undefined,
    });
  }
  return out;
}

function deduplicateMeterBoxes(boxes: MeterRectBox[], overlapThreshold = 0.42): MeterRectBox[] {
  const out: MeterRectBox[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    const areaA = Math.max(0.5, (a.maxX - a.minX) * (a.maxY - a.minY));
    let merged = false;
    for (let j = 0; j < out.length; j++) {
      const b = out[j];
      const ix0 = Math.max(a.minX, b.minX);
      const iy0 = Math.max(a.minY, b.minY);
      const ix1 = Math.min(a.maxX, b.maxX);
      const iy1 = Math.min(a.maxY, b.maxY);
      if (ix1 <= ix0 || iy1 <= iy0) continue;
      const inter = (ix1 - ix0) * (iy1 - iy0);
      const areaB = Math.max(0.5, (b.maxX - b.minX) * (b.maxY - b.minY));
      if (inter / Math.min(areaA, areaB) >= overlapThreshold) {
        merged = true;
        break;
      }
    }
    if (!merged) out.push(a);
  }
  return out;
}

const SECTOR_ANALYSIS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    buildings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          ymin: { type: Type.INTEGER },
          xmin: { type: Type.INTEGER },
          ymax: { type: Type.INTEGER },
          xmax: { type: Type.INTEGER },
          heightMeters: { type: Type.NUMBER },
          kind: { type: Type.STRING },
        },
        required: ['ymin', 'xmin', 'ymax', 'xmax'],
      },
    },
    trees: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          ymin: { type: Type.INTEGER },
          xmin: { type: Type.INTEGER },
          ymax: { type: Type.INTEGER },
          xmax: { type: Type.INTEGER },
        },
        required: ['ymin', 'xmin', 'ymax', 'xmax'],
      },
    },
    narrowShadows: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          ymin: { type: Type.INTEGER },
          xmin: { type: Type.INTEGER },
          ymax: { type: Type.INTEGER },
          xmax: { type: Type.INTEGER },
        },
        required: ['ymin', 'xmin', 'ymax', 'xmax'],
      },
    },
    barriers: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          ymin: { type: Type.INTEGER },
          xmin: { type: Type.INTEGER },
          ymax: { type: Type.INTEGER },
          xmax: { type: Type.INTEGER },
        },
        required: ['ymin', 'xmin', 'ymax', 'xmax'],
      },
    },
    tacticalSummary: { type: Type.STRING },
    threatLevel: { type: Type.STRING },
    evacTips: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: ['buildings', 'trees', 'narrowShadows', 'barriers'],
};

const TACTICAL_ADVISOR_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    situation: { type: Type.STRING },
    priorityAction: {
      type: Type.STRING,
      enum: [
        'call_evac_heli',
        'call_gunship',
        'deploy_quarantine',
        'airstrike',
        'reinforce_police',
        'reinforce_soldier',
        'regroup',
      ],
    },
    actionLabel: { type: Type.STRING },
    targetX: { type: Type.NUMBER },
    targetY: { type: Type.NUMBER },
    rationale: { type: Type.STRING },
    riskLevel: {
      type: Type.STRING,
      enum: ['Düşük', 'Orta', 'Yüksek', 'Kritik'],
    },
  },
  required: [
    'situation',
    'priorityAction',
    'actionLabel',
    'targetX',
    'targetY',
    'rationale',
    'riskLevel',
  ],
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function safeParseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    }
    throw new Error('Invalid JSON returned by Gemini model.');
  }
}

async function analyzeSingleTile(
  ai: GoogleGenAI,
  mapsKey: string,
  originLat: number,
  originLng: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
  halfSizeMeters: number,
  scale: 1 | 2 = 2
): Promise<{
  spanMeters: number;
  metersPerPixel: number;
  rawBuildings: AnalyzedBox[];
  rawTrees: AnalyzedBox[];
  rawShadows: AnalyzedBox[];
  rawBarriers: AnalyzedBox[];
  tacticalBrief?: SectorTacticalBrief;
  buildings: MeterRectBox[];
  trees: MeterRectBox[];
  narrowShadows: MeterRectBox[];
  barriers: MeterRectBox[];
}> {
  const tileCenter = metersToLatLng(originLat, originLng, offsetX, offsetY);
  const cosLat = Math.max(0.15, Math.cos((tileCenter.lat * Math.PI) / 180));
  const metersPerPixel = (2 * Math.PI * EARTH_RADIUS_M * cosLat) / (256 * Math.pow(2, zoom));
  const spanMeters = 640 * metersPerPixel;

  const staticMapUrl =
    `https://maps.googleapis.com/maps/api/staticmap?center=${tileCenter.lat.toFixed(6)},${tileCenter.lng.toFixed(6)}` +
    `&zoom=${zoom}&size=640x640&scale=${scale}&format=jpg&maptype=satellite&key=${encodeURIComponent(mapsKey)}`;

  const imgResp = await fetch(staticMapUrl, { signal: AbortSignal.timeout(8000) });
  if (!imgResp.ok) {
    const errText = await imgResp.text().catch(() => '');
    throw new Error(`Google Static Maps HTTP ${imgResp.status}: ${errText.slice(0, 180)}`);
  }

  const mimeType = imgResp.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
  const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
  const base64Img = imgBuffer.toString('base64');

  const prompt = [
    'Perform a fast overhead satellite inspection of this tile for 2D collision masking and evacuation planning.',
    'All boxes MUST use normalized [0..1000] [ymin, xmin, ymax, xmax] coordinates (0=top/left, 1000=bottom/right).',
    '1. buildings (max 30 largest): Prominent man-made roofs/houses/sheds (tightly around roof footprint, never roads). Include heightMeters.',
    '2. trees (max 20): Dense tree canopy clumps.',
    '3. narrowShadows (max 12): Dark cast shadow strips beside walls/trees or tight alleys.',
    '4. barriers (max 12): Solid walls or fences blocking movement.',
    '5. tacticalSummary (Turkish, max 2 short sentences): Brief terrain evaluation of bottlenecks and safe landing zones.',
    '6. threatLevel: One of "Düşük", "Orta", "Yüksek", "Kritik".',
    '7. evacTips (Turkish, 2 short tips): Practical evacuation & defense tips.',
  ].join('\n');

  const promptPayload = [
    {
      inlineData: {
        mimeType,
        data: base64Img,
      },
    },
    prompt,
  ];

  let response: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
  const attemptErrors: string[] = [];
  const candidateModels = ['gemini-4-hydrogen', 'gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
  for (let attempt = 0; attempt < candidateModels.length; attempt++) {
    const modelName = candidateModels[attempt];
    try {
      const reqConfig =
        modelName === 'gemini-4-hydrogen'
          ? {
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              responseMimeType: 'application/json',
              responseSchema: SECTOR_ANALYSIS_SCHEMA,
            }
          : {
              responseMimeType: 'application/json',
              responseSchema: SECTOR_ANALYSIS_SCHEMA,
            };

      response = await withTimeout(
        ai.models.generateContent({
          model: modelName,
          contents: promptPayload,
          config: reqConfig,
        }),
        14000,
        `Gemini ${modelName} timeout`
      );
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attemptErrors.push(`${modelName}#${attempt + 1}: ${msg}`);
      console.warn(`[analyzeSingleTile] ${modelName}#${attempt + 1} failed:`, msg);
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  if (!response) {
    throw new Error(attemptErrors.join(' | ') || 'Satellite Vision request failed.');
  }

  const text = response.text;
  if (!text) {
    throw new Error('Gemini returned empty response text for satellite tile analysis.');
  }

  const parsed = safeParseJsonObject(text);
  const rawBuildings = sanitizeBoxes(parsed.buildings, 140);
  const rawTrees = sanitizeBoxes(parsed.trees, 120);
  const rawShadows = sanitizeBoxes(parsed.narrowShadows, 80);
  const rawBarriers = sanitizeBoxes(parsed.barriers, 70);

  const threatRaw = String(parsed.threatLevel || '');
  const threatLevel: SectorTacticalBrief['threatLevel'] =
    threatRaw === 'Düşük' || threatRaw === 'Orta' || threatRaw === 'Yüksek' || threatRaw === 'Kritik'
      ? threatRaw
      : 'Yüksek';
  const tacticalSummary = typeof parsed.tacticalSummary === 'string' ? parsed.tacticalSummary.trim() : '';
  const evacTips = Array.isArray(parsed.evacTips)
    ? parsed.evacTips.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 3)
    : [];
  const tacticalBrief: SectorTacticalBrief | undefined = tacticalSummary
    ? { summary: tacticalSummary, threatLevel, evacTips }
    : undefined;

  const sectorBound = halfSizeMeters * 1.04;
  const projectList = (list: AnalyzedBox[]): MeterRectBox[] => {
    const out: MeterRectBox[] = [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const minX = offsetX + (b.xmin / 1000 - 0.5) * spanMeters;
      const maxX = offsetX + (b.xmax / 1000 - 0.5) * spanMeters;
      const minY = offsetY + (b.ymin / 1000 - 0.5) * spanMeters;
      const maxY = offsetY + (b.ymax / 1000 - 0.5) * spanMeters;
      if (maxX < -sectorBound || minX > sectorBound || maxY < -sectorBound || minY > sectorBound) {
        continue;
      }
      out.push({
        minX,
        maxX,
        minY,
        maxY,
        heightMeters: b.heightMeters,
        kind: b.kind,
      });
    }
    return out;
  };

  return {
    spanMeters,
    metersPerPixel,
    rawBuildings,
    rawTrees,
    rawShadows,
    rawBarriers,
    tacticalBrief,
    buildings: projectList(rawBuildings),
    trees: projectList(rawTrees),
    narrowShadows: projectList(rawShadows),
    barriers: projectList(rawBarriers),
  };
}

async function analyzeSectorWithGemini(
  lat: number,
  lng: number,
  halfSizeMeters: number
): Promise<SectorAnalysisResponse> {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!mapsKey) {
    throw new Error('GOOGLE_MAPS_API_KEY is not configured on the server.');
  }

  const use2x2Grid = halfSizeMeters > 650;
  const targetTileSpan = use2x2Grid
    ? Math.max(420, Math.min(1300, halfSizeMeters * 1.18))
    : Math.max(240, halfSizeMeters * 2.1);

  const { zoom, metersPerPixel, spanMeters } = computeTileZoomForSpan(lat, targetTileSpan);
  const cacheKey = `${lat.toFixed(5)}:${lng.toFixed(5)}:${zoom}:${use2x2Grid ? '2x2' : '1x1'}:${Math.round(halfSizeMeters)}`;
  const cached = analysisCache.get(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  const ai = new GoogleGenAI({
    apiKey: geminiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const stepM = use2x2Grid ? Math.min(halfSizeMeters * 0.48, spanMeters * 0.42) : 0;
  const tileOffsets = use2x2Grid
    ? [
        { ox: -stepM, oy: -stepM },
        { ox: stepM, oy: -stepM },
        { ox: -stepM, oy: stepM },
        { ox: stepM, oy: stepM },
      ]
    : [{ ox: 0, oy: 0 }];

  const tileScale: 1 | 2 = 1;
  const settled = await Promise.allSettled(
    tileOffsets.map(async (t, idx) => {
      if (idx > 0) {
        await new Promise((r) => setTimeout(r, idx * 90));
      }
      return analyzeSingleTile(ai, mapsKey, lat, lng, t.ox, t.oy, zoom, halfSizeMeters, tileScale);
    })
  );

  const succeeded = settled
    .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof analyzeSingleTile>>> => r.status === 'fulfilled')
    .map((r) => r.value);

  if (succeeded.length === 0) {
    const firstErr = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    throw firstErr?.reason instanceof Error
      ? firstErr.reason
      : new Error('All satellite tile Vision analyses failed.');
  }

  const allBuildings = deduplicateMeterBoxes(succeeded.flatMap((s) => s.buildings), 0.42);
  const allTrees = deduplicateMeterBoxes(succeeded.flatMap((s) => s.trees), 0.45);
  const allShadows = deduplicateMeterBoxes(succeeded.flatMap((s) => s.narrowShadows), 0.48);
  const allBarriers = deduplicateMeterBoxes(succeeded.flatMap((s) => s.barriers), 0.45);
  const tacticalBrief = succeeded.find((s) => s.tacticalBrief)?.tacticalBrief;

  const totalSpan = halfSizeMeters * 2;
  const toLegacyNormalized = (list: MeterRectBox[]): AnalyzedBox[] =>
    list.map((b) => ({
      xmin: Math.max(0, Math.min(1000, Math.round(((b.minX / totalSpan) + 0.5) * 1000))),
      xmax: Math.max(0, Math.min(1000, Math.round(((b.maxX / totalSpan) + 0.5) * 1000))),
      ymin: Math.max(0, Math.min(1000, Math.round(((b.minY / totalSpan) + 0.5) * 1000))),
      ymax: Math.max(0, Math.min(1000, Math.round(((b.maxY / totalSpan) + 0.5) * 1000))),
      heightMeters: b.heightMeters,
      kind: b.kind,
    }));

  const result: SectorAnalysisResponse = {
    ok: true,
    zoom,
    spanMeters: totalSpan,
    metersPerPixel,
    buildings: toLegacyNormalized(allBuildings),
    trees: toLegacyNormalized(allTrees),
    narrowShadows: toLegacyNormalized(allShadows),
    barriers: toLegacyNormalized(allBarriers),
    tacticalBrief,
    meterBoxes: {
      buildings: allBuildings,
      trees: allTrees,
      narrowShadows: allShadows,
      barriers: allBarriers,
    },
  };

  if (analysisCache.size > 40) {
    const oldestKey = analysisCache.keys().next().value;
    if (oldestKey) analysisCache.delete(oldestKey);
  }
  analysisCache.set(cacheKey, result);
  return result;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/analyze-sector', async (req, res) => {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    const halfSizeMeters = Number(req.body?.halfSizeMeters ?? 450);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -85 ||
      lat > 85 ||
      lng < -180 ||
      lng > 180 ||
      !Number.isFinite(halfSizeMeters) ||
      halfSizeMeters < 100 ||
      halfSizeMeters > 10000
    ) {
      res.status(400).json({ ok: false, error: 'Invalid lat, lng, or halfSizeMeters parameters.' });
      return;
    }

    try {
      const analysis = await analyzeSectorWithGemini(lat, lng, halfSizeMeters);
      res.json(analysis);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Satellite sector analysis failed.';
      console.warn('[api/analyze-sector] Vision fallback activated:', message);
      if (message.includes('not configured on the server')) {
        res.status(503).json({ ok: false, error: message });
        return;
      }
      // Graceful 200 fallback with optional fast text tactical brief so client never receives noisy 502 errors
      let fallbackBrief: SectorTacticalBrief | undefined;
      try {
        const geminiKey = process.env.GEMINI_API_KEY;
        if (geminiKey) {
          const ai = new GoogleGenAI({
            apiKey: geminiKey,
            httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
          });
          const briefResp = await withTimeout(
            ai.models.generateContent({
              model: 'gemini-4-hydrogen',
              contents: `Sectors coordinates (${lat.toFixed(4)}, ${lng.toFixed(4)}), half-size ${halfSizeMeters}m. Write a concise Turkish tactical brief (summary max 2 sentences, threatLevel: Düşük|Orta|Yüksek|Kritik, 2 short evacTips) for a zombie evacuation operation.`,
              config: {
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                responseMimeType: 'application/json',
              },
            }),
            6000,
            'Brief timeout'
          );
          if (briefResp.text) {
            const p = safeParseJsonObject(briefResp.text);
            if (typeof p.summary === 'string' && p.summary.trim()) {
              fallbackBrief = {
                summary: p.summary.trim(),
                threatLevel:
                  p.threatLevel === 'Düşük' ||
                  p.threatLevel === 'Orta' ||
                  p.threatLevel === 'Yüksek' ||
                  p.threatLevel === 'Kritik'
                    ? p.threatLevel
                    : 'Yüksek',
                evacTips: Array.isArray(p.evacTips)
                  ? p.evacTips.filter((t): t is string => typeof t === 'string').slice(0, 2)
                  : [],
              };
            }
          }
        }
      } catch {
        // Ignore secondary text brief failure
      }

      const spanMeters = halfSizeMeters * 2;
      res.json({
        ok: true,
        zoom: 17,
        spanMeters,
        metersPerPixel: 1,
        buildings: [],
        trees: [],
        narrowShadows: [],
        barriers: [],
        tacticalBrief: fallbackBrief,
        meterBoxes: { buildings: [], trees: [], narrowShadows: [], barriers: [] },
      });
    }
  });

  app.post('/api/tactical-advisor', async (req, res) => {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      res.status(503).json({ ok: false, error: 'GEMINI_API_KEY is not configured on the server.' });
      return;
    }

    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const sectorName = String(body.sectorName || body.cityName || 'Bilinmeyen Sektör').slice(0, 120);
    const halfSizeMeters = Math.max(200, Math.min(5000, Number(body.halfSizeMeters) || 500));
    const zombiesAlive = Math.max(0, Number(body.zombiesAlive) || 0);
    const civiliansAlive = Math.max(0, Number(body.civiliansAlive) || 0);
    const civiliansEvacuated = Math.max(0, Number(body.civiliansEvacuated) || 0);
    const policeAlive = Math.max(0, Number(body.policeAlive) || 0);
    const soldiersAlive = Math.max(0, Number(body.soldiersAlive) || 0);
    const helicoptersRemaining = Math.max(0, Number(body.helicoptersRemaining) || 0);
    const quarantineRemaining = Math.max(0, Number(body.quarantineRemaining) || 0);
    const barricadesRemaining = Math.max(0, Number(body.barricadesRemaining) || 0);
    const dayPhase = String(body.dayPhase || 'Gündüz');
    const outbreakCenter =
      body.outbreakCenter && typeof body.outbreakCenter === 'object'
        ? {
            x: Number((body.outbreakCenter as Record<string, unknown>).x) || 0,
            y: Number((body.outbreakCenter as Record<string, unknown>).y) || 0,
          }
        : { x: 0, y: 0 };
    const stats =
      body.obstacleStats && typeof body.obstacleStats === 'object'
        ? (body.obstacleStats as Record<string, unknown>)
        : {};

    const ai = new GoogleGenAI({
      apiKey: geminiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const prompt = [
      'You are the AI Tactical Commander ("AI Taktik Komutan") in a top-down urban zombie evacuation RTS game ("Karantina Hattı").',
      'Respond ONLY in Turkish with crisp military/emergency dispatch terminology.',
      `Sector: ${sectorName} (Half-size: ${halfSizeMeters}m, coordinates X,Y in [-${Math.round(halfSizeMeters * 0.78)}, +${Math.round(halfSizeMeters * 0.78)}])`,
      `Time/Phase: ${dayPhase}`,
      `Live Forces: Zombies=${zombiesAlive}, CiviliansAlive=${civiliansAlive}, Evacuated=${civiliansEvacuated}, Police=${policeAlive}, Soldiers=${soldiersAlive}`,
      `Resources: EvacHelis=${helicoptersRemaining}, QuarantineBases=${quarantineRemaining}, Barricades=${barricadesRemaining}`,
      `Outbreak Center (meters): (${Math.round(outbreakCenter.x)}, ${Math.round(outbreakCenter.y)})`,
      `Terrain Stats: Buildings=${Number(stats.buildings) || 0}, Bridges=${Number(stats.bridges) || 0}, Trees=${Number(stats.trees) || 0}`,
      'Choose ONE highest-impact priorityAction:',
      '- call_evac_heli (ONLY if helicoptersRemaining > 0 and civiliansAlive > 0; pick safe coords away from outbreakCenter)',
      '- deploy_quarantine (ONLY if quarantineRemaining > 0; pick defensive perimeter between outbreakCenter and center)',
      '- airstrike (ONLY if zombiesAlive >= 18; target outbreakCenter)',
      '- call_gunship (if helicoptersRemaining == 0 or heavy horde threat)',
      '- reinforce_soldier / reinforce_police (if defenders are low)',
      '- regroup (otherwise)',
      'Keep situation <= 2 sentences, actionLabel <= 5 words, rationale <= 1 sentence.',
    ].join('\n');

    try {
      let response: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
      let lastErr: unknown = null;
      const advisorModels = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
      for (const modelName of advisorModels) {
        try {
          const reqConfig =
            modelName === 'gemini-4-hydrogen'
              ? {
                  thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                  responseMimeType: 'application/json',
                  responseSchema: TACTICAL_ADVISOR_SCHEMA,
                }
              : {
                  responseMimeType: 'application/json',
                  responseSchema: TACTICAL_ADVISOR_SCHEMA,
                };
          response = await withTimeout(
            ai.models.generateContent({
              model: modelName,
              contents: prompt,
              config: reqConfig,
            }),
            11000,
            `AI Tactical Advisor (${modelName}) timed out`
          );
          break;
        } catch (err) {
          lastErr = err;
        }
      }

      if (!response) {
        throw lastErr instanceof Error ? lastErr : new Error('AI Tactical Advisor failed.');
      }

      const text = response.text;
      if (!text) {
        throw new Error('Empty tactical advisor response.');
      }
      const parsed = safeParseJsonObject(text);
      const bound = Math.round(halfSizeMeters * 0.78);
      const tx = Math.max(-bound, Math.min(bound, Number(parsed.targetX) || 0));
      const ty = Math.max(-bound, Math.min(bound, Number(parsed.targetY) || 0));

      res.json({
        ok: true,
        advice: {
          situation: String(parsed.situation || 'Sektör durumu analiz edildi.'),
          priorityAction: String(parsed.priorityAction || 'regroup'),
          actionLabel: String(parsed.actionLabel || 'Birlikleri Topla'),
          targetX: tx,
          targetY: ty,
          rationale: String(parsed.rationale || 'Sivil tahliye koridorunu güvenceye alın.'),
          riskLevel: String(parsed.riskLevel || 'Yüksek'),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tactical advisor failed.';
      console.error('[api/tactical-advisor]', message);
      res.status(502).json({ ok: false, error: message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Karantina Hatti server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
