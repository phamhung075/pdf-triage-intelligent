import { IDocumentRepository } from '../../domain/repositories/IDocumentRepository.js';
import { IPdfExtractorGateway } from '../../domain/repositories/IPdfExtractorGateway.js';
import { ILlmClassifierGateway } from '../../domain/repositories/ILlmClassifierGateway.js';
import { IFileSystemGateway } from '../../domain/repositories/IFileSystemGateway.js';
import { Document } from '../../domain/model/Document.js';
import { logger } from '../../infrastructure/logger.js';
import { syncJSONRegistry } from '../../infrastructure/json-registry.js';
import { acquireScanLock, ScanInProgressError } from '../scan-lock.js';

export interface TriageScanResult {
  indexedCount: number;
  duplicateCount: number;
  blockedCount: number;
  movedToRawsCount: number;
  relocalizedCount: number;
}

export class TriageScanUseCase {
  constructor(
    private readonly docRepo: IDocumentRepository,
    private readonly pdfExtractor: IPdfExtractorGateway,
    private readonly classifier: ILlmClassifierGateway,
    private readonly fileSystem: IFileSystemGateway
  ) {}

  public async execute(isAutoTriage: boolean = false): Promise<TriageScanResult> {
    let releaseLock: (() => void) | null = null;
    try {
      releaseLock = acquireScanLock();
    } catch (err) {
      if (err instanceof ScanInProgressError) {
        logger.warn('TRIAGE', 'Triage scan requested while scan is already running. Skipping.');
        return { indexedCount: 0, duplicateCount: 0, blockedCount: 0, movedToRawsCount: 0, relocalizedCount: 0 };
      }
      throw err;
    }

    try {
      const result: TriageScanResult = {
        indexedCount: 0,
        duplicateCount: 0,
        blockedCount: 0,
        movedToRawsCount: 0,
        relocalizedCount: 0
      };

      const files = this.fileSystem.getRawPdfFiles();
      logger.info('TRIAGE', `Starting triage scan of ${files.length} raw PDF files...`);

      for (const filePath of files) {
        try {
          const { raw_text, checksum } = await this.pdfExtractor.extractContent(filePath);
          const existing = await this.docRepo.findByChecksum(checksum);

          if (existing) {
            result.duplicateCount++;
            continue;
          }

          const metadata = await this.classifier.classify(raw_text, filePath);
          const targetCat = metadata.categorie;
          const targetSub = metadata.subcategorie;

          const isGenericTarget = !targetSub || targetSub === 'general' || targetSub === 'other' || targetSub === 'divers';
          if (isGenericTarget) {
            logger.warn('TRIAGE', `File '${filePath}' blocked because no specific subcategory was assigned.`);
            result.blockedCount++;
            continue;
          }

          const { newPath, moved } = this.fileSystem.relocalizeFile(
            filePath,
            targetCat,
            targetSub,
            metadata.date,
            metadata.titre
          );

          if (moved) result.relocalizedCount++;

          const doc = new Document({
            checksum,
            title: metadata.titre || filePath.replace(/\.pdf$/i, ''),
            registre: metadata.registre || '',
            date: metadata.date || '',
            category: targetCat,
            subcategory: targetSub,
            summary: metadata.summary || '',
            tags: metadata.tags || [],
            rawText: raw_text,
            markdownContent: metadata.markdown_content || '',
            totalAmount: metadata.total_amount || '',
            vatAmount: metadata.vat_amount || '',
            siren: metadata.siren || '',
            iban: metadata.iban || '',
            expiryDate: metadata.expiry_date || '',
            originalFilename: filePath,
            originalPath: filePath,
            newPath,
            status: 'MOVED'
          });

          await this.docRepo.save(doc);
          result.indexedCount++;
        } catch (err) {
          logger.error('TRIAGE', `Error triaging file ${filePath}:`, err);
        }
      }

      await syncJSONRegistry();
      return result;
    } finally {
      if (releaseLock) releaseLock();
    }
  }
}
