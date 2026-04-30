import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const LEADS_DIR = path.join(DATA_DIR, 'leads');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const RESEARCH_CACHE_DIR = path.join(DATA_DIR, 'research-cache');
const GUIDELINES_PATH = path.join(DATA_DIR, 'guidelines.json');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');

const PORT = 3737;
const MODEL_RESEARCH = 'claude-haiku-4-5-20251001';
const MODEL_BRIEFS = 'claude-haiku-4-5-20251001';
const MODEL_REGEN = 'claude-sonnet-4-5-20250929';

// NANO BANANA 2 - reasoning-guided, fast (1-3s), Gemini 3.1 Flash Image
const FAL_ENDPOINT = 'https://queue.fal.run/fal-ai/nano-banana-2';
const FAL_EDIT_ENDPOINT = 'https://queue.fal.run/fal-ai/nano-banana-2/edit';
const IMAGE_ASPECT_RATIO = '1:1';
const IMAGE_OUTPUT_FORMAT = 'png';

// Referencyjne figurki Blocki - serwowane z GitHub raw
// Używane jako wzorzec stylu dla generowania scenek (image-to-image)
const REFERENCE_FIGURE_URLS = [
  'https://raw.githubusercontent.com/TomBlocki/blocki-lead-flow/main/refs/figurka1.png',
  'https://raw.githubusercontent.com/TomBlocki/blocki-lead-flow/main/refs/figurka2.png',
  'https://raw.githubusercontent.com/TomBlocki/blocki-lead-flow/main/refs/figurka3.png',
  'https://raw.githubusercontent.com/TomBlocki/blocki-lead-flow/main/refs/figurka4.png',
  'https://raw.githubusercontent.com/TomBlocki/blocki-lead-flow/main/refs/figurka5.png'
];

const MAX_SEARCHES_PER_ANCHOR = 2;
const PAUSE_BETWEEN_ANCHORS_MS = 20000; // 20s pauzy żeby nie wyczerpać rate limit
const RESEARCH_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const client = new Anthropic();

// =============================================
// TIMING UTILS
// =============================================
function now() { return Date.now(); }

function logTiming(sessionId, phase, startMs, extra = '') {
  const ms = now() - startMs;
  const secStr = (ms / 1000).toFixed(1);
  console.log(`[${sessionId}] ⏱  ${phase}: ${secStr}s${extra ? ' ' + extra : ''}`);
  return ms;
}

// =============================================
// SAFE JSON PARSE
// LLMs (szczególnie Haiku) czasem wrzucają literalne znaki kontrolne
// (nowe linie, tabulatory) w pola string zamiast ich escape'ować.
// JSON.parse tego nie akceptuje — sanityzujemy przed parsowaniem.
// =============================================
function sanitizeJsonString(s) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString) {
      const code = ch.charCodeAt(0);
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      if (code < 0x20) continue; // pomiń inne znaki kontrolne
    }
    out += ch;
  }
  return out;
}

function safeParseJson(text, where) {
  const m = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!m) {
    // Czasem Claude zwraca JSON bez oznaczenia ```json
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (!braceMatch) throw new Error(`${where}: brak bloku JSON w odpowiedzi`);
    try { return JSON.parse(braceMatch[0]); }
    catch { return JSON.parse(sanitizeJsonString(braceMatch[0])); }
  }
  const raw = m[1];
  try {
    return JSON.parse(raw);
  } catch (e) {
    try {
      return JSON.parse(sanitizeJsonString(raw));
    } catch (e2) {
      throw new Error(`${where}: JSON parse failed (po sanityzacji też) — ${e2.message}`);
    }
  }
}

// =============================================
// DEFAULT GUIDELINES — uproszczone, dyrektywne
// =============================================
const DEFAULT_GUIDELINES = {
  blocki_style: `KRYTYCZNE: Każdy obrazek MUSI pokazywać zestaw zbudowany Z KLOCKÓW kompatybilnych z LEGO.

Obowiązkowe cechy każdego obrazka:
1. Wszystkie obiekty zbudowane są z prostokątnych, interlocking klocków plastikowych
2. Na każdej płaskiej, górnej powierzchni widoczne są okrągłe STUDS (wypustki)
3. Figurki mają KWADRATOWE GŁOWY z prostą namalowaną twarzą (dwa punkty-oczy, kreska-usta)
4. Zestaw stoi na STUDDED BASEPLATE (płytce z wypustkami)
5. Materiał: matowy plastik ABS, bez połysku
6. Widoczne linie podziału między klockami
7. Oświetlenie: delikatne studio, miękkie cienie
8. Tło: neutralne szare lub białe, professional product photography

ZAKAZ: gładkie, ciągłe powierzchnie bez podziałów. Zaokrąglone kształty. Figurki jak Playmobil lub anime. Realistyczne tekstury typu metal, szkło, materiał.`,

  totem_definition: `TOTEM = jeden obiekt-symbol stojący na postumencie z klocków.
- Pojedynczy, pionowy kształt (jak pomnik albo statuetka)
- Wysokość mniej więcej 20-30cm
- Stoi na prostokątnej podstawie zrobionej z klocków
- Brak figurek ludzi, brak otaczającej sceny
- Jeden kąt spojrzenia, jak obiekt w muzeum
- Podstawa może mieć napis/etykietę`,

  scenka_definition: `SCENKA = diorama z wieloma elementami i minimum 4 figurkami ludzi.
- Kwadratowa podstawa (baseplate) ~30x30cm z widocznymi studsami
- Budynek lub wnętrze jako tło sceny
- Minimum 4 MINIFIGURKI z kwadratowymi głowami, w akcji
- Dodatkowe rekwizyty (narzędzia, meble, pojazdy)
- Wyraźna narracja: widać co się dzieje
- Kompozycja jak scena w modelu kolejowym`
};

// =============================================
// UTILS
// =============================================
async function ensureDirs() {
  for (const d of [DATA_DIR, LEADS_DIR, IMAGES_DIR, RESEARCH_CACHE_DIR]) {
    await fs.mkdir(d, { recursive: true });
  }
}

async function loadGuidelines() {
  try {
    const raw = await fs.readFile(GUIDELINES_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    await fs.writeFile(GUIDELINES_PATH, JSON.stringify(DEFAULT_GUIDELINES, null, 2));
    return DEFAULT_GUIDELINES;
  }
}

async function saveGuidelines(g) {
  await fs.writeFile(GUIDELINES_PATH, JSON.stringify(g, null, 2));
}

async function loadHistory() {
  try {
    const raw = await fs.readFile(HISTORY_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { leads: [] };
  }
}

async function appendHistory(entry) {
  const h = await loadHistory();
  h.leads.push(entry);
  await fs.writeFile(HISTORY_PATH, JSON.stringify(h, null, 2));
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function newLeadId(domain) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${ts}__${slugify(domain)}`;
}

async function getCachedResearch(domain) {
  const cachePath = path.join(RESEARCH_CACHE_DIR, `${slugify(domain)}.json`);
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const data = JSON.parse(raw);
    const age = Date.now() - data.cachedAt;
    if (age < RESEARCH_CACHE_MAX_AGE_MS) {
      return { research: data.research, ageDays: Math.floor(age / (24 * 60 * 60 * 1000)) };
    }
    return null;
  } catch {
    return null;
  }
}

async function saveCachedResearch(domain, research) {
  const cachePath = path.join(RESEARCH_CACHE_DIR, `${slugify(domain)}.json`);
  await fs.writeFile(cachePath, JSON.stringify({
    cachedAt: Date.now(), domain, research
  }, null, 2));
}

// =============================================
// RESEARCH
// =============================================
function buildAnchorPrompt(anchor, lead) {
  const isA = anchor === 'A';
  const focus = isA ? `AKTUALNE CELE MARKETINGOWE (obecny i nadchodzący rok)` : `LEGENDA MARKI (z czego firma jest znana)`;

  return `Jesteś analitykiem B2B dla Blocki Custom (corporate gifts z klocków).

KLIENT:
Domena: ${lead.domain}
Kontakt: ${lead.contact || '(nie podano)'}

NOTATKA KWALIFIKACJI:
${lead.bantNotes}

UWZGLĘDNIJ sygnały z notatki priorytetowo.

FOKUS: KOTWICA ${anchor} — ${focus}

WYKONANIE:
1. Web_search MAX ${MAX_SEARCHES_PER_ANCHOR} wyszukiwań
2. Wybierz 3-5 najmocniejszych wątków z konkretnym potencjałem wizualnym

Na końcu JSON w \`\`\`json:

\`\`\`json
{
  "anchor": "${anchor}",
  "company_summary": "2 zdania",
  "visual_identity": {
    "primary_colors": ["#hex1", "#hex2"],
    "style_notes": "1 zdanie"
  },
  "elements": [
    {
      "title": "nazwa",
      "description": "2 zdania",
      "why_relevant": "1 zdanie",
      "visual_potential": "co pokazać",
      "source_urls": ["url"]
    }
  ],
  "top_recommendation": "który najmocniejszy i dlaczego"
}
\`\`\`

Polski. Konkrety, nie abstrakty. Zwięźle.`;
}

async function researchAnchor(anchor, lead, sessionId, retryCount = 0) {
  const startMs = now();
  const response = await client.messages.create({
    model: MODEL_RESEARCH,
    max_tokens: 6000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES_PER_ANCHOR }],
    messages: [{ role: 'user', content: buildAnchorPrompt(anchor, lead) }]
  });

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const searches = response.content.filter(b => b.type === 'server_tool_use').length;
  const tokensIn = response.usage?.input_tokens || 0;
  const tokensOut = response.usage?.output_tokens || 0;

  try {
    const parsed = safeParseJson(text, `research-${anchor}`);
    logTiming(sessionId, `research-${anchor}`, startMs, `(${searches} searches, in:${tokensIn}, out:${tokensOut})`);
    return parsed;
  } catch (err) {
    if (retryCount < 2) {
      console.log(`[${sessionId}] ⚠️  research-${anchor} parse failed (próba ${retryCount + 1}/3), retry...`);
      // Pauza 5s przed retry
      await new Promise(r => setTimeout(r, 5000));
      return researchAnchor(anchor, lead, sessionId, retryCount + 1);
    }
    throw err;
  }
}

