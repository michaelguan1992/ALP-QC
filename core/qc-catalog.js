import { fail, makeId, requireBoolean, requireRecord, requireString } from "./qc-domain.js";

export function createVariant(state, data, context) {
  const input = requireRecord(data, "Variant");
  const family = state.families.find((candidate) => candidate.id === input.familyId);
  if (!family) fail("Choose an available inspection family.");
  const model = requireString(input.model, "Product model", { maxLength: 30 });
  if (!family.models.includes(model)) fail(`Model ${model} does not belong to ${family.name}.`);
  const color = requireString(input.color, "Variant color", { maxLength: 80 });
  const label = requireString(input.label, "Variant display name", { maxLength: 160 });
  const duplicate = state.variants.some((variant) =>
    variant.familyId === family.id && variant.model === model &&
    variant.color.toLocaleLowerCase() === color.toLocaleLowerCase() &&
    variant.label.toLocaleLowerCase() === label.toLocaleLowerCase());
  if (duplicate) fail("A product variant with this model, color, and display name already exists.");
  const id = makeId(context.idFactory);
  state.variants.push({ id, familyId: family.id, model, color, label, active: true });
  return { entityId: id, action: "createVariant", summary: `Added variant ${label}.` };
}

export function setVariantActive(state, data) {
  const id = requireString(data.id, "Variant ID", { maxLength: 120 });
  const variant = state.variants.find((candidate) => candidate.id === id);
  if (!variant) fail("That product variant is no longer available.");
  const active = requireBoolean(data.active, "Variant active state");
  if (variant.active === active) return { entityId: id, changed: false, action: "setVariantActive", summary: `Variant ${variant.label} already has that active state.` };
  variant.active = active;
  return { entityId: id, action: "setVariantActive", summary: `${active ? "Activated" : "Archived"} variant ${variant.label}.` };
}
