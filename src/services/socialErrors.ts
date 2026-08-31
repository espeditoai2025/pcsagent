// Traduzione degli errori di una pubblicazione social in messaggi comprensibili.
//
// REGOLA IMPORTANTE: l'input e' l'INTERO log del container (dockerService antepone
// "Exit Code N:" e concatena stdout+stderr), quindi contiene anche le didascalie dei
// post e il testo estratto dai siti. Cercare parole generiche ("oauth", "permission",
// "docker") in quel blob porta a diagnosi sbagliate: "OAuthException" e' presente in
// QUALSIASI errore Graph, e un prodotto chiamato "Corso Docker" farebbe dire che e'
// caduto l'ambiente di esecuzione. Percio' qui si matcha SOLO su:
//   1) la riga FB_BLOCKED che lo script emette dopo aver classificato l'errore Meta
//      per codice numerico (fb_fatal in socialTemplates.ts) — la fonte autorevole;
//   2) marcatori inequivocabili stampati dal NOSTRO script o da dockerService.
// Tutto il resto torna grezzo: meglio un testo tecnico che una diagnosi falsa.

/** Traduce l'output/errore di un'esecuzione. Non tronca: e' il chiamante a decidere. */
export function friendlyError(err: string | null | undefined): string {
  const raw = (err || "").trim();
  if (!raw) return "errore sconosciuto";

  // 1) Spiegazione gia' pronta dallo script. Ancorata a inizio riga: cosi' una
  // didascalia che contenesse "FB_BLOCKED" non puo' spacciarsi per errore.
  const blocked = raw.match(/^FB_BLOCKED[ \t]+(.+)$/m);
  if (blocked) return blocked[1].trim();

  const e = raw.toLowerCase();

  // 2) Marcatori inequivocabili (nostri o dell'infrastruttura).
  if (e.includes("api access blocked") || e.includes("app is blocked"))
    return "l'app Facebook ha l'accesso alle API bloccato da Meta: apri developers.facebook.com → la tua app → Avvisi e completa la Verifica dell'utilizzo dei dati (Data Use Checkup), poi controlla eventuali restrizioni per violazione delle policy";
  if (e.includes("pcsai-python") || e.includes("no such image"))
    return "l'ambiente di esecuzione del server non era disponibile (problema tecnico lato server, da sistemare dall'amministratore)";
  if (e.includes("errore caricamento fonte dati") || e.includes("la fonte dati non contiene righe") || e.includes("fonte dati non configurata"))
    return "la fonte dati non è stata letta: controlla il file o il link del foglio e ricaricalo dal pannello";
  if (e.includes("credenziali facebook mancanti") || e.includes("pagina o token"))
    return "pagina o token Facebook non configurati per questa pubblicazione";

  // 3) Sconosciuto: testo grezzo, senza inventare una causa.
  return raw;
}
