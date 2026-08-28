// Shared classification logic between crisp-classify.mjs (the scheduled
// scan) and crisp-resolve-dispatch.mjs (the instant single-session
// trigger). Split out from crisp-classify.mjs specifically because that
// file runs its own main() unconditionally at the bottom -- importing
// anything from it directly would trigger a full Stage 1 scan as a side
// effect of the import.
import { getInboxKey } from "./crisp-client.mjs";
import { chatJSON } from "./openai-client.mjs";

// Single-product (or Crisp-tagged-inbox) account: just actionable/kind.
async function classify(transcript) {
  return chatJSON(
    "You triage customer support transcripts for a WordPress plugin company. " +
      "Given a transcript, decide if it describes an actionable software " +
      "defect (bug) or a genuine feature request -- as opposed to a billing " +
      "question, how-to question, client-side misconfiguration, or anything " +
      "that isn't a product code issue. Respond with ONLY a JSON object: " +
      '{"actionable": boolean, "kind": "bug" | "feature" | "none"}. ' +
      "Be conservative: when genuinely unsure whether it's a real product " +
      'defect, prefer {"actionable": false, "kind": "none"} -- the next ' +
      "stage is expensive, so false positives cost real money and false " +
      "negatives just wait for a clearer report.",
    transcript,
    { actionable: false, kind: "none" }
  );
}

// Multi-product account with no structured signal for which one: same
// actionable/kind decision plus product name (from the known list only) and
// free/pro edition. Unknown product is skipped and logged, not guessed at.
async function classifyWithProduct(transcript, productNames) {
  return chatJSON(
    "You triage customer support transcripts for a WordPress theme/plugin company " +
      "with many products. Given a transcript, decide (1) if it describes an " +
      "actionable software defect (bug) or a genuine feature request -- as opposed " +
      "to a billing question, how-to question, client-side misconfiguration, or " +
      "anything that isn't a product code issue; (2) which ONE product from this " +
      `exact list it is about: ${productNames.join(", ")}. Never invent a name not ` +
      'in this list -- if you cannot tell, or it doesn\'t match any of these, use ' +
      '"unknown"; (3) whether the transcript indicates the PRO/premium edition ' +
      "(mentions of a license, purchase, or Pro-only features) or the free edition " +
      "(the default when unclear). Respond with ONLY a JSON object: " +
      '{"actionable": boolean, "kind": "bug" | "feature" | "none", ' +
      '"product": "<exact-name-from-list>" | "unknown", "edition": "free" | "pro"}. ' +
      "Be conservative on actionable/kind: when genuinely unsure whether it's a " +
      'real product defect, prefer {"actionable": false, "kind": "none"} -- the ' +
      "next stage is expensive, so false positives cost real money and false " +
      "negatives just wait for a clearer report.",
    transcript,
    { actionable: false, kind: "none", product: "unknown", edition: "free" }
  );
}

// Three routing modes: a single-product account maps to one repo directly;
// `inboxes` is for when Crisp structurally tags which product an inbox
// serves; `products` is for many products with no such signal, so the
// classifier names one itself.
//
// `skipClassifier: true` (manual-trigger note) always returns
// actionable=true -- a human already made the call. Still runs
// classifyWithProduct for a `products` account to resolve the repo, ignoring
// that call's own actionable verdict.
export async function classifyAndRoute(accountConfig, conversation, transcript, { skipClassifier = false } = {}) {
  if (accountConfig.repo) {
    const { actionable, kind } = skipClassifier
      ? { actionable: true, kind: "bug" }
      : await classify(transcript);
    return { repo: accountConfig.repo, actionable, kind };
  }

  if (accountConfig.products) {
    const productNames = Object.keys(accountConfig.products);
    const result = await classifyWithProduct(transcript, productNames);
    const mapping = accountConfig.products[result.product];
    if (!mapping) return { repo: null, unmappedKey: `product:${result.product}` };
    const repo = result.edition === "pro" && mapping.pro ? mapping.pro : mapping.free;
    return skipClassifier
      ? { repo, actionable: true, kind: result.kind === "feature" ? "feature" : "bug" }
      : { repo, actionable: result.actionable, kind: result.kind };
  }

  const inboxKey = getInboxKey(conversation);
  const mapping = inboxKey && accountConfig.inboxes?.[inboxKey];
  if (!mapping) return { repo: null, unmappedKey: inboxKey };
  const { actionable, kind } = skipClassifier
    ? { actionable: true, kind: "bug" }
    : await classify(transcript);
  return { repo: mapping.repo, actionable, kind };
}
