// server/src/app.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import { ZodError } from "zod";

// server/src/http/errors.ts
var ApiError = class _ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "ApiError";
  }
  status;
  code;
  static badRequest(message) {
    return new _ApiError(400, "bad_request", message);
  }
  static notFound(message) {
    return new _ApiError(404, "not_found", message);
  }
  static conflict(message) {
    return new _ApiError(409, "conflict", message);
  }
  static tooLarge(message) {
    return new _ApiError(413, "payload_too_large", message);
  }
  toResponse() {
    return { error: { code: this.code, message: this.message } };
  }
};

// shared/chunk.ts
var METRES_PER_DEGREE_LAT = 110540;
function metresPerDegreeLon(lat) {
  return 111320 * Math.cos(lat * Math.PI / 180);
}
function metresBetween(a, b) {
  const midLat = (a[1] + b[1]) / 2;
  const dx = (b[0] - a[0]) * metresPerDegreeLon(midLat);
  const dy = (b[1] - a[1]) * METRES_PER_DEGREE_LAT;
  return Math.hypot(dx, dy);
}
function lengthOf(path) {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += metresBetween(path[i - 1], path[i]);
  }
  return total;
}
function chunkLine(path, targetM = 50) {
  if (path.length < 2) return path.length === 1 ? [path] : [];
  const chunks = [];
  let current = [path[0]];
  let accumulated = 0;
  for (let i = 1; i < path.length; i++) {
    let from = path[i - 1];
    const to = path[i];
    let spanRemaining = metresBetween(from, to);
    while (accumulated + spanRemaining >= targetM) {
      const needed = targetM - accumulated;
      const t = spanRemaining === 0 ? 0 : needed / spanRemaining;
      const cut = [
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t
      ];
      current.push(cut);
      chunks.push(current);
      current = [cut];
      from = cut;
      spanRemaining -= needed;
      accumulated = 0;
    }
    accumulated += spanRemaining;
    current.push(to);
  }
  if (current.length >= 2) {
    const tail = lengthOf(current);
    if (tail < targetM / 4 && chunks.length > 0) {
      chunks[chunks.length - 1].push(...current.slice(1));
    } else {
      chunks.push(current);
    }
  }
  return chunks;
}

// shared/simulate.ts
import seedrandom from "seedrandom";

// shared/stats.ts
function normalCdf(x) {
  const sign3 = x < 0 ? -1 : 1;
  const z2 = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z2 * z2);
  return 0.5 * (1 + sign3 * y);
}
function linearTrend(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, residualStd: 1 };
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  const denominator = n * sumXX - sumX * sumX;
  const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const residual = values[i] - (intercept + slope * i);
    sse += residual * residual;
  }
  return {
    slope,
    intercept,
    residualStd: Math.sqrt(sse / Math.max(1, n - 2))
  };
}
var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// shared/bands.ts
var BAND_THRESHOLDS = { good: 70, watch: 40 };
function scoreBand(score) {
  if (score >= BAND_THRESHOLDS.good) return "good";
  if (score >= BAND_THRESHOLDS.watch) return "watch";
  return "critical";
}

// shared/photoBoxes.ts
var PHOTO_BOXES = [
  {
    x: 0.2744,
    y: 0.4651,
    w: 0.2439,
    h: 0.2344
  },
  {
    x: 0.4128,
    y: 0.3027,
    w: 0.2735,
    h: 0.2713
  },
  {
    x: 0.3283,
    y: 0.3025,
    w: 0.2757,
    h: 0.242
  },
  {
    x: 0.424,
    y: 0.332,
    w: 0.2948,
    h: 0.288
  },
  {
    x: 0.2847,
    y: 0.4331,
    w: 0.3983,
    h: 0.3079
  },
  {
    x: 0.5013,
    y: 0.4234,
    w: 0.2588,
    h: 0.2522
  },
  {
    x: 0.2778,
    y: 0.4695,
    w: 0.2407,
    h: 0.244
  },
  {
    x: 0.3095,
    y: 0.5019,
    w: 0.2479,
    h: 0.2271
  }
];

// shared/simulate.ts
var SEED = "infrapulse-demo";
var HISTORY_DAYS = 180;
var FORECAST_DAYS = 90;
var CRITICAL_LINE = 30;
var CONFIG = {
  startMin: 72,
  startMax: 100,
  /** Points lost per day on an average local road outside the monsoon. */
  baseDecay: 0.03,
  monsoonMultiplier: 2.5,
  classFactor: { arterial: 1.35, collector: 1, local: 0.78 },
  /* Per-segment susceptibility: drainage, subgrade, build quality. Skewed,
     not uniform — most roads in a district are fine and a minority are much
     worse than average, which is what gives the map its bimodal look instead
     of a wash of amber. */
  vulnerabilityMin: 0.22,
  vulnerabilityRange: 3.4,
  vulnerabilitySkew: 2.2,
  shockChancePerDay: 49e-4,
  shockMin: 10,
  shockMax: 25,
  repairChancePerDay: 55e-4,
  repairBelow: 52,
  noise: 0.45
};
function isMonsoon(date) {
  const m = date.getUTCMonth();
  return m === 6 || m === 7 || m === 8;
}
function today() {
  const now = /* @__PURE__ */ new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}
