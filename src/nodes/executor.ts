import { AgentState } from "../state";
import { executePythonScript } from "../services/dockerService";
import { SystemMessage } from "@langchain/core/messages";

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
  } else {
    console.error(`Esecuzione fallita: ${result.error}`);
    return {
      executionError: result.error,
      messages: [new SystemMessage(`Esecuzione fallita: ${result.error}`)],
    };
  }
};

// Edge condizionale post-esecuzione
export const checkErrorEdge = (state: AgentState): string => {
  if (state.executionError === null) {
    return "finish"; // Successo
  }
  
  if (state.iterations >= 3) {
    return "finish"; // Fallimento controllato dopo 3 tentativi
  }
  
  return "coder"; // Torna indietro per il self-healing
};
