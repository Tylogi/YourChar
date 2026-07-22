export type WebReaderInput = {
  url: string;
  maxCharacters?: number;
};

export type WebReaderResult = {
  url: string;
  title: string;
  byline?: string;
  excerpt?: string;
  content: string;
  contentType: string;
  characters: number;
  truncated: boolean;
};

export type WebReaderResolvedAddress = {
  address: string;
  family: 4 | 6;
};
