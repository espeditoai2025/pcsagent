import { AgentState } from "../state";
import { searchModel } from "../services/llm";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

export const searcherNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  const prompt = `Sei un esperto ricercatore web. Analizza la cronologia della conversazione ed esegui una ricerca approfondita usando il tuo accesso a Internet. Restituisci i risultati in modo strutturato e con fonti.`;
  
  const messages = [
    new SystemMessage(prompt),
    ...state.messages,
  ];

  const response = await searchModel.invoke(messages);

  return {
    messages: [response],
    finalResult: response.content as string,
  };
};
