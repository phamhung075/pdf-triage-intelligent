import { ILlmClassifierGateway } from '../../domain/repositories/ILlmClassifierGateway.js';
import { DocumentMetadata } from '../../domain/document.schema.js';
import { classifyPDFText } from '../../application/classify-document.js';
import { generateEmbedding } from '../ollama-client.js';

export class OllamaClassifierAdapter implements ILlmClassifierGateway {
  public async classify(rawText: string, filename: string, userFeedbackReason?: string): Promise<DocumentMetadata> {
    return await classifyPDFText(rawText, filename, userFeedbackReason);
  }

  public async generateEmbedding(text: string): Promise<number[]> {
    return await generateEmbedding(text);
  }
}
