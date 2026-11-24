// Which product a storage tank holds. A tank has a product, or only the product label Odoo keeps in the comment of
// its location ("CPO", "Olein", "PFAD"), or neither (then no field form uses it).
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
 * of them; a tank without product and label takes any (tankUse refuses that tank before asking).
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

/** Whether the label is a whole word, or whole words, of the product's name or code, in any case. */
export function labelNamesProduct(label: string, product: LabelledProduct): boolean {
  const wanted = normal(label);
  if (wanted === "") return false;
  const pattern = new RegExp(`(^|[^a-z0-9])${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`);
  return [product.name, product.code ?? ""].some((text) => pattern.test(normal(text)));
}

/** A tank as the field forms judge it; `productCategory` is the category of its own product, if any. */
export interface FormTank {
  productId: number | null;
  productLabel: string | null;
  productCategory: string | null;
  erpRef: string | null;
}

/** A tank that says what it holds: a product or a label. A tank with neither is never used by a form. */
export const tankIsLabelled = (tank: { productId: number | null; productLabel: string | null }) =>
  tank.productId !== null || (tank.productLabel !== null && normal(tank.productLabel) !== "");

const isCpoTank = (tank: FormTank) => tank.productCategory === "CPO" || (tank.productLabel !== null && normal(tank.productLabel) === "cpo");

/**
 * How a form may use the tank for a truck of this direction carrying these products, following the old system:
 * "fits" (the tank holds the truck's product), "other" (an outgoing truck may still be loaded from it), or null.
 * - a tank without product and label: never;
 * - a tank made in this application (no erp_ref): only for its own product, as before;
 * - incoming CPO: CPO tanks (product of category CPO, or the label "CPO");
 * - other incoming goods: a tank of the product, or whose label names it;
 * - outgoing: any tank that is not a CPO tank, those of the product first.
 */
export function tankUse(tank: FormTank, direction: "IN" | "OUT", truckProducts: (LabelledProduct & { id: number })[]): "fits" | "other" | null {
  if (!tankIsLabelled(tank)) return null;
  const label = tank.productLabel !== null && normal(tank.productLabel) !== "" ? tank.productLabel : null;
  const holds = truckProducts.some((product) => product.id === tank.productId || (label !== null && (labelFits(label, product) || labelNamesProduct(label, product))));
  if (tank.erpRef === null) return tankTakes(tank, truckProducts) ? "fits" : null;
  if (direction === "IN") {
    if (truckProducts.some((product) => product.category === "CPO")) return isCpoTank(tank) ? "fits" : null;
    return holds ? "fits" : null;
  }
  if (isCpoTank(tank)) return null;
  return holds ? "fits" : "other";
}
