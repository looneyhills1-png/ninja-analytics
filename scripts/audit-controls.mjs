/**
 * Lists every <Button> / <button> in src with whether it carries help text.
 * Used by the coverage test (src/test/controls-help.test.ts) and by hand:
 *   node scripts/audit-controls.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (
      p.endsWith(".tsx") &&
      !p.endsWith(".test.tsx") &&
      !/[\\/]ui[\\/](button|tooltip|help-button)\.tsx$/.test(p)
    )
      out.push(p);
  }
  return out;
}

/** End index of the opening tag that starts at `start` (brace aware, so
 * arrow functions' `=>` inside attributes do not end it early). */
function tagEnd(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0 && src[i - 1] !== "=") return i;
  }
  return -1;
}

export function findControls(root = "src") {
  const found = [];
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    const re = /<(Button|button|HelpButton)(?=[\s>])/g;
    let m;
    while ((m = re.exec(src))) {
      const end = tagEnd(src, m.index);
      if (end < 0) continue;
      const tag = src.slice(m.index, end + 1);
      const line = src.slice(0, m.index).split("\n").length;
      const label = src
        .slice(end + 1, end + 160)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      // A raw <button> is covered when it sits directly inside <Tooltip ...>.
      const before = src.slice(Math.max(0, m.index - 400), m.index);
      const wrapped =
        /<(Tooltip|HelpTip)\b[^<]*>\s*$/.test(before) ||
        /<Tooltip\b[\s\S]*?>\s*$/.test(
          before.slice(before.lastIndexOf("<Tooltip")),
        );
      const helped =
        /\b(help|disabledReason)=/.test(tag) ||
        (m[1] === "Button" && /\btitle=/.test(tag)) ||
        wrapped;
      found.push({
        file: file.replace(/\\/g, "/"),
        line,
        kind: m[1],
        helped,
        label,
      });
    }
  }
  return found;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const all = findControls();
  const missing = all.filter((c) => !c.helped);
  for (const c of missing) {
    console.log(`${c.file}:${c.line} <${c.kind}> ${c.label}`);
  }
  console.log(`\n${all.length} controls, ${missing.length} without help`);
}
