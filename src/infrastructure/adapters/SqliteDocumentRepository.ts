import { IDocumentRepository } from '../../domain/repositories/IDocumentRepository.js';
import { Document } from '../../domain/model/Document.js';
import { ContactInfo } from '../../domain/model/ContactInfo.js';
import { getDb, getAllDocuments, getDocumentById, getDocumentByChecksum, insertDocumentRecord, updateDocumentRecord, getCategorySubcategoryStats } from '../db/database.js';

export class SqliteDocumentRepository implements IDocumentRepository {
  public async findById(id: number): Promise<Document | null> {
    const raw = await getDocumentById(id);
    if (!raw) return null;
    return this.mapToDomain(raw);
  }

  public async findByChecksum(checksum: string): Promise<Document | null> {
    const raw = await getDocumentByChecksum(checksum);
    if (!raw) return null;
    return this.mapToDomain(raw);
  }

  public async getAllDocuments(): Promise<Document[]> {
    const rawList = await getAllDocuments();
    return rawList.map(r => this.mapToDomain(r));
  }

  public async save(document: Document): Promise<number> {
    const id = await insertDocumentRecord({
      checksum: document.getChecksum().getValue(),
      title: document.getTitle(),
      registre: '',
      date: document.getDate(),
      category: document.getCategory().getId(),
      subcategory: document.getSubcategory().getSlug(),
      summary: document.getSummary(),
      tags: document.getTags(),
      raw_text: document.getRawText(),
      markdown_content: document.getMarkdownContent(),
      contact_name: document.getContact().getName(),
      contact_email: document.getContact().getEmail(),
      contact_phone: document.getContact().getPhone(),
      contact_address: document.getContact().getAddress(),
      contact_website: document.getContact().getWebsite(),
      original_filename: document.getOriginalFilename(),
      original_path: document.getOriginalPath(),
      new_path: document.getNewPath(),
      status: document.getStatus()
    });
    return id;
  }

  public async update(id: number, updates: Partial<any>): Promise<void> {
    await updateDocumentRecord(id, updates);
  }

  public async delete(id: number): Promise<void> {
    const db = await getDb();
    await db.run('DELETE FROM documents WHERE id = ?', [id]);
    try {
      await db.run('DELETE FROM documents_fts WHERE doc_id = ?', [id]);
    } catch (e) {}
  }

  public async clearAll(): Promise<void> {
    const db = await getDb();
    await db.run('DELETE FROM documents');
    try {
      await db.run('DELETE FROM documents_fts');
    } catch (e) {}
  }

  public async getCategorySubcategoryStats() {
    return await getCategorySubcategoryStats();
  }

  private mapToDomain(raw: any): Document {
    return new Document({
      id: raw.id,
      checksum: raw.checksum,
      title: raw.title,
      registre: raw.registre,
      date: raw.date,
      category: raw.category,
      subcategory: raw.subcategory,
      summary: raw.summary,
      tags: Array.isArray(raw.tags) ? raw.tags : JSON.parse(raw.tags || '[]'),
      rawText: raw.raw_text,
      markdownContent: raw.markdown_content,
      totalAmount: raw.total_amount,
      vatAmount: raw.vat_amount,
      siren: raw.siren,
      iban: raw.iban,
      expiryDate: raw.expiry_date,
      contact: new ContactInfo({
        name: raw.contact_name,
        email: raw.contact_email,
        phone: raw.contact_phone,
        address: raw.contact_address,
        website: raw.contact_website
      }),
      originalFilename: raw.original_filename,
      originalPath: raw.original_path,
      newPath: raw.new_path,
      status: raw.status
    });
  }
}
