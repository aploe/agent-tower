// Answering a held permission request in its row: the logic without the DOM.

/** How long the answer controls ignore clicks after they appeared or moved. A click that was
 *  already on its way when the list shifted must not allow a command. */
export const ARM_MS = 500;

/** The requests held for a row. A row from an older daemon, or an old fixture, has no such key. */
export function requestsOf(session) {
  return Array.isArray(session?.requests) ? session.requests : [];
}

/**
 * The selection after a click on option `index` of question `q`. `choices` holds one array
 * of option indices per question (undefined: nothing picked yet). A single choice takes the
 * clicked option; a multiple choice adds or removes it and stays sorted.
 */
export function toggleChoice(questions, choices, q, index) {
  const next = questions.map((_, k) => [...(choices?.[k] ?? [])]);
  if (!questions[q].multiSelect) next[q] = [index];
  else if (next[q].includes(index)) next[q] = next[q].filter((i) => i !== index);
  else next[q] = [...next[q], index].sort((a, b) => a - b);
  return next;
}

/** Whether every question has what it needs: exactly one option, or at least one for a
 *  multiple choice. */
export function choicesComplete(questions, choices) {
  return questions.every((question, k) => {
    const picked = choices?.[k] ?? [];
    return question.multiSelect ? picked.length >= 1 : picked.length === 1;
  });
}

/** One string for where the answer controls are: it changes when a block appears, leaves or
 *  moves, when the page height changes (the window then moves on screen) or the view does. */
export function layoutSignature({ view, height, blocks }) {
  return JSON.stringify([view, height, blocks.map((b) => [b.id, b.top])]);
}