function isoDay(date) {
  return date.toISOString().slice(0, 10);
}
function addDays(date, days) {
  return new Date(date.getTime() + days * 864e5);
}
function midpointOf(path) {
  if (path.length === 0) return [0, 0];
  if (path.length === 1) return path[0];
  const spans = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(
      path[i][0] - path[i - 1][0],
      path[i][1] - path[i - 1][1]
    );
    spans.push(d);
    total += d;
  }
  if (total === 0) return path[0];
  let remaining = total / 2;
  for (let i = 0; i < spans.length; i++) {
    if (remaining <= spans[i]) {
      const t = spans[i] === 0 ? 0 : remaining / spans[i];
      return [
        path[i][0] + (path[i + 1][0] - path[i][0]) * t,
        path[i][1] + (path[i + 1][1] - path[i][1]) * t
      ];
    }
    remaining -= spans[i];
  }
  return path[path.length - 1];
}
function segmentsFromGeoJson(json) {
  return json.features.map((f) => {
    const path = f.geometry.coordinates;
    return {
      id: f.properties.id,
      name: f.properties.name,
      highway: f.properties.highway,
      roadClass: f.properties.roadClass,
      lengthM: f.properties.lengthM,
      nearSensitive: f.properties.nearSensitive,
      busRoute: f.properties.busRoute,
      path,
      center: midpointOf(path)
    };
  });
}
function simulateSegment(segment) {
  const rng = seedrandom(`${SEED}:segment:${segment.id}`);
  const start = CONFIG.startMin + rng() * (CONFIG.startMax - CONFIG.startMin);
  const vulnerability = CONFIG.vulnerabilityMin + CONFIG.vulnerabilityRange * rng() ** CONFIG.vulnerabilitySkew;
  const classFactor = CONFIG.classFactor[segment.roadClass];
  const end = today();
  const history = [];
  let score = start;
  let bumpPenalty = 0;
  let roughnessPenalty = 0;
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const date = addDays(end, -i);
    const decay = CONFIG.baseDecay * classFactor * vulnerability * (isMonsoon(date) ? CONFIG.monsoonMultiplier : 1);
    score -= decay;
    roughnessPenalty += decay;
    if (rng() < CONFIG.shockChancePerDay * vulnerability) {
      const shock = CONFIG.shockMin + rng() * (CONFIG.shockMax - CONFIG.shockMin);
      score -= shock;
      bumpPenalty += shock;
    }
    if (score < CONFIG.repairBelow && rng() < CONFIG.repairChancePerDay) {
      const repaired = 92 + rng() * 6;
      const recovered = repaired - score;
      const share = bumpPenalty + roughnessPenalty === 0 ? 0 : bumpPenalty / (bumpPenalty + roughnessPenalty);
      bumpPenalty = Math.max(0, bumpPenalty - recovered * share);
      roughnessPenalty = Math.max(0, roughnessPenalty - recovered * (1 - share));
      score = repaired;
    }
    score += (rng() - 0.5) * 2 * CONFIG.noise;
    score = clamp(score, 0, 100);
    history.push({ day: isoDay(date), score: Math.round(score * 10) / 10 });
  }
  const current = history[history.length - 1].score;
  const bumpsLast7Days = Math.round(
    (1 - current / 100) ** 2 * 140 * (0.5 + rng())
  );
  return {
    history,
    breakdown: {
      base: 100,
      bumpPenalty: Math.round(bumpPenalty * 10) / 10,
      roughnessPenalty: Math.round(roughnessPenalty * 10) / 10,
      photoPenalty: 0
      // filled in once photo reports are attached
    },
    bumpsLast7Days
  };
}
function forecastFor(history) {
  const recent = history.slice(-30).map((d) => d.score);
  const { slope, residualStd } = linearTrend(recent);
  const last = recent[recent.length - 1];
  const start = today();
  const points = [];
  for (let offset = 0; offset <= FORECAST_DAYS; offset++) {
    const value = clamp(last + slope * offset, 0, 100);
    const sigma = Math.max(1.2, residualStd) * Math.sqrt(1 + offset / 12);
    points.push({
      day: isoDay(addDays(start, offset)),
      offset,
      value: Math.round(value * 10) / 10,
      lower: Math.round(clamp(value - 1.96 * sigma, 0, 100) * 10) / 10,
      upper: Math.round(clamp(value + 1.96 * sigma, 0, 100) * 10) / 10
    });
  }
  return points;
}
function riskAt(history, offset) {
  const recent = history.slice(-30).map((d) => d.score);
  const { slope, residualStd } = linearTrend(recent);
  const last = recent[recent.length - 1];
  const projected = last + slope * offset;
  const sigma = Math.max(1.2, residualStd) * Math.sqrt(1 + offset / 12);
  return clamp(normalCdf((CRITICAL_LINE - projected) / sigma), 0, 1);
}
var CLASS_WEIGHT = {
  arterial: 3,
  collector: 2,
  local: 1
};
function impactOf(segment) {
  return CLASS_WEIGHT[segment.roadClass] * (segment.nearSensitive ? 1.5 : 1) * (segment.busRoute ? 1.3 : 1);
}
function estimateCostInr(segment, score) {
  return score >= 40 ? { costInr: Math.round(segment.lengthM * 400), repairType: "patching" } : { costInr: Math.round(segment.lengthM * 2500), repairType: "resurfacing" };
}
function reconcileBreakdown(breakdown, score) {
  const drop = 100 - score;
  const raw = breakdown.bumpPenalty + breakdown.roughnessPenalty + breakdown.photoPenalty;
  const scale = raw > 0 ? drop / raw : 0;
  const round = (v) => Math.round(v * scale * 10) / 10;
  return {
    base: 100,
    bumpPenalty: round(breakdown.bumpPenalty),
    roughnessPenalty: round(breakdown.roughnessPenalty),
    photoPenalty: round(breakdown.photoPenalty)
  };
}
function statusFor(segment, sim, photoCount) {
  const score = sim.history[sim.history.length - 1].score;
  const { costInr, repairType } = estimateCostInr(segment, score);
  const risk30 = riskAt(sim.history, 30);
  const recent = sim.history.slice(-30).map((d) => d.score);
  const { slope } = linearTrend(recent);
  return {
    id: segment.id,
    // The mock simulates history for every segment, so all of them are.
    surveyed: true,
    score,
    band: scoreBand(score),
    risk30,
    risk60: riskAt(sim.history, 60),
    risk90: riskAt(sim.history, 90),
    priority: risk30 * impactOf(segment) * (1 + (100 - score) / 100),
    trend30: Math.round(slope * 1e3) / 1e3,
    estimatedCostInr: costInr,
    repairType,
    breakdown: reconcileBreakdown(
      { ...sim.breakdown, photoPenalty: photoCount * 2.5 },
      score
    ),
    bumpsLast7Days: sim.bumpsLast7Days,
    photoReportCount: photoCount
  };
}
var PHOTO_COUNT = 40;
var PHOTO_IMAGES = 8;
var LABELS = [
  "pothole",
  "pothole cluster",
  "edge break",
  "alligator cracking",
  "rutting",
  "surface ravelling"
];
var REPORTERS = [
  "A. Sharma",
  "P. Kaur",
  "R. Singh",
  "M. Verma",
  "S. Gill",
  "N. Bansal",
  "H. Dhillon",
  "T. Chopra"
];
function severityFor(score, rng) {
  const roll = rng();
  if (score < 40) return roll < 0.65 ? "severe" : "moderate";
  if (score < 70)
    return roll < 0.55 ? "moderate" : roll < 0.85 ? "minor" : "severe";
  return roll < 0.75 ? "minor" : "moderate";
}
function jitterBox(box, rng) {
  const nudge = () => (rng() - 0.5) * 0.03;
  const x = Math.max(0, Math.min(0.9, box.x + nudge()));
  const y = Math.max(0, Math.min(0.9, box.y + nudge()));
  return {
    x,
    y,
    w: Math.min(1 - x, box.w + nudge()),
    h: Math.min(1 - y, box.h + nudge())
  };
}
function generatePhotoReports(segments, scores) {
  const rng = seedrandom(`${SEED}:photos`);
  const weighted = segments.map((s) => ({ s, w: (1 - (scores.get(s.id) ?? 80) / 100) ** 2 + 0.02 })).filter((e) => e.w > 0);
  const total = weighted.reduce((a, e) => a + e.w, 0);
  const pick = () => {
    let r = rng() * total;
    for (const entry of weighted) {
      r -= entry.w;
      if (r <= 0) return entry.s;
    }
    return weighted[weighted.length - 1].s;
  };
  const end = today();
  const reports = [];
  for (let i = 0; i < PHOTO_COUNT; i++) {
    const imageIndex = i % PHOTO_IMAGES;
    const segment = pick();
    const score = scores.get(segment.id) ?? 80;
    const daysAgo = Math.floor(rng() * 21);
    const confidence = Math.round((0.61 + rng() * 0.38) * 100) / 100;
    reports.push({
      id: `PR-${String(i + 1).padStart(3, "0")}`,
      segmentId: segment.id,
      segmentName: segment.name,
      imageUrl: `/mock-photos/road-${imageIndex + 1}.svg`,
      label: LABELS[Math.floor(rng() * LABELS.length)],
      confidence,
      // The box tracks the damage actually drawn in that image, nudged a
      // little so forty reports do not share four identical rectangles.
      box: jitterBox(PHOTO_BOXES[imageIndex], rng),
      severity: severityFor(score, rng),
      status: rng() < 0.55 ? "pending" : rng() < 0.75 ? "approved" : "rejected",
      createdAt: addDays(end, -daysAgo).toISOString(),
      reporter: REPORTERS[Math.floor(rng() * REPORTERS.length)]
    });
  }
  return reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
var CREW = ["Crew A", "Crew B", "Crew C", "PWD Zone 2", "Contractor NHK"];
var SEED_STATUSES = [
  "open",
  "open",
  "open",
  "in-progress",
  "in-progress",
  "in-progress",
  "repaired",
  "repaired",
  "verified",
  "verified",
  "verified",
  "reopened"
];
function generateWorkOrders(segments, statuses) {
  const rng = seedrandom(`${SEED}:work-orders`);
  const byId = new Map(segments.map((s) => [s.id, s]));
  const worst = [...statuses].sort((a, b) => b.priority - a.priority).slice(0, SEED_STATUSES.length * 3);
  const end = today();
  const orders = [];
  SEED_STATUSES.forEach((status, i) => {
    const target = worst[Math.floor(rng() * worst.length)] ?? worst[i];
    const segment = byId.get(target.id);
    if (!segment) return;
    const createdDaysAgo = 3 + Math.floor(rng() * 40);
    const bumpRateBefore = Math.round((6 + rng() * 22) * 10) / 10;
    orders.push({
      id: `WO-${String(i + 1).padStart(3, "0")}`,
      segmentId: segment.id,
      segmentName: segment.name,
      status,
      assignee: CREW[Math.floor(rng() * CREW.length)],
      costInr: target.estimatedCostInr,
      repairType: target.repairType,
      createdAt: addDays(end, -createdDaysAgo).toISOString(),
      updatedAt: addDays(
        end,
        -Math.floor(rng() * createdDaysAgo)
      ).toISOString(),
      bumpRateBefore,
      bumpRateAfter: status === "verified" ? Math.round(bumpRateBefore * (0.08 + rng() * 0.2) * 10) / 10 : void 0
    });
  });
  return orders;
}

// server/src/regions/overpass.ts
var ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
var SEGMENT_LENGTH_M = 50;
var MAX_AREA_SQ_DEG = 0.25;
var ImportError = class extends Error {
};
function validateBox(box) {
  const { south, west, north, east } = box;
  if ([south, west, north, east].some((v) => !Number.isFinite(v)) || south < -90 || north > 90 || west < -180 || east > 180) {
    throw new ImportError("Those coordinates are not on Earth.");
  }
  if (north <= south || east <= west) {
    throw new ImportError(
      "The north-east corner must be north and east of the south-west corner."
    );
  }
  const area = (north - south) * (east - west);
  if (area > MAX_AREA_SQ_DEG) {
    throw new ImportError(
      `That area is too large for one import (${area.toFixed(2)} sq deg, limit ${MAX_AREA_SQ_DEG}). Import it as several smaller regions.`
    );
  }
}
function roadClassOf(highway) {
  if (["motorway", "trunk", "primary", "secondary"].includes(highway)) {
    return "arterial";
  }
  if (highway === "tertiary") return "collector";
  return "local";
}
var ENDPOINT_TIMEOUT_MS = 45e3;
async function overpass(query, signal) {
  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      const deadline = AbortSignal.timeout(ENDPOINT_TIMEOUT_MS);
      const response = await fetch(endpoint, {
        method: "POST",
        body: query,
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          // Overpass answers 406 to clients that do not identify themselves.
          "User-Agent": "infrapulse/1.0 (road condition monitoring)",
          Accept: "application/json"
        },
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline
      });
      if (response.status === 429 || response.status === 504) {
        throw new Error(`${endpoint} is busy (${response.status})`);
      }
      if (!response.ok) {
        throw new Error(`${endpoint} returned ${response.status}`);
      }
      const json = await response.json();
      return json.elements;
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError?.message ?? "";
  throw new ImportError(
    detail.includes("timed out") || detail.includes("busy") ? "OpenStreetMap is busy right now. It is a free shared service \u2014 wait a minute and try again, or try a smaller area." : `Could not reach OpenStreetMap. ${detail}`.trim()
  );
}
async function importRegion(box, signal) {
  validateBox(box);
  const bbox = `${box.south},${box.west},${box.north},${box.east}`;
  const roadQuery = `
[out:json][timeout:90];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)$"](${bbox});
);
out geom;
`;
  const poiQuery = `
[out:json][timeout:90];
(
  node["amenity"~"^(school|college|university|hospital|clinic)$"](${bbox});
  way["amenity"~"^(school|college|university|hospital|clinic)$"](${bbox});
);
out center;
`;
  const ways = await overpass(roadQuery, signal);
  let sites = [];
  try {
    const pois = await overpass(poiQuery, signal);
    sites = pois.map((p) => [p.lon ?? p.center?.lon, p.lat ?? p.center?.lat]).filter(
      (p) => Number.isFinite(p[0]) && Number.isFinite(p[1])
    );
  } catch {
  }
  const segments = [];
  for (const way of ways) {
    const geometry = way.geometry;
    if (!geometry || geometry.length < 2) continue;
    const coordinates = geometry.map((g) => [g.lon, g.lat]);
    const highway = way.tags?.highway ?? "residential";
    const name = way.tags?.name ?? `Unnamed ${highway}`;
    const roadClass = roadClassOf(highway);
    for (const piece of chunkLine(coordinates, SEGMENT_LENGTH_M)) {
      if (piece.length < 2) continue;
      const centre = midpointOf(piece);
      segments.push({
        name,
        highway,
        roadClass,
        lengthM: Math.round(lengthOf(piece) * 10) / 10,
        nearSensitive: sites.some((site) => metresBetween(centre, site) <= 300),
        // A rough proxy until a transit feed says otherwise.
        busRoute: roadClass === "arterial",
        path: piece,
        center: centre
      });
    }
  }
  if (segments.length === 0) {
    throw new ImportError(
      "OpenStreetMap has no mapped roads in that area. Try a larger box, or somewhere more built up."
    );
  }
  return { segments, sensitiveSites: sites.length, waysFound: ways.length };
}
async function searchPlace(query, signal) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "5");
  const response = await fetch(url, {
    headers: {
      // Nominatim's usage policy requires identifying the application.
      "User-Agent": "infrapulse/1.0 (road condition monitoring)"
    },
    signal
  });
  if (!response.ok) {
    throw new ImportError(`Place search failed (${response.status}).`);
  }
  const results = await response.json();
  return results.map((result) => {
    const [south, north, west, east] = result.boundingbox.map(Number);
    return {
      name: result.display_name,
      box: { south, north, west, east }
    };
  });
}

// server/src/http/session.ts
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
var COOKIE = "infrapulse_session";
var SESSION_VERSION = "v1";
var SESSION_TTL_SECONDS = 12 * 60 * 60;
function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
function mintSession(secret) {
  const expiresAt = Math.floor(Date.now() / 1e3) + SESSION_TTL_SECONDS;
  const payload = `${SESSION_VERSION}.${randomUUID()}.${expiresAt}`;
  return {
    token: `${payload}.${sign(payload, secret)}`,
    maxAge: SESSION_TTL_SECONDS
  };
}
function verifySession(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [version, id, expiresRaw, signature] = parts;
  if (version !== SESSION_VERSION) return null;
  const expected = sign(`${version}.${id}.${expiresRaw}`, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt * 1e3 < Date.now()) return null;
  return { id, expiresAt };
}
function passwordMatches(submitted, expected) {
  const a = createHmac("sha256", "infrapulse-password-compare").update(submitted).digest();
  const b = createHmac("sha256", "infrapulse-password-compare").update(expected).digest();
  return timingSafeEqual(a, b);
}
function issueSessionCookie(c, secret, secure) {
  const { token, maxAge } = mintSession(secret);
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    /*
     * Lax locally, None once the cookie is Secure.
     *
     * Deployed, the dashboard and the API sit on different domains — a Vercel
     * app calling a server hosted elsewhere — which makes every API call
     * cross-site. A Lax cookie is not sent on cross-site fetch at all, so
     * signing in would appear to succeed and every subsequent request would
     * arrive anonymous. None is what actually works there, and it requires
     * Secure, which production has and plain-http development does not.
     *
     * The CSRF that Lax normally guards against is covered here by CORS: the
     * allowed origins are an explicit list rather than `*`, and every mutation
     * sends JSON, which forces a preflight an unlisted origin cannot pass.
     */
    sameSite: secure ? "None" : "Lax",
    secure,
    path: "/",
    maxAge
  });
}
function clearSessionCookie(c) {
  deleteCookie(c, COOKIE, { path: "/" });
}
function currentSession(c, secret) {
  const token = getCookie(c, COOKIE);
  return token ? verifySession(token, secret) : null;
}
function requireOperator(secret) {
  return async (c, next) => {
    const session = currentSession(c, secret);
    if (!session) {
      throw new ApiError(
        401,
        "login_required",
        "Sign in to view or change road data."
      );
    }
    c.set("operator", session);
    await next();
  };
}

