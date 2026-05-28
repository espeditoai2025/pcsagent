import { ChatOpenAI } from "@langchain/openai";
import dotenv from "dotenv";

dotenv.config();

const openRouterApiKey = process.env.OPENROUTER_API_KEY || "";

// Configurazione base per OpenRouter
const openRouterConfig = {
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: openRouterApiKey,
    defaultHeaders: {
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "X-Title": "AI Agent Builder",
    },
  },
};

/**
 * Modello principale per ragionamento e coding.
 */
export const coderModel = new ChatOpenAI({
  ...openRouterConfig,
  modelName: "deepseek/deepseek-chat",
  temperature: 0.1, // Bassa temperatura per maggiore affidabilità nel codice
});

/**
 * Modello per ricerche web approfondite
 */
export const searchModel = new ChatOpenAI({
  ...openRouterConfig,
  modelName: "perplexity/sonar",
  temperature: 0.2,
});

/**
 * Modello per routing (può essere lo stesso del coder)
 */
export const routerModel = new ChatOpenAI({
  ...openRouterConfig,
  modelName: "deepseek/deepseek-chat",
  temperature: 0.0,
});
