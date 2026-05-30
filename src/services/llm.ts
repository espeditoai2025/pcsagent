import { ChatOpenAI } from "@langchain/openai";
import { TokenMeterHandler } from "./tokenMeter";
import dotenv from "dotenv";

dotenv.config();

const openRouterApiKey = process.env.OPENROUTER_API_KEY || "";

const CODER_MODEL = "google/gemini-3.1-flash-lite";
const SEARCH_MODEL = "perplexity/sonar";
const ROUTER_MODEL = "google/gemini-3.1-flash-lite";

const openRouterConfig = {
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: openRouterApiKey,
    defaultHeaders: {
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "X-Title": "AI Agent Builder",
    },
  },
  timeout: 90000, // 90s max — evita hang infiniti su OpenRouter
};

export const coderModel = new ChatOpenAI({
  ...openRouterConfig,
  modelName: CODER_MODEL,
  temperature: 0.1,
  callbacks: [new TokenMeterHandler(CODER_MODEL)],
});

export const searchModel = new ChatOpenAI({
  ...openRouterConfig,
  modelName: SEARCH_MODEL,
  temperature: 0.2,
  callbacks: [new TokenMeterHandler(SEARCH_MODEL)],
});

export const routerModel = new ChatOpenAI({
  ...openRouterConfig,
  modelName: ROUTER_MODEL,
  temperature: 0.0,
  callbacks: [new TokenMeterHandler(ROUTER_MODEL)],
});