// server/src/http/auth.ts
import { createHmac as createHmac2, randomUUID as randomUUID2, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
var TOKEN_VERSION = "v1";
function sign2(deviceId, secret) {
  return createHmac2("sha256", secret).update(`${TOKEN_VERSION}:${deviceId}`).digest("base64url");
}
function mintDeviceToken(secret) {
  const deviceId = randomUUID2();
  return {
    deviceId,
    token: `${TOKEN_VERSION}.${deviceId}.${sign2(deviceId, secret)}`
  };
}
function verifyDeviceToken(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, deviceId, signature] = parts;
  if (version !== TOKEN_VERSION || !deviceId) return null;
  const expected = sign2(deviceId, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual2(a, b)) return null;
  return { deviceId };
}
function requireDevice(secret) {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      throw new ApiError(
        401,
        "device_token_required",
        "Register this device first, then send its token as a bearer token."
      );
    }
    const identity = verifyDeviceToken(token, secret);
    if (!identity) {
      throw new ApiError(
        401,
        "device_token_invalid",
        "That device token is not valid. Register again."
      );
    }
    c.set("device", identity);
    await next();
  };
}

// server/src/http/rateLimit.ts
var RateLimiter = class {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  limit;
  windowMs;
  buckets = /* @__PURE__ */ new Map();
  lastSweep = Date.now();
  /** Returns false when the caller has run out of budget. */
  take(key, cost = 1) {
    this.sweep();
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      const bucket = { tokens: this.limit - cost, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
      return {
        ok: bucket.tokens >= 0,
        remaining: Math.max(0, bucket.tokens),
        resetAt: bucket.resetAt
      };
    }
    if (existing.tokens - cost < 0) {
      return { ok: false, remaining: 0, resetAt: existing.resetAt };
    }
    existing.tokens -= cost;
    return {
      ok: true,
      remaining: existing.tokens,
      resetAt: existing.resetAt
    };
  }
  /** Drops expired buckets so a long-running process does not grow forever. */
  sweep() {
    const now = Date.now();
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
  reset() {
    this.buckets.clear();
  }
};
function clientKey(c) {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown";
}
function rateLimit(options) {
  const limiter = new RateLimiter(options.limit, options.windowMs);
  return async (c, next) => {
    const key = options.key ? options.key(c) : clientKey(c);
    const cost = options.cost ? await options.cost(c) : 1;
    const result = limiter.take(key, cost);
    c.header("X-RateLimit-Limit", String(options.limit));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1e3)));
    if (!result.ok) {
      const seconds = Math.max(
        1,
        Math.ceil((result.resetAt - Date.now()) / 1e3)
      );
      c.header("Retry-After", String(seconds));
      throw new ApiError(
        429,
        "rate_limited",
        `Too many readings. Try again in ${seconds}s.`
      );
    }
    await next();
  };
}

// server/src/http/schemas.ts
import { z } from "zod";
var MAX_BUMPS_PER_REQUEST = 500;
var isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Not a valid timestamp");
var bumpSchema = z.object({
  at: isoDate,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  // A pothole is a spike, not a rocket launch: anything past 10g is a dropped
  // phone or a bad sensor, and should not be allowed to tank a road's score.
  magnitude: z.number().min(0).max(100),
  speedMs: z.number().min(0).max(120)
});
var ingestSchema = z.object({
  // No deviceId here on purpose: it comes from the signed token, not the body.
  // A body field would let any caller claim to be any device.
  tripId: z.string().min(1).max(128),
  bumps: z.array(bumpSchema).min(1).max(MAX_BUMPS_PER_REQUEST)
});
var photoReportSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  imageUrl: z.string().min(1).max(2048),
  label: z.string().min(1).max(64),
  confidence: z.number().min(0).max(1),
  severity: z.enum(["minor", "moderate", "severe"]),
  box: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1)
  }),
  reporter: z.string().min(1).max(64).default("Anonymous")
});
var photoStatusSchema = z.object({
  status: z.enum(["pending", "approved", "rejected"])
});
var createWorkOrdersSchema = z.object({
  segmentIds: z.array(z.number().int().nonnegative()).min(1).max(2e3)
});
var updateWorkOrderSchema = z.object({
  status: z.enum(["open", "in-progress", "repaired", "verified", "reopened"]).optional(),
  assignee: z.string().min(1).max(64).optional()
}).refine(
  (value) => value.status !== void 0 || value.assignee !== void 0,
  "Nothing to update"
);
var placeSearchSchema = z.object({
  q: z.string().min(2).max(200)
});
var importRegionSchema = z.object({
  name: z.string().min(1).max(200),
  south: z.number().min(-90).max(90),
  west: z.number().min(-180).max(180),
  north: z.number().min(-90).max(90),
  east: z.number().min(-180).max(180)
});
var loginSchema = z.object({
  password: z.string().min(1).max(200)
});
var reviewEscalationSchema = z.object({
  action: z.enum(["approve", "send", "dismiss"]),
  reason: z.string().max(500).optional()
});
var projectedQuerySchema = z.object({
  days: z.coerce.number().int().min(0).max(90).default(0)
});

// server/src/app.ts
var INGEST_REQUESTS_PER_MINUTE = 60;
var INGEST_READINGS_PER_MINUTE = 3e3;
var REGISTRATIONS_PER_HOUR = 20;
function createApp({
  service: service2,
  corsOrigins = [],
  enableDemoRoutes = false,
  deviceTokenSecret = "infrapulse-development-secret",
  operatorPassword = "infrapulse-dev",
  sessionSecret = "infrapulse-development-session-secret",
  secureCookies = false,
  requireLogin = true,
  quiet = false
}) {
  const operatorGate = requireLogin ? requireOperator(sessionSecret) : async (_c, next) => next();
  const app2 = new Hono();
  if (!quiet) app2.use("*", logger());
  if (corsOrigins.length > 0) {
    app2.use(
      "/api/*",
      cors({
        origin: corsOrigins,
        allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
        allowHeaders: ["Content-Type"],
        // The session is a cookie, so the browser will not send it
        // cross-origin unless the server says so. This is also why `origin`
        // is an explicit list and never '*' — the two are incompatible.
        credentials: true,
        maxAge: 86400
      })
    );
  }
  app2.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json(error.toResponse(), error.status);
    }
    if (error instanceof ImportError) {
      return c.json(
        { error: { code: "import_failed", message: error.message } },
        422
      );
    }
    if (error instanceof ZodError) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: "The request body did not match what this endpoint expects.",
            fields: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message
            }))
          }
        },
        400
      );
    }
    console.error("Unhandled error", error);
    return c.json(
      { error: { code: "internal", message: "Something went wrong." } },
      500
    );
  });
  app2.notFound(
    (c) => c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404)
  );
  app2.get(
    "/api/health",
    (c) => c.json({ status: "ok", time: (/* @__PURE__ */ new Date()).toISOString() })
  );
  app2.post(
    "/api/auth/login",
    // Slow down anyone working through a password list. The window is long on
    // purpose: a real operator logs in once a shift.
    rateLimit({ limit: 10, windowMs: 15 * 6e4 }),
    async (c) => {
      const body = loginSchema.parse(await c.req.json());
      if (!passwordMatches(body.password, operatorPassword)) {
        throw new ApiError(
          401,
          "invalid_credentials",
          "That password is not right."
        );
      }
      issueSessionCookie(c, sessionSecret, secureCookies);
      return c.json({ signedIn: true });
    }
  );
  app2.post("/api/auth/logout", (c) => {
    clearSessionCookie(c);
    return c.json({ signedIn: false });
  });
  app2.get(
    "/api/auth/me",
    (c) => c.json({
      required: requireLogin,
      signedIn: !requireLogin || currentSession(c, sessionSecret) !== null
    })
  );
  app2.use("/api/segments/*", operatorGate);
  app2.use("/api/segments", operatorGate);
  app2.use("/api/work-orders/*", operatorGate);
  app2.use("/api/work-orders", operatorGate);
  app2.use("/api/escalations/*", operatorGate);
  app2.use("/api/escalations", operatorGate);
  app2.use("/api/demo/*", operatorGate);
  app2.use("/api/regions/import", operatorGate);
  app2.use("/api/reports/*", async (c, next) => {
    if (c.req.method === "POST") return next();
    return operatorGate(c, next);
  });
  app2.use("/api/reports", async (c, next) => {
    if (c.req.method === "POST") return next();
    return operatorGate(c, next);
  });
  app2.get("/api/segments", async (c) => c.json(await service2.getSegments()));
  app2.get(
    "/api/segments/status",
    async (c) => c.json(await service2.getStatuses())
  );
  app2.get("/api/segments/projected", async (c) => {
    const { days } = projectedQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    return c.json(await service2.getProjected(days));
  });
  app2.get("/api/segments/:id/history", async (c) => {
    const id = segmentId(c.req.param("id"));
    return c.json(await service2.getHistory(id));
  });
  app2.get("/api/segments/:id/forecast", async (c) => {
    const id = segmentId(c.req.param("id"));
    return c.json(await service2.getForecast(id));
  });
  app2.post(
    "/api/devices/register",
    rateLimit({ limit: REGISTRATIONS_PER_HOUR, windowMs: 60 * 6e4 }),
    (c) => c.json(mintDeviceToken(deviceTokenSecret), 201)
  );
  app2.post(
    "/api/ingest/bumps",
    requireDevice(deviceTokenSecret),
    // Two limits: how often a device may call, and how much it may submit.
    // Either alone is easy to walk around — one big request, or many small ones.
    rateLimit({
      limit: INGEST_REQUESTS_PER_MINUTE,
      windowMs: 6e4,
      key: (c) => `req:${c.get("device").deviceId}`
    }),
    rateLimit({
      limit: INGEST_READINGS_PER_MINUTE,
      windowMs: 6e4,
      key: (c) => `readings:${c.get("device").deviceId}`,
      cost: async (c) => {
        const body = await c.req.json().catch(() => null);
        return Math.max(1, body?.bumps?.length ?? 1);
      }
    }),
    async (c) => {
      const body = ingestSchema.parse(await c.req.json());
      const result = await service2.ingestBumps(
        c.get("device").deviceId,
        body.tripId,
        body.bumps
      );
      return c.json(result, 202);
    }
  );
  app2.get("/api/reports", async (c) => c.json(await service2.getPhotoReports()));
  app2.post("/api/reports", async (c) => {
    const body = photoReportSchema.parse(await c.req.json());
    return c.json(await service2.createPhotoReport(body), 201);
  });
  app2.patch("/api/reports/:id", async (c) => {
    const body = photoStatusSchema.parse(await c.req.json());
    return c.json(await service2.setPhotoStatus(c.req.param("id"), body.status));
  });
  app2.get(
    "/api/work-orders",
    async (c) => c.json(await service2.getWorkOrders())
  );
  app2.post("/api/work-orders", async (c) => {
    const body = createWorkOrdersSchema.parse(await c.req.json());
    const created = await service2.createWorkOrders(body.segmentIds);
    return c.json(created, 201);
  });
  app2.patch("/api/work-orders/:id", async (c) => {
    const body = updateWorkOrderSchema.parse(await c.req.json());
    return c.json(await service2.updateWorkOrder(c.req.param("id"), body));
  });
  app2.get("/api/regions", async (c) => c.json(await service2.getRegions()));
  app2.get("/api/regions/search", async (c) => {
    const { q } = placeSearchSchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    return c.json(await service2.findPlaces(q));
  });
  app2.post(
    "/api/regions/import",
    // An import hits OpenStreetMap's free, shared infrastructure and writes
    // thousands of rows. Both are reasons not to allow it in a loop.
    rateLimit({ limit: 5, windowMs: 10 * 6e4 }),
    async (c) => {
      const body = importRegionSchema.parse(await c.req.json());
      const { name, ...box } = body;
      return c.json(await service2.importRegion(name, box), 201);
    }
  );
  app2.get(
    "/api/escalations",
    async (c) => c.json(await service2.getEscalations())
  );
  app2.post(
    "/api/escalations/generate",
    async (c) => c.json(await service2.generateEscalations(), 201)
  );
  app2.patch("/api/escalations/:id", async (c) => {
    const body = reviewEscalationSchema.parse(await c.req.json());
    return c.json(
      await service2.reviewEscalation(
        c.req.param("id"),
        body.action,
        body.reason
      )
    );
  });
  app2.get("/api/kpis", async (c) => c.json(await service2.getKpis()));
  app2.get(
    "/api/live",
    (c) => streamSSE(c, async (stream) => {
      for (const event of service2.liveHistory().slice().reverse()) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event)
        });
      }
      const queue = [];
      let wake = null;
      const unsubscribe = service2.subscribe((event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      try {
        while (!stream.aborted) {
          while (queue.length > 0) {
            const event = queue.shift();
            await stream.writeSSE({
              event: event.type,
              data: JSON.stringify(event)
            });
          }
          await new Promise((resolve2) => {
            wake = resolve2;
            setTimeout(resolve2, 2e4);
          });
          wake = null;
          if (!stream.aborted && queue.length === 0) {
            await stream.writeSSE({ event: "ping", data: "{}" });
          }
        }
      } finally {
        unsubscribe();
      }
    })
  );
  if (enableDemoRoutes) {
    app2.post("/api/demo/reset", async (c) => {
      await service2.reset();
      return c.json({ status: "reset" });
    });
  }
  return app2;
}
function segmentId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 0) {
    throw ApiError.badRequest(`"${raw}" is not a segment id.`);
  }
  return id;
}

