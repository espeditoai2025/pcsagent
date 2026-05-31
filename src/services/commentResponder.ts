import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import { decryptSecret } from "../utils/crypto";
import { modelForLevel } from "./aiLevels";
import { chargeUser } from "./tokenMeter";

const GRAPH = "https://graph.facebook.com/v21.0";
const MAX_COMMENTS_PER_SCAN = 25; // tetto per contenere i costi
const POSTS_LOOKBACK = 25; // ultimi N post pubblicati da controllare

type CatalogRow = { name: string; price: string; availability: string; description: string; imageUrl: string };

// ---- Catalogo (CSV caricato o Google Sheet) -------------------------------
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const t = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQuotes) {
      if (ch === '"') {
        if (t[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function pick(header: string[], obj: string[], names: string[]): string {
  for (const n of names) {
    const idx = header.findIndex((h) => h.trim().toLowerCase() === n);
    if (idx >= 0 && obj[idx] != null && obj[idx].trim() !== "") return obj[idx].trim();
  }
  return "";
}

async function loadCatalog(userId: string, type: string | null, ref: string | null): Promise<CatalogRow[]> {
  if (!ref) return [];
  let text = "";
  try {
    if (type === "GOOGLE_SHEET" || /^https?:\/\//i.test(ref)) {
      let url = ref;
      const m = ref.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (m) url = `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv`;
      const r = await fetch(url);
      text = await r.text();
    } else {
      const file = path.join(process.cwd(), "shared_data", userId, ref);
      text = fs.readFileSync(file, "utf8");
    }
  } catch {
    return [];
  }
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.replace(/^﻿/, ""));
  return rows.slice(1).map((r) => ({
    name: pick(header, r, ["name", "nome", "prodotto", "titolo", "servizio"]),
    price: pick(header, r, ["promoprice", "prezzo", "price", "prezzo_promo", "prezzoscontato"]) || pick(header, r, ["originalprice", "prezzo_originale"]),
    availability: pick(header, r, ["availability", "disponibilita", "disponibilità", "stock", "quantita", "quantità", "giacenza"]),
    description: pick(header, r, ["description", "descrizione", "dettagli", "note"]),
    imageUrl: pick(header, r, ["imageurl", "image", "immagine", "foto", "img", "image_url"]),
  })).filter((x) => x.name);
}

// Pre-filtra il catalogo per parole chiave del commento (max 6 candidati).
function prefilter(comment: string, rows: CatalogRow[]): { idx: number; row: CatalogRow }[] {
  const stop = new Set(["della", "dello", "delle", "degli", "questo", "questa", "avete", "vorrei", "quanto", "costa", "prezzo", "disponibile", "disponibilita", "ciao", "salve", "buongiorno", "buonasera", "grazie", "info", "informazioni", "vendete", "posso", "sapere", "ancora"]);
  const words = (comment.toLowerCase().match(/[a-zàèéìòù0-9]{3,}/g) || []).filter((w) => !stop.has(w));
  const scored = rows.map((row, idx) => {
    const hay = `${row.name} ${row.description}`.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score++;
    return { idx, row, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, 6).map(({ idx, row }) => ({ idx, row }));
}

// ---- Graph API ------------------------------------------------------------
async function getPageToken(userToken: string, pageId: string): Promise<string | null> {
  try {
    const r = await fetch(`${GRAPH}/${pageId}?fields=access_token&access_token=${encodeURIComponent(userToken)}`);
    const j: any = await r.json();
    return j.access_token || null;
  } catch {
    return null;
  }
}

async function fetchComments(postId: string, pageToken: string): Promise<{ id: string; message: string; fromId: string }[]> {
  try {
    const r = await fetch(`${GRAPH}/${postId}/comments?fields=id,message,from&limit=50&order=reverse_chronological&access_token=${encodeURIComponent(pageToken)}`);
    const j: any = await r.json();
    if (!r.ok || j.error) return [];
    return (j.data || []).map((c: any) => ({ id: String(c.id), message: String(c.message || ""), fromId: c.from?.id ? String(c.from.id) : "" }));
  } catch {
    return [];
  }
}

async function replyToComment(commentId: string, message: string, pageToken: string, imageUrl?: string): Promise<boolean> {
  try {
    const body = new URLSearchParams({ message, access_token: pageToken });
    if (imageUrl && /^https?:\/\//i.test(imageUrl)) body.set("attachment_url", imageUrl);
    const r = await fetch(`${GRAPH}/${commentId}/comments`, { method: "POST", body });
    const j: any = await r.json();
    return r.ok && !j.error;
  } catch {
    return false;
  }
}

// ---- AI: compone una risposta breve e orientata alla vendita --------------
async function aiCompose(
  model: string,
  comment: string,
  bizContext: string,
  whatsapp: string,
  candidates: { idx: number; row: CatalogRow }[]
): Promise<{ skip: boolean; reply: string; imageIndex: number; p: number; c: number }> {
  const apiKey = process.env.OPENROUTER_API_KEY || "";
  const cat = candidates.length
    ? candidates.map((x) => `[${x.idx}] ${x.row.name} | prezzo: ${x.row.price || "n/d"} | disp: ${x.row.availability || "n/d"} | ${x.row.description}`.slice(0, 240)).join("\n")
    : "(nessun articolo pertinente nel catalogo)";
  const sys =
    `Sei l'assistente social di questa attività. Contesto: ${bizContext || "(non specificato)"}.\n` +
    `Rispondi ai commenti dei clienti in modo BREVISSIMO (max 1-2 frasi), cordiale e ORIENTATO ALLA VENDITA (invoglia all'acquisto con una piccola call-to-action).\n` +
    `Catalogo pertinente (prodotti/servizi):\n${cat}\n\n` +
    `Regole:\n` +
    `- Se il commento chiede prezzo/disponibilità/info di un articolo in catalogo, rispondi con l'info e invoglia all'acquisto.\n` +
    `- Se l'articolo esatto non c'è ma esiste un'alternativa simile in catalogo, PROPONILA.\n` +
    `- Se non c'entra col catalogo o serve assistenza, invita gentilmente a scrivere su WhatsApp ${whatsapp || "(numero non impostato)"}.\n` +
    `- Se è spam, un'emoji o un complimento generico che non richiede risposta, salta.\n` +
    `Rispondi SOLO con JSON valido: {"skip": boolean, "reply": "testo breve in italiano", "imageIndex": numero_indice_articolo_di_cui_allegare_la_foto_oppure_-1}`;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: sys }, { role: "user", content: comment }],
        temperature: 0.6,
        response_format: { type: "json_object" },
      }),
    });
    const j: any = await r.json();
    const content = j?.choices?.[0]?.message?.content || "{}";
    const p = j?.usage?.prompt_tokens || 0;
    const c = j?.usage?.completion_tokens || 0;
    let parsed: any = {};
    try { parsed = JSON.parse(content); } catch { parsed = {}; }
    return {
      skip: parsed.skip === true || !parsed.reply,
      reply: String(parsed.reply || "").slice(0, 600),
      imageIndex: typeof parsed.imageIndex === "number" ? parsed.imageIndex : -1,
      p,
      c,
    };
  } catch {
    return { skip: true, reply: "", imageIndex: -1, p: 0, c: 0 };
  }
}

