import { DocumentMetadata } from '../document.schema.js';

export interface ILlmClassifierGateway {
  classify(rawText: string, filename: string, userFeedbackReason?: string): Promise<DocumentMetadata>;
  generateEmbedding(text: string): Promise<number[]>;
}