// =============================================
// BRIEFS — nowe instrukcje dla Claude: natural language prompts
// =============================================
function buildBriefPrompt(config, research, guidelines) {
  const anchor = research[config.anchorKey];
  const top = anchor.elements[0];
  const isTotem = config.format === 'totem';
  const formatDef = isTotem ? guidelines.totem_definition : guidelines.scenka_definition;

  // Dla totemu — wymuszamy zakaz figurek na końcu prompta (różny od scenki)
  const FORMAT_ENFORCEMENT = isTotem
    ? `\n\nKRYTYCZNE — TOTEM ZAKAZUJE FIGUREK:
TOTEM to ABSTRAKCYJNA RZEŹBA - jeden obiekt symboliczny na postumencie. NIGDY nie zawiera ludzi, robotników, pracowników, ani postaci.

Pisząc image_prompt_en MUSISZ:
- NIE używać słów: "workers", "employees", "people", "workers", "minifigures", "figures", "characters", "operators", "engineers", "team"
- Opisać TYLKO główny obiekt-symbol (np. maszyna, narzędzie, urządzenie produkcyjne) i postument
- Skupić się na bryle, kształcie, kolorach, etykiecie
- NIE opisywać żadnej akcji ani działania - tylko statyczny obiekt

OSTATNIE ZDANIE image_prompt_en MUSI brzmieć DOKŁADNIE:
"ABSOLUTELY NO HUMAN FIGURES, NO MINIFIGURES, NO PEOPLE, NO WORKERS anywhere in the scene. Just the single sculptural object on its pedestal with a label. Empty studio background, no characters, no living creatures, no action — purely a static sculptural display."`
    : `\n\nKRYTYCZNE — anatomia figurek:
NIE pisz "cubic heads", "blocky figures", "standard LEGO minifigures" ani niczego co sugeruje klasyczne LEGO city. Figurki w scenkach MUSZĄ być w stylu Blocki (zaokrąglone kształty). Wszystkie figurki w jednym kadrze MUSZĄ mieć ten sam styl anatomiczny - bez mieszania.

OSTATNIE ZDANIE image_prompt_en MUSI brzmieć DOKŁADNIE:
"CRITICAL STYLE REQUIREMENT — ALL figures in this scene MUST match the reference image anatomy. Most importantly: legs are smooth rounded forms with organic taper (NOT rectangular block legs), and feet are rounded shoe shapes with a clearly protruding toe at the front like a real shoe (NOT flat square block ends). This applies to EVERY figure including small or background figures. Avoid standard LEGO city minifigure legs and feet completely — those square block legs and flat square feet are wrong. Other body features: torso rectangular with rounded corners, arms smooth flowing curves without elbow segments, distinct rounded hip segment between torso and legs. Uniform consistent anatomy across all figures in the scene — do not mix Blocki anatomy with standard LEGO anatomy."`;

  return `Jesteś art directorem Blocki Custom.

Przygotuj brief wizualny dla Nano Banana 2 (Google Gemini 3.1 Flash Image) — model reasoning-guided, rozumie naturalny język i intent, NIE keywords.

KLIENT: ${research.lead?.domain || 'klient'}
FORMAT: ${config.format.toUpperCase()}

DEFINICJA FORMATU:
${formatDef}

KOTWICA: ${config.anchorLabel}

TOP MOTYW:
Tytuł: ${top.title}
Opis: ${top.description}
Potencjał wizualny: ${top.visual_potential}

WYTYCZNE STYLU (OBOWIĄZKOWE):
${guidelines.blocki_style}

PALETA:
${JSON.stringify(anchor.visual_identity, null, 2)}

TWOJE ZADANIE:
Napisz naturalny angielski opis sceny dla generatora obrazków. To NIE jest zestaw keywords — to jest opis jak do człowieka. Model rozumie intent.

Zasady dla image_prompt_en:
- Pisz naturalnym angielskim, pełnymi zdaniami
- Zacznij od: "A detailed scale model built entirely from interlocking plastic construction bricks like LEGO"
- Opisz konkretnie CO jest w kadrze (obiekty, figurki, rekwizyty, tło)
- Wspomnij że płaskie powierzchnie klocków mają widoczne studs (wypustki)
- Oświetlenie: "professional product photography lighting on a neutral gray background"
- Kolory: użyj konkretnych hex z palety
- Długość: 400-800 znaków
${FORMAT_ENFORCEMENT}

JSON w \`\`\`json:

\`\`\`json
{
  "id": "${config.id}",
  "format": "${config.format}",
  "anchor": "${config.anchorLabel}",
  "title_pl": "tytuł max 5 słów",
  "concept_pl": "2-3 zdania po polsku",
  "key_elements": ["element1", "element2"],
  "image_prompt_en": "Natural English description 400-800 chars. Start: 'A detailed scale model built entirely from interlocking plastic construction bricks like LEGO...'. End with the EXACT mandatory Blocki anatomy sentence above."
}
\`\`\``;
}

async function generateBrief(config, research, guidelines, sessionId, retryCount = 0) {
  const startMs = now();
  const response = await client.messages.create({
    model: MODEL_BRIEFS,
    max_tokens: 2048,
    messages: [{ role: 'user', content: buildBriefPrompt(config, research, guidelines) }]
  });

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const tokensIn = response.usage?.input_tokens || 0;
  const tokensOut = response.usage?.output_tokens || 0;

  try {
    const parsed = safeParseJson(text, `brief-${config.id}`);

    // GUARD RAIL: wymuszamy frazę enforcement na końcu image_prompt_en
    // Niezależnie czy Claude ją dodał czy nie - kod dokleja jeśli brak
    const isTotem = config.format === 'totem';
    const BLOCKI_ANATOMY = "CRITICAL STYLE REQUIREMENT — ALL figures in this scene MUST match the reference image anatomy. Most importantly: legs are smooth rounded forms with organic taper (NOT rectangular block legs), and feet are rounded shoe shapes with a clearly protruding toe at the front like a real shoe (NOT flat square block ends). This applies to EVERY figure including small or background figures. Avoid standard LEGO city minifigure legs and feet completely — those square block legs and flat square feet are wrong. Other body features: torso rectangular with rounded corners, arms smooth flowing curves without elbow segments, distinct rounded hip segment between torso and legs. Uniform consistent anatomy across all figures in the scene — do not mix Blocki anatomy with standard LEGO anatomy.";
    const TOTEM_NO_FIGURES = "ABSOLUTELY NO HUMAN FIGURES OR MINIFIGURES anywhere in the scene. Just the single sculptural object on its pedestal with a label. Empty studio background, no people, no characters, no living creatures.";
    const ENFORCEMENT = isTotem ? TOTEM_NO_FIGURES : BLOCKI_ANATOMY;
    const MARKER = isTotem ? 'ABSOLUTELY NO HUMAN FIGURES' : 'CRITICAL STYLE REQUIREMENT';

    if (parsed.image_prompt_en) {
      // Usuwamy frazy które przyklepują LEGO (jeśli Claude je dał) - tylko dla scenek
      if (!isTotem) {
        parsed.image_prompt_en = parsed.image_prompt_en
          .replace(/\bcubic heads?\b/gi, 'rounded heads')
          .replace(/\bcubic minifigures?\b/gi, 'Blocki-style minifigures')
          .replace(/\bblocky minifigures?\b/gi, 'Blocki-style minifigures')
          .replace(/\bstandard LEGO minifigures?\b/gi, 'Blocki-style minifigures');
      }

      // Sprawdź czy fraza już jest na końcu, jeśli nie - dodaj
      if (!parsed.image_prompt_en.includes(MARKER)) {
        parsed.image_prompt_en = parsed.image_prompt_en.trim();
        if (!parsed.image_prompt_en.endsWith('.')) parsed.image_prompt_en += '.';
        parsed.image_prompt_en += ' ' + ENFORCEMENT;
      }

      // Limit długości
      if (parsed.image_prompt_en.length > 1500) {
        parsed.image_prompt_en = parsed.image_prompt_en.slice(0, 1497) + '...';
      }
    }

    logTiming(sessionId, `brief-${config.id}`, startMs, `(in:${tokensIn}, out:${tokensOut})`);
    return parsed;
  } catch (err) {
    if (retryCount < 2) {
      console.log(`[${sessionId}] ⚠️  brief-${config.id} parse failed (próba ${retryCount + 1}/3), retry...`);
      await new Promise(r => setTimeout(r, 3000));
      return generateBrief(config, research, guidelines, sessionId, retryCount + 1);
    }
    throw err;
  }
}

