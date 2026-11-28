// A small HTML tokenizer for the guard scans of index.html (D24). It follows the WHATWG tokenization states (data, RCDATA, RAWTEXT, script
// data with its escaped and double escaped states, PLAINTEXT, tags and attributes, comments including `--!>`, `<!-->` and `<!--->`, bogus
// comments, DOCTYPE) and does the one thing of the tree builder that changes tokenization: after a start tag it switches to RCDATA (title,
// textarea), RAWTEXT (style, xmp, iframe, noembed, noframes, noscript: scripting is on), script data (script) or PLAINTEXT (plaintext).
// So `<!--` inside <style>, <title>, <textarea>, <noscript> or a <script src> is NOT a comment, exactly as in a browser.
//
// What it does NOT do: the rest of the tree builder. Where the tree builder changes how the following text is tokenized in ways this scanner does
// not model (foreign content in <svg> / <math>, <select>, <frameset>), scanHtml reports the element in `ambiguous` and the callers refuse the file
// (fail closed). Character references are not decoded (they cannot change a tag name, an attribute NAME, the text of a script or where a token ends).
//
// This file exists twice, byte for byte: scripts/lib/html-scan.mjs (storefront guard) and admin/scripts/lib/html-scan.mjs (admin guard); tests/html-scan.test.mjs
// fails when the copies differ. Dependency free.

const WS = new Set([" ", "\t", "\n", "\f", "\r"]);
const isAlpha = (c) => c !== undefined && /[A-Za-z]/.test(c);
const RCDATA = new Set(["title", "textarea"]);
const RAWTEXT = new Set(["style", "xmp", "iframe", "noembed", "noframes", "noscript"]);
/** Elements whose content the tree builder parses with rules this scanner does not model. */
export const AMBIGUOUS = new Set(["svg", "math", "select", "frameset"]);

/**
 * Tokenize `html`. Returns { tokens, scripts, ambiguous, live }:
 *  tokens:    [{ type: "start", name, attrs: Map (first duplicate wins), selfClosing, start, end } | { type: "end", name, start, end } | { type: "comment", start, end } | { type: "doctype", start, end }]
 *  scripts:   every <script> element [{ attrs, text, unterminated, start }]; `unterminated` = no closing `>` of the start tag (end of file inside the tag) or no end tag
 *  ambiguous: names of start tags found that make the parse uncertain (see AMBIGUOUS)
 *  live:      the source text without the comment tokens
 */
