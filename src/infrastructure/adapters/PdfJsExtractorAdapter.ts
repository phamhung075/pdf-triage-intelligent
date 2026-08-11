import { IPdfExtractorGateway, ExtractedPdfContent } from '../../domain/repositories/IPdfExtractorGateway.js';
import { extractPDFContent } from '../pdf-extractor.js';

export class PdfJsExtractorAdapter implements IPdfExtractorGateway {
  public async extractContent(filePath: string): Promise<ExtractedPdfContent> {
    const res = await extractPDFContent(filePath);
    return {
      raw_text: res.raw_text,
      numpages: res.numpages,
      info: res.info,
      checksum: res.checksum
    };
  }
}
