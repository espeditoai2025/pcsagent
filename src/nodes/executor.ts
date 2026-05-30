import { AgentState } from "../state";
import { executePythonScript } from "../services/dockerService";
import { SystemMessage } from "@langchain/core/messages";

// Pattern che identificano un problema di INFRASTRUTTURA (non del codice generato):
// immagine Docker mancante, daemon Docker non raggiungibile, ecc.
// In questi casi è inutile rigenerare il codice col self-healing: l'errore si ripeterebbe identico.
const INFRA_ERROR_PATTERNS = [
  "no such image",
  "pcsai-python",
  "cannot connect to the docker daemon",
  "connect enoent",       // socket Docker assente
  "econnrefused",         // daemon Docker giù
  "dockerdesktoplinuxengine",
  "//./pipe/docker_engine",
];

export function isInfrastructureError(error: string | null): boolean {
  if (!error) return false;
  const low = error.toLowerCase();
  return INFRA_ERROR_PATTERNS.some((p) => low.includes(p));
}

const INFRA_USER_MESSAGE =
  "⚠️ Al momento non riesco a eseguire codice: l'ambiente di esecuzione (container Docker) " +
  "non è disponibile sul server. Ho preparato la soluzione ma non posso lanciarla finché " +
  "l'ambiente non viene ripristinato. Riprova tra poco o contatta l'amministratore.";

export const executorNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  if (!state.pythonCode) {
    return { executionError: "No Python code provided." };
  }

  console.log(`Executing code (Attempt ${state.iterations})...`);
  const result = await executePythonScript(state.pythonCode);

  if (result.success) {
    return {
      executionError: null,
      finalResult: result.output,
      messages: [new SystemMessage(`Esecuzione completata con successo.\nOutput:\n${result.output}`)],
    };
  }

  console.error(`Esecuzione fallita: ${result.error}`);

  // Errore di infrastruttura: non riprovare, restituisci un messaggio comprensibile all'utente.
  if (isInfrastructureError(result.error)) {
    console.error("Errore di infrastruttura rilevato — self-healing disattivato.");
    return {
      executionError: result.error,
      finalResult: INFRA_USER_MESSAGE,
      messages: [new SystemMessage(`Esecuzione non disponibile (infrastruttura): ${result.error}`)],
    };
  }

  // Errore del codice generato: lascia che il self-healing riprovi.
  return {
    executionError: result.error,
    messages: [new SystemMessage(`Esecuzione fallita: ${result.error}`)],
  };
};

// Edge condizionale post-esecuzione
export const checkErrorEdge = (state: AgentState): string => {
  if (state.executionError === null) {
    return "finish"; // Successo
  }

  // Errore di infrastruttura: inutile rigenerare il codice, termina subito.
  if (isInfrastructureError(state.executionError)) {
    return "finish";
  }

  if (state.iterations >= 3) {
    return "finish"; // Fallimento controllato dopo 3 tentativi
  }

  return "coder"; // Torna indietro per il self-healing
};