export function scanHtml(html) {
  const s = String(html);
  const n = s.length;
  const tokens = [];
  const scripts = [];
  const ambiguous = [];
  let i = 0, state = "data", tokStart = 0;
  let tag = null; // the tag being built
  let attr = null;
  let lastStart = ""; // name of the last emitted start tag (the "appropriate end tag" test)
  let buf = ""; // the temporary buffer of the tokenizer spec
  let ret = "data"; // the text state to return to from the end-tag states
  let openScript = null;
  const c0 = () => s[i];
  const newTag = (type) => { tag = { type, name: "", attrs: new Map(), selfClosing: false, start: tokStart }; };
  const startAttr = (name) => { attr = { name, value: "" }; };
  const endAttr = () => { if (attr) { if (!tag.attrs.has(attr.name)) tag.attrs.set(attr.name, attr.value); attr = null; } };
  const emitTag = () => {
    endAttr();
    tag.end = i + 1; // i is at the ">"
    tokens.push(tag);
    if (tag.type === "start") {
      lastStart = tag.name;
      if (AMBIGUOUS.has(tag.name)) ambiguous.push(tag.name);
      if (tag.name === "script") { openScript = { attrs: tag.attrs, text: "", unterminated: false, start: tag.start, bodyStart: tag.end }; scripts.push(openScript); }
      state = RCDATA.has(tag.name) ? "rcdata" : RAWTEXT.has(tag.name) ? "rawtext" : tag.name === "script" ? "script" : tag.name === "plaintext" ? "plaintext" : "data";
    } else {
      if (tag.name === "script" && openScript) { openScript.text = s.slice(openScript.bodyStart, tag.start); openScript = null; }
      state = "data";
    }
    tag = null;
  };
  const emitComment = (endIdx) => { tokens.push({ type: "comment", start: tokStart, end: endIdx }); state = "data"; };
  // inside an end-tag-name state of a text mode: is the name collected so far the appropriate end tag?
  const appropriate = () => tag.type === "end" && tag.name === lastStart;
  const tail = (t) => s.slice(i, i + t.length).toLowerCase() === t;

  while (i <= n) {
    const c = c0(); // undefined at the end of the input
    switch (state) {
      case "data":
        if (c === "<") { tokStart = i; state = "tagOpen"; i++; } else i++;
        break;
      case "rcdata": case "rawtext":
        if (c === "<") { tokStart = i; ret = state; state = "textLt"; i++; } else i++;
        break;
      case "plaintext": i = n + 1; break;
      case "script":
        if (c === "<") { tokStart = i; state = "scriptLt"; i++; } else i++;
        break;
      case "tagOpen":
        if (c === "!") { state = "markupDecl"; i++; }
        else if (c === "/") { state = "endTagOpen"; i++; }
        else if (isAlpha(c)) { newTag("start"); state = "tagName"; }
        else if (c === "?") { state = "bogusComment"; }
        else state = "data"; // "<" is text
        break;
      case "endTagOpen":
        if (isAlpha(c)) { newTag("end"); state = "tagName"; }
        else if (c === ">") { state = "data"; i++; }
        else if (c === undefined) state = "data";
        else state = "bogusComment";
        break;
      case "tagName":
        if (c === undefined) { eofInTag(); i++; }
        else if (WS.has(c)) { state = "beforeAttrName"; i++; }
        else if (c === "/") { state = "selfClosing"; i++; }
        else if (c === ">") { emitTag(); i++; }
        else { tag.name += c.toLowerCase(); i++; }
        break;
      case "beforeAttrName":
        if (c === undefined) { eofInTag(); i++; }
        else if (WS.has(c)) i++;
        else if (c === "/") { state = "selfClosing"; i++; }
        else if (c === ">") { emitTag(); i++; }
        else if (c === "=") { startAttr("="); state = "attrName"; i++; }
        else { startAttr(""); state = "attrName"; }
        break;
      case "attrName":
        if (c === undefined) { eofInTag(); i++; }
        else if (WS.has(c)) { state = "afterAttrName"; i++; }
        else if (c === "/") { endAttr(); state = "selfClosing"; i++; }
        else if (c === ">") { emitTag(); i++; }
        else if (c === "=") { state = "beforeAttrValue"; i++; }
        else { attr.name += c.toLowerCase(); i++; }
        break;
      case "afterAttrName":
        if (c === undefined) { eofInTag(); i++; }
        else if (WS.has(c)) i++;
        else if (c === "/") { endAttr(); state = "selfClosing"; i++; }
        else if (c === "=") { state = "beforeAttrValue"; i++; }
        else if (c === ">") { emitTag(); i++; }
        else { endAttr(); startAttr(""); state = "attrName"; }
        break;
      case "beforeAttrValue":
        if (c === undefined) { eofInTag(); i++; }
        else if (WS.has(c)) i++;
        else if (c === '"') { state = "attrDQ"; i++; }
        else if (c === "'") { state = "attrSQ"; i++; }
        else if (c === ">") { emitTag(); i++; }
        else state = "attrUnquoted";
        break;
      case "attrDQ": case "attrSQ":
        if (c === undefined) { eofInTag(); i++; }
        else if (c === (state === "attrDQ" ? '"' : "'")) { endAttr(); state = "afterAttrQuoted"; i++; }
        else { attr.value += c; i++; }
        break;
      case "attrUnquoted":
        if (c === undefined) { eofInTag(); i++; }
        else if (WS.has(c)) { endAttr(); state = "beforeAttrName"; i++; }
        else if (c === ">") { emitTag(); i++; }
        else { attr.value += c; i++; }
        break;
      case "afterAttrQuoted":
        if (c === undefined) { eofInTag(); i++; }
        else if (WS.has(c)) { state = "beforeAttrName"; i++; }
        else if (c === "/") { state = "selfClosing"; i++; }
        else if (c === ">") { emitTag(); i++; }
        else state = "beforeAttrName";
        break;
      case "selfClosing":
        if (c === undefined) { eofInTag(); i++; }
        else if (c === ">") { tag.selfClosing = true; emitTag(); i++; }
        else state = "beforeAttrName";
        break;
      case "bogusComment":
        if (c === undefined) emitComment(n);
        else if (c === ">") { emitComment(i + 1); i++; }
        else i++;
        break;
      case "markupDecl":
        if (s.startsWith("--", i)) { i += 2; state = "commentStart"; }
        else if (tail("doctype")) { i += 7; state = "doctype"; }
        else state = "bogusComment"; // includes <![CDATA[ outside foreign content
        break;
      case "doctype": // every DOCTYPE state ends at the first ">" (abrupt endings included)
        if (c === undefined) { tokens.push({ type: "doctype", start: tokStart, end: n }); state = "data"; }
        else if (c === ">") { tokens.push({ type: "doctype", start: tokStart, end: i + 1 }); state = "data"; i++; }
        else i++;
        break;
      // ── comments (13.2.5.43 to 13.2.5.52) ──
      case "commentStart":
        if (c === "-") { state = "commentStartDash"; i++; }
        else if (c === ">") { emitComment(i + 1); i++; }
        else state = "comment";
        break;
      case "commentStartDash":
        if (c === "-") { state = "commentEnd"; i++; }
        else if (c === ">") { emitComment(i + 1); i++; }
        else if (c === undefined) emitComment(n);
        else state = "comment";
        break;
      case "comment":
        if (c === undefined) emitComment(n);
        else if (c === "<") { state = "commentLt"; i++; }
        else if (c === "-") { state = "commentEndDash"; i++; }
        else i++;
        break;
      case "commentLt":
        if (c === "!") { state = "commentLtBang"; i++; }
        else if (c === "<") i++;
        else state = "comment";
        break;
      case "commentLtBang":
        if (c === "-") { state = "commentLtBangDash"; i++; } else state = "comment";
        break;
      case "commentLtBangDash":
        if (c === "-") { state = "commentLtBangDashDash"; i++; } else state = "commentEndDash";
        break;
      case "commentLtBangDashDash": state = "commentEnd"; break;
      case "commentEndDash":
        if (c === "-") { state = "commentEnd"; i++; }
        else if (c === undefined) emitComment(n);
        else state = "comment";
        break;
      case "commentEnd":
        if (c === ">") { emitComment(i + 1); i++; }
        else if (c === "!") { state = "commentEndBang"; i++; }
        else if (c === "-") i++;
        else if (c === undefined) emitComment(n);
        else state = "comment";
        break;
      case "commentEndBang":
        if (c === "-") { state = "commentEndDash"; i++; }
        else if (c === ">") { emitComment(i + 1); i++; }
        else if (c === undefined) emitComment(n);
        else state = "comment";
        break;
      // ── RCDATA / RAWTEXT end tags ──
      case "textLt":
        if (c === "/") { buf = ""; state = "textEndOpen"; i++; } else state = ret;
        break;
      case "textEndOpen":
        if (isAlpha(c)) { newTag("end"); state = "textEndName"; } else state = ret;
        break;
      case "textEndName": endTagName(ret); break;
      // ── script data ──
      case "scriptLt":
        if (c === "/") { state = "scriptEndOpen"; i++; }
        else if (c === "!") { state = "escapeStart"; i++; }
        else state = "script";
        break;
      case "scriptEndOpen":
        if (isAlpha(c)) { newTag("end"); state = "scriptEndName"; } else state = "script";
        break;
      case "scriptEndName": endTagName("script"); break;
      case "escapeStart": if (c === "-") { state = "escapeStartDash"; i++; } else state = "script"; break;
      case "escapeStartDash": if (c === "-") { state = "escapedDashDash"; i++; } else state = "script"; break;
      case "escaped":
        if (c === "-") { state = "escapedDash"; i++; }
        else if (c === "<") { tokStart = i; state = "escapedLt"; i++; }
        else i++; // EOF falls out of the loop
        break;
      case "escapedDash":
        if (c === "-") { state = "escapedDashDash"; i++; }
        else if (c === "<") { tokStart = i; state = "escapedLt"; i++; }
        else state = "escaped";
        break;
      case "escapedDashDash":
        if (c === "-") i++;
        else if (c === "<") { tokStart = i; state = "escapedLt"; i++; }
        else if (c === ">") { state = "script"; i++; }
        else state = "escaped";
        break;
      case "escapedLt":
        if (c === "/") { buf = ""; state = "escapedEndOpen"; i++; }
        else if (isAlpha(c)) { buf = ""; state = "doubleEscapeStart"; }
        else state = "escaped";
        break;
      case "escapedEndOpen":
        if (isAlpha(c)) { newTag("end"); state = "escapedEndName"; } else state = "escaped";
        break;
      case "escapedEndName": endTagName("escaped"); break;
      case "doubleEscapeStart":
        if (WS.has(c) || c === "/" || c === ">") { state = buf === "script" ? "doubleEscaped" : "escaped"; i++; }
        else if (isAlpha(c)) { buf += c.toLowerCase(); i++; }
        else state = "escaped";
        break;
      case "doubleEscaped":
        if (c === "-") { state = "doubleEscapedDash"; i++; }
        else if (c === "<") { state = "doubleEscapedLt"; i++; }
        else i++;
        break;
      case "doubleEscapedDash":
        if (c === "-") { state = "doubleEscapedDashDash"; i++; }
        else if (c === "<") { state = "doubleEscapedLt"; i++; }
        else state = "doubleEscaped";
        break;
      case "doubleEscapedDashDash":
        if (c === "-") i++;
        else if (c === "<") { state = "doubleEscapedLt"; i++; }
        else if (c === ">") { state = "script"; i++; }
        else state = "doubleEscaped";
        break;
      case "doubleEscapedLt":
        if (c === "/") { buf = ""; state = "doubleEscapeEnd"; i++; } else state = "doubleEscaped";
        break;
      case "doubleEscapeEnd":
        if (WS.has(c) || c === "/" || c === ">") { state = buf === "script" ? "escaped" : "doubleEscaped"; i++; }
        else if (isAlpha(c)) { buf += c.toLowerCase(); i++; }
        else state = "doubleEscaped";
        break;
      default: throw new Error("html-scan: bad state " + state);
    }
    if (c === undefined && i > n) break; // never loop past the end
  }
  // the end of the input inside an open <script>: no end tag
  if (openScript) { if (!openScript.cut) openScript.text = s.slice(openScript.bodyStart); openScript.unterminated = true; }
  let live = "", pos = 0;
  for (const t of tokens) if (t.type === "comment") { live += s.slice(pos, t.start); pos = t.end; }
  live += s.slice(pos);
  return { tokens, scripts, ambiguous, live };

  // The end of the input inside a tag (the browser drops the tag). A <script ...> cut off like this is reported as an unterminated script (fail closed).
  function eofInTag() {
    if (tag && tag.type === "start" && tag.name === "script") scripts.push({ attrs: new Map(), text: "", unterminated: true, eofInTag: true, start: tag.start });
    // an end tag cut off by the end of the input (`</script x`) is discarded by the tokenizer: its characters are not part of the script text either
    if (tag && tag.type === "end" && tag.name === "script" && openScript) { openScript.text = s.slice(openScript.bodyStart, tag.start); openScript.cut = true; }
    state = "data";
    i = n + 1;
  }
  // The tag-name state shared by the RCDATA, RAWTEXT, script data and script data escaped end tags. `back` is the text state to fall back to.
  function endTagName(back) {
    if (WS.has(c0()) && appropriate()) { state = "beforeAttrName"; i++; }
    else if (c0() === "/" && appropriate()) { state = "selfClosing"; i++; }
    else if (c0() === ">" && appropriate()) { emitTag(); i++; }
    else if (isAlpha(c0())) { tag.name += c0().toLowerCase(); i++; }
    else { tag = null; state = back; } // not an appropriate end tag: the text "</name" stays text; reconsume in the text state
  }
}
