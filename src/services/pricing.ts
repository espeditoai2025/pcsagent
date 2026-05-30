import path from "path";
import fs from "fs";

/**
 * Prezzi reali dei modelli da OpenRouter (USD per token), per calcolare il peso
 * dei crediti in base al COSTO REALE. Live (cache 6h) + fallback alla tabella
 * archiviata in docs/openrouter-models.json.
 */
export interface Price {
  inP: number; // USD per token (input)
  outP: number; // USD per token (output)
}

const TTL = 6 * 3600_000;
let cache: { map: Record<string, Price>; ts: number } | null = null;

async function fetchLive(): Promise<Record<string, Price> | null> {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models");
    if (!r.ok) return null;
    const j: any = await r.json();
    const map: Record<string, Price> = {};
    for (const m of j.data || []) {
      if (m.pricing) map[m.id] = { inP: parseFloat(m.pricing.prompt) || 0, outP: parseFloat(m.pricing.completion) || 0 };
    }
    return Object.keys(map).length ? map : null;
  } catch {
    return null;
  }
}

function fromArchive(): Record<string, Price> {
  try {
    const p = path.resolve(process.cwd(), "docs/openrouter-models.json");
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    const map: Record<string, Price> = {};
    for (const m of data.models || []) {
      map[m.id] = { inP: (m.in_usd_per_m || 0) / 1e6, outP: (m.out_usd_per_m || 0) / 1e6 };
    }
    return map;
  } catch {
    return {};
  }
}

export async function getPriceMap(): Promise<Record<string, Price>> {
  if (cache && Date.now() - cache.ts < TTL) return cache.map;
  const map = (await fetchLive()) || fromArchive();
  cache = { map, ts: Date.now() };
  return map;
}

/** Prezzo output di riferimento (modello base, fallback gemini-flash-lite $1.5/M). */
export const FALLBACK_BASE_OUT = 1.5 / 1e6;
