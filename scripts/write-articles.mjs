// The Rampart — article writer.
// Researches recent news with Claude's web search tool, writes 2–3 articles,
// and merges them into articles.json. No dependencies; needs Node 20+.
//
// Env:
//   ANTHROPIC_API_KEY  (required)
//   RAMPART_MODEL      (optional, default "claude-sonnet-5")
//   RAMPART_MAX_KEEP   (optional, default 150 articles kept on the site)
//   RAMPART_DRY_RUN=1  (optional: print results, don't write the file)

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "articles.json");
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.RAMPART_MODEL || "claude-sonnet-5";
const MAX_KEEP = Number(process.env.RAMPART_MAX_KEEP || 150);
const DRY = process.env.RAMPART_DRY_RUN === "1";
const SECTIONS = ["Washington", "Elections", "Culture", "World", "Economy"];

if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Add it as a repository secret (see README).");
  process.exit(1);
}

const existing = JSON.parse(await readFile(FILE, "utf8"));
const now = new Date();

const SYSTEM = `You are the AI news writer for "The Rampart," a populist, nationalist, America First news site.

Voice: skeptical of mass immigration, globalist elites and the D.C. establishment; focused on American workers, sovereignty and patriotism. Put that point of view in the framing and in analysis paragraphs.

Standards (these are not optional):
- Every factual claim (names, numbers, dates, quotes) must come from sources you actually retrieved with web search in this session. Never invent quotes, figures, people or events. Quote exactly. Say so when something is unconfirmed.
- Near the end of each article, include one paragraph that fairly states the strongest opposing view or criticism.
- Criticize policies, officials and institutions. Never demean people for ethnicity, nationality, religion or immigrant status. No slurs, no dehumanizing language, no conspiracy claims.
- Write entirely original prose. Paraphrase everything; never reuse a source's sentences or long phrases. The only exception is a direct quote from a named person or document, in quotation marks and attributed ("…," Bessent said). Never present an outlet's own reporting sentences as a quote.
- Cite news outlets, wire services and primary documents. Don't cite Wikipedia.
- No disclaimers or notes about how the article was produced in the body.
- Plain text only inside the JSON: no <cite> tags, citation markers, HTML or markdown.`;

const recent = existing.slice(0, 40).map(a => `- ${a.title} (${a.publishedAt})`).join("\n");

const USER = `Current time: ${now.toISOString()}.

Already published (do not repeat these stories unless there is a major new development, and then write a new angle):
${recent || "(none)"}

Task:
1. Use web search to find 2 or 3 significant U.S. political or national news stories from roughly the last 12 hours. Favor these sections: ${SECTIONS.join(", ")}. Border and immigration stories go under "Washington". Prefer wire services, major outlets and primary sources (government releases, court filings, official statements).
2. For each story, gather enough detail from at least one full news report to write accurately.
3. Write one article per story.

When you are done researching, output ONLY a JSON array inside <articles></articles> tags. Each item:
{
  "slug": "short-kebab-case-slug",
  "title": "headline",
  "dek": "one-sentence summary",
  "section": one of ${JSON.stringify(SECTIONS)},
  "type": "news" (straight reporting) or "analysis" (opinion framing),
  "breaking": true only for the single most urgent story, else false,
  "body": ["paragraph", ... 5 to 7 paragraphs],
  "sources": [{"title": "Outlet: headline", "url": "https://..."}],
  "image_queries": ["2 or 3 Wikimedia Commons search terms for a relevant real photo: the main named person, building, place or institution in the story, most specific first (e.g. \"Xi Jinping\", \"Smithsonian Institution Building\", \"United States Capitol\"). No abstract concepts."]
}
Every source URL must be a page you found through web search in this session.`;

async function callClaude(messages, { tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 12 }], system = SYSTEM, max_tokens = 16000 } = {}) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens,
      system,
      messages,
      ...(tools.length ? { tools } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Run the conversation, continuing through pause_turn.
const messages = [{ role: "user", content: USER }];
const allBlocks = [];
for (let i = 0; i < 6; i++) {
  const r = await callClaude(messages);
  allBlocks.push(...r.content);
  if (r.stop_reason === "pause_turn") {
    messages.push({ role: "assistant", content: r.content });
    continue;
  }
  break;
}

// URLs Claude actually retrieved — used to reject any source it didn't find.
const seenUrls = new Set();
const sourceSnippets = [];
for (const b of allBlocks) {
  if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
    for (const r of b.content) if (r.url) seenUrls.add(normUrl(r.url));
  }
  if (b.type === "text" && Array.isArray(b.citations)) {
    for (const c of b.citations) {
      if (c.url) seenUrls.add(normUrl(c.url));
      if (c.cited_text) sourceSnippets.push(c.cited_text);
    }
  }
}

