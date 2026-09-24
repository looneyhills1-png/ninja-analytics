// Shared lightweight tokenizer used wherever this app compares real text
// (query vs title/meta/URL/blurb) for genuine word overlap - never a
// semantic/NLP model, just a small, auditable stopword-filtered token set so
// two texts don't score as "related" merely by both containing generic
// site/ticketing/English filler words.
const MIN_TOKEN_LENGTH = 3;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "your",
  "you",
  "are",
  "is",
  "in",
  "at",
  "on",
  "to",
  "of",
  "a",
  "an",
  "book",
  "buy",
  "find",
  "best",
  "top",
  "guide",
  "guides",
  "things",
  "do",
  "near",
  "tickets",
  "ticket",
  "event",
  "events",
  "ninjatickets",
  "com",
  "www",
  "http",
  "https",
  "html",
  "index",
  "co",
  "uk",
  // Generic ticketing/commerce filler that caused a real bad internal-link
  // suggestion (2026-09-24): "when do oasis tickets go on sale" shares the
  // token "sale" with the unrelated "Sale Sharks" rugby page (Sale is a
  // place/team name, coincidentally also this common English word). None of
  // these carry topical meaning on their own - filter them exactly like
  // "book"/"buy"/"tickets" above, so a shared generic word never counts as
  // genuine relevance.
  "sale",
  "sales",
  "onsale",
  "date",
  "dates",
  "release",
]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t),
  );
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}