// server/src/domain/service.ts
import { randomUUID as randomUUID3 } from "node:crypto";

// shared/potholes.ts
import seedrandom2 from "seedrandom";
var CLEAN_ABOVE = 72;
function severityOf(depthCm) {
  if (depthCm >= 12) return "severe";
  if (depthCm >= 6) return "moderate";
  return "minor";
}
function pointAlong(path, t) {
  if (path.length === 1) return path[0];
  const lengths = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(
      path[i][0] - path[i - 1][0],
      path[i][1] - path[i - 1][1]
    );
    lengths.push(d);
    total += d;
  }
  if (total === 0) return path[0];
  let travelled = t * total;
  for (let i = 0; i < lengths.length; i++) {
    if (travelled <= lengths[i]) {
      const f = lengths[i] === 0 ? 0 : travelled / lengths[i];
      return [
        path[i][0] + (path[i + 1][0] - path[i][0]) * f,
        path[i][1] + (path[i + 1][1] - path[i][1]) * f
      ];
    }
    travelled -= lengths[i];
  }
  return path[path.length - 1];
}
function potholesFor(segment, score) {
  if (score >= CLEAN_ABOVE) return [];
  const rng = seedrandom2(`infrapulse-demo:potholes:${segment.id}`);
  const damage = 1 - score / 100;
  const count = Math.max(1, Math.round(damage ** 2 * 16));
  const potholes = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count + (rng() - 0.5) * (0.8 / count);
    const depthCm = Math.round((2 + damage * 16 * (0.5 + rng())) * 10) / 10;
    potholes.push({
      id: `PH-${segment.id}-${i}`,
      segmentId: segment.id,
      position: pointAlong(segment.path, Math.max(0, Math.min(1, t))),
      depthCm,
      widthCm: Math.round(depthCm * (4 + rng() * 6)),
      severity: severityOf(depthCm)
    });
  }
  return potholes.sort((a, b) => b.depthCm - a.depthCm);
}

