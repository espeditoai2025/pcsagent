// Utility Graph API per le pagine Facebook gestite dall'utente.

export interface FacebookPage {
  id: string;
  name: string;
}

const GRAPH = "https://graph.facebook.com/v21.0";

/**
 * Elenca le pagine Facebook amministrate dall'utente proprietario del token.
 * Un utente puo essere admin di piu pagine: /me/accounts le restituisce tutte.
 */
export async function listFacebookPages(userToken: string): Promise<FacebookPage[]> {
  const url = `${GRAPH}/me/accounts?fields=id,name&limit=100&access_token=${encodeURIComponent(userToken)}`;
  const r = await fetch(url);
  const j: any = await r.json();
  if (!r.ok || j.error) {
    throw new Error(j?.error?.message || `Graph API error ${r.status}`);
  }
  return (j.data || []).map((p: any) => ({ id: String(p.id), name: String(p.name) }));
}

/** Ricava il Page Access Token (per leggere/pubblicare come pagina) dal token utente. */
export async function getPageAccessToken(userToken: string, pageId: string): Promise<string | null> {
  const url = `${GRAPH}/${pageId}?fields=access_token&access_token=${encodeURIComponent(userToken)}`;
  const r = await fetch(url);
  const j: any = await r.json();
  if (!r.ok || j.error) return null;
  return j.access_token || null;
}

export interface PagePost {
  message: string;
  imageUrl: string;
  createdTime: string;
  permalink: string;
}

/** Ultimi N post pubblicati da una pagina (testo, immagine, data, link). */
export async function getRecentPagePosts(pageToken: string, pageId: string, limit: number): Promise<PagePost[]> {
  const n = Math.min(Math.max(limit, 1), 50);
  const url = `${GRAPH}/${pageId}/posts?fields=message,created_time,full_picture,permalink_url&limit=${n}&access_token=${encodeURIComponent(pageToken)}`;
  const r = await fetch(url);
  const j: any = await r.json();
  if (!r.ok || j.error) throw new Error(j?.error?.message || `Graph API error ${r.status}`);
  return (j.data || [])
    .filter((p: any) => (p.message && String(p.message).trim()) || p.full_picture)
    .map((p: any) => ({
      message: String(p.message || "").trim(),
      imageUrl: String(p.full_picture || ""),
      createdTime: String(p.created_time || ""),
      permalink: String(p.permalink_url || ""),
    }));
}

/** Permessi concessi al token (da /me/permissions). Ritorna solo quelli "granted". */
export async function getTokenPermissions(userToken: string): Promise<string[]> {
  const url = `${GRAPH}/me/permissions?access_token=${encodeURIComponent(userToken)}`;
  const r = await fetch(url);
  const j: any = await r.json();
  if (!r.ok || j.error) {
    throw new Error(j?.error?.message || `Graph API error ${r.status}`);
  }
  return (j.data || []).filter((p: any) => p.status === "granted").map((p: any) => String(p.permission));
}
