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
