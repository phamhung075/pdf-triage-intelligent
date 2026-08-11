export class DocumentId {
  private readonly id: number;

  constructor(id: number) {
    if (id < 0) {
      throw new Error('DocumentId cannot be negative');
    }
    this.id = id;
  }

  public getValue(): number {
    return this.id;
  }

  public equals(other?: DocumentId): boolean {
    if (!other) return false;
    return this.id === other.getValue();
  }

  public toString(): string {
    return String(this.id);
  }
}
