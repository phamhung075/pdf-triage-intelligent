import { Category } from '../model/Category.js';

export interface ICategoryRepository {
  getCategories(): Promise<Category[]>;
  saveCategories(categories: Category[]): Promise<void>;
  ensureCategoryAndSubcategory(category: string, subcategory: string): Promise<void>;
}