// =============================================
// REWRITE BRIEF (regen)
// =============================================
async function rewriteBriefWithFeedback(oldBrief, userFeedbackPl, guidelines) {
  const prompt = `Jesteś art directorem Blocki. Popraw brief dla generatora obrazków Nano Banana 2 na podstawie komentarza użytkownika.

STARY BRIEF:
${JSON.stringify(oldBrief, null, 2)}

KOMENTARZ UŻYTKOWNIKA:
${userFeedbackPl}

WYTYCZNE STYLU:
${guidelines.blocki_style}

DEFINICJA FORMATU (${oldBrief.format}):
${oldBrief.format === 'totem' ? guidelines.totem_definition : guidelines.scenka_definition}

ZASADY PROMPTA:
- Naturalny angielski, pełnymi zdaniami, NIE keywords
- Zacznij: "A detailed scale model built entirely from interlocking plastic construction bricks like LEGO"
- Konkrety: co w kadrze, oświetlenie, tło, kolory
- 400-800 znaków

Wygeneruj zaktualizowany JSON w \`\`\`json.`;

  const response = await client.messages.create({
    model: MODEL_REGEN,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const parsed = safeParseJson(text, 'brief-rewrite');

  // GUARD RAIL: ta sama logika co w generateBrief
  const BLOCKI_ANATOMY = "CRITICAL STYLE REQUIREMENT — ALL figures in this scene MUST match the reference image anatomy. Most importantly: legs are smooth rounded forms with organic taper (NOT rectangular block legs), and feet are rounded shoe shapes with a clearly protruding toe at the front like a real shoe (NOT flat square block ends). This applies to EVERY figure including small or background figures. Avoid standard LEGO city minifigure legs and feet completely — those square block legs and flat square feet are wrong. Other body features: torso rectangular with rounded corners, arms smooth flowing curves without elbow segments, distinct rounded hip segment between torso and legs. Uniform consistent anatomy across all figures in the scene — do not mix Blocki anatomy with standard LEGO anatomy.";

  if (parsed.image_prompt_en) {
    parsed.image_prompt_en = parsed.image_prompt_en
      .replace(/\bcubic heads?\b/gi, 'rounded heads')
      .replace(/\bcubic minifigures?\b/gi, 'Blocki-style minifigures')
      .replace(/\bblocky minifigures?\b/gi, 'Blocki-style minifigures')
      .replace(/\bstandard LEGO minifigures?\b/gi, 'Blocki-style minifigures');

    if (!parsed.image_prompt_en.includes('CRITICAL STYLE REQUIREMENT')) {
      parsed.image_prompt_en = parsed.image_prompt_en.trim();
      if (!parsed.image_prompt_en.endsWith('.')) parsed.image_prompt_en += '.';
      parsed.image_prompt_en += ' ' + BLOCKI_ANATOMY;
    }

    if (parsed.image_prompt_en.length > 1500) {
      parsed.image_prompt_en = parsed.image_prompt_en.slice(0, 1497) + '...';
    }
  }

  return parsed;
}

// =============================================
// IMAGE GEN — Nano Banana 2
// =============================================
async function generateImage(brief, imageFilename, sessionId, retryCount = 0) {
  const startMs = now();
  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) throw new Error('Brak FAL_KEY');
  if (!brief?.image_prompt_en) throw new Error('Brief bez image_prompt_en');

  const isTotem = brief.format === 'totem';

  // Totem -> standard text-to-image (bez figurek, bez referencji)
  // Scenka -> edit endpoint z referencjami stylu figurek Blocki
  const endpoint = isTotem ? FAL_ENDPOINT : FAL_EDIT_ENDPOINT;

  // Dla scenek - wzbogacamy prompt o instrukcję jak używać referencji
  let finalPrompt = brief.image_prompt_en;
  let requestBody;

  if (isTotem) {
    requestBody = {
      prompt: finalPrompt,
      num_images: 1,
      aspect_ratio: IMAGE_ASPECT_RATIO,
      output_format: IMAGE_OUTPUT_FORMAT
    };
  } else {
    // Scenka - dodaj instrukcję na początku promptu
    const STYLE_INSTRUCTION = "CRITICAL STYLE REFERENCE PROTOCOL: 5 reference images are attached showing the EXACT physical anatomy required for ALL figures in the output. These references are NOT characters to insert — they are an anatomy reference template. Study these specific body features from the references and apply them to ALL new figures you generate:\n\n1. LEGS — Look at how the legs in the references are shaped: they are smooth rounded plastic forms with subtle organic curvature, NOT straight rectangular blocks. The legs taper slightly. Reproduce this leg shape in every figure.\n\n2. FEET — This is critical. Look carefully at the feet in the reference images: they are clearly shoe-shaped with a visible protruding TOE at the front, like a real shoe. They are NOT flat square block ends like standard LEGO minifigures. Every figure in the output MUST have these rounded shoe-shaped feet with a protruding toe. NO square block feet anywhere.\n\n3. HIPS — Notice the distinct rounded hip segment between the torso and legs in the references. It looks like a separate pelvis piece. Include this in every figure.\n\n4. ARMS — Smooth flowing curves, no elbow segment.\n\n5. TORSO — Rectangular shape but with softly rounded corners, not sharp trapezoidal LEGO torsos.\n\nIGNORE the black backgrounds. IGNORE the specific clothing, hair colors, and accessories of the reference figures. The figures in your output should be NEW characters wearing clothing appropriate to the scene below — but their bodies, especially their LEGS and FEET, must match the Blocki anatomy shown in the references. Even small or background figures must follow this. Do NOT use standard LEGO city minifigure body parts anywhere — particularly NOT the square block feet which are the most common LEGO feature to avoid.\n\nNOW, the scene description: ";

    finalPrompt = STYLE_INSTRUCTION + brief.image_prompt_en;

    requestBody = {
      prompt: finalPrompt,
      image_urls: REFERENCE_FIGURE_URLS,
      num_images: 1,
      aspect_ratio: 'auto',
      output_format: IMAGE_OUTPUT_FORMAT,
      resolution: '1K'
    };
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!res.ok) {
      const errText = await res.text();
      console.log(`[${sessionId}] fal submit failed (${res.status}). Endpoint: ${endpoint}. Body sent: ${JSON.stringify(requestBody).slice(0, 500)}. Response: ${errText.slice(0, 500)}`);
      throw new Error(`fal submit ${res.status}: ${errText.slice(0, 200)}`);
    }

    const submitText = await res.text();
    let submitJson;
    try {
      submitJson = JSON.parse(submitText);
    } catch (e) {
      console.log(`[${sessionId}] fal submit returned non-JSON. Response: ${submitText.slice(0, 500)}`);
      throw new Error(`fal submit returned non-JSON: ${submitText.slice(0, 200)}`);
    }
    const { request_id } = submitJson;
    if (!request_id) {
      console.log(`[${sessionId}] fal submit no request_id. Response: ${submitText.slice(0, 500)}`);
      throw new Error(`fal submit no request_id`);
    }

    // KRYTYCZNE: status i wynik leci na bazowy queue URL bez sufiksu /edit
    // Submit: queue.fal.run/fal-ai/nano-banana-2/edit (POST)
    // Status: queue.fal.run/fal-ai/nano-banana-2/requests/{id}/status (GET, BEZ /edit)
    // Result: queue.fal.run/fal-ai/nano-banana-2/requests/{id} (GET, BEZ /edit)
    const queueBaseUrl = 'https://queue.fal.run/fal-ai/nano-banana-2';
    const statusUrl = `${queueBaseUrl}/requests/${request_id}/status`;
    const resultUrl = `${queueBaseUrl}/requests/${request_id}`;

    for (let i = 0; i < 240; i++) {
      // Edit może być wolniejszy niż text-to-image, dłuższy timeout (2 min)
      await new Promise(r => setTimeout(r, 500));
      const s = await fetch(statusUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
      if (!s.ok) {
        const errText = await s.text();
        console.log(`[${sessionId}] fal status check failed (${s.status}). URL: ${statusUrl}. Response: ${errText.slice(0, 500)}`);
        throw new Error(`fal status ${s.status}: ${errText.slice(0, 200)}`);
      }
      const statusText = await s.text();
      let sj;
      try {
        sj = JSON.parse(statusText);
      } catch (e) {
        console.log(`[${sessionId}] fal status returned non-JSON. Response: ${statusText.slice(0, 500)}`);
        throw new Error(`fal status non-JSON: ${statusText.slice(0, 200)}`);
      }

      if (sj.status === 'COMPLETED') {
        const r = await fetch(resultUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
        if (!r.ok) {
          const errText = await r.text();
          console.log(`[${sessionId}] fal result fetch failed (${r.status}). URL: ${resultUrl}. Response: ${errText.slice(0, 500)}`);
          throw new Error(`fal result ${r.status}: ${errText.slice(0, 200)}`);
        }
        const resultText = await r.text();
        let rj;
        try {
          rj = JSON.parse(resultText);
        } catch (e) {
          console.log(`[${sessionId}] fal result returned non-JSON. Response: ${resultText.slice(0, 500)}`);
          throw new Error(`fal result non-JSON: ${resultText.slice(0, 200)}`);
        }
        const url = rj.images?.[0]?.url;
        if (!url) {
          console.log(`[${sessionId}] fal result has no image URL. Full response: ${JSON.stringify(rj).slice(0, 800)}`);
          throw new Error('brak URL');
        }

        const imgRes = await fetch(url);
        if (!imgRes.ok) {
          throw new Error(`fal image download ${imgRes.status}`);
        }
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const filepath = path.join(IMAGES_DIR, imageFilename);
        await fs.writeFile(filepath, buf);

        logTiming(sessionId, `image-${brief.id}`, startMs, isTotem ? '(text-to-image)' : '(edit z 5 ref)');
        return `/images/${imageFilename}`;
      }
      if (sj.status === 'FAILED') {
        console.log(`[${sessionId}] fal job FAILED. Full status: ${JSON.stringify(sj).slice(0, 800)}`);
        throw new Error(`fal failed: ${JSON.stringify(sj).slice(0, 300)}`);
      }
    }
    throw new Error('fal timeout');
  } catch (err) {
    if (retryCount < 2) {
      console.log(`[${sessionId}] ⚠️  image-${brief.id} failed (próba ${retryCount + 1}/3): ${err.message}, retry...`);
      await new Promise(r => setTimeout(r, 5000));
      return generateImage(brief, imageFilename, sessionId, retryCount + 1);
    }
    throw err;
  }
}

// =============================================
// COMPACT RESEARCH FOR BRIEFS
// Wytnij source_urls (nie potrzebne w briefach), skróć opisy
// =============================================
function compactAnchor(anchor) {
  if (!anchor) return anchor;
  return {
    anchor: anchor.anchor,
    company_summary: anchor.company_summary,
    visual_identity: anchor.visual_identity,
    elements: (anchor.elements || []).slice(0, 3).map(e => ({
      title: e.title,
      description: (e.description || '').slice(0, 200),
      visual_potential: (e.visual_potential || '').slice(0, 200)
    })),
    top_recommendation: (anchor.top_recommendation || '').slice(0, 300)
  };
}

// =============================================
// PIPELINE
// =============================================
const MATRIX = [
  { id: 'totem_cele',     format: 'totem',  anchorKey: 'anchorA', anchorLabel: 'Aktualne cele' },
  { id: 'totem_legenda',  format: 'totem',  anchorKey: 'anchorB', anchorLabel: 'Legenda marki' },
  { id: 'scenka_cele',    format: 'scenka', anchorKey: 'anchorA', anchorLabel: 'Aktualne cele' },
  { id: 'scenka_legenda', format: 'scenka', anchorKey: 'anchorB', anchorLabel: 'Legenda marki' }
];

async function generateLead(lead, guidelines, session) {
  const sessionId = session.id;
  const overallStart = now();
  const leadId = newLeadId(lead.domain);
  const leadDir = path.join(LEADS_DIR, leadId);
  await fs.mkdir(leadDir, { recursive: true });

  console.log(`\n[${sessionId}] === Start pipeline dla ${lead.domain} ===`);
  session.events.push({ type: 'start', leadId, at: now() });

  // ===== RESEARCH =====
  let research;
  const cached = await getCachedResearch(lead.domain);
  if (cached) {
    console.log(`[${sessionId}] ⚡ Research z cache (${cached.ageDays}d)`);
    session.events.push({ type: 'phase', phase: 'research', msg: `Research z cache (${cached.ageDays}d)`, cached: true, at: now() });
    research = { lead, ...cached.research };
  } else {
    session.events.push({ type: 'phase', phase: 'research', msg: 'Research kotwicy A (cele)...', at: now() });
    const researchStart = now();
    const anchorA = await researchAnchor('A', lead, sessionId);

    // Pauza między kotwicami żeby nie przekroczyć rate limit (10k tokens/min na Tier 1)
    console.log(`[${sessionId}] ⏸  Pauza ${PAUSE_BETWEEN_ANCHORS_MS/1000}s przed kotwicą B (rate limit safety)`);
    session.events.push({ type: 'phase', phase: 'research', msg: `Pauza ${PAUSE_BETWEEN_ANCHORS_MS/1000}s (rate limit)...`, at: now() });
    await new Promise(r => setTimeout(r, PAUSE_BETWEEN_ANCHORS_MS));

    session.events.push({ type: 'phase', phase: 'research', msg: 'Research kotwicy B (legenda)...', at: now() });
    const anchorB = await researchAnchor('B', lead, sessionId);

    logTiming(sessionId, 'research-total', researchStart);
    research = { lead, anchorA, anchorB };
    await saveCachedResearch(lead.domain, { anchorA, anchorB });
  }
  await fs.writeFile(path.join(leadDir, 'research.json'), JSON.stringify(research, null, 2));

  // ===== BRIEFS — sekwencyjnie z pauzami (rate limit) =====
  // Skompaktuj research dla briefów — wycina source_urls i skraca opisy
  const compactResearch = {
    lead: research.lead,
    anchorA: compactAnchor(research.anchorA),
    anchorB: compactAnchor(research.anchorB)
  };

  await new Promise(r => setTimeout(r, 10000)); // 10s przerwy po researchu
  session.events.push({ type: 'phase', phase: 'briefs', msg: 'Generowanie 4 briefów sekwencyjnie (rate limit safe)...', at: now() });
  const briefsStart = now();
  const briefs = [];
  for (let i = 0; i < MATRIX.length; i++) {
    const cfg = MATRIX[i];
    if (i > 0) {
      // Pauza 12s między briefami
      await new Promise(r => setTimeout(r, 12000));
    }
    session.events.push({ type: 'phase', phase: 'briefs', msg: `Brief ${i+1}/4: ${cfg.id}...`, at: now() });
    const b = await generateBrief(cfg, compactResearch, guidelines, sessionId);
    briefs.push(b);
  }
  logTiming(sessionId, 'briefs-total', briefsStart);
  await fs.writeFile(path.join(leadDir, 'briefs.json'), JSON.stringify(briefs, null, 2));

  session.events.push({ type: 'briefs_ready', briefs, at: now() });

  // ===== IMAGES (parallel, streaming) =====
  session.events.push({ type: 'phase', phase: 'images', msg: 'Generowanie 4 obrazków (Nano Banana 2, parallel)...', at: now() });
  const imagesStart = now();

  const imagePromises = briefs.map(async (brief, idx) => {
    const imgName = `${leadId}__${brief.id}.png`;
    try {
      const imgUrl = await generateImage(brief, imgName, sessionId);
      const result = { idx, brief_id: brief.id, image_url: imgUrl, image_filename: imgName };
      session.events.push({ type: 'image_ready', ...result, at: now() });
      return { brief, image_url: imgUrl, image_filename: imgName };
    } catch (e) {
      console.error(`[${sessionId}] ❌ image ${brief.id}: ${e.message}`);
      const result = { idx, brief_id: brief.id, error: e.message };
      session.events.push({ type: 'image_failed', ...result, at: now() });
      return { brief, error: e.message };
    }
  });

  const results = await Promise.all(imagePromises);
  logTiming(sessionId, 'images-total', imagesStart);

  const totalMs = now() - overallStart;
  console.log(`[${sessionId}] ✅ TOTAL: ${(totalMs/1000).toFixed(1)}s\n`);
  session.events.push({ type: 'done', leadId, totalMs, at: now() });

  await appendHistory({
    ts: new Date().toISOString(),
    leadId,
    domain: lead.domain,
    totalMs,
    items: results.map(r => ({
      brief_id: r.brief?.id,
      title: r.brief?.title_pl,
      image_url: r.image_url,
      comments: []
    }))
  });

  return { leadId, leadDir, research, results };
}

// =============================================
// UPDATE GUIDELINES
// =============================================
async function proposeGuidelinesUpdate(currentGuidelines, history) {
  const recentComments = [];
  for (const lead of history.leads.slice(-10)) {
    for (const item of lead.items || []) {
      if (item.comments && item.comments.length) {
        for (const c of item.comments) {
          recentComments.push({ lead: lead.domain, brief: item.brief_id, comment: c });
        }
      }
    }
  }

  if (recentComments.length < 3) {
    return { error: `Za mało komentarzy (${recentComments.length}, min. 3).` };
  }

  const prompt = `Asystent uczący się z feedbacku.

Obecne wytyczne:
STYL: ${currentGuidelines.blocki_style}
TOTEM: ${currentGuidelines.totem_definition}
SCENKA: ${currentGuidelines.scenka_definition}

${recentComments.length} komentarzy:
${recentComments.map((c, i) => `${i+1}. [${c.lead} / ${c.brief}] ${c.comment}`).join('\n')}

Znajdź WZORCE (min 2 wystąpienia). Zaproponuj zmiany.

\`\`\`json
{
  "patterns_found": ["wzorzec (N razy)"],
  "proposed_changes": {
    "blocki_style": "nowa treść lub null",
    "totem_definition": "nowa treść lub null",
    "scenka_definition": "nowa treść lub null"
  },
  "reasoning_pl": "2-3 zdania"
}
\`\`\``;

  const response = await client.messages.create({
    model: MODEL_REGEN,
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return safeParseJson(text, 'guidelines-update');
}

// =============================================
// SESSIONS
// =============================================
const activeSessions = new Map();

// =============================================
// HTTP SERVER
// =============================================
function checkBasicAuth(req, res) {
  const expectedUser = process.env.BASIC_AUTH_USER;
  const expectedPass = process.env.BASIC_AUTH_PASS;

  // Jeśli zmienne nie są ustawione - auth wyłączony (np. lokalny dev)
  if (!expectedUser || !expectedPass) return true;

  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Basic (.+)$/);
  if (!match) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Blocki Lead Flow"',
      'Content-Type': 'text/plain; charset=utf-8'
    });
    res.end('Wymagane logowanie');
    return false;
  }

  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  if (user !== expectedUser || pass !== expectedPass) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Blocki Lead Flow"',
      'Content-Type': 'text/plain; charset=utf-8'
    });
    res.end('Niepoprawne dane logowania');
    return false;
  }

  return true;
}

