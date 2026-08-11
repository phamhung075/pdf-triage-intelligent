import { Document } from '../model/Document.js';

export interface IDocumentRepository {
  findById(id: number): Promise<Document | null>;
  findByChecksum(checksum: string): Promise<Document | null>;
  getAllDocuments(): Promise<Document[]>;
  save(document: Document): Promise<number>;
  update(id: number, updates: Partial<any>): Promise<void>;
  delete(id: number): Promise<void>;
  clearAll(): Promise<void>;
  getCategorySubcategoryStats(): Promise<{ total: number; categoryCounts: Record<string, number>; subcategoryCounts: Record<string, Record<string, number>> }>;
}
