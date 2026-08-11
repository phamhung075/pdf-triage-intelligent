export class Category {
  private readonly id: string;
  private readonly name: string;
  private readonly description: string;
  private readonly aliases: string[];

  constructor(id: string, name?: string, description?: string, aliases: string[] = []) {
    const cleanId = (id || 'administrative').trim().toLowerCase();
    this.id = cleanId;
    this.name = name || cleanId.charAt(0).toUpperCase() + cleanId.slice(1);
    this.description = description || `Category ${cleanId}`;
    this.aliases = aliases.map(a => a.toLowerCase().trim()).filter(Boolean);
  }

  public getId(): string {
    return this.id;
  }

  public getName(): string {
    return this.name;
  }

  public getDescription(): string {
    return this.description;
  }

  public getAliases(): string[] {
    return [...this.aliases];
  }

  public equals(other?: Category): boolean {
    if (!other) return false;
    return this.id === other.getId();
  }
}
