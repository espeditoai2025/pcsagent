// Traduzione degli errori tecnici di una pubblicazione social in messaggi
// comprensibili per l'utente. Usata sia dalla diagnosi in chat sia dal testo mostrato
// nella scheda della pubblicazione (scheduledJob.lastError).
// L'output grezzo dello script resta comunque salvato in scheduledJobRun.error.

/** Traduce l'output/errore di un'esecuzione in una spiegazione leggibile. */
export function friendlyError(err: string | null | undefined): string {
  const raw = (err || "").trim();
  if (!raw) return "errore sconosciuto";

  // Lo script Python emette gia una spiegazione pronta (in italiano) quando riconosce
  // un errore fatale lato Meta: la usiamo cosi com'e.
  const blocked = raw.match(/FB_BLOCKED[ \t]+(.+)/);
  if (blocked) return blocked[1].trim();

  const e = raw.toLowerCase();
  // Prima del controllo generico su "oauth": e un blocco dell'APP, non del token.
  if (e.includes("api access blocked") || e.includes("app is blocked"))
    return "l'app Facebook ha l'accesso alle API bloccato da Meta: apri developers.facebook.com → la tua app → Avvisi e completa la Verifica dell'utilizzo dei dati (Data Use Checkup), poi controlla eventuali restrizioni per violazione delle policy";
  if (e.includes("pcsai-python") || e.includes("no such image") || e.includes("docker"))
    return "l'ambiente di esecuzione del server non era disponibile (problema tecnico lato server, da sistemare dall'amministratore)";
  if (e.includes("no such file") || e.includes("file not found") || e.includes("nessuna riga") || e.includes("caricamento fonte"))
    return "il file dei dati non è stato trovato: ricaricalo dal pannello";
  if (e.includes("pages_manage_posts") || e.includes("permission"))
    return "il token Facebook non ha il permesso di pubblicare (pages_manage_posts): rigeneralo includendo quel permesso";
  if (e.includes("oauth") || e.includes("expired") || e.includes("session has been invalidated") || e.includes("access token"))
    return "il token Facebook non è più valido o è scaduto: rigeneralo dal Profilo";
  if (e.includes("pagina o token"))
    return "pagina o token Facebook non configurati per questa pubblicazione";
  return raw.slice(0, 160);
}