// shared/escalation.ts
var DEFAULT_ESCALATION_RULES = {
  scoreBelow: 40,
  risk30Above: 0.75,
  minBumpsLast7Days: 8,
  photoCountsAsEvidence: true,
  cooldownDays: 30,
  maxPerRun: 10
};
function shouldEscalate(candidate, rules = DEFAULT_ESCALATION_RULES, now = /* @__PURE__ */ new Date()) {
  const { segment, status, approvedPhotos, lastEscalatedAt } = candidate;
  if (lastEscalatedAt) {
    const days = (now.getTime() - new Date(lastEscalatedAt).getTime()) / 864e5;
    if (days < rules.cooldownDays) {
      return {
        escalate: false,
        reason: `Reported ${Math.floor(days)} days ago; waiting out the ${rules.cooldownDays}-day cooldown.`
      };
    }
  }
  const badEnough = status.score < rules.scoreBelow || status.risk30 > rules.risk30Above;
  if (!badEnough) {
    return {
      escalate: false,
      reason: `Score ${status.score.toFixed(0)} and ${Math.round(status.risk30 * 100)}% risk are below the reporting threshold.`
    };
  }
  const corroborated = status.bumpsLast7Days >= rules.minBumpsLast7Days || rules.photoCountsAsEvidence && approvedPhotos.length > 0;
  if (!corroborated) {
    return {
      escalate: false,
      reason: `Only ${status.bumpsLast7Days} impacts in 7 days and no approved photograph \u2014 not enough to report.`
    };
  }
  const evidence = approvedPhotos.length > 0 ? `${approvedPhotos.length} approved photo report${approvedPhotos.length > 1 ? "s" : ""}` : `${status.bumpsLast7Days} impacts in 7 days`;
  return {
    escalate: true,
    reason: `Score ${status.score.toFixed(0)}, ${Math.round(status.risk30 * 100)}% risk of failure within 30 days, ${evidence}${segment.nearSensitive ? ", near a school or hospital" : ""}.`
  };
}
function authorityKindFor(segment) {
  if (segment.highway === "motorway" || segment.highway === "trunk") {
    return "national";
  }
  if (segment.highway === "primary" || segment.highway === "secondary") {
    return "state";
  }
  return "municipal";
}
function formatInr(value) {
  return `Rs ${Math.round(value).toLocaleString("en-IN")}`;
}
function mapsUrl(lat, lon) {
  return `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
}
function buildComplaint(input) {
  const { segment, status, authority, approvedPhotos, reference } = input;
  const [lon, lat] = segment.center;
  const defects = potholesFor(segment, status.score);
  const severe = defects.filter((d) => d.severity === "severe");
  const worst = defects[0];
  const subject = `Road damage report: ${segment.name} (ref ${reference})`;
  const lines = [];
  lines.push(`To: ${authority.name}`);
  lines.push("");
  lines.push("Sir / Madam,");
  lines.push("");
  lines.push(
    `We wish to report damaged road surface on ${segment.name}, a ${segment.roadClass} road under your jurisdiction.`
  );
  lines.push("");
  lines.push("LOCATION");
  lines.push(`  ${segment.name}`);
  lines.push(`  Latitude ${lat.toFixed(6)}, Longitude ${lon.toFixed(6)}`);
  lines.push(`  Map: ${mapsUrl(lat, lon)}`);
  lines.push(
    `  Affected stretch: approximately ${segment.lengthM.toFixed(0)} metres`
  );
  if (segment.nearSensitive) {
    lines.push(
      "  NOTE: this stretch lies within 300 metres of a school or hospital."
    );
  }
  lines.push("");
  lines.push("CONDITION");
  if (worst) {
    lines.push(
      `  ${defects.length} distinct defects identified, of which ${severe.length} are severe.`
    );
    lines.push(
      `  Largest measures approximately ${worst.depthCm.toFixed(0)} cm deep and ${worst.widthCm} cm across.`
    );
  }
  lines.push(
    `  ${status.bumpsLast7Days} impacts recorded by passing vehicles in the last seven days.`
  );
  lines.push(
    `  On present trend this stretch is likely to become impassable within ${status.risk30 > 0.75 ? "30" : "60"} days.`
  );
  lines.push("");
  if (approvedPhotos.length > 0) {
    lines.push("EVIDENCE");
    for (const photo of approvedPhotos.slice(0, 5)) {
      lines.push(
        `  ${photo.id} \u2014 ${photo.label}, ${photo.severity}, reported ${new Date(photo.createdAt).toLocaleDateString("en-IN")} by ${photo.reporter}`
      );
    }
    lines.push("");
  }
  lines.push("RECOMMENDED ACTION");
  lines.push(
    `  ${status.repairType === "resurfacing" ? "Resurfacing" : "Pothole patching"} of the affected stretch.`
  );
  lines.push(`  Indicative cost: ${formatInr(status.estimatedCostInr)}.`);
  lines.push("");
  lines.push(
    "We request that this stretch be inspected and taken up for repair at the earliest."
  );
  lines.push("");
  if (authority.portal) {
    lines.push(
      `A copy of this report may also be filed at: ${authority.portal}`
    );
    lines.push("");
  }
  if (input.dashboardUrl) {
    lines.push(`Supporting data: ${input.dashboardUrl}`);
    lines.push("");
  }
  lines.push("Yours faithfully,");
  lines.push("InfraPulse road condition monitoring");
  lines.push(`Reference: ${reference}`);
  lines.push("");
  lines.push(
    "This report was prepared from vehicle-mounted sensor readings and citizen photographs, and reviewed by an engineer before sending."
  );
  return { subject, body: lines.join("\n") };
}

// server/src/escalation/authorities.ts
function read(kind, fallbackName, portal) {
  const upper = kind.toUpperCase();
  return {
    kind,
    name: process.env[`AUTHORITY_${upper}_NAME`] ?? fallbackName,
    email: process.env[`AUTHORITY_${upper}_EMAIL`] ?? "",
    portal: process.env[`AUTHORITY_${upper}_PORTAL`] ?? portal
  };
}
function authorities() {
  return {
    // Names describe the office rather than naming an individual, so a draft
    // does not go stale when someone is transferred.
    national: read(
      "national",
      "The Project Director, National Highways Authority of India"
    ),
    state: read(
      "state",
      "The Executive Engineer, Public Works Department (Buildings & Roads)"
    ),
    municipal: read("municipal", "The Commissioner, Municipal Corporation")
  };
}
function isDeliverable(authority) {
  return authority.email.trim().length > 0 && authority.email.includes("@");
}

// server/src/domain/scoring.ts
var PENALTY_PER_BUMP = 0.45;
var PENALTY_PER_PHOTO = 2.5;
var BUMP_CAP = 60;
function scoreSegment(inputs) {
  const bumpPenalty = Math.min(inputs.bumpsInWindow, BUMP_CAP) * PENALTY_PER_BUMP;
  const photoPenalty = inputs.approvedPhotoCount * PENALTY_PER_PHOTO;
  const roughnessPenalty = Math.max(0, inputs.roughnessPenalty);
  const score = clamp(inputs.baselineScore - bumpPenalty - photoPenalty, 0, 100);
  const drop = 100 - score;
  const raw = bumpPenalty + photoPenalty + roughnessPenalty;
  const scale = raw > 0 ? drop / raw : 0;
  const round = (v) => Math.round(v * scale * 10) / 10;
  return {
    score: Math.round(score * 10) / 10,
    bumpPenalty: round(bumpPenalty),
    photoPenalty: round(photoPenalty),
    roughnessPenalty: round(roughnessPenalty)
  };
}
function buildStatus(inputs) {
  const { segment, history } = inputs;
  if (history.length === 0) {
    const { costInr: costInr2, repairType: repairType2 } = estimateCostInr(segment, 100);
    return {
      id: segment.id,
      surveyed: false,
      score: 100,
      band: "good",
      risk30: 0,
      risk60: 0,
      risk90: 0,
      // Nothing to prioritise until something is known.
      priority: 0,
      trend30: 0,
      estimatedCostInr: costInr2,
      repairType: repairType2,
      breakdown: {
        base: 100,
        bumpPenalty: 0,
        roughnessPenalty: 0,
        photoPenalty: 0
      },
      bumpsLast7Days: inputs.bumpsLast7Days,
      photoReportCount: inputs.photoReportCount
    };
  }
  const recent = history.slice(-30).map((d) => d.score);
  const { slope } = linearTrend(recent);
  const baseline = recent[recent.length - 1] ?? 100;
  const roughnessPenalty = Math.max(0, 100 - baseline);
  const scored = scoreSegment({
    baselineScore: baseline,
    bumpsInWindow: inputs.bumpsLast7Days,
    approvedPhotoCount: inputs.approvedPhotoCount,
    roughnessPenalty
  });
  const withToday = [
    ...history.slice(0, -1),
    { day: history[history.length - 1]?.day ?? today2(), score: scored.score }
  ];
  const risk30 = riskAt(withToday, 30);
  const { costInr, repairType } = estimateCostInr(segment, scored.score);
  return {
    id: segment.id,
    surveyed: true,
    score: scored.score,
    band: scoreBand(scored.score),
    risk30,
    risk60: riskAt(withToday, 60),
    risk90: riskAt(withToday, 90),
    priority: risk30 * impactOf(segment) * (1 + (100 - scored.score) / 100),
    trend30: Math.round(slope * 1e3) / 1e3,
    estimatedCostInr: costInr,
    repairType,
    breakdown: {
      base: 100,
      bumpPenalty: scored.bumpPenalty,
      roughnessPenalty: scored.roughnessPenalty,
      photoPenalty: scored.photoPenalty
    },
    bumpsLast7Days: inputs.bumpsLast7Days,
    photoReportCount: inputs.photoReportCount
  };
}
function buildKpis(statuses, histories, workOrders, bumpsToday) {
  const critical = statuses.filter((s) => s.surveyed && s.band === "critical");
  const watch = statuses.filter((s) => s.surveyed && s.band === "watch");
  const surveyed = statuses.filter((s) => s.surveyed);
  const sample = [...histories.values()].filter((_, i) => i % 7 === 0);
  const healthTrend = [];
  const length = sample[0]?.length ?? 0;
  for (let d = Math.max(0, length - 30); d < length; d++) {
    const scores = sample.map((h) => h[d]?.score ?? 0);
    healthTrend.push(
      Math.round(
        scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length) * 10
      ) / 10
    );
  }
  return {
    cityHealthIndex: Math.round(
      surveyed.reduce((a, s) => a + s.score, 0) / Math.max(1, surveyed.length) * 10
    ) / 10,
    criticalCount: critical.length,
    watchCount: watch.length,
    goodCount: surveyed.length - critical.length - watch.length,
    unsurveyedCount: statuses.length - surveyed.length,
    bumpsToday,
    costExposureInr: [...critical, ...watch].reduce(
      (a, s) => a + s.estimatedCostInr,
      0
    ),
    openWorkOrders: workOrders.filter(
      (w) => w.status === "open" || w.status === "in-progress"
    ).length,
    healthTrend
  };
}
function today2() {
  return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
}

// server/src/domain/geo.ts
var MAX_MATCH_DISTANCE_M = 40;
var METRES_PER_DEGREE_LAT2 = 110540;
function metresPerDegreeLon2(lat) {
  return 111320 * Math.cos(lat * Math.PI / 180);
}
function distanceToSegmentSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return (px - ax) ** 2 + (py - ay) ** 2;
  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))
  );
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}
function buildSpatialIndex(segments) {
  if (segments.length === 0) {
    return { nearest: () => null };
  }
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const segment of segments) {
    for (const [lon, lat] of segment.path) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
  }
  const midLat = (minLat + maxLat) / 2;
  const cellLat = 100 / METRES_PER_DEGREE_LAT2;
  const cellLon = 100 / metresPerDegreeLon2(midLat);
  const cells = /* @__PURE__ */ new Map();
  const key = (cx, cy) => `${cx}:${cy}`;
  for (const segment of segments) {
    const seen = /* @__PURE__ */ new Set();
    for (const [lon, lat] of segment.path) {
      const cx = Math.floor((lon - minLon) / cellLon);
      const cy = Math.floor((lat - minLat) / cellLat);
      const k = key(cx, cy);
      if (seen.has(k)) continue;
      seen.add(k);
      const bucket = cells.get(k);
      if (bucket) bucket.push(segment.id);
      else cells.set(k, [segment.id]);
    }
  }
  const byId = new Map(segments.map((s) => [s.id, s]));
  return {
    nearest(lon, lat) {
      const cx = Math.floor((lon - minLon) / cellLon);
      const cy = Math.floor((lat - minLat) / cellLat);
      const candidates = /* @__PURE__ */ new Set();
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const id of cells.get(key(cx + dx, cy + dy)) ?? []) {
            candidates.add(id);
          }
        }
      }
      const pool = candidates.size > 0 ? candidates : byId.keys();
      const mPerLon = metresPerDegreeLon2(lat);
      let bestId = null;
      let bestSq = Infinity;
      for (const id of pool) {
        const segment = byId.get(id);
        if (!segment) continue;
        for (let i = 1; i < segment.path.length; i++) {
          const [ax, ay] = segment.path[i - 1];
          const [bx, by] = segment.path[i];
          const d = distanceToSegmentSq(
            lon * mPerLon,
            lat * METRES_PER_DEGREE_LAT2,
            ax * mPerLon,
            ay * METRES_PER_DEGREE_LAT2,
            bx * mPerLon,
            by * METRES_PER_DEGREE_LAT2
          );
          if (d < bestSq) {
            bestSq = d;
            bestId = id;
          }
        }
      }
      if (bestId === null) return null;
      const distanceM = Math.sqrt(bestSq);
      return distanceM <= MAX_MATCH_DISTANCE_M ? { segmentId: bestId, distanceM } : null;
    }
  };
}

// server/src/repository/Repository.ts
var WORK_ORDER_TRANSITIONS = {
  open: ["in-progress"],
  "in-progress": ["repaired", "open"],
  repaired: ["verified", "in-progress"],
  verified: ["reopened"],
  reopened: ["in-progress"]
};

// server/src/domain/service.ts
var SCORING_WINDOW_DAYS = 7;
var TREND_DAYS = 30;
var InfraPulseService = class _InfraPulseService {
  constructor(repo, bus2, notifier) {
    this.repo = repo;
    this.bus = bus2;
    this.notifier = notifier;
  }
  repo;
  bus;
  notifier;
  index = null;
  /*
   * Computing every segment's status means reading 1,108 histories and running
   * a regression over each — and both /api/segments/status and /api/kpis want
   * it. A dashboard receiving a burst of live events asks for the KPIs several
   * times in a second, so the result is held briefly and dropped the moment
   * anything writes. The TTL is short enough that nothing else needs to know
   * this cache exists.
   */
  statusCache = null;
  static STATUS_TTL_MS = 1e3;
  async spatialIndex() {
    this.index ??= buildSpatialIndex(await this.repo.listSegments());
    return this.index;
  }
  windowStart(days = SCORING_WINDOW_DAYS) {
    return new Date(Date.now() - days * 864e5);
  }
  async getSegments() {
    return this.repo.listSegments();
  }
  /** Drops the memoised statuses. Called by everything that writes. */
  invalidate() {
    this.statusCache = null;
  }
  /** Status for every segment, computed from observations rather than stored. */
  async getStatuses() {
    const cached = this.statusCache;
    if (cached && Date.now() - cached.at < _InfraPulseService.STATUS_TTL_MS) {
      return cached.value;
    }
    const [segments, photos, bumpCounts, histories] = await Promise.all([
      this.repo.listSegments(),
      this.repo.listPhotoReports(),
      this.repo.countBumpsSince(this.windowStart()),
      // One read for the whole network rather than one per segment.
      this.repo.listRecentHistories(TREND_DAYS)
    ]);
    const photoCounts = /* @__PURE__ */ new Map();
    for (const photo of photos) {
      const entry = photoCounts.get(photo.segmentId) ?? {
        total: 0,
        approved: 0
      };
      entry.total += 1;
      if (photo.status === "approved") entry.approved += 1;
      photoCounts.set(photo.segmentId, entry);
    }
    const statuses = [];
    for (const segment of segments) {
      const counts = photoCounts.get(segment.id) ?? { total: 0, approved: 0 };
      statuses.push(
        buildStatus({
          segment,
          history: histories.get(segment.id) ?? [],
          bumpsLast7Days: bumpCounts.get(segment.id) ?? 0,
          photoReportCount: counts.total,
          approvedPhotoCount: counts.approved
        })
      );
    }
    this.statusCache = { at: Date.now(), value: statuses };
    return statuses;
  }
  async getHistory(segmentId2) {
    const segment = await this.repo.getSegment(segmentId2);
    if (!segment) throw ApiError.notFound(`No segment ${segmentId2}`);
    return this.repo.listHistory(segmentId2);
  }
  async getForecast(segmentId2) {
    return forecastFor(await this.getHistory(segmentId2));
  }
  /** Every segment's score `days` into the future — the Time Machine. */
  async getProjected(days) {
    const segments = await this.repo.listSegments();
    const projected = [];
    for (const segment of segments) {
      const forecast = forecastFor(await this.repo.listHistory(segment.id));
      const point = forecast[Math.min(days, forecast.length - 1)];
      projected.push({ id: segment.id, score: point?.value ?? 0 });
    }
    return projected;
  }
  /* --- Ingest ------------------------------------------------------------ */
  /**
   * Takes a trip's worth of detected impacts, matches each to a stretch of
   * road, rescores what changed and tells every connected dashboard.
   *
   * Unmatched points are stored rather than dropped: they usually mean the road
   * exists but is not in our OpenStreetMap import, which is worth knowing.
   */
  async ingestBumps(deviceId, tripId, incoming) {
    const index = await this.spatialIndex();
    const observations = [];
    const touched = /* @__PURE__ */ new Set();
    for (const bump of incoming) {
      const match = index.nearest(bump.lon, bump.lat);
      observations.push({
        id: randomUUID3(),
        segmentId: match?.segmentId ?? null,
        at: new Date(bump.at),
        lon: bump.lon,
        lat: bump.lat,
        magnitude: bump.magnitude,
        speedMs: bump.speedMs,
        deviceId,
        tripId
      });
      if (match) touched.add(match.segmentId);
    }
    await this.repo.insertBumps(observations);
    this.invalidate();
    const rescored = [];
    for (const segmentId2 of touched) {
      const score = await this.currentScore(segmentId2);
      if (score !== null) rescored.push({ segmentId: segmentId2, score });
    }
    for (const observation of observations) {
      if (observation.segmentId === null) continue;
      this.bus.publish({
        type: "bump",
        segmentId: observation.segmentId,
        at: observation.at.toISOString(),
        magnitude: observation.magnitude,
        position: [observation.lon, observation.lat],
        real: true
      });
    }
    for (const entry of rescored) {
      if (entry.score >= 40) continue;
      const segment = await this.repo.getSegment(entry.segmentId);
      if (!segment) continue;
      this.bus.publish({
        type: "alert",
        segmentId: entry.segmentId,
        at: (/* @__PURE__ */ new Date()).toISOString(),
        message: `${segment.name} crossed into critical`,
        band: "critical"
      });
    }
    const matched = observations.filter((o) => o.segmentId !== null).length;
    return {
      accepted: observations.length,
      matched,
      unmatched: observations.length - matched,
      rescored
    };
  }
  /**
   * Today's score for one segment, derived rather than stored.
   *
   * It is important that this does not write the result back into history.
   * The stored daily score is the wear baseline; the live score is that
   * baseline minus what has been observed since. Persisting the derived value
   * would make the next read subtract the same impacts a second time, and the
   * score would sink a little further on every request — which is exactly what
   * an earlier version of this did (25 to 19.6 to 14.2 on three reads).
   *
   * Folding a day's observations into the baseline is a separate, once-a-day
   * operation: see `rollUpDay`.
   */
  async currentScore(segmentId2) {
    const segment = await this.repo.getSegment(segmentId2);
    if (!segment) return null;
    const [history, photos, bumps] = await Promise.all([
      this.repo.listHistory(segmentId2),
      this.repo.listPhotoReports(),
      this.repo.countBumpsForSegment(segmentId2, this.windowStart())
    ]);
    const mine = photos.filter((p) => p.segmentId === segmentId2);
    const status = buildStatus({
      segment,
      history,
      bumpsLast7Days: bumps,
      photoReportCount: mine.length,
      approvedPhotoCount: mine.filter((p) => p.status === "approved").length
    });
    return status.score;
  }
  /**
   * Folds today's observations into the stored history, once per day.
   *
   * In a deployment this is a scheduled job, not something a request triggers:
   * running it twice in one day would count the same impacts toward two days
   * of wear. It is exposed here so the job has something to call.
   */
  async rollUpDay() {
    const segments = await this.repo.listSegments();
    let written = 0;
    for (const segment of segments) {
      const score = await this.currentScore(segment.id);
      if (score === null) continue;
      await this.repo.putTodayScore(segment.id, score);
      written++;
    }
    return written;
  }
  /* --- Photo reports ------------------------------------------------------ */
  async getPhotoReports() {
    return this.repo.listPhotoReports();
  }
  async createPhotoReport(input) {
    const index = await this.spatialIndex();
    const match = index.nearest(input.lon, input.lat);
    if (!match) {
      throw ApiError.badRequest(
        "That location is not on a mapped road segment."
      );
    }
    const segment = await this.repo.getSegment(match.segmentId);
    if (!segment) throw ApiError.notFound("Segment disappeared mid-request");
    const report = {
      id: `PR-${randomUUID3().slice(0, 8)}`,
      segmentId: segment.id,
      segmentName: segment.name,
      imageUrl: input.imageUrl,
      label: input.label,
      confidence: input.confidence,
      box: input.box,
      severity: input.severity,
      // A citizen's report is a claim, not a fact: it affects the score only
      // once an engineer approves it.
      status: "pending",
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      reporter: input.reporter
    };
    await this.repo.insertPhotoReport(report);
    this.invalidate();
    this.bus.publish({
      type: "photo",
      segmentId: segment.id,
      at: report.createdAt,
      report
    });
    return report;
  }
  async setPhotoStatus(id, status) {
    const updated = await this.repo.setPhotoStatus(id, status);
    if (!updated) throw ApiError.notFound(`No photo report ${id}`);
    this.invalidate();
    return updated;
  }
  /* --- Work orders -------------------------------------------------------- */
  async getWorkOrders() {
    return this.repo.listWorkOrders();
  }
  async createWorkOrders(segmentIds) {
    const existing = await this.repo.listWorkOrders();
    const statuses = await this.getStatuses();
    const statusById = new Map(statuses.map((s) => [s.id, s]));
    const alreadyLive = new Set(
      existing.filter((w) => w.status !== "verified").map((w) => w.segmentId)
    );
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const created = [];
    for (const segmentId2 of segmentIds) {
      if (alreadyLive.has(segmentId2)) continue;
      const segment = await this.repo.getSegment(segmentId2);
      if (!segment) continue;
      const status = statusById.get(segmentId2);
      const fallback = estimateCostInr(segment, status?.score ?? 50);
      created.push({
        id: `WO-${randomUUID3().slice(0, 8)}`,
        segmentId: segmentId2,
        segmentName: segment.name,
        status: "open",
        assignee: "Unassigned",
        costInr: status?.estimatedCostInr ?? fallback.costInr,
        repairType: status?.repairType ?? fallback.repairType,
        createdAt: now,
        updatedAt: now,
        bumpRateBefore: Math.round((status?.bumpsLast7Days ?? 0) / 7 * 10) / 10
      });
      alreadyLive.add(segmentId2);
    }
    return this.repo.insertWorkOrders(created);
  }
  async updateWorkOrder(id, patch) {
    const current = await this.repo.getWorkOrder(id);
    if (!current) throw ApiError.notFound(`No work order ${id}`);
    const next = { ...patch };
    if (patch.status && patch.status !== current.status) {
      const allowed = WORK_ORDER_TRANSITIONS[current.status];
      if (!allowed.includes(patch.status)) {
        throw ApiError.conflict(
          `A ${current.status} work order cannot move to ${patch.status}. Allowed: ${allowed.join(", ")}.`
        );
      }
      if (patch.status === "verified") {
        const since = new Date(current.updatedAt);
        const after = await this.repo.countBumpsForSegment(
          current.segmentId,
          since
        );
        const days = Math.max(1, (Date.now() - since.getTime()) / 864e5);
        next.bumpRateAfter = Math.round(after / days * 10) / 10;
      }
    }
    const updated = await this.repo.updateWorkOrder(id, next);
    if (!updated) throw ApiError.notFound(`No work order ${id}`);
    return updated;
  }
  /* --- Aggregates --------------------------------------------------------- */
  async getKpis() {
    const [statuses, workOrders, histories] = await Promise.all([
      this.getStatuses(),
      this.repo.listWorkOrders(),
      this.repo.listRecentHistories(TREND_DAYS)
    ]);
    const startOfDay = /* @__PURE__ */ new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const today3 = await this.repo.countBumpsSince(startOfDay);
    const bumpsToday = [...today3.values()].reduce((a, b) => a + b, 0);
    return buildKpis(statuses, histories, workOrders, bumpsToday);
  }
  /* --- Escalation to the road-owning authority --------------------------- */
  async getEscalations() {
    return this.repo.listEscalations();
  }
  /**
   * Drafts a complaint for every segment that has earned one.
   *
   * Idempotent by way of the cooldown: running it twice in a day produces
   * nothing the second time, so it is safe to call on a schedule or from a
   * button without piling up duplicates.
   */
  async generateEscalations() {
    const [statuses, photos] = await Promise.all([
      this.getStatuses(),
      this.repo.listPhotoReports()
    ]);
    const approvedBySegment = /* @__PURE__ */ new Map();
    for (const photo of photos) {
      if (photo.status !== "approved") continue;
      const list2 = approvedBySegment.get(photo.segmentId) ?? [];
      list2.push(photo);
      approvedBySegment.set(photo.segmentId, list2);
    }
    const directory = authorities();
    const created = [];
    const skipped = [];
    const ranked = [...statuses].sort((a, b) => b.priority - a.priority);
    for (const status of ranked) {
      if (created.length >= DEFAULT_ESCALATION_RULES.maxPerRun) break;
      const segment = await this.repo.getSegment(status.id);
      if (!segment) continue;
      const decision = shouldEscalate(
        {
          segment,
          status,
          approvedPhotos: approvedBySegment.get(status.id) ?? [],
          lastEscalatedAt: await this.repo.lastEscalatedAt(status.id)
        },
        DEFAULT_ESCALATION_RULES
      );
      if (!decision.escalate) {
        if (status.band !== "good" && skipped.length < 20) {
          skipped.push({ segmentId: status.id, reason: decision.reason });
        }
        continue;
      }
      const authority = directory[authorityKindFor(segment)];
      const reference = "IP-" + (/* @__PURE__ */ new Date()).getFullYear() + "-" + String(status.id).padStart(4, "0");
      const { subject, body } = buildComplaint({
        segment,
        status,
        authority,
        approvedPhotos: approvedBySegment.get(status.id) ?? [],
        reference
      });
      const [lon, lat] = segment.center;
      const escalation = {
        id: reference,
        segmentId: segment.id,
        segmentName: segment.name,
        // Drafted, never sent. A person decides.
        status: "draft",
        authority,
        subject,
        body,
        location: {
          lat,
          lon,
          mapsUrl: "https://www.google.com/maps?q=" + lat.toFixed(6) + "," + lon.toFixed(6)
        },
        severity: status.band === "critical" ? "critical" : "watch",
        photoReportIds: (approvedBySegment.get(status.id) ?? []).map(
          (p) => p.id
        ),
        estimatedCostInr: status.estimatedCostInr,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      created.push(await this.repo.insertEscalation(escalation));
    }
    return { created, skipped };
  }
  async reviewEscalation(id, action, reason) {
    const current = await this.repo.getEscalation(id);
    if (!current) throw ApiError.notFound(`No escalation ${id}`);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    let patch;
    if (action === "approve") {
      if (current.status !== "draft") {
        throw ApiError.conflict(`${id} is already ${current.status}.`);
      }
      patch = { status: "approved", approvedAt: now };
    } else if (action === "dismiss") {
      patch = {
        status: "dismissed",
        dismissedReason: reason
      };
    } else {
      if (current.status !== "approved") {
        throw ApiError.conflict(
          `${id} must be approved by a reviewer before it can be sent.`
        );
      }
      if (!isDeliverable(current.authority)) {
        throw ApiError.conflict(
          `No address is configured for ${current.authority.name}. Set it from that office's published contacts, or open the draft in your own mail client.`
        );
      }
      await this.notifier?.send(current);
      patch = { status: "sent", sentAt: now };
    }
    const updated = await this.repo.updateEscalation(id, patch);
    if (!updated) throw ApiError.notFound(`No escalation ${id}`);
    return updated;
  }
  /* --- Regions ------------------------------------------------------------ */
  async getRegions() {
    return this.repo.listRegions();
  }
  async findPlaces(query) {
    return searchPlace(query);
  }
  /**
   * Imports a bounding box of roads from OpenStreetMap.
   *
   * The segments arrive with geometry and nothing else. No history is
   * fabricated for them: a road nobody has driven has no condition, and
   * inventing one would fill the map with confident green over roads the
   * system knows nothing about. They stay unsurveyed until impacts arrive.
   */
  async importRegion(name, box) {
    const imported = await importRegion(box);
    const region = await this.repo.upsertRegion({ name, ...box });
    const count = await this.repo.insertSegments(region.id, imported.segments);
    this.index = null;
    this.invalidate();
    return { regionId: region.id, name: region.name, segments: count };
  }
  liveHistory() {
    return this.bus.history();
  }
  subscribe(listener) {
    return this.bus.subscribe(listener);
  }
  async reset() {
    await this.repo.reset();
    this.index = null;
    this.invalidate();
  }
};

