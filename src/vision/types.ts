export type VisionMode = "auto" | "direct" | "mcp" | "off";
export type VisionDetail = "auto" | "low" | "high";
export type VisionFeature = "caption" | "ocr" | "layout";

export type VisionApiConfig = {
  mode: VisionMode;
  baseUrl: string;
  model: string;
  apiKeySet: boolean;
  apiKeyMasked: string;
  detail: VisionDetail;
  maxImages: number;
  maxOutputTokens: number;
  updatedAt?: string;
};

export type VisionApiConfigPatch = {
  mode?: VisionMode;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  detail?: VisionDetail;
  maxImages?: number;
  maxOutputTokens?: number;
};

export type VisionAnalysisInput = {
  path: string;
  question: string;
  detail?: VisionDetail;
  features?: VisionFeature[];
};

export type VisionAnalysis = {
  path: string;
  summary: string;
  observations: string[];
  ocr: string[];
  uncertainties: string[];
  imageSha256: string;
  model: string;
  cached: boolean;
  /** The provider or the application reached an output limit. */
  truncated?: boolean;
};
