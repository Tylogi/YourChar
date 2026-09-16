export type DocumentConversionEngine = "officeparser";

export type DocumentConversion = {
  engine: DocumentConversionEngine;
  title?: string;
  markdown: string;
  sourceSha256: string;
  cached: boolean;
};

export type DocumentReadInput = {
  path: string;
  offset?: number;
  limit?: number;
};

export type DocumentReadResult = {
  path: string;
  engine: DocumentConversionEngine;
  title?: string;
  sourceSha256: string;
  offset: number;
  lines: number;
  totalLines: number;
  nextOffset?: number;
  cached: boolean;
  markdown: string;
};
