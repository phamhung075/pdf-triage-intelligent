import { SqliteDocumentRepository } from '../adapters/SqliteDocumentRepository.js';
import { FileCategoryRepository } from '../adapters/FileCategoryRepository.js';
import { FileManualDecisionRepository } from '../adapters/FileManualDecisionRepository.js';
import { OllamaClassifierAdapter } from '../adapters/OllamaClassifierAdapter.js';
import { PdfJsExtractorAdapter } from '../adapters/PdfJsExtractorAdapter.js';
import { LocalFileSystemAdapter } from '../adapters/LocalFileSystemAdapter.js';
import { TriageScanUseCase } from '../../application/use-cases/TriageScanUseCase.js';
import { RelocalizeDocumentUseCase } from '../../application/use-cases/RelocalizeDocumentUseCase.js';

export class Container {
  private static instance: Container;

  public readonly documentRepository = new SqliteDocumentRepository();
  public readonly categoryRepository = new FileCategoryRepository();
  public readonly manualDecisionRepository = new FileManualDecisionRepository();
  public readonly classifierGateway = new OllamaClassifierAdapter();
  public readonly pdfExtractorGateway = new PdfJsExtractorAdapter();
  public readonly fileSystemGateway = new LocalFileSystemAdapter();

  public readonly triageScanUseCase = new TriageScanUseCase(
    this.documentRepository,
    this.pdfExtractorGateway,
    this.classifierGateway,
    this.fileSystemGateway
  );

  public readonly relocalizeDocumentUseCase = new RelocalizeDocumentUseCase(
    this.documentRepository,
    this.categoryRepository,
    this.manualDecisionRepository,
    this.classifierGateway,
    this.pdfExtractorGateway,
    this.fileSystemGateway
  );

  public static getInstance(): Container {
    if (!Container.instance) {
      Container.instance = new Container();
    }
    return Container.instance;
  }
}
