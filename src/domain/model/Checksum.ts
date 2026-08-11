export class Checksum {
  private readonly value: string;

  constructor(value: string) {
    const trimmed = (value || '').trim().toLowerCase();
    if (!trimmed) {
      throw new Error('Checksum cannot be empty');
    }
    this.value = trimmed;
  }

  public getValue(): string {
    return this.value;
  }

  public equals(other?: Checksum): boolean {
    if (!other) return false;
    return this.value === other.getValue();
  }

  public toString(): string {
    return this.value;
  }
}
