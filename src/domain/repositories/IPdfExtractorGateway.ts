export interface ExtractedPdfContent {
  raw_text: string;
  numpages: number;
  info?: any;
  checksum: string;
}

export interface IPdfExtractorGateway {
  extractContent(filePath: string): Promise<ExtractedPdfContent>;
}
