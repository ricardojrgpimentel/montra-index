// A draft retains upstream prose without guessing its language. It must be
// curated before publication; placeholders are rejected by CI and proposal review.
export const DRAFT_SUMMARY = "English summary pending review";
export const DRAFT_DESCRIPTION = "English description pending review";

export function draftCatalogueText(original) {
  return {
    summary: DRAFT_SUMMARY,
    description: {
      en: DRAFT_DESCRIPTION,
      ...(original?.trim() ? { und: original.trim().slice(0, 4000) } : {}),
    },
  };
}

export function catalogueTextErrors(entry) {
  const errors = [];
  if (!entry.summary?.trim() || entry.summary.trim() === DRAFT_SUMMARY) {
    errors.push("Completa o resumo inglês em summary.");
  }
  if (!entry.description?.en?.trim() || entry.description.en.trim() === DRAFT_DESCRIPTION) {
    errors.push("Completa a descrição inglesa em description.en e preserva a língua original.");
  }
  return errors;
}
