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
]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t),
  );
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}
