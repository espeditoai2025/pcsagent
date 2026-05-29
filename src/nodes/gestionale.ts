import { AgentState } from "../state";
import { PrismaClient } from "@prisma/client";
import { SystemMessage } from "@langchain/core/messages";
import { calcolaTotali } from "../utils/calcola-totali";

const prisma = new PrismaClient();

async function logAudit(userId: string, azione: string, esito = "OK", dettagli?: string) {
  try {
    await prisma.auditLog.create({ data: { userId, azione, esito, dettagli } });
  } catch {}
}

export const gestionaleNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  console.log("---GESTIONALE NODE---");

  const userData = state.userData || {};
  const userId = userData.id;

  if (!userId) {
    return {
      messages: [new SystemMessage("Errore: utente non identificato, impossibile accedere al gestionale.")],
    };
  }

  const userMessage = (state.messages[state.messages.length - 1].content as string).toLowerCase();

  try {
    // Carica sempre anagrafiche e catalogo
    const [anagrafiche, prodotti] = await Promise.all([
      prisma.anagrafica.findMany({
        where: { userId },
        orderBy: { ragioneSociale: "asc" },
      }),
      prisma.prodotto.findMany({
        where: { userId, attivo: true },
        orderBy: { nomeProdotto: "asc" },
      }),
    ]);

    // Carica documenti solo se richiesto
    const needsDocumenti =
      userMessage.includes("preventiv") ||
      userMessage.includes("fattur") ||
      userMessage.includes("document") ||
      userMessage.includes("storico") ||
      userMessage.includes("contabilit") ||
      userMessage.includes("fatturato") ||
      userMessage.includes("analisi") ||
      userMessage.includes("ordine");

    const documenti = needsDocumenti
      ? await prisma.documento.findMany({
          where: { userId },
          include: {
            anagrafica: { select: { ragioneSociale: true, email: true } },
            righe: true,
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        })
      : [];

    // ===== BLOCCO DATI =====
    let ctx = "=== DATI GESTIONALE UTENTE ===\n";

    // Anagrafiche
    const clienti = anagrafiche.filter((a) => a.tipo === "CLIENTE");
    const fornitori = anagrafiche.filter((a) => a.tipo === "FORNITORE");
    const lead = anagrafiche.filter((a) => a.tipo === "LEAD");

    if (clienti.length > 0) {
      ctx += "\n--- CLIENTI ---\n";
      for (const c of clienti) {
        ctx += `[${c.id}] ${c.ragioneSociale}`;
        if (c.email) ctx += ` | email: ${c.email}`;
        if (c.telefono) ctx += ` | tel: ${c.telefono}`;
        if (c.pivaCf) ctx += ` | P.IVA/CF: ${c.pivaCf}`;
        if (c.indirizzoCompleto) ctx += ` | indirizzo: ${c.indirizzoCompleto}`;
        if (c.referente) ctx += ` | referente: ${c.referente}`;
        if (c.noteAi) ctx += ` | note: ${c.noteAi}`;
        ctx += "\n";
      }
    }

    if (fornitori.length > 0) {
      ctx += "\n--- FORNITORI ---\n";
      for (const f of fornitori) {
        ctx += `[${f.id}] ${f.ragioneSociale}`;
        if (f.email) ctx += ` | email: ${f.email}`;
        if (f.telefono) ctx += ` | tel: ${f.telefono}`;
        if (f.pivaCf) ctx += ` | P.IVA/CF: ${f.pivaCf}`;
        ctx += "\n";
      }
    }

    if (lead.length > 0) {
      ctx += "\n--- LEAD ---\n";
      for (const l of lead) {
        ctx += `[${l.id}] ${l.ragioneSociale}`;
        if (l.email) ctx += ` | email: ${l.email}`;
        ctx += "\n";
      }
    }

    if (anagrafiche.length === 0) ctx += "\nNessuna anagrafica registrata.\n";

    // Catalogo prodotti
    if (prodotti.length > 0) {
      ctx += "\n--- CATALOGO PRODOTTI/SERVIZI ---\n";
      for (const p of prodotti) {
        ctx += `[${p.id}] ${p.nomeProdotto}`;
        if (p.sku) ctx += ` | SKU: ${p.sku}`;
        ctx += ` | tipo: ${p.tipoArticolo}`;
        ctx += ` | prezzo: €${p.prezzoVendita.toFixed(2)} | IVA: ${p.aliquotaIva}%`;
        if (p.categoria) ctx += ` | cat: ${p.categoria}`;
        if (p.descrizione) ctx += ` | desc: ${p.descrizione}`;
        ctx += "\n";
      }
    } else {
      ctx += "\nNessun prodotto/servizio nel catalogo.\n";
    }

    // Documenti (se richiesti)
    if (documenti.length > 0) {
      ctx += "\n--- DOCUMENTI (ultimi 50) ---\n";
      let totAccettati = 0;
      let totInviati = 0;
      let totBozze = 0;

      for (const doc of documenti) {
        const totali = calcolaTotali(
          doc.righe.map((r) => ({
            quantita: r.quantita,
            prezzoUnitarioApplicato: r.prezzoUnitarioApplicato,
            scontoPercentuale: r.scontoPercentuale,
            aliquotaIva: r.aliquotaIva,
          }))
        );
        const lordo = totali.totaleLordo;

        if (doc.stato === "ACCETTATO") totAccettati += lordo;
        if (doc.stato === "INVIATO") totInviati += lordo;
        if (doc.stato === "BOZZA") totBozze += lordo;

        ctx += `N°${doc.numero} | ${doc.tipoDocumento} | ${doc.stato}`;
        ctx += ` | Cliente: ${doc.anagrafica?.ragioneSociale || "N/D"}`;
        if (doc.oggetto) ctx += ` | Oggetto: ${doc.oggetto}`;
        ctx += ` | Lordo: €${lordo.toFixed(2)}`;
        ctx += ` | Data: ${doc.createdAt.toLocaleDateString("it-IT")}\n`;
      }

      ctx += `\nRIEPILOGO COMMERCIALE:\n`;
      ctx += `  Accettati: €${totAccettati.toFixed(2)}\n`;
      ctx += `  Inviati (in attesa): €${totInviati.toFixed(2)}\n`;
      ctx += `  Bozze: €${totBozze.toFixed(2)}\n`;
      ctx += `  Totale pipeline: €${(totAccettati + totInviati).toFixed(2)}\n`;
    }

    ctx += "\n=== FINE DATI GESTIONALE ===\n\n";
    ctx +=
      "ISTRUZIONI PER L'AGENTE:\n" +
      "- Usa i dati qui sopra per rispondere alla richiesta.\n" +
      "- Per preventivi/fatture: usa i dati ESATTI di anagrafiche e prodotti.\n" +
      "- Per trovare un cliente/prodotto per nome approssimativo: cerca il match più vicino.\n" +
      "- NON inventare prezzi, email o P.IVA — usa solo quelli presenti.\n" +
      "- Se devi creare un PDF, il nodo pdf_maker userà questi dati direttamente.\n" +
      "- Per inviare email: usa l'email del cliente indicata sopra.";

    await logAudit(userId, "AGENT_ACCEDE_GESTIONALE", "OK", `Query: ${userMessage.slice(0, 100)}`);

    return {
      messages: [new SystemMessage(ctx)],
    };
  } catch (error: any) {
    console.error("Gestionale Error:", error);
    await logAudit(userId, "AGENT_GESTIONALE_ERRORE", "ERRORE", error.message);
    return {
      messages: [new SystemMessage(`Errore accesso gestionale: ${error.message}`)],
    };
  }
};
