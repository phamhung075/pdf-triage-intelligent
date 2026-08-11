import { DocumentId } from './DocumentId.js';
import { Checksum } from './Checksum.js';
import { Category } from './Category.js';
import { Subcategory } from './Subcategory.js';
import { ContactInfo } from './ContactInfo.js';

export interface DocumentProps {
  id?: number;
  checksum: string;
  title: string;
  registre?: string;
  date?: string;
  category: string;
  subcategory: string;
  summary?: string;
  tags?: string[];
  rawText?: string;
  markdownContent?: string;
  totalAmount?: string;
  vatAmount?: string;
  siren?: string;
  iban?: string;
  expiryDate?: string;
  contact?: ContactInfo;
  originalFilename?: string;
  originalPath?: string;
  newPath?: string;
  status?: string;
}

export class Document {
  private readonly id?: DocumentId;
  private readonly checksum: Checksum;
  private title: string;
  private registre: string;
  private date: string;
  private category: Category;
  private subcategory: Subcategory;
  private summary: string;
  private tags: string[];
  private rawText: string;
  private markdownContent: string;
  private totalAmount: string;
  private vatAmount: string;
  private siren: string;
  private iban: string;
  private expiryDate: string;
  private contact: ContactInfo;
  private originalFilename: string;
  private originalPath: string;
  private newPath: string;
  private status: string;

  constructor(props: DocumentProps) {
    this.id = props.id !== undefined ? new DocumentId(props.id) : undefined;
    this.checksum = new Checksum(props.checksum);
    this.title = props.title || 'Untitled Document';
    this.registre = props.registre || '';
    this.date = props.date || new Date().toISOString().split('T')[0];
    this.category = new Category(props.category);
    this.subcategory = new Subcategory(props.subcategory);
    this.summary = props.summary || '';
    this.tags = props.tags || [];
    this.rawText = props.rawText || '';
    this.markdownContent = props.markdownContent || '';
    this.totalAmount = props.totalAmount || '';
    this.vatAmount = props.vatAmount || '';
    this.siren = props.siren || '';
    this.iban = props.iban || '';
    this.expiryDate = props.expiryDate || '';
    this.contact = props.contact || new ContactInfo();
    this.originalFilename = props.originalFilename || '';
    this.originalPath = props.originalPath || '';
    this.newPath = props.newPath || '';
    this.status = props.status || 'NEW';
  }

  public getId(): DocumentId | undefined { return this.id; }
  public getChecksum(): Checksum { return this.checksum; }
  public getTitle(): string { return this.title; }
  public getCategory(): Category { return this.category; }
  public getSubcategory(): Subcategory { return this.subcategory; }
  public getDate(): string { return this.date; }
  public getSummary(): string { return this.summary; }
  public getTags(): string[] { return [...this.tags]; }
  public getRawText(): string { return this.rawText; }
  public getMarkdownContent(): string { return this.markdownContent; }
  public getContact(): ContactInfo { return this.contact; }
  public getOriginalFilename(): string { return this.originalFilename; }
  public getOriginalPath(): string { return this.originalPath; }
  public getNewPath(): string { return this.newPath; }
  public getStatus(): string { return this.status; }

  public relocalize(newCategory: string, newSubcategory: string, newPath: string, newTitle?: string, newDate?: string): void {
    this.category = new Category(newCategory);
    this.subcategory = new Subcategory(newSubcategory);
    this.newPath = newPath;
    this.status = 'MOVED';
    if (newTitle) this.title = newTitle;
    if (newDate) this.date = newDate;
  }
}
