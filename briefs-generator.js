import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs/promises';
import path from 'node:path';

// =============================================
// OVERRIDE PALETY (weryfikacja ręczna)
// =============================================
const COLOR_OVERRIDE = {
  primary: '#003C71',
  secondary: '#0066CC',
  neutral_dark: '#000000',
  neutral_light: '#FFFFFF',
  notes: 'Aktualny branding Hagera: czarny woodmark + granatowo-niebieski double dot. Biel jako tło. Unikać czerwieni i pomarańczu (stare logo).'
};

// =============================================
// KONFIGURACJA
// =============================================
const MODEL = 'claude-sonnet-4-5-20250929';
const INPUT_PATH = './output/research.json';
const OUTPUT_PATH = './output/briefs.json';

const client = new Anthropic();

// =============================================
// MACIERZ 2x2
// =============================================
const MATRIX = [
  { id: 'totem_cele',     format: 'totem',  anchorKey: 'anchorA', anchorLabel: 'Aktualne cele' },
  { id: 'totem_legenda',  format: 'totem',  anchorKey: 'anchorB', anchorLabel: 'Legenda marki' },
  { id: 'scenka_cele',    format: 'scenka', anchorKey: 'anchorA', anchorLabel: 'Aktualne cele' },
  { id: 'scenka_legenda', format: 'scenka', anchorKey: 'anchorB', anchorLabel: 'Legenda marki' }
];

// =============================================
// PROMPT
// =============================================
function buildBriefPrompt(config, research, colorOverride) {
  const anchor = research[config.anchorKey];
  const TOP_OVERRIDE = {
    anchorA: 'Dom Energetyczny Przyszłości',
    anchorB: 'Rozdzielnica Volta'
  };
  const topTitle = TOP_OVERRIDE[config.anchorKey];
  const top = anchor.elements.find(e => e.title.includes(topTitle.split(' ').pop()))
           || anchor.elements[0];

  const formatDescription = config.format === 'totem'
    ? `TOTEM – to nie dom, nie fabryka, nie scena z wieloma elementami. To JEDEN ikoniczny obiekt-symbol stojący na eleganckiej podstawie. Wysokość około 20-30cm. Wybierz z potencjału wizualnego JEDEN najbardziej rozpoznawalny element i zrób z niego pomnik-statuetkę. Przykłady totemu: sama rozdzielnica jako obiekt, sam samochód EV z wallboxem, sam panel fotowoltaiczny z mini-słońcem. Bez dioramy, bez figurek postaci, bez tła fabularnego. Totem = LOGO-obiekt w formie 3D. Jeśli zauważysz że robisz totem wyglądający jak mała scena, to znaczy że idziesz w złą stronę – uprość do jednego obiektu-symbolu.`
    : `SCENKA – to pełna diorama z wieloma elementami, budynkami, figurkami postaci, akcją. Nie pojedynczy obiekt na podstawie. Scena opowiada historię przez kompozycję wielu elementów. Wymagane: minimum 3-4 figurki postaci (ludzie w akcji), budynek lub wnętrze, rekwizyty, wyraźna narracja. Format przypomina modele kolejowe, makiety lub dioramy muzealne. Podstawa około 30x30cm. Jeśli scenka nie ma co najmniej 3 figurek ludzi wykonujących akcje, to znaczy że za bardzo przypomina totem – dodaj postacie i kontekst.`;

  return `Jesteś senior art directorem w Blocki Custom, agencji produkującej zestawy klocków LEGO-kompatybilne jako corporate gifts.

Twoim zadaniem jest przygotowanie precyzyjnego briefu wizualnego dla konceptu zestawu klocków dla klienta Hager Group. Brief trafi do modelu generującego obrazek (Recraft V3, digital illustration style). Output ma być key visual dla oferty, ilustracja koncepcyjna pokazująca pomysł, nie finalny render produkcyjny.

KLIENT: Hager Group (producent rozwiązań elektroinstalacyjnych)

FORMAT ZESTAWU: ${config.format.toUpperCase()}
${formatDescription}

KOTWICA NARRACYJNA: ${config.anchorLabel}

TOP MOTYW Z RESEARCHU:
Tytuł: ${top.title}
Opis: ${top.description}
Potencjał wizualny: ${top.visual_potential}
${top.why_relevant ? 'Dlaczego aktualnie ważne: ' + top.why_relevant : ''}
${top.why_iconic ? 'Dlaczego legenda: ' + top.why_iconic : ''}

PALETA KOLORÓW HAGERA (zweryfikowana):
Primary: ${colorOverride.primary} (granat)
Secondary: ${colorOverride.secondary} (niebieski)
Neutral dark: ${colorOverride.neutral_dark}
Neutral light: ${colorOverride.neutral_light}
Uwagi: ${colorOverride.notes}

STYL OBRAZKA:
- Digital illustration, koncepcyjna, nie fotorealizm
- Zestaw klocków jako główny bohater kadru
- Otoczenie pasujące do motywu (nie puste białe tło, nie product shot)
- Kolory zestawu nawiązują do palety Hagera
- Oświetlenie: delikatne, wywołujące ciepło i eksploracyjną ciekawość
- Nastrój: inspirujący, nowoczesny, ciepły, pokazujący potencjał

TWOJE ZADANIE:
Wygeneruj kompletny brief wizualny dla tego konkretnego konceptu. Output w JSON, w bloku kodu:

\`\`\`json
{
  "id": "${config.id}",
  "format": "${config.format}",
  "anchor": "${config.anchorLabel}",
  "title_pl": "krótki, chwytliwy tytuł po polsku (max 5 słów), który użyjemy w ofercie",
  "concept_pl": "2-3 zdania po polsku opisujące główną ideę zestawu i dlaczego pasuje do Hagera",
  "key_elements": [
    "element1 widoczny na obrazku",
    "element2",
    "element3",
    "element4 i więcej jeśli potrzeba"
  ],
  "setting": "krótki opis otoczenia sceny lub kontekstu wokół zestawu",
  "mood": "nastrój jednym zdaniem",
  "image_prompt_en": "FULL ENGLISH PROMPT for Recraft V3, MAX 850 CHARACTERS (hard limit — jeśli przekraczasz, skracaj). Struktura: główny obiekt (LEGO-compatible brick set) | co przedstawia | 3-5 kluczowych elementów widocznych | krótki opis otoczenia | kolory z palety Hager (navy #003C71, blue #0066CC, white, black) | styl (digital illustration, concept art) | oświetlenie | nastrój. Pisz konkretnie ale zwięźle. Wymieniaj obiekty pojedynczymi słowami lub krótkimi frazami oddzielonymi przecinkami, nie pełnymi zdaniami. Na końcu: 'digital illustration, soft lighting, concept art, warm inspiring mood'. Prompt MUSI zaczynać się od 'A LEGO-compatible brick set'."
\`\`\`

Jedna zasada krytyczna: image_prompt_en MUSI zaczynać się od "A LEGO-compatible brick set" (nie "LEGO", bo copyright). Cały prompt po angielsku, opisowy, konkretny. Wymień fizyczne obiekty, nie abstrakcje.`;
}