// Copy check: flag any 10-word run outside quotation marks that matches a source excerpt.
function words(s) { return String(s).toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean); }
const RUN = 10;
const sourceRuns = new Set();
for (const s of sourceSnippets) { const w = words(s); for (let i = 0; i + RUN <= w.length; i++) sourceRuns.add(w.slice(i, i + RUN).join(" ")); }
function copiedRuns(paragraphs) {
  let hits = 0;
  for (const p of paragraphs) {
    const unquoted = String(p).replace(/["“][^"”]*["”]/g, " | ");
    for (const seg of unquoted.split("|")) {
      const w = words(seg);
      for (let i = 0; i + RUN <= w.length; i++) if (sourceRuns.has(w.slice(i, i + RUN).join(" "))) { hits++; i += RUN - 1; }
    }
  }
  return hits;
}

function normUrl(u) {
  try { const x = new URL(u); x.hash = ""; return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/$/, "")).toLowerCase(); }
  catch { return String(u).toLowerCase(); }
}

const text = allBlocks.filter(b => b.type === "text").map(b => b.text).join("");
const m = text.match(/<articles>([\s\S]*?)<\/articles>/);
if (!m) {
  console.error("No <articles> block in the response. Nothing published.");
  console.error(text.slice(-2000));
  process.exit(1);
}