// server/src/live/EventBus.ts
var EventBus = class {
  subscribers = /* @__PURE__ */ new Set();
  /** Kept so a dashboard that connects mid-demo is not staring at nothing. */
  recent = [];
  historyLimit = 30;
  subscribe(listener) {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }
  publish(event) {
    this.recent = [event, ...this.recent].slice(0, this.historyLimit);
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
      }
    }
  }
  /** Newest first. */
  history() {
    return this.recent;
  }
  get subscriberCount() {
    return this.subscribers.size;
  }
};

// server/src/escalation/Notifier.ts
var OutboxNotifier = class {
  sent = [];
  async send(escalation) {
    const result = {
      delivered: false,
      detail: `Recorded, not transmitted: no mail transport is configured. Open the draft in your mail client to send it from a mailbox someone reads. (${escalation.authority.name})`,
      at: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.sent = [result, ...this.sent].slice(0, 200);
    console.log(
      `[escalation] ${escalation.id} for segment ${escalation.segmentId} marked sent by reviewer`
    );
    return result;
  }
  history() {
    return this.sent;
  }
};

// server/src/repository/InMemoryRepository.ts
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var HERE = dirname(fileURLToPath(import.meta.url));
var SEGMENTS_PATH = resolve(HERE, "../../../public/data/segments.geojson");
var InMemoryRepository = class {
  segments = [];
  histories = /* @__PURE__ */ new Map();
  bumps = [];
  photos = [];
  workOrders = [];
  escalations = [];
  ready = null;
  /** Loads the network and seeds history on first use. */
  init() {
    this.ready ??= this.seed();
    return this.ready;
  }
  async seed() {
    const raw = await readFile(SEGMENTS_PATH, "utf-8");
    this.segments = segmentsFromGeoJson(JSON.parse(raw));
    const scores = /* @__PURE__ */ new Map();
    for (const segment of this.segments) {
      const sim = simulateSegment(segment);
      this.histories.set(segment.id, sim.history);
      scores.set(segment.id, sim.history[sim.history.length - 1].score);
    }
    this.photos = generatePhotoReports(this.segments, scores);
    const photoCounts = /* @__PURE__ */ new Map();
    for (const photo of this.photos) {
      photoCounts.set(
        photo.segmentId,
        (photoCounts.get(photo.segmentId) ?? 0) + 1
      );
    }
    const statuses = this.segments.map(
      (segment) => statusFor(
        segment,
        {
          history: this.histories.get(segment.id),
          breakdown: {
            base: 100,
            bumpPenalty: 0,
            roughnessPenalty: 0,
            photoPenalty: 0
          },
          bumpsLast7Days: 0
        },
        photoCounts.get(segment.id) ?? 0
      )
    );
    this.workOrders = generateWorkOrders(this.segments, statuses);
  }
  /*
   * Regions exist here so the API behaves the same either way, but importing
   * one is a database operation: it writes thousands of rows that have to
   * outlive the process. Without persistence an import would vanish on
   * restart, which is worse than declining it.
   */
  async listRegions() {
    await this.init();
    const surveyed = this.segments.filter(
      (s) => (this.histories.get(s.id)?.length ?? 0) > 0
    ).length;
    return [
      {
        id: 1,
        name: "Chandigarh University, Gharuan",
        south: 30.7545,
        west: 76.5593,
        north: 30.7815,
        east: 76.5907,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        segmentCount: this.segments.length,
        surveyedCount: surveyed
      }
    ];
  }
  async upsertRegion() {
    throw new Error(
      "Importing a region needs a database: set DATABASE_URL and run the migrations."
    );
  }
  async insertSegments() {
    throw new Error(
      "Importing a region needs a database: set DATABASE_URL and run the migrations."
    );
  }
  async listSegments() {
    await this.init();
    return this.segments;
  }
  async getSegment(id) {
    await this.init();
    return this.segments.find((s) => s.id === id) ?? null;
  }
  async listHistory(segmentId2) {
    await this.init();
    return this.histories.get(segmentId2) ?? [];
  }
  async listRecentHistories(days) {
    await this.init();
    const recent = /* @__PURE__ */ new Map();
    for (const [id, history] of this.histories) {
      recent.set(id, history.slice(-days));
    }
    return recent;
  }
  async listLatestScores() {
    await this.init();
    const latest = /* @__PURE__ */ new Map();
    for (const [id, history] of this.histories) {
      const last = history[history.length - 1];
      if (last) latest.set(id, last.score);
    }
    return latest;
  }
  async putTodayScore(segmentId2, score) {
    await this.init();
    const history = this.histories.get(segmentId2);
    if (!history || history.length === 0) return;
    history[history.length - 1] = {
      ...history[history.length - 1],
      score: Math.round(score * 10) / 10
    };
  }
  async insertBumps(bumps) {
    await this.init();
    this.bumps.push(...bumps);
  }
  async countBumpsSince(since) {
    await this.init();
    const counts = /* @__PURE__ */ new Map();
    for (const bump of this.bumps) {
      if (bump.segmentId === null || bump.at < since) continue;
      counts.set(bump.segmentId, (counts.get(bump.segmentId) ?? 0) + 1);
    }
    return counts;
  }
  async countBumpsForSegment(segmentId2, since) {
    await this.init();
    let count = 0;
    for (const bump of this.bumps) {
      if (bump.segmentId === segmentId2 && bump.at >= since) count++;
    }
    return count;
  }
  async listPhotoReports() {
    await this.init();
    return this.photos;
  }
  async insertPhotoReport(report) {
    await this.init();
    this.photos = [report, ...this.photos];
    return report;
  }
  async setPhotoStatus(id, status) {
    await this.init();
    const index = this.photos.findIndex((p) => p.id === id);
    if (index === -1) return null;
    const updated = { ...this.photos[index], status };
    this.photos[index] = updated;
    return updated;
  }
  async listWorkOrders() {
    await this.init();
    return this.workOrders;
  }
  async getWorkOrder(id) {
    await this.init();
    return this.workOrders.find((w) => w.id === id) ?? null;
  }
  async insertWorkOrders(orders) {
    await this.init();
    this.workOrders = [...this.workOrders, ...orders];
    return orders;
  }
  async updateWorkOrder(id, patch) {
    await this.init();
    const index = this.workOrders.findIndex((w) => w.id === id);
    if (index === -1) return null;
    const updated = {
      ...this.workOrders[index],
      ...patch,
      id: this.workOrders[index].id,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.workOrders[index] = updated;
    return updated;
  }
  async listEscalations() {
    await this.init();
    return this.escalations;
  }
  async getEscalation(id) {
    await this.init();
    return this.escalations.find((e) => e.id === id) ?? null;
  }
  async insertEscalation(escalation) {
    await this.init();
    this.escalations = [escalation, ...this.escalations];
    return escalation;
  }
  async updateEscalation(id, patch) {
    await this.init();
    const index = this.escalations.findIndex((e) => e.id === id);
    if (index === -1) return null;
    const updated = { ...this.escalations[index], ...patch, id };
    this.escalations[index] = updated;
    return updated;
  }
  async lastEscalatedAt(segmentId2) {
    await this.init();
    const relevant = this.escalations.filter((e) => e.segmentId === segmentId2 && e.status !== "dismissed").map((e) => e.createdAt).sort();
    return relevant[relevant.length - 1] ?? null;
  }
  async reset() {
    this.segments = [];
    this.escalations = [];
    this.histories.clear();
    this.bumps = [];
    this.photos = [];
    this.workOrders = [];
    this.ready = null;
    await this.init();
  }
};

// server/src/repository/PostgresRepository.ts
import pg from "pg";
var { Pool } = pg;
function num(value) {
  return typeof value === "number" ? value : Number(value);
}
function isoDay2(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
function toSegment(row) {
  const path = JSON.parse(row.path);
  const center = JSON.parse(row.center);
  return {
    id: row.id,
    name: row.name,
    highway: row.highway,
    roadClass: row.road_class,
    lengthM: num(row.length_m),
    nearSensitive: row.near_sensitive,
    busRoute: row.bus_route,
    path: path.coordinates,
    center: center.coordinates
  };
}
var SEGMENT_COLUMNS = `
  id, name, highway, road_class, length_m, near_sensitive, bus_route,
  ST_AsGeoJSON(geom) AS path,
  ST_AsGeoJSON(center) AS center
`;
var PostgresRepository = class {
  pool;
  constructor(connectionString) {
    this.pool = new Pool({
      connectionString,
      // Managed Postgres almost always terminates TLS with a certificate this
      // process has no chain for. The connection is still encrypted.
      ssl: connectionString.includes("localhost") ? void 0 : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 3e4,
      // Supabase keeps PostGIS in an `extensions` schema rather than public,
      // so without this the geometry functions are simply not visible.
      options: "-c search_path=public,extensions"
    });
  }
  async close() {
    await this.pool.end();
  }
  /** Fails fast at startup rather than on the first request. */
  async verify() {
    const { rows } = await this.pool.query(
      "SELECT count(*)::text AS count FROM segments"
    );
    if (Number(rows[0].count) === 0) {
      throw new Error(
        "The segments table is empty. Run `npm run db:migrate` then `npm run db:import`."
      );
    }
  }
  /* --- Road network ------------------------------------------------------ */
  async listSegments(regionId) {
    const query = regionId ? `SELECT ${SEGMENT_COLUMNS} FROM segments WHERE region_id = $1 ORDER BY id` : `SELECT ${SEGMENT_COLUMNS} FROM segments WHERE region_id = 1 OR region_id IS NULL ORDER BY id LIMIT 2000`;
    const { rows } = await this.pool.query(
      query,
      regionId ? [regionId] : []
    );
    return rows.map(toSegment);
  }
  async getSegment(id) {
    const { rows } = await this.pool.query(
      `SELECT ${SEGMENT_COLUMNS} FROM segments WHERE id = $1`,
      [id]
    );
    return rows[0] ? toSegment(rows[0]) : null;
  }
  /* --- Regions -------------------------------------------------------------- */
  async listRegions() {
    const { rows } = await this.pool.query(
      `SELECT r.*,
              count(s.id)::int AS segment_count,
              count(h.segment_id)::int AS surveyed_count
       FROM regions r
       LEFT JOIN segments s ON s.region_id = r.id
       LEFT JOIN LATERAL (
         SELECT 1 AS segment_id
         FROM segment_daily_scores d
         WHERE d.segment_id = s.id
         LIMIT 1
       ) h ON true
       GROUP BY r.id
       ORDER BY r.created_at`
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      south: num(r.south),
      west: num(r.west),
      north: num(r.north),
      east: num(r.east),
      createdAt: r.created_at.toISOString(),
      segmentCount: num(r.segment_count),
      surveyedCount: num(r.surveyed_count)
    }));
  }
  async upsertRegion(region) {
    const { rows } = await this.pool.query(
      `INSERT INTO regions (name, south, west, north, east)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (south, west, north, east)
       DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [region.name, region.south, region.west, region.north, region.east]
    );
    const row = rows[0];
    return {
      id: row.id,
      name: row.name,
      south: num(row.south),
      west: num(row.west),
      north: num(row.north),
      east: num(row.east),
      createdAt: row.created_at.toISOString(),
      segmentCount: 0,
      surveyedCount: 0
    };
  }
  async insertSegments(regionId, segments) {
    if (segments.length === 0) return 0;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM segments WHERE region_id = $1", [
        regionId
      ]);
      const BATCH = 250;
      for (let start = 0; start < segments.length; start += BATCH) {
        const slice = segments.slice(start, start + BATCH);
        const values = [];
        const tuples = [];
        for (const segment of slice) {
          const base = values.length;
          const line = `LINESTRING(${segment.path.map(([lon, lat]) => `${lon} ${lat}`).join(", ")})`;
          values.push(
            regionId,
            segment.name,
            segment.highway,
            segment.roadClass,
            segment.lengthM,
            segment.nearSensitive,
            segment.busRoute,
            line,
            segment.center[0],
            segment.center[1]
          );
          tuples.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::road_class, $${base + 5}, $${base + 6}, $${base + 7}, ST_GeomFromText($${base + 8}, 4326), ST_SetSRID(ST_MakePoint($${base + 9}, $${base + 10}), 4326))`
          );
        }
        await client.query(
          `INSERT INTO segments
             (region_id, name, highway, road_class, length_m,
              near_sensitive, bus_route, geom, center)
           VALUES ${tuples.join(", ")}`,
          values
        );
      }
      await client.query("COMMIT");
      return segments.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  /* --- Condition history -------------------------------------------------- */
  async listHistory(segmentId2) {
    const { rows } = await this.pool.query(
      `SELECT day, score FROM segment_daily_scores
       WHERE segment_id = $1 ORDER BY day`,
      [segmentId2]
    );
    return rows.map((r) => ({ day: isoDay2(r.day), score: num(r.score) }));
  }
  async listRecentHistories(days) {
    const { rows } = await this.pool.query(
      `SELECT segment_id, day, score
       FROM segment_daily_scores
       WHERE day > CURRENT_DATE - $1::int
       ORDER BY segment_id, day`,
      [days]
    );
    const histories = /* @__PURE__ */ new Map();
    for (const row of rows) {
      const list2 = histories.get(row.segment_id) ?? [];
      list2.push({ day: isoDay2(row.day), score: num(row.score) });
      histories.set(row.segment_id, list2);
    }
    return histories;
  }
  async listLatestScores() {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (segment_id) segment_id, score
       FROM segment_daily_scores
       ORDER BY segment_id, day DESC`
    );
    return new Map(rows.map((r) => [r.segment_id, num(r.score)]));
  }
  async putTodayScore(segmentId2, score) {
    await this.pool.query(
      `INSERT INTO segment_daily_scores (segment_id, day, score, simulated)
       VALUES ($1, CURRENT_DATE, $2, false)
       ON CONFLICT (segment_id, day)
       DO UPDATE SET score = EXCLUDED.score, simulated = false`,
      [segmentId2, score]
    );
  }
  /* --- Observations -------------------------------------------------------- */
  async insertBumps(bumps) {
    if (bumps.length === 0) return;
    const values = [];
    const tuples = [];
    for (const bump of bumps) {
      const base = values.length;
      values.push(
        bump.id,
        bump.segmentId,
        bump.at.toISOString(),
        bump.lon,
        bump.lat,
        bump.magnitude,
        bump.speedMs,
        bump.deviceId,
        bump.tripId
      );
      tuples.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, ST_SetSRID(ST_MakePoint($${base + 4}, $${base + 5}), 4326), $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`
      );
    }
    await this.pool.query(
      `INSERT INTO bump_observations
         (id, segment_id, at, position, magnitude, speed_ms, device_id, trip_id)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (id) DO NOTHING`,
      values
    );
  }
  async countBumpsSince(since) {
    const { rows } = await this.pool.query(
      `SELECT segment_id, count(*)::int AS count
       FROM bump_observations
       WHERE at >= $1 AND segment_id IS NOT NULL
       GROUP BY segment_id`,
      [since.toISOString()]
    );
    return new Map(rows.map((r) => [r.segment_id, num(r.count)]));
  }
  async countBumpsForSegment(segmentId2, since) {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS count FROM bump_observations
       WHERE segment_id = $1 AND at >= $2`,
      [segmentId2, since.toISOString()]
    );
    return num(rows[0].count);
  }
  /* --- Photo reports -------------------------------------------------------- */
  toPhoto(row) {
    return {
      id: row.id,
      segmentId: row.segment_id,
      segmentName: row.segment_name ?? "",
      imageUrl: row.image_url,
      label: row.label,
      confidence: num(row.confidence),
      box: {
        x: num(row.box_x),
        y: num(row.box_y),
        w: num(row.box_w),
        h: num(row.box_h)
      },
      severity: row.severity,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      reporter: row.reporter
    };
  }
  photoSelect = `
    SELECT p.*, s.name AS segment_name
    FROM photo_reports p
    JOIN segments s ON s.id = p.segment_id
  `;
  async listPhotoReports() {
    const { rows } = await this.pool.query(
      `${this.photoSelect} ORDER BY p.created_at DESC`
    );
    return rows.map((r) => this.toPhoto(r));
  }
  async insertPhotoReport(report) {
    await this.pool.query(
      `INSERT INTO photo_reports
         (id, segment_id, image_url, label, confidence,
          box_x, box_y, box_w, box_h, severity, status, reporter, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        report.id,
        report.segmentId,
        report.imageUrl,
        report.label,
        report.confidence,
        report.box.x,
        report.box.y,
        report.box.w,
        report.box.h,
        report.severity,
        report.status,
        report.reporter,
        report.createdAt
      ]
    );
    return report;
  }
  async setPhotoStatus(id, status) {
    await this.pool.query(
      `UPDATE photo_reports
       SET status = $2::photo_status,
           reviewed_at = CASE WHEN $2::text = 'pending' THEN NULL ELSE now() END
       WHERE id = $1`,
      [id, status]
    );
    const { rows } = await this.pool.query(
      `${this.photoSelect} WHERE p.id = $1`,
      [id]
    );
    return rows[0] ? this.toPhoto(rows[0]) : null;
  }
  /* --- Work orders ---------------------------------------------------------- */
  toWorkOrder(row) {
    return {
      id: row.id,
      segmentId: row.segment_id,
      segmentName: row.segment_name ?? "",
      status: row.status,
      assignee: row.assignee,
      costInr: num(row.cost_inr),
      repairType: row.repair_type,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      bumpRateBefore: num(row.bump_rate_before),
      bumpRateAfter: row.bump_rate_after === null ? void 0 : num(row.bump_rate_after)
    };
  }
  workOrderSelect = `
    SELECT w.*, s.name AS segment_name
    FROM work_orders w
    JOIN segments s ON s.id = w.segment_id
  `;
  async listWorkOrders() {
    const { rows } = await this.pool.query(
      `${this.workOrderSelect} ORDER BY w.created_at`
    );
    return rows.map((r) => this.toWorkOrder(r));
  }
  async getWorkOrder(id) {
    const { rows } = await this.pool.query(
      `${this.workOrderSelect} WHERE w.id = $1`,
      [id]
    );
    return rows[0] ? this.toWorkOrder(rows[0]) : null;
  }
  async insertWorkOrders(orders) {
    const created = [];
    for (const order of orders) {
      try {
        await this.pool.query(
          `INSERT INTO work_orders
             (id, segment_id, status, assignee, cost_inr, repair_type,
              bump_rate_before, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            order.id,
            order.segmentId,
            order.status,
            order.assignee,
            order.costInr,
            order.repairType,
            order.bumpRateBefore,
            order.createdAt,
            order.updatedAt
          ]
        );
        created.push(order);
      } catch (error) {
        if (error.code === "23505") continue;
        throw error;
      }
    }
    return created;
  }
  async updateWorkOrder(id, patch) {
    const sets = ["updated_at = now()"];
    const values = [id];
    const assign = (column, value) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.status !== void 0) assign("status", patch.status);
    if (patch.assignee !== void 0) assign("assignee", patch.assignee);
    if (patch.costInr !== void 0) assign("cost_inr", patch.costInr);
    if (patch.bumpRateAfter !== void 0) {
      assign("bump_rate_after", patch.bumpRateAfter);
    }
    await this.pool.query(
      `UPDATE work_orders SET ${sets.join(", ")} WHERE id = $1`,
      values
    );
    return this.getWorkOrder(id);
  }
  /* --- Escalations ----------------------------------------------------------- */
  toEscalation(row) {
    return {
      id: row.id,
      segmentId: row.segment_id,
      segmentName: row.segment_name ?? "",
      status: row.status,
      authority: {
        kind: row.authority_kind,
        name: row.authority_name,
        email: row.authority_email ?? ""
      },
      subject: row.subject,
      body: row.body,
      location: {
        lat: num(row.lat),
        lon: num(row.lon),
        mapsUrl: row.maps_url
      },
      severity: row.severity,
      photoReportIds: row.photo_report_ids ?? [],
      estimatedCostInr: num(row.estimated_cost_inr),
      createdAt: row.created_at.toISOString(),
      approvedAt: row.approved_at ? row.approved_at.toISOString() : void 0,
      sentAt: row.sent_at ? row.sent_at.toISOString() : void 0,
      dismissedReason: row.dismissed_reason ?? void 0
    };
  }
  escalationSelect = `
    SELECT e.*, s.name AS segment_name
    FROM escalations e
    JOIN segments s ON s.id = e.segment_id
  `;
  async listEscalations() {
    const { rows } = await this.pool.query(
      `${this.escalationSelect} ORDER BY e.created_at DESC`
    );
    return rows.map((r) => this.toEscalation(r));
  }
  async getEscalation(id) {
    const { rows } = await this.pool.query(
      `${this.escalationSelect} WHERE e.id = $1`,
      [id]
    );
    return rows[0] ? this.toEscalation(rows[0]) : null;
  }
  async insertEscalation(escalation) {
    await this.pool.query(
      `INSERT INTO escalations
         (id, segment_id, status, authority_kind, authority_name, authority_email,
          subject, body, lat, lon, maps_url, severity, photo_report_ids,
          estimated_cost_inr, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        escalation.id,
        escalation.segmentId,
        escalation.status,
        escalation.authority.kind,
        escalation.authority.name,
        escalation.authority.email,
        escalation.subject,
        escalation.body,
        escalation.location.lat,
        escalation.location.lon,
        escalation.location.mapsUrl,
        escalation.severity,
        escalation.photoReportIds,
        escalation.estimatedCostInr,
        escalation.createdAt
      ]
    );
    return escalation;
  }
  async updateEscalation(id, patch) {
    const sets = [];
    const values = [id];
    const assign = (column, value) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.status !== void 0) assign("status", patch.status);
    if (patch.approvedAt !== void 0) assign("approved_at", patch.approvedAt);
    if (patch.sentAt !== void 0) assign("sent_at", patch.sentAt);
    if (patch.dismissedReason !== void 0) {
      assign("dismissed_reason", patch.dismissedReason);
    }
    if (sets.length === 0) return this.getEscalation(id);
    await this.pool.query(
      `UPDATE escalations SET ${sets.join(", ")} WHERE id = $1`,
      values
    );
    return this.getEscalation(id);
  }
  async lastEscalatedAt(segmentId2) {
    const { rows } = await this.pool.query(
      `SELECT max(created_at) AS last FROM escalations
       WHERE segment_id = $1 AND status <> 'dismissed'`,
      [segmentId2]
    );
    return rows[0]?.last ? rows[0].last.toISOString() : null;
  }
  /* --- Demo ------------------------------------------------------------------- */
  async reset() {
    if (process.env.NODE_ENV === "production") {
      throw ApiError.conflict("Reset is not available against a live database.");
    }
    await this.pool.query(
      `TRUNCATE bump_observations, photo_reports, work_order_events,
                work_orders, escalations RESTART IDENTITY CASCADE`
    );
  }
};

