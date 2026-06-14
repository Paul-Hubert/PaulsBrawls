// Token estimation (layer 1) — the ONE approximate token counter shared by the context-pack
// (D-11 fitBudget) and the brain. Imports nothing but is intentionally dependency-free so any
// layer can size prompt text. This is a heuristic (≈4 chars/token, o200k-ish), NOT a real
// tokenizer: budgeting only needs an upper-ish bound that is stable and cheap (R19 — we budget
// by tokens, not message count, and one image/tool-result outweighs dozens of chat lines).
//
// Lives in render/ (not llm/) because it is a pure string utility with zero LLM-client coupling,
// and render/ imports only types/ — so both villagers/ and god/ may import it without either
// layer-3 actor importing the other (the dependency law).

/** Approximate token count of a piece of text (≈4 chars/token, min 1 for non-empty). */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
