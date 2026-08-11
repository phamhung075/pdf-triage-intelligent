import { isForbiddenSubcategory } from '../taxonomy.js';

export class Subcategory {
  private readonly slug: string;
  private readonly name: string;

  constructor(slug: string, name?: string) {
    const cleanSlug = (slug || 'general').trim().toLowerCase();
    this.slug = cleanSlug;
    this.name = name || cleanSlug.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  public getSlug(): string {
    return this.slug;
  }

  public getName(): string {
    return this.name;
  }

  public isGeneric(): boolean {
    return isForbiddenSubcategory(this.slug) || this.slug === 'general';
  }

  public equals(other?: Subcategory): boolean {
    if (!other) return false;
    return this.slug === other.getSlug();
  }
}