// server/src/vercel.ts
function list(value) {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}
var databaseUrl = process.env.DATABASE_URL;
var isProduction = (process.env.NODE_ENV ?? "development") === "production";
var repository = databaseUrl ? new PostgresRepository(databaseUrl) : new InMemoryRepository();
var bus = new EventBus();
var service = new InfraPulseService(repository, bus, new OutboxNotifier());
var app = createApp({
  service,
  corsOrigins: list(process.env.CORS_ORIGINS),
  enableDemoRoutes: process.env.ENABLE_DEMO_ROUTES === "true",
  deviceTokenSecret: process.env.DEVICE_TOKEN_SECRET ?? "infrapulse-development-secret",
  operatorPassword: process.env.OPERATOR_PASSWORD ?? "infrapulse-dev",
  sessionSecret: process.env.SESSION_SECRET ?? "infrapulse-development-session-secret",
  requireLogin: process.env.REQUIRE_LOGIN === "true" || process.env.REQUIRE_LOGIN !== "false" && isProduction,
  secureCookies: isProduction
});
app.get(
  "/api",
  (c) => c.json({
    status: "ok",
    name: "InfraPulse API",
    database: databaseUrl ? "postgres" : "in-memory",
    time: (/* @__PURE__ */ new Date()).toISOString()
  })
);
var handler = (req) => {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api")) {
    url.pathname = `/api${url.pathname}`;
    return app.fetch(new Request(url.toString(), req));
  }
  return app.fetch(req);
};
var vercel_default = handler;
var GET = handler;
var POST = handler;
var PATCH = handler;
var PUT = handler;
var DELETE = handler;
var OPTIONS = handler;
export {
  DELETE,
  GET,
  OPTIONS,
  PATCH,
  POST,
  PUT,
  vercel_default as default
};
