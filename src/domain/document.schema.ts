import { z } from 'zod';

export type SubcategoryItem = {
  id: string;
  name: string;
  name_fr?: string;
  name_en?: string;
  aliases?: string[];
  subcategories?: SubcategoryItem[];
};

export const SubcategorySchema: z.ZodType<SubcategoryItem> = z.lazy(() =>
  z.object({
    id: z.string().min(1, "Subcategory ID is required"),
    name: z.string().min(1, "Subcategory Name is required"),
    name_fr: z.string().optional(),
    name_en: z.string().optional(),
    aliases: z.array(z.string()).optional().default([]),
    subcategories: z.array(SubcategorySchema).optional().default([])
  })
);

export const CategorySchema = z.object({
  id: z.string().min(1, "ID is required"),
  name: z.string().min(1, "Name is required"),
  name_fr: z.string().optional(),
  name_en: z.string().optional(),
  description: z.string().optional().default(""),
  description_fr: z.string().optional(),
  description_en: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  subcategories: z.array(SubcategorySchema).optional().default([])
});

export const CategoriesConfigSchema = z.object({
  categories: z.array(CategorySchema)
});

export const EntityItemSchema = z.object({
  slug: z.string().min(1, "Entity slug is required"),
  name: z.string().min(1, "Entity name is required"),
  aliases: z.array(z.string()).optional().default([])
});

export const EntityDictionarySchema = z.object({
  banks: z.array(EntityItemSchema).optional().default([]),
  energy: z.array(EntityItemSchema).optional().default([]),
  telecom: z.array(EntityItemSchema).optional().default([]),
  insurance: z.array(EntityItemSchema).optional().default([]),
  gov: z.array(EntityItemSchema).optional().default([]),
  health: z.array(EntityItemSchema).optional().default([])
});

export type EntityItem = z.infer<typeof EntityItemSchema>;
export type EntityDictionary = z.infer<typeof EntityDictionarySchema>;

export const SystemSettingsSchema = z.object({
  language: z.string().optional(),
  input_dir: z.string().min(1, "Input directory is required"),
  output_root_dir: z.string().min(1, "Output directory is required"),
  ollama_model: z.string().min(1, "Ollama model is required").refine(
    (val) => val === 'qwen3.5:9b',
    { message: "Only 'qwen3.5:9b' is supported (Golden Rule #14) — other models, including cloud/subscription-gated ones, are rejected." }
  ),
  ollama_host: z.string().min(1, "Ollama host is required"),
  // No .default([]) — an absent field must stay `undefined` so updateConfig() can tell
  // "the caller didn't send this" apart from "the caller explicitly wants it cleared";
  // otherwise every settings save from a client that doesn't know this field (e.g. the
  // current UI form) would silently reset it to CONFIG's default list.
  personal_name_denylist: z.array(z.string()).optional()
});

// Nullable optional-string fields: Qwen frequently returns an explicit JSON `null` (not an
// absent key) for a field that doesn't apply to this document type (e.g. `expiry_date` on a
// bank statement, `iban` on a payslip). Plain `z.string().optional()` only tolerates `undefined`
// — an explicit `null` fails validation with "Expected string, received null", which threw
// DocumentMetadataSchema.parse() into classify-document.ts's catch block, discarding the whole
// Step A/C/D result and silently downgrading the document to the generic rule-based fallback
// classifier (often landing it in .blocked_files). `.nullable()` + a transform normalizes
// null/undefined to the same "" default a real absent field already got.
const nullableOptionalString = z.string().nullable().optional().transform((v) => v ?? "");

// Same null-tolerance as nullableOptionalString, for the one array field. Qwen returns
// "tags": null about as often as it omits the key.
const nullableOptionalStringArray = z.array(z.string()).nullable().optional().transform((v) => v ?? []);

export const DocumentMetadataSchema = z.object({
  // Every non-required field below is null-tolerant. The previous pass fixed only the contact_*
  // and amount fields, leaving these six on plain .default(""), which handles an ABSENT key but
  // still throws "Expected string, received null" on an explicit JSON null — the exact failure
  // the comment above describes, just on a different set of keys. One null `registre` or `date`
  // discarded the whole Step A/C/D result and downgraded the document to the rule-based fallback.
  thinking: nullableOptionalString,
  titre: z.string().min(1, "Titre est requis"),
  registre: nullableOptionalString,
  date: nullableOptionalString,
  categorie: z.string().min(1, "Catégorie est requise"),
  subcategorie: nullableOptionalString,
  summary: nullableOptionalString,
  tags: nullableOptionalStringArray,
  markdown_content: nullableOptionalString,
  total_amount: nullableOptionalString,
  vat_amount: nullableOptionalString,
  siren: nullableOptionalString,
  iban: nullableOptionalString,
  expiry_date: nullableOptionalString,
  contact_name: nullableOptionalString,
  contact_email: nullableOptionalString,
  contact_phone: nullableOptionalString,
  contact_address: nullableOptionalString,
  contact_website: nullableOptionalString,
  other: z.record(z.string(), z.any()).optional().default({})
});

export const UpdateDocumentSchema = z.object({
  title: z.string().optional(),
  titre: z.string().optional(),
  registre: z.string().optional(),
  date: z.string().optional(),
  category: z.string().optional(),
  categorie: z.string().optional(),
  subcategory: z.string().optional(),
  subcategorie: z.string().optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  markdown_content: z.string().optional(),
  total_amount: z.string().optional(),
  vat_amount: z.string().optional(),
  siren: z.string().optional(),
  iban: z.string().optional(),
  expiry_date: z.string().optional(),
  contact_name: z.string().optional(),
  contact_email: z.string().optional(),
  contact_phone: z.string().optional(),
  contact_address: z.string().optional(),
  contact_website: z.string().optional()
});

export const SearchQuerySchema = z.object({
  query: z.string().default(""),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  mode: z.enum(['hybrid', 'keyword', 'semantic']).default('hybrid'),
  limit: z.number().int().positive().default(50)
});

export type DocumentMetadata = z.infer<typeof DocumentMetadataSchema>;
export type UpdateDocumentInput = z.infer<typeof UpdateDocumentSchema>;
export type SearchQuery = z.infer<typeof SearchQuerySchema>;
export type CategoryItem = z.infer<typeof CategorySchema>;
export type SystemSettings = z.infer<typeof SystemSettingsSchema>;
