// lib/env.ts
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export const env = {
  pipedrive: {
    token: required("PD_API_TOKEN"),
    baseUrl: required("PD_API"), // z.B. https://xxx.pipedrive.com/api/v1
  },
  brave: {
    apiKey: required("BRAVE_API_KEY"),
  },
  openai: {
    apiKey: required("OPENAI_API_KEY"),
  },
  webhookSecret: required("WEBHOOK_SECRET"),
  pipelineId: process.env.PIPELINE_ID || null,
  stageId: process.env.STAGE_ID || null,
  productTrigger: process.env.PRODUCT_TRIGGER || null,
  fields: {
    emailIntro1: required("FIELD_EMAIL_INTRO_1"),
    emailIntro2: required("FIELD_EMAIL_INTRO_2"),
    emailIntro3: required("FIELD_EMAIL_INTRO_3"),
    enrichmentSummary: required("FIELD_ENRICHMENT_SUMMARY"),
    companyIndustry: required("FIELD_COMPANY_INDUSTRY"),
  },
};
