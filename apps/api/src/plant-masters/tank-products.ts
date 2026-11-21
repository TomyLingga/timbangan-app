// Which product a storage tank holds. A tank has a product, or only the product label Odoo keeps in the comment of
// its location ("CPO", "Olein", "PFAD"), or neither (it takes any product).
import { inArray } from "drizzle-orm";
import type { Orm } from "../db/client.js";
import { products } from "../db/schema.js";

export interface LabelledProduct {
  name: string;
  code: string | null;
  category: string;
}

const normal = (text: string) => text.trim().toLowerCase();

/**
 * Whether an Odoo tank label names this product: its name or its code in any case, or "CPO" for a product of
 * category CPO (the label is a short product name, the synced product is called "Crude Palm Oil" or similar).
 */
export function labelFits(label: string, product: LabelledProduct): boolean {
  const wanted = normal(label);
  if (wanted === "") return false;
  if (normal(product.name) === wanted || (product.code !== null && normal(product.code) === wanted)) return true;
  return wanted === "cpo" && product.category === "CPO";
}

/** The one product a label names, or null when none or several do. An exact name or code wins over the CPO rule. */
export function productForLabel<T extends LabelledProduct & { id: number }>(label: string | null, candidates: T[]): number | null {
  if (label === null || normal(label) === "") return null;
  const wanted = normal(label);
  const exact = candidates.filter((product) => normal(product.name) === wanted || (product.code !== null && normal(product.code) === wanted));
  if (exact.length > 0) return exact.length === 1 ? (exact[0]?.id ?? null) : null;
  const byCategory = candidates.filter((product) => labelFits(label, product));
  return byCategory.length === 1 ? (byCategory[0]?.id ?? null) : null;
}

/**
 * Whether the tank may take one of these products: its own product, or when it has none, a label that names one
 * of them; a tank without product and label takes any.
 */
export function tankTakes(tank: { productId: number | null; productLabel: string | null }, truckProducts: (LabelledProduct & { id: number })[]): boolean {
  if (tank.productId !== null) return truckProducts.some((product) => product.id === tank.productId);
  if (tank.productLabel === null || normal(tank.productLabel) === "") return true;
  const label = tank.productLabel;
  return truckProducts.some((product) => labelFits(label, product));
}

/** Name, code and category of the products with these ids. */
export async function productsByIds(orm: Orm, ids: number[]) {
  if (ids.length === 0) return [];
  return orm.select({ id: products.id, name: products.name, code: products.code, category: products.category }).from(products).where(inArray(products.id, ids));
}