// ---- Scansione di un agente ----------------------------------------------
export async function scanAgentComments(prisma: PrismaClient, agent: any): Promise<void> {
  // 1) Token: connessione dell'agente o token del profilo.
  let encToken: string | null = null;
  if (agent.connectionId) {
    const conn = await prisma.socialConnection.findUnique({ where: { id: agent.connectionId }, select: { accessToken: true } });
    encToken = conn?.accessToken || null;
  }
  if (!encToken) {
    const user = await prisma.user.findUnique({ where: { id: agent.userId }, select: { fbAccessToken: true } });
    encToken = user?.fbAccessToken || null;
  }
  if (!encToken) return;
  const userToken = decryptSecret(encToken);
  const pageToken = await getPageToken(userToken, agent.fbPageId);
  if (!pageToken) return;

  // 2) Post pubblicati dall'agente (ultimi N) + commenti gia gestiti.
  const posts = await prisma.publishedPost.findMany({ where: { socialAgentId: agent.id }, orderBy: { createdAt: "desc" }, take: POSTS_LOOKBACK, select: { fbPostId: true } });
  if (posts.length === 0) return;
  const answered = new Set((await prisma.answeredComment.findMany({ where: { socialAgentId: agent.id }, select: { commentId: true } })).map((a) => a.commentId));

  // 3) Catalogo + modello AI.
  const catalog = await loadCatalog(agent.userId, agent.catalogType, agent.catalogRef);
  const model = await modelForLevel(prisma, agent.aiLevel || 1);
  const whatsapp = agent.bizWhatsapp || "";

  let processed = 0;
  const usage: { model: string; prompt: number; completion: number }[] = [];

  for (const post of posts) {
    if (processed >= MAX_COMMENTS_PER_SCAN) break;
    const comments = await fetchComments(post.fbPostId, pageToken);
    for (const cm of comments) {
      if (processed >= MAX_COMMENTS_PER_SCAN) break;
      if (answered.has(cm.id)) continue;
      if (cm.fromId && cm.fromId === agent.fbPageId) { answered.add(cm.id); continue; } // commento della pagina stessa
      if (!cm.message || cm.message.trim().length < 2) { continue; }

      processed++;
      const cands = prefilter(cm.message, catalog);
      const out = await aiCompose(model, cm.message, agent.bizContext || "", whatsapp, cands);
      if (out.p || out.c) usage.push({ model, prompt: out.p, completion: out.c });

      // Segna come gestito comunque (anche se SKIP) per non riprocessarlo.
      await prisma.answeredComment.create({ data: { socialAgentId: agent.id, commentId: cm.id } }).catch(() => {});
      answered.add(cm.id);
      if (out.skip || !out.reply.trim()) continue;

      const img = out.imageIndex >= 0 ? catalog[out.imageIndex]?.imageUrl : undefined;
      await replyToComment(cm.id, out.reply.trim(), pageToken, img);
    }
  }

  // 4) Conteggio token + timestamp ultima scansione.
  if (usage.length) await chargeUser(prisma, agent.userId, usage, "social-reply").catch(() => {});
  await prisma.socialAgent.update({ where: { id: agent.id }, data: { autoReplyLastScan: new Date() } }).catch(() => {});
  if (processed) console.log(`[AutoReply] Agente ${agent.name}: ${processed} commenti elaborati.`);
}
