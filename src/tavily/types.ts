export type TavilyApiConfig = {
  apiKeySet: boolean;
  apiKeyMasked: string;
  proxyUrlSet: boolean;
  proxyUrlMasked: string;
  updatedAt?: string;
};

export type TavilyApiConfigPatch = {
  apiKey?: string;
  clearApiKey?: boolean;
  proxyUrl?: string;
  clearProxyUrl?: boolean;
};

export type TavilySearchDepth = "basic" | "advanced" | "fast" | "ultra-fast";
export type TavilySearchTopic = "general" | "news" | "finance";
export type TavilyTimeRange = "day" | "week" | "month" | "year";

export type TavilySearchInput = {
  query: string;
  searchDepth?: TavilySearchDepth;
  topic?: TavilySearchTopic;
  timeRange?: TavilyTimeRange;
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
};

export type TavilySearchResult = {
  title: string;
  url: string;
  content: string;
  score?: number;
};

export type TavilySearchResponse = {
  query: string;
  results: TavilySearchResult[];
  responseTime?: number;
  requestId?: string;
  credits?: number;
};