async function handleRequest(req, res) {
  // Basic Auth check - blokuje wszystkie requesty bez prawidłowego loginu
  if (!checkBasicAuth(req, res)) return;

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/images/')) {
      const filename = path.basename(url.pathname);
      const filepath = path.join(IMAGES_DIR, filename);
      try {
        const data = await fs.readFile(filepath);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
        res.end(data);
      } catch {
        res.writeHead(404); res.end('not found');
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/guidelines') {
      const g = await loadGuidelines();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(g));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/guidelines') {
      const body = await readBody(req);
      const g = JSON.parse(body);
      await saveGuidelines(g);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/generate') {
      const body = await readBody(req);
      const { domain, bantNotes, contact } = JSON.parse(body);
      const sessionId = Math.random().toString(36).slice(2, 10);
      const session = { id: sessionId, events: [], done: false, result: null, error: null };
      activeSessions.set(sessionId, session);

      (async () => {
        try {
          const guidelines = await loadGuidelines();
          const lead = { domain, bantNotes, contact };
          const out = await generateLead(lead, guidelines, session);
          session.result = out;
          session.done = true;
        } catch (e) {
          console.error(`[${sessionId}] ❌ PIPELINE ERROR:`, e);
          session.error = e.message;
          session.done = true;
          session.events.push({ type: 'error', msg: e.message, at: now() });
        }
      })();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionId }));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/stream/')) {
      const id = url.pathname.split('/').pop();
      const session = activeSessions.get(id);
      if (!session) { res.writeHead(404); res.end(); return; }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      let lastIdx = 0;
      const sendNew = () => {
        while (lastIdx < session.events.length) {
          const event = session.events[lastIdx++];
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      };

      sendNew();
      const interval = setInterval(() => {
        sendNew();
        if (session.done) {
          clearInterval(interval);
          res.write(`event: close\ndata: done\n\n`);
          res.end();
        }
      }, 300);

      req.on('close', () => clearInterval(interval));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/regen') {
      const body = await readBody(req);
      const { leadId, briefId, oldBrief: clientOldBrief, comment } = JSON.parse(body);
      const guidelines = await loadGuidelines();

      // Jeśli klient nie wysłał oldBrief (np. po reload), pobierz z dysku
      let oldBrief = clientOldBrief;
      if (!oldBrief || !oldBrief.image_prompt_en) {
        try {
          const briefsPath = path.join(LEADS_DIR, leadId, 'briefs.json');
          const raw = await fs.readFile(briefsPath, 'utf8');
          const allBriefs = JSON.parse(raw);
          oldBrief = allBriefs.find(b => b.id === briefId);
          if (!oldBrief) {
            throw new Error(`Brief ${briefId} nie znaleziony w ${briefsPath}`);
          }
          console.log(`[regen] Wczytany brief z dysku: ${briefId}`);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Brief niedostępny: ${e.message}` }));
          return;
        }
      }

      const regenStart = now();
      const newBrief = await rewriteBriefWithFeedback(oldBrief, comment, guidelines);
      logTiming('regen', 'brief-rewrite', regenStart);

      const imgName = `${leadId}__${briefId}__r${Date.now()}.png`;
      const imgUrl = await generateImage(newBrief, imgName, 'regen');

      const h = await loadHistory();
      const leadEntry = h.leads.find(l => l.leadId === leadId);
      if (leadEntry) {
        const item = leadEntry.items.find(i => i.brief_id === briefId);
        if (item) {
          item.comments = item.comments || [];
          item.comments.push(comment);
          // Historia wersji: każda regeneracja to nowy wpis
          item.versions = item.versions || [];
          if (item.versions.length === 0 && item.image_url) {
            // Pierwsza wersja to oryginał
            item.versions.push({
              label: 'Oryginał',
              image_url: item.image_url,
              comment: null,
              ts: leadEntry.ts
            });
          }
          item.versions.push({
            label: 'Regen ' + item.versions.length,
            image_url: imgUrl,
            comment,
            ts: new Date().toISOString()
          });
          item.image_url = imgUrl; // aktualny = najnowszy
          await fs.writeFile(HISTORY_PATH, JSON.stringify(h, null, 2));
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ newBrief, image_url: imgUrl }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/propose-guidelines-update') {
      const guidelines = await loadGuidelines();
      const history = await loadHistory();
      const proposal = await proposeGuidelinesUpdate(guidelines, history);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(proposal));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/clear-cache') {
      const body = await readBody(req);
      const { domain } = JSON.parse(body);
      const cachePath = path.join(RESEARCH_CACHE_DIR, `${slugify(domain)}.json`);
      try { await fs.unlink(cachePath); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /api/history - lista zapisanych leadów (lżejsza wersja, bez pełnych briefów)
    if (req.method === 'GET' && url.pathname === '/api/history') {
      const h = await loadHistory();
      // Odwracamy - najnowsze pierwsze
      const leads = (h.leads || []).slice().reverse().map(l => ({
        leadId: l.leadId,
        ts: l.ts,
        domain: l.domain,
        totalMs: l.totalMs,
        items: (l.items || []).map(i => ({
          brief_id: i.brief_id,
          title: i.title,
          image_url: i.image_url,
          has_comments: (i.comments || []).length > 0,
          comments_count: (i.comments || []).length
        }))
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ leads }));
      return;
    }

    // GET /api/lead/:leadId - pełne dane leada żeby otworzyć go w UI z możliwością regenu
    if (req.method === 'GET' && url.pathname.startsWith('/api/lead/')) {
      const leadId = url.pathname.split('/').pop();
      const h = await loadHistory();
      const leadEntry = (h.leads || []).find(l => l.leadId === leadId);
      if (!leadEntry) { res.writeHead(404); res.end('lead not found'); return; }

      // Wczytaj pełne briefy z dysku
      const briefsPath = path.join(LEADS_DIR, leadId, 'briefs.json');
      let briefs = [];
      try {
        const raw = await fs.readFile(briefsPath, 'utf8');
        briefs = JSON.parse(raw);
      } catch {
        // fallback - zbuduj z history entry (bez image_prompt_en)
        briefs = (leadEntry.items || []).map(i => ({
          id: i.brief_id,
          title_pl: i.title,
          format: i.brief_id?.startsWith('totem') ? 'totem' : 'scenka',
          anchor: i.brief_id?.endsWith('cele') ? 'Aktualne cele' : 'Legenda marki'
        }));
      }

      // Scal briefy z aktualnymi image_url i komentarzami z history
      const items = briefs.map(b => {
        const histItem = (leadEntry.items || []).find(i => i.brief_id === b.id);
        return {
          brief: b,
          image_url: histItem?.image_url || null,
          comments: histItem?.comments || [],
          versions: histItem?.versions || []
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        leadId,
        domain: leadEntry.domain,
        ts: leadEntry.ts,
        totalMs: leadEntry.totalMs,
        items
      }));
      return;
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    console.error('HTTP Error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// =============================================
// HTML
// =============================================
const PAGE_HTML = `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<title>Blocki Lead Flow v3</title>
<style>
* { box-sizing: border-box; }
body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 20px; max-width: 1400px; margin: 0 auto; background: #f5f5f5; color: #222; }
h1 { margin: 0 0 20px; display: flex; align-items: center; gap: 10px; }
h1 .badge { font-size: 12px; background: #0066CC; color: white; padding: 3px 8px; border-radius: 4px; font-weight: normal; }
h2 { margin: 0 0 10px; font-size: 18px; }
.panel { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.panel.collapsed .panel-body { display: none; }
.panel-header { cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
.panel-header .toggle { font-size: 12px; color: #888; }
label { display: block; font-size: 13px; margin: 8px 0 4px; color: #555; font-weight: 500; }
textarea, input { width: 100%; padding: 8px 10px; font-family: inherit; font-size: 14px; border: 1px solid #ddd; border-radius: 4px; }
textarea { min-height: 80px; resize: vertical; }
button { background: #0066CC; color: white; border: none; padding: 10px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
button:hover { background: #0055aa; }
button:disabled { background: #aaa; cursor: not-allowed; }
button.secondary { background: #666; }
button.secondary:hover { background: #444; }
.status-bar { padding: 12px; background: #e8f0fc; border-radius: 4px; margin: 10px 0; font-size: 13px; display: none; }
.status-bar.active { display: block; }
.status-bar.error { background: #fde8e8; color: #a00; }
.status-bar.done { background: #e8f8e8; color: #050; }
.timer { font-family: Menlo, monospace; font-size: 12px; color: #0066CC; margin-left: 8px; }
.phase-log { font-size: 12px; color: #666; margin-top: 6px; font-family: Menlo, monospace; }
.results { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
.card { background: white; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.card h3 { margin: 0 0 10px; font-size: 16px; }
.card img { width: 100%; border-radius: 4px; display: block; }
.card .card-status { font-size: 12px; color: #888; margin: 8px 0; }
.card .card-status.working { color: #0066CC; }
.card .card-status.error { color: #a00; }
.card .card-status.done { color: #050; }
.card textarea { min-height: 50px; }
.card .placeholder { width: 100%; aspect-ratio: 1; background: repeating-linear-gradient(45deg,#f5f5f5,#f5f5f5 10px,#ebebeb 10px,#ebebeb 20px); border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #999; font-size: 13px; }
.two-col { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; }
.history-item { background: #fafafa; border: 1px solid #eee; border-radius: 6px; padding: 10px; cursor: pointer; transition: all 0.15s; }
.history-item:hover { background: #f0f7ff; border-color: #0066CC; }
.history-item .hi-header { display: flex; justify-content: space-between; font-size: 12px; color: #666; margin-bottom: 8px; }
.history-item .hi-domain { font-weight: 600; color: #222; font-size: 14px; margin-bottom: 8px; }
.history-item .hi-thumbs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
.history-item .hi-thumbs img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 3px; background: #eee; }
.history-item .hi-thumbs .hi-missing { width: 100%; aspect-ratio: 1; background: #eee; border-radius: 3px; display: flex; align-items: center; justify-content: center; color: #aaa; font-size: 11px; }
.history-item .hi-meta { display: flex; gap: 8px; margin-top: 6px; font-size: 11px; color: #888; }
.history-item .hi-meta .hi-comments { color: #0066CC; }
.download-link { font-size: 11px; color: #0066CC; text-decoration: none; margin-top: 4px; display: inline-block; }
.download-link:hover { text-decoration: underline; }
.bulk-download-bar { background: white; border-radius: 8px; padding: 10px 16px; margin-bottom: 12px; display: none; align-items: center; justify-content: space-between; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.bulk-download-bar.visible { display: flex; }
.bulk-download-bar span { font-size: 13px; color: #666; }
.prompt-toggle { font-size: 11px; color: #888; cursor: pointer; margin-top: 4px; user-select: none; }
.prompt-toggle:hover { color: #0066CC; }
.prompt-box { display: none; background: #f8f8f8; border: 1px solid #e0e0e0; border-radius: 4px; padding: 8px; margin-top: 6px; font-family: Menlo, monospace; font-size: 11px; color: #444; white-space: pre-wrap; max-height: 200px; overflow-y: auto; }
.prompt-box.visible { display: block; }
.version-nav { display: none; gap: 6px; align-items: center; margin-top: 6px; font-size: 11px; }
.version-nav.visible { display: flex; }
.version-nav button { background: #eee; color: #333; border: 1px solid #ddd; padding: 2px 8px; font-size: 11px; border-radius: 3px; cursor: pointer; }
.version-nav button:hover:not(:disabled) { background: #ddd; }
.version-nav button:disabled { opacity: 0.4; cursor: not-allowed; }
.version-nav .version-label { color: #666; font-family: Menlo, monospace; }
.version-nav .version-comment { color: #888; font-style: italic; margin-left: 4px; }
.proposal-section { margin: 10px 0; padding: 10px; background: #fff8e1; border-radius: 4px; }
.diff-box { background: #f9f9f9; border: 1px solid #ddd; padding: 10px; border-radius: 4px; font-size: 13px; white-space: pre-wrap; margin: 10px 0; }
</style>
</head>
<body>
<h1>Blocki Lead Flow <span class="badge">v3 — Nano Banana 2</span></h1>

<div class="panel collapsed" id="guidelines-panel">
  <div class="panel-header" onclick="this.parentElement.classList.toggle('collapsed')">
    <h2>Wytyczne uniwersalne</h2>
    <span class="toggle">rozwiń/zwiń</span>
  </div>
  <div class="panel-body">
    <div class="two-col">
      <div>
        <label>Styl Blocki</label>
        <textarea id="g-style" rows="12"></textarea>
      </div>
      <div>
        <label>Definicja totemu</label>
        <textarea id="g-totem" rows="12"></textarea>
      </div>
      <div>
        <label>Definicja scenki</label>
        <textarea id="g-scenka" rows="12"></textarea>
      </div>
    </div>
    <div style="margin-top: 12px; display: flex; gap: 10px; align-items: center;">
      <button onclick="saveGuidelines()">Zapisz</button>
      <button class="secondary" onclick="resetGuidelines()">Przywróć domyślne</button>
      <button class="secondary" onclick="proposeUpdate()">Zaktualizuj z komentarzy</button>
      <span id="guidelines-status" style="font-size: 13px;"></span>
    </div>
    <div id="proposal-box" style="display:none;"></div>
  </div>
</div>

<div class="panel">
  <h2>Nowy lead</h2>
  <label>Domena</label>
  <input id="in-domain" placeholder="np. hagergroup.com">
  <label>Email (opcjonalnie)</label>
  <input id="in-contact" placeholder="np. karolina.sosna@...">
  <label>Notatka BANT</label>
  <textarea id="in-bant" rows="10" placeholder="Notatka od Weroniki..."></textarea>
  <div style="margin-top: 12px; display: flex; gap: 8px; align-items: center;">
    <button id="btn-generate" onclick="generate()">Generuj 4 obrazki</button>
    <button class="secondary" onclick="clearCache()">Wymuś świeży research</button>
  </div>
  <div id="status-bar" class="status-bar"></div>
</div>

<div class="panel collapsed" id="history-panel">
  <div class="panel-header" onclick="toggleHistory()">
    <h2>Historia leadów <span id="history-count" style="font-weight: normal; color: #888; font-size: 14px;"></span></h2>
    <span class="toggle">rozwiń/zwiń</span>
  </div>
  <div class="panel-body">
    <div id="history-list" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px;"></div>
  </div>
</div>

<div id="bulk-download-bar" class="bulk-download-bar">
  <span id="bulk-download-info"></span>
  <button onclick="downloadAll()">Pobierz wszystkie 4 PNG</button>
</div>

<div id="results" class="results"></div>

<script>
let currentLeadId = null;
let currentBriefs = {};
let currentImages = {}; // { briefId: image_url }
let cardVersions = {}; // { briefId: { versions: [{label, image_url, comment}], currentIdx } }
let sessionStart = null;
let timerInterval = null;

function updateBulkDownloadBar() {
  const bar = document.getElementById('bulk-download-bar');
  const info = document.getElementById('bulk-download-info');
  const count = Object.keys(currentImages).length;
  if (count > 0 && currentLeadId) {
    bar.classList.add('visible');
    info.textContent = count + ' obrazków dla ' + (currentLeadId.split('__')[1] || 'leada');
  } else {
    bar.classList.remove('visible');
  }
}

function downloadAll() {
  const entries = Object.entries(currentImages);
  for (const [briefId, imgUrl] of entries) {
    const filename = (currentLeadId || 'blocki') + '__' + briefId + '.png';
    // Opóźnienie 200ms między pobraniami żeby przeglądarka nie blokowała
    setTimeout(() => downloadImage(imgUrl, filename), entries.indexOf([briefId, imgUrl]) * 200);
  }
  // Lepsza pętla z indeksem
  entries.forEach(([briefId, imgUrl], idx) => {
    const filename = (currentLeadId || 'blocki') + '__' + briefId + '.png';
    setTimeout(() => downloadImage(imgUrl, filename), idx * 200);
  });
}

function navigateVersion(briefId, delta) {
  const cv = cardVersions[briefId];
  if (!cv || !cv.versions.length) return;
  const newIdx = cv.currentIdx + delta;
  if (newIdx < 0 || newIdx >= cv.versions.length) return;
  cv.currentIdx = newIdx;
  const v = cv.versions[newIdx];
  const img = document.getElementById('img-' + briefId);
  if (img) img.src = v.image_url + '?t=' + Date.now();
  currentImages[briefId] = v.image_url;
  updateVersionNav(briefId);
}

function updateVersionNav(briefId) {
  const cv = cardVersions[briefId];
  if (!cv) return;
  const navEl = document.getElementById('vn-' + briefId);
  const labelEl = document.getElementById('vl-' + briefId);
  const commentEl = document.getElementById('vc-' + briefId);
  const prevBtn = document.getElementById('vp-' + briefId);
  const nextBtn = document.getElementById('vn-next-' + briefId);
  if (cv.versions.length <= 1) {
    navEl.classList.remove('visible');
    return;
  }
  navEl.classList.add('visible');
  const v = cv.versions[cv.currentIdx];
  labelEl.textContent = v.label + ' (' + (cv.currentIdx + 1) + '/' + cv.versions.length + ')';
  commentEl.textContent = v.comment ? '— ' + v.comment.slice(0, 50) + (v.comment.length > 50 ? '...' : '') : '';
  prevBtn.disabled = cv.currentIdx === 0;
  nextBtn.disabled = cv.currentIdx === cv.versions.length - 1;
}

async function loadHistoryList() {
  try {
    const r = await fetch('/api/history');
    const { leads } = await r.json();
    const list = document.getElementById('history-list');
    const countEl = document.getElementById('history-count');
    countEl.textContent = leads.length ? '(' + leads.length + ')' : '';

    if (!leads.length) {
      list.innerHTML = '<div style="color: #888; font-size: 13px; padding: 10px;">Brak zapisanych leadów. Wygeneruj pierwszy powyżej.</div>';
      return;
    }

    list.innerHTML = leads.map(l => {
      const date = new Date(l.ts).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
      const thumbs = l.items.map(i => i.image_url
        ? '<img src="' + i.image_url + '?t=' + Date.now() + '" alt="' + (i.title || '') + '">'
        : '<div class="hi-missing">?</div>'
      ).join('');
      const regens = l.items.reduce((sum, i) => sum + (i.comments_count || 0), 0);
      const time = l.totalMs ? Math.round(l.totalMs / 1000) + 's' : '';
      return '<div class="history-item" onclick="openLead(\\''+ l.leadId +'\\')">' +
        '<div class="hi-header"><span>' + date + '</span><span>' + time + '</span></div>' +
        '<div class="hi-domain">' + l.domain + '</div>' +
        '<div class="hi-thumbs">' + thumbs + '</div>' +
        '<div class="hi-meta">' +
          '<span>' + l.items.length + ' obrazków</span>' +
          (regens > 0 ? '<span class="hi-comments">• ' + regens + ' regenów</span>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    console.error('loadHistoryList error:', e);
  }
}

function toggleHistory() {
  const panel = document.getElementById('history-panel');
  panel.classList.toggle('collapsed');
  if (!panel.classList.contains('collapsed')) {
    loadHistoryList();
  }
}

async function openLead(leadId) {
  try {
    const r = await fetch('/api/lead/' + leadId);
    const data = await r.json();
    currentLeadId = data.leadId;
    currentBriefs = {};
    currentImages = {};
    cardVersions = {};
    document.getElementById('results').innerHTML = '';

    for (const item of data.items) {
      currentBriefs[item.brief.id] = item.brief;
      renderCardSkeleton(item.brief);
      if (item.image_url) {
        renderImageInCard(item.brief.id, item.image_url);
      }
      // Wczytaj historię wersji jeśli istnieje
      if (item.versions && item.versions.length > 0) {
        cardVersions[item.brief.id] = {
          versions: item.versions.map(v => ({
            label: v.label,
            image_url: v.image_url,
            comment: v.comment
          })),
          currentIdx: item.versions.length - 1
        };
        updateVersionNav(item.brief.id);
      }
      if (item.comments && item.comments.length) {
        const cs = document.getElementById('cs-' + item.brief.id);
        if (cs) cs.textContent += ' (' + item.comments.length + 'x regen)';
      }
    }
    updateBulkDownloadBar();
    document.getElementById('results').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    alert('Błąd wczytywania leada: ' + e.message);
  }
}

function downloadImage(url, filename) {
  const a = document.createElement('a');
  a.href = url + '?t=' + Date.now();
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function loadGuidelines() {
  const r = await fetch('/api/guidelines');
  const g = await r.json();
  document.getElementById('g-style').value = g.blocki_style;
  document.getElementById('g-totem').value = g.totem_definition;
  document.getElementById('g-scenka').value = g.scenka_definition;
}

async function saveGuidelines() {
  const g = {
    blocki_style: document.getElementById('g-style').value,
    totem_definition: document.getElementById('g-totem').value,
    scenka_definition: document.getElementById('g-scenka').value
  };
  await fetch('/api/guidelines', { method: 'POST', body: JSON.stringify(g), headers: {'Content-Type': 'application/json'} });
  const s = document.getElementById('guidelines-status');
  s.textContent = 'Zapisano';
  setTimeout(() => s.textContent = '', 2000);
}

async function resetGuidelines() {
  if (!confirm('Przywrócić domyślne wytyczne v3? (nadpisze obecne)')) return;
  // Wyślij pusty obiekt, serwer przy następnym load zregeneruje defaulty
  // Alternatywnie - wyślij defaulty z frontu (ale lepiej zaufać serwerowi)
  // Tu po prostu usuwamy plik przez API i ładujemy na nowo
  await fetch('/api/guidelines', { method: 'POST', body: JSON.stringify({
    blocki_style: '', totem_definition: '', scenka_definition: ''
  }), headers: {'Content-Type': 'application/json'} });
  // Teraz usuń plik i ponownie załaduj (serwer utworzy defaulty)
  location.reload();
}

async function clearCache() {
  const domain = document.getElementById('in-domain').value.trim();
  if (!domain) { alert('Wpisz najpierw domenę'); return; }
  await fetch('/api/clear-cache', { method: 'POST', body: JSON.stringify({ domain }), headers: {'Content-Type': 'application/json'} });
  alert('Cache wyczyszczony dla ' + domain);
}

async function proposeUpdate() {
  const box = document.getElementById('proposal-box');
  box.style.display = 'block';
  box.innerHTML = '<div class="proposal-section">Analizuję...</div>';
  const r = await fetch('/api/propose-guidelines-update', { method: 'POST' });
  const p = await r.json();
  if (p.error) { box.innerHTML = '<div class="proposal-section">' + p.error + '</div>'; return; }
  let html = '<div class="proposal-section"><h3>Wzorce:</h3><ul>';
  for (const pat of p.patterns_found || []) html += '<li>' + pat + '</li>';
  html += '</ul><h3>Uzasadnienie:</h3><p>' + p.reasoning_pl + '</p><h3>Zmiany:</h3>';
  for (const [k, v] of Object.entries(p.proposed_changes || {})) {
    if (v) html += '<div><strong>' + k + '</strong><div class="diff-box">' + v + '</div></div>';
  }
  const pData = JSON.stringify(p).replace(/"/g, '&quot;');
  html += '<button onclick="acceptProposal(JSON.parse(this.dataset.p))" data-p="' + pData + '">Akceptuj</button> ';
  html += '<button class="secondary" onclick="document.getElementById(\\'proposal-box\\').style.display=\\'none\\'">Odrzuć</button></div>';
  box.innerHTML = html;
}

async function acceptProposal(p) {
  const g = {
    blocki_style: p.proposed_changes.blocki_style || document.getElementById('g-style').value,
    totem_definition: p.proposed_changes.totem_definition || document.getElementById('g-totem').value,
    scenka_definition: p.proposed_changes.scenka_definition || document.getElementById('g-scenka').value
  };
  await fetch('/api/guidelines', { method: 'POST', body: JSON.stringify(g), headers: {'Content-Type': 'application/json'} });
  await loadGuidelines();
  document.getElementById('proposal-box').style.display = 'none';
}

function updateTimer() {
  if (!sessionStart) return;
  const el = document.getElementById('timer');
  if (el) el.textContent = '[' + ((Date.now() - sessionStart) / 1000).toFixed(1) + 's]';
}

async function generate() {
  const domain = document.getElementById('in-domain').value.trim();
  const contact = document.getElementById('in-contact').value.trim();
  const bantNotes = document.getElementById('in-bant').value.trim();
  if (!domain || !bantNotes) { alert('Domena i BANT wymagane'); return; }

  document.getElementById('btn-generate').disabled = true;
  const bar = document.getElementById('status-bar');
  bar.className = 'status-bar active';
  bar.innerHTML = 'Uruchamiam... <span id="timer" class="timer">[0.0s]</span><div class="phase-log" id="phase-log"></div>';
  document.getElementById('results').innerHTML = '';
  currentImages = {};
  cardVersions = {};
  updateBulkDownloadBar();

  sessionStart = Date.now();
  timerInterval = setInterval(updateTimer, 100);

  const r = await fetch('/api/generate', { method: 'POST', body: JSON.stringify({ domain, contact, bantNotes }), headers: {'Content-Type': 'application/json'} });
  const { sessionId } = await r.json();

  const evtSource = new EventSource('/api/stream/' + sessionId);
  const phaseLog = [];

  evtSource.onmessage = (e) => {
    const event = JSON.parse(e.data);
    handleEvent(event, phaseLog);
  };

  evtSource.addEventListener('close', () => {
    evtSource.close();
    clearInterval(timerInterval);
    document.getElementById('btn-generate').disabled = false;
  });

  evtSource.onerror = () => {
    evtSource.close();
    clearInterval(timerInterval);
    document.getElementById('btn-generate').disabled = false;
  };
}

function handleEvent(event, phaseLog) {
  const bar = document.getElementById('status-bar');
  const statusText = bar.childNodes[0];
  const phaseLogEl = document.getElementById('phase-log');

  switch (event.type) {
    case 'start':
      currentLeadId = event.leadId;
      currentBriefs = {};
      break;
    case 'phase':
      statusText.textContent = event.msg + ' ';
      phaseLog.push((event.cached ? '⚡ ' : '▶ ') + event.msg);
      phaseLogEl.textContent = phaseLog.join(' → ');
      break;
    case 'briefs_ready':
      for (const brief of event.briefs) {
        currentBriefs[brief.id] = brief;
        renderCardSkeleton(brief);
      }
      break;
    case 'image_ready':
      renderImageInCard(event.brief_id, event.image_url);
      break;
    case 'image_failed':
      renderErrorInCard(event.brief_id, event.error);
      break;
    case 'done':
      bar.className = 'status-bar active done';
      statusText.textContent = 'Gotowe w ' + (event.totalMs / 1000).toFixed(1) + 's ';
      // Odśwież historię w tle
      loadHistoryList();
      break;
    case 'error':
      bar.className = 'status-bar active error';
      statusText.textContent = 'Błąd: ' + event.msg + ' ';
      break;
  }
}

function renderCardSkeleton(brief) {
  const container = document.getElementById('results');
  let card = document.getElementById('card-' + brief.id);
  if (card) return;
  card = document.createElement('div');
  card.className = 'card';
  card.id = 'card-' + brief.id;
  const promptText = brief.image_prompt_en || '(prompt niedostępny)';
  card.innerHTML =
    '<h3>' + (brief.title_pl || brief.id) + '</h3>' +
    '<div class="card-status working" id="cs-' + brief.id + '">' + brief.format + ' × ' + brief.anchor + ' — generowanie...</div>' +
    '<div class="placeholder" id="ph-' + brief.id + '">⏳ Render</div>' +
    '<div class="version-nav" id="vn-' + brief.id + '">' +
      '<button onclick="navigateVersion(\\''+ brief.id +'\\', -1)" id="vp-' + brief.id + '">←</button>' +
      '<span class="version-label" id="vl-' + brief.id + '"></span>' +
      '<button onclick="navigateVersion(\\''+ brief.id +'\\', 1)" id="vn-next-' + brief.id + '">→</button>' +
      '<span class="version-comment" id="vc-' + brief.id + '"></span>' +
    '</div>' +
    '<div class="prompt-toggle" onclick="togglePrompt(\\''+ brief.id +'\\')">📝 Zobacz prompt</div>' +
    '<div class="prompt-box" id="pb-' + brief.id + '">' + escapeHtml(promptText) + '</div>' +
    '<label>Co poprawić</label>' +
    '<textarea id="c-' + brief.id + '" placeholder="np. dodaj więcej figurek, więcej studsów na dachu..."></textarea>' +
    '<div style="margin-top: 8px;"><button onclick="regen(\\''+ brief.id +'\\')">Regeneruj</button></div>';
  container.appendChild(card);
  // Każda karta może mieć własną tablicę wersji
  cardVersions[brief.id] = { versions: [], currentIdx: -1 };
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function togglePrompt(briefId) {
  const box = document.getElementById('pb-' + briefId);
  if (box) box.classList.toggle('visible');
}

function renderImageInCard(briefId, imageUrl) {
  const ph = document.getElementById('ph-' + briefId);
  if (ph) {
    const img = document.createElement('img');
    img.src = imageUrl + '?t=' + Date.now();
    img.id = 'img-' + briefId;
    ph.replaceWith(img);
    const card = document.getElementById('card-' + briefId);
    if (card && !document.getElementById('dl-' + briefId)) {
      const dl = document.createElement('a');
      dl.id = 'dl-' + briefId;
      dl.className = 'download-link';
      dl.href = '#';
      dl.textContent = '↓ Pobierz PNG';
      const filename = (currentLeadId || 'blocki') + '__' + briefId + '.png';
      dl.onclick = (e) => { e.preventDefault(); downloadImage(imageUrl, filename); };
      img.insertAdjacentElement('afterend', dl);
    }
  } else {
    // Obrazek już istnieje - podmień src (np. przy navigateVersion)
    const img = document.getElementById('img-' + briefId);
    if (img) img.src = imageUrl + '?t=' + Date.now();
  }
  const cs = document.getElementById('cs-' + briefId);
  if (cs) {
    const brief = currentBriefs[briefId];
    cs.className = 'card-status done';
    cs.textContent = brief.format + ' × ' + brief.anchor + ' ✓';
  }
  // Zaktualizuj globalny stan obrazków
  currentImages[briefId] = imageUrl;
  updateBulkDownloadBar();
}

function renderErrorInCard(briefId, errorMsg) {
  const ph = document.getElementById('ph-' + briefId);
  if (ph) { ph.textContent = 'BŁĄD: ' + errorMsg; }
  const cs = document.getElementById('cs-' + briefId);
  if (cs) { cs.className = 'card-status error'; cs.textContent = 'Błąd: ' + errorMsg; }
}

async function regen(briefId) {
  const comment = document.getElementById('c-' + briefId).value.trim();
  if (!comment) { alert('Wpisz komentarz'); return; }
  const cs = document.getElementById('cs-' + briefId);
  const origStatus = cs.textContent;
  cs.className = 'card-status working';
  cs.textContent = 'Regeneruję...';

  try {
    const r = await fetch('/api/regen', {
      method: 'POST',
      body: JSON.stringify({ leadId: currentLeadId, briefId, oldBrief: currentBriefs[briefId], comment }),
      headers: {'Content-Type': 'application/json'}
    });
    const { newBrief, image_url } = await r.json();

    // Zapisz oryginał jako wersję 0 jeśli nie jest jeszcze zapisana
    const cv = cardVersions[briefId] = cardVersions[briefId] || { versions: [], currentIdx: -1 };
    if (cv.versions.length === 0 && currentImages[briefId]) {
      cv.versions.push({
        label: 'Oryginał',
        image_url: currentImages[briefId],
        comment: null
      });
    }
    cv.versions.push({
      label: 'Regen ' + cv.versions.length,
      image_url,
      comment
    });
    cv.currentIdx = cv.versions.length - 1;

    // Zaktualizuj brief (może mieć nowy prompt)
    currentBriefs[briefId] = newBrief;
    // Zaktualizuj prompt w UI
    const pb = document.getElementById('pb-' + briefId);
    if (pb) pb.textContent = newBrief.image_prompt_en || '(prompt niedostępny)';

    const img = document.getElementById('img-' + briefId);
    if (img) img.src = image_url + '?t=' + Date.now();
    currentImages[briefId] = image_url;
    updateVersionNav(briefId);
    updateBulkDownloadBar();

    cs.className = 'card-status done';
    cs.textContent = origStatus + ' (wersja ' + cv.versions.length + ')';
    document.getElementById('c-' + briefId).value = '';
    loadHistoryList();
  } catch (e) {
    cs.className = 'card-status error';
    cs.textContent = 'Błąd: ' + e.message;
  }
}

loadGuidelines();
loadHistoryList();
</script>
</body>
</html>`;

// =============================================
// START
// =============================================
async function main() {
  await ensureDirs();
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`\n=== Blocki Lead Flow v3 ===`);
    console.log(`Serwer: http://localhost:${PORT}`);
    console.log(`Model obrazów: Nano Banana 2 (Gemini 3.1 Flash Image, reasoning-guided)`);
    console.log(`Endpoint: ${FAL_ENDPOINT}`);
    console.log(`Modele Claude: research=${MODEL_RESEARCH}, briefy=${MODEL_BRIEFS}`);
    console.log(`Searches: ${MAX_SEARCHES_PER_ANCHOR} per kotwica\n`);
    console.log(`Otwórz: http://localhost:${PORT}\n`);
  });
}

main().catch(err => {
  console.error('Błąd startu:', err.message);
  process.exit(1);
});
