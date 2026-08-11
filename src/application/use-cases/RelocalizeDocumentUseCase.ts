import { IDocumentRepository } from '../../domain/repositories/IDocumentRepository.js';
import { ICategoryRepository } from '../../domain/repositories/ICategoryRepository.js';
import { IManualDecisionRepository } from '../../domain/repositories/IManualDecisionRepository.js';
import { ILlmClassifierGateway } from '../../domain/repositories/ILlmClassifierGateway.js';
import { IPdfExtractorGateway } from '../../domain/repositories/IPdfExtractorGateway.js';
import { IFileSystemGateway } from '../../domain/repositories/IFileSystemGateway.js';
import { isForbiddenSubcategory } from '../../domain/taxonomy.js';
import { syncJSONRegistry } from '../../infrastructure/json-registry.js';
import { logger } from '../../infrastructure/logger.js';

export interface RelocalizeResult {
  success: boolean;
  staleCleaned?: boolean;
  error?: string;
  message?: string;
  document?: any;
}

export class RelocalizeDocumentUseCase {
  constructor(
    private readonly docRepo: IDocumentRepository,
    private readonly categoryRepo: ICategoryRepository,
    private readonly manualDecisionRepo: IManualDecisionRepository,
    private readonly classifier: ILlmClassifierGateway,
    private readonly pdfExtractor: IPdfExtractorGateway,
    private readonly fileSystem: IFileSystemGateway
  ) {}

  public async execute(
    id: number,
    explicitCategory?: string,
    explicitSubcategory?: string,
    userFeedbackReason?: string
  ): Promise<RelocalizeResult> {
    const doc = await this.docRepo.findById(id);
    if (!doc) {
      return { success: false, error: 'Document not found' };
    }

    if (explicitSubcategory !== undefined && isForbiddenSubcategory(explicitSubcategory)) {
      return { success: false, error: `'${explicitSubcategory}' is not a valid subcategory (general/other/divers/year strings are not allowed — Golden Rule #4). Please choose a specific entity or document-type name.` };
    }

    const docProps = {
      original_filename: doc.getOriginalFilename(),
      original_path: doc.getOriginalPath(),
      new_path: doc.getNewPath()
    };

    const actualPath = this.fileSystem.findFileOnDisk(docProps);
    if (!actualPath) {
      logger.info('RELOCALIZE', `Purging stale ghost database record ID ${id} (${doc.getTitle()}) - missing on disk`);
      await this.docRepo.delete(id);
      await syncJSONRegistry();
      return {
        success: false,
        staleCleaned: true,
        error: `Physical file '${doc.getOriginalFilename() || doc.getTitle()}' was missing on disk. Cleaned up stale record.`
      };
    }

    const { raw_text } = await this.pdfExtractor.extractContent(actualPath);
    const textToAnalyze = (raw_text && raw_text.trim().length > 10) ? raw_text : doc.getRawText();

    let newCategory = doc.getCategory().getId();
    let newSubcategory = doc.getSubcategory().getSlug();
    let newTitle = doc.getTitle();
    let newDate = doc.getDate();
    let newSummary = doc.getSummary();
    let newMarkdown = doc.getMarkdownContent();

    if (explicitCategory && explicitSubcategory) {
      newCategory = explicitCategory.toLowerCase().trim();
      newSubcategory = explicitSubcategory.toLowerCase().trim();
      await this.categoryRepo.ensureCategoryAndSubcategory(newCategory, newSubcategory);
    } else {
      logger.info('RELOCALIZE', `Re-analyzing document content with AI for ID ${id} (${doc.getTitle()})...`, { userFeedbackReason });
      const meta = await this.classifier.classify(textToAnalyze, doc.getOriginalFilename() || actualPath, userFeedbackReason);

      newCategory = meta.categorie;
      newSubcategory = meta.subcategorie;
      newTitle = meta.titre || doc.getTitle();
      newDate = meta.date || doc.getDate();
      newSummary = meta.summary || doc.getSummary();
      newMarkdown = meta.markdown_content || doc.getMarkdownContent();
    }

    const { newPath, moved } = this.fileSystem.relocalizeFile(actualPath, newCategory, newSubcategory, newDate, newTitle);

    await this.docRepo.update(id, {
      title: newTitle,
      category: newCategory,
      subcategory: newSubcategory,
      date: newDate,
      summary: newSummary,
      markdown_content: newMarkdown,
      new_path: newPath,
      status: 'MOVED'
    });

    if (doc.getCategory().getId() !== newCategory || doc.getSubcategory().getSlug() !== newSubcategory || userFeedbackReason || explicitCategory) {
      await this.manualDecisionRepo.recordDecision({
        document_id: id,
        checksum: doc.getChecksum().getValue(),
        original_filename: doc.getOriginalFilename() || actualPath,
        title: newTitle,
        old_category: doc.getCategory().getId(),
        old_subcategory: doc.getSubcategory().getSlug(),
        new_category: newCategory,
        new_subcategory: newSubcategory,
        user_feedback_reason: userFeedbackReason || (explicitCategory ? 'Manual user selection' : 'AI re-analysis'),
        raw_text_snippet: textToAnalyze
      });
    }

    await syncJSONRegistry();
    const updatedDoc = await this.docRepo.findById(id);

    return {
      success: true,
      message: moved
        ? `📍 Re-analyzed & relocated document to: ${newCategory.toUpperCase()} / ${newSubcategory.toUpperCase()}`
        : `📍 Document re-analyzed & confirmed in canonical location: ${newCategory.toUpperCase()} / ${newSubcategory.toUpperCase()}`,
      document: updatedDoc
    };
  }
}