// Remove citation markup the model sometimes leaves in its text.
const clean = t => String(t ?? "").replace(/<\/?cite[^>]*>/gi, "").replace(/<[^>]+>/g, "").replace(/\s+([,.;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
const hasMarkup = a => /<\/?cite/i.test([a.title, a.dek, ...(Array.isArray(a.body) ? a.body : [a.body])].join(" "));

// One-time cleanup: articles saved with citation tags came from the first runs,
// before the copy check existed, and contain copied source text. Drop them.
const beforeCleanup = existing.length;
for (let i = existing.length - 1; i >= 0; i--) if (hasMarkup(existing[i])) existing.splice(i, 1);
const removedOld = beforeCleanup - existing.length;
if (removedOld) console.log(`Removed ${removedOld} older article(s) that contained copied source text.`);

let drafts;
try { drafts = JSON.parse(m[1].trim().replace(/^```(?:json)?|```$/g, "")); }
catch (e) { console.error("Couldn't parse the articles JSON:", e.message); process.exit(1); }

const mmdd = `${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
const ids = new Set(existing.map(a => a.id));
const accepted = [];

for (const d of Array.isArray(drafts) ? drafts : []) {
  d.title = clean(d.title); d.dek = clean(d.dek);
  if (Array.isArray(d.body)) d.body = d.body.map(clean).filter(Boolean);
  const problems = [];
  if (!d.title || !d.dek) problems.push("missing title or dek");
  if (!SECTIONS.includes(d.section)) problems.push(`bad section "${d.section}"`);
  if (!Array.isArray(d.body) || d.body.length < 3) problems.push("body too short");
  const sources = (d.sources || []).filter(s => s && /^https?:\/\//.test(s.url) && seenUrls.has(normUrl(s.url)) && !/wikipedia\.org/i.test(s.url));
  if (!sources.length) problems.push("no sources that match pages actually searched");
  if (Array.isArray(d.body) && copiedRuns(d.body) > 0) problems.push("copies source wording outside quotation marks");
  if (problems.length) { console.warn(`Skipped "${d.title}": ${problems.join("; ")}`); continue; }

  let id = `${String(d.slug || d.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)}-${mmdd}`;
  while (ids.has(id)) id += "-2";
  ids.add(id);

  accepted.push({
    id,
    title: String(d.title),
    dek: String(d.dek),
    section: d.section,
    type: d.type === "analysis" ? "analysis" : "news",
    breaking: d.breaking === true,
    publishedAt: new Date().toISOString(),
    body: d.body.map(String),
    sources: sources.map(s => ({ title: String(s.title || s.url), url: s.url })),
    _imageQueries: Array.isArray(d.image_queries) ? d.image_queries.map(String).slice(0, 4) : [],
  });
}

// ---------- Images (Wikimedia Commons, free licenses only) ----------
const UA = `TheRampartWire/1.0 (https://github.com/${process.env.GITHUB_REPOSITORY || "the-rampart"})`;
const OK_LICENSE = /^(cc0|public domain|pd\b|pd-|no restrictions)/i;
const BAD_TITLE = /logo|map|flag|seal|coat[ _]of[ _]arms|diagram|chart|graph|figure|process|infographic|signature|icon|emblem|screenshot|impersonat|parody|cartoon|caricature|meme|lookalike|cosplay|\.svg|\.gif|\.tif/i;
const stripHtml = h => String(h || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

async function searchCommons(q) {
  const u = new URL("https://commons.wikimedia.org/w/api.php");
  Object.entries({
    action: "query", format: "json", formatversion: "2", origin: "*",
    generator: "search", gsrsearch: `${q} filetype:bitmap`, gsrnamespace: "6", gsrlimit: "15",
    prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "1280",
    iiextmetadatafilter: "LicenseShortName|Artist|LicenseUrl|ImageDescription",
  }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`Commons ${r.status}`);
  const j = await r.json();
  return (j.query?.pages || []).sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
}

function candidates(pages) {
  const out = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0]; if (!ii) continue;
    const md = ii.extmetadata || {};
    const license = stripHtml(md.LicenseShortName?.value);
    const ratio = ii.width / ii.height;
    if (!/image\/(jpeg|png|webp)/.test(ii.mime || "")) continue;
    if (ii.width < 900 || ratio < 1.15 || ratio > 2.3) continue;
    if (!OK_LICENSE.test(license) || BAD_TITLE.test(p.title)) continue;
    let credit = stripHtml(md.Artist?.value);
    if (/unknown author|^unknown$/i.test(credit)) credit = "";
    if (credit.length > 80) credit = credit.slice(0, 77) + "…";
    out.push({
      src: ii.thumburl || ii.url,
      width: ii.thumbwidth || ii.width,
      height: ii.thumbheight || ii.height,
      alt: p.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " "),
      credit: credit || "Wikimedia Commons",
      license,
      page: ii.descriptionurl,
      _desc: stripHtml(md.ImageDescription?.value).slice(0, 220),
    });
  }
  return out;
}

// Ask Claude which candidate (if any) actually fits the story.
async function chooseImage(article, cands) {
  if (!cands.length) return null;
  const list = cands.map((c, i) => `${i}. ${c.alt} — ${c._desc || "(no description)"}`).join("\n");
  const prompt = `News article: "${article.title}" — ${article.dek}

Candidate public-domain photos (file title — description):
${list}

Pick the ONE photo that directly shows the story's main subject: the specific named person, place, building or institution the story is about. Reject any photo whose main subject is a different named person, an impersonator or lookalike, a diagram, a document, or anything that would mislead a reader about what happened. Generic but accurate scenes (e.g. the U.S. Capitol for a Congress story) are fine. If none qualify, answer -1.
Answer with only the number.`;
  try {
    const r = await callClaude([{ role: "user", content: prompt }], { tools: [], system: "You answer with a single integer.", max_tokens: 10 });
    const n = parseInt(r.content.filter(b => b.type === "text").map(b => b.text).join("").trim(), 10);
    if (Number.isInteger(n) && n >= 0 && n < cands.length) { const { _desc, ...img } = cands[n]; return img; }
  } catch (e) { console.warn("Image choice failed:", e.message); }
  return null;
}

async function findImage(queries, article) {
  const seen = new Set(), pool = [];
  for (const q of queries.slice(0, 3)) {
    try {
      for (const c of candidates(await searchCommons(q))) {
        if (!seen.has(c.src) && pool.length < 12) { seen.add(c.src); pool.push(c); }
      }
    } catch (e) { console.warn(`Image search failed for "${q}": ${e.message}`); }
  }
  return chooseImage(article, pool);
}

async function queriesFor(list) {
  if (!list.length) return {};
  const prompt = `For each news article below, give 2 or 3 Wikimedia Commons search terms for a relevant real photo: the main named person, building, place or institution, most specific first. No abstract concepts.
Output ONLY JSON: {"<id>": ["term", ...], ...}

${list.map(a => `${a.id}: ${a.title} — ${a.dek}`).join("\n")}`;
  const r = await callClaude([{ role: "user", content: prompt }], { tools: [], system: "You return compact JSON only.", max_tokens: 2000 });
  const t = r.content.filter(b => b.type === "text").map(b => b.text).join("");
  try { return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); } catch { return {}; }
}

// New articles
for (const a of accepted) {
  const q = a._imageQueries.length ? a._imageQueries : [a.title];
  const img = await findImage(q, a);
  if (img) a.image = img;
  a.imageTried = true;
  a.imageV = 2;
  delete a._imageQueries;
}

// Backfill up to 10 older articles that never got an image
// Re-check older articles picked before the relevance check (imageV < 2).
const needImg = existing.filter(a => a.imageV !== 2).slice(0, 12);
let backfilled = 0;
if (needImg.length) {
  let qmap = {};
  try { qmap = await queriesFor(needImg); } catch (e) { console.warn("Couldn't get image queries:", e.message); }
  for (const a of needImg) {
    const img = await findImage(Array.isArray(qmap[a.id]) && qmap[a.id].length ? qmap[a.id] : [a.title], a);
    if (img) { a.image = img; backfilled++; } else delete a.image;
    a.imageTried = true;
    a.imageV = 2;
  }
}

if (!accepted.length && !needImg.length && !removedOld) { console.log("No articles passed checks. Nothing published."); process.exit(0); }

// Only one breaking story at a time.
const hasBreaking = accepted.some(a => a.breaking);
if (hasBreaking) {
  let first = true;
  for (const a of accepted) { if (a.breaking && !first) a.breaking = false; if (a.breaking) first = false; }
  for (const a of existing) a.breaking = false;
}

const merged = [...accepted, ...existing]
  .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
  .slice(0, MAX_KEEP);

if (DRY) { console.log(JSON.stringify(accepted, null, 2)); }
else { await writeFile(FILE, JSON.stringify(merged, null, 2) + "\n"); }
console.log(`Published ${accepted.length}: ${accepted.map(a => a.title + (a.image ? " [img]" : "")).join(" | ")}`);
if (needImg.length) console.log(`Backfilled images for ${backfilled} of ${needImg.length} older articles.`);