// =============================================
// LOGIKA
// =============================================
async function generateBrief(config, research, colorOverride) {
  console.log(`[${config.id}] start...`);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: buildBriefPrompt(config, research, colorOverride) }]
  });

  const finalText = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  const jsonMatch = finalText.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    console.error(`[${config.id}] brak bloku JSON`);
    return { id: config.id, parse_error: true, raw_text: finalText };
  }

  try {const parsed = JSON.parse(jsonMatch[1]);
    if (parsed.image_prompt_en && parsed.image_prompt_en.length > 950) {
      console.warn(`[${config.id}] prompt za długi (${parsed.image_prompt_en.length}), skracam do 950 znaków`);
      parsed.image_prompt_en = parsed.image_prompt_en.slice(0, 947) + '...';
    }
    console.log(`[${config.id}] OK. title: "${parsed.title_pl}" (prompt: ${parsed.image_prompt_en?.length ?? 0} znaków)`);
    return parsed; } catch (e) {
    console.error(`[${config.id}] błąd JSON: ${e.message}`);
    return { id: config.id, parse_error: true, raw_text: finalText };
  }
}

// =============================================
// MAIN
// =============================================
async function main() {
  const research = JSON.parse(await fs.readFile(INPUT_PATH, 'utf8'));
  const start = Date.now();

  console.log(`\n=== Blocki Briefs Generator ===`);
  console.log(`Klient: ${research.lead.domain}`);
  console.log(`Model:  ${MODEL}`);
  console.log(`Macierz: 4 briefy (2 formaty × 2 kotwice)\n`);

  const briefs = await Promise.all(
    MATRIX.map(config => generateBrief(config, research, COLOR_OVERRIDE))
  );

  const result = {
    lead: research.lead,
    model: MODEL,
    timestamp: new Date().toISOString(),
    duration_s: ((Date.now() - start) / 1000).toFixed(1),
    color_override: COLOR_OVERRIDE,
    briefs
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(result, null, 2));

  console.log(`\n=== Gotowe w ${result.duration_s}s ===`);
  console.log(`Zapisano: ${OUTPUT_PATH}\n`);
  briefs.forEach(b => {
    if (b.parse_error) {
      console.log(`${b.id}: BŁĄD PARSOWANIA`);
    } else {
      console.log(`${b.id}: ${b.title_pl}`);
    }
  });
}

main().catch(err => {
  console.error('Błąd:', err.message);
  process.exit(1);
});

