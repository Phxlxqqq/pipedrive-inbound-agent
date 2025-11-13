// lib/openaiClient.ts
import OpenAI from "openai";
import { env } from "./env";

export const openai = new OpenAI({
  apiKey: env.openai.apiKey,
});
