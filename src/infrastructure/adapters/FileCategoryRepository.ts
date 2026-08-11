import { ICategoryRepository } from '../../domain/repositories/ICategoryRepository.js';
import { Category } from '../../domain/model/Category.js';
import { getCategoriesConfig, saveCategoriesConfig } from '../categories-store.js';
import { ensureCategoryAndSubcategoryExist } from '../../application/relocalize-document.js';

export class FileCategoryRepository implements ICategoryRepository {
  public async getCategories(): Promise<Category[]> {
    const config = getCategoriesConfig();
    return config.categories.map(c => new Category(c.id, c.name, c.description, c.aliases));
  }

  public async saveCategories(categories: Category[]): Promise<void> {
    const rawList = categories.map(c => ({
      id: c.getId(),
      name: c.getName(),
      description: c.getDescription(),
      aliases: c.getAliases(),
      subcategories: []
    }));
    saveCategoriesConfig(rawList);
  }

  public async ensureCategoryAndSubcategory(category: string, subcategory: string): Promise<void> {
    ensureCategoryAndSubcategoryExist(category, subcategory);
  }
}
