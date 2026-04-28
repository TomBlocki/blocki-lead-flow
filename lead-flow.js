import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs/promises';
import path from 'node:path';

// =============================================
// INPUT
// =============================================
const LEAD = {
  domain: 'hagergroup.com',
  contactEmail: 'karolina.sosna@hagergroup-external.com',
  bantNotes: `Telefon, robią elektroinstalacje
Pomysł: makieta domu z ich rozwiązaniami, dom plus garaż
Cel: gadżety promocyjne dla klientów
Efekt: wyróżnienie na tle konkurencji
B: praktyczne dla elektryków instalatorów, gadżety do ich pracy, napoje gazowane z grafiką (jakaś współpraca), nasz budżet i ilości okej
A: zespół marketingu, szefowa
N: ciężko odpowiedzieć, inicjatywa szefowej
T: Dzień Dziecka 2026
Storytelling: pomyśli, podpyta teamu z komunikacji
Gotowość: wstępny pomysł ale szefowa go rzuciła
Spotkanie: 30.10, 13:00
Wysłany mail z podsumowaniem`
};

// =============================================
// KONFIGURACJA
// =============================================
const MODEL = 'claude-sonnet-4-5-20250929';
const OUTPUT_DIR = './output';
const MAX_SEARCHES_PER_ANCHOR = 6;

const client = new Anthropic();

// =============================================
// PROMPTY
// =============================================
function buildAnchorAPrompt(lead) {
  return `Jesteś analitykiem marketingu B2B pracującym dla Blocki Custom, agencji produkującej zestawy klocków LEGO-kompatybilne jako corporate gifts.

Badasz firmę, która zgłosiła się do nas jako lead. Twoim celem jest znalezienie konkretnych, wizualnych motywów mogących stać się tematem zestawu klocków.

KLIENT:
Domena: ${lead.domain}
Kontakt: ${lead.contactEmail}

NOTATKA Z KWALIFIKACJI (Pre-Sales):
${lead.bantNotes}

WAŻNE: Notatka zawiera sygnały od samego klienta: co ich interesuje, na jaki target, jaka okazja, jaki wstępny pomysł. Potraktuj te informacje priorytetowo. Jeśli klient sam zasugerował kierunek (np. "makieta domu z rozwiązaniami"), w researchu szukaj tego co uzupełnia i konkretyzuje ten kierunek.

TWÓJ FOKUS: KOTWICA A, AKTUALNE CELE MARKETINGOWE I STRATEGICZNE

Zbadaj co firma komunikuje jako priorytet TERAZ (bieżący rok i rok nadchodzący). Szukasz:
- ogłoszonych celów strategicznych (nowe rynki, linie produktowe, akwizycje)
- aktualnych kampanii komunikacyjnych i ich motywów
- tematów z raportów, newsroomu, LinkedIn firmy ostatnich 12 miesięcy
- wystąpień zarządu i tego co akcentują
- zmian brandingowych, kierunkowych, symboli nowej strategii

ŹRÓDŁA:
- strona firmy (About, Newsroom, Investor Relations, kampanie)
- LinkedIn firmy, ostatnie 6-12 miesięcy
- wiadomości branżowe
- raport roczny, ESG, sustainability

WYKONANIE:
1. Zrób web_search aby zebrać materiał (maksymalnie ${MAX_SEARCHES_PER_ANCHOR} wyszukiwań)
2. Zsyntetyzuj
3. Wybierz 3 do 5 najmocniejszych wątków które mogłyby być kotwicą wizualną zestawu klocków
4. Dla każdego: opisz konkretny potencjał wizualny (co pokazać figurkami, scenerią, rekwizytami)

FORMAT ODPOWIEDZI:
Najpierw krótka analiza w tekście (4 do 8 zdań). Następnie umieść strukturyzowany JSON w bloku kodu:

\`\`\`json
{
  "anchor": "A - aktualne cele",
  "company_summary": "opis firmy w 2-3 zdaniach, czym żyje, jaka skala, jaka branża",
  "visual_identity": {
    "primary_colors": ["#hex1", "#hex2"],
    "style_notes": "styl wizualny firmy w jednym zdaniu"
  },
  "elements": [
    {
      "title": "nazwa wątku",
      "description": "co to jest, 2-3 zdania",
      "why_relevant": "dlaczego centralne dla tej firmy teraz",
      "visual_potential": "co konkretnie można pokazać w zestawie klocków",
      "source_urls": ["url1", "url2"]
    }
  ],
  "top_recommendation": "który element najmocniejszy i dlaczego, 2-3 zdania"
}
\`\`\`

Pisz po polsku. Unikaj ogólników typu "innowacyjność" czy "zrównoważony rozwój bez kontekstu". Szukaj rzeczy namacalnych, które da się pokazać wizualnie dziecku budującemu zestaw klocków.`;
}

function buildAnchorBPrompt(lead) {
  return `Jesteś analitykiem marketingu B2B pracującym dla Blocki Custom, agencji produkującej zestawy klocków LEGO-kompatybilne jako corporate gifts.

Badasz firmę, która zgłosiła się do nas jako lead.

KLIENT:
Domena: ${lead.domain}
Kontakt: ${lead.contactEmail}

NOTATKA Z KWALIFIKACJI (Pre-Sales):
${lead.bantNotes}

WAŻNE: Notatka zawiera sygnały od klienta. Uwzględnij je. Jeśli klient wspomniał o storytellingu, historii, produktach flagowych, to jest sygnał że kotwica B (legenda) jest trafna.

TWÓJ FOKUS: KOTWICA B, LEGENDA MARKI

Zbadaj z czego firma jest ZNANA. Co każdy z nią kojarzy? Szukasz:
- ikonicznych produktów lub usług, które zbudowały markę
- kluczowych momentów historii, pierwszeństw, rekordów
- rozpoznawalnych kampanii lub sloganów z przeszłości
- symboli, postaci, obiektów kojarzonych z firmą wizualnie
- legendarnych osiągnięć lub motywów powtarzających się w komunikacji firmy przez lata

ŹRÓDŁA:
- Wikipedia firmy
- sekcja "Historia" na stronie firmy
- artykuły branżowe o marce
- materiały rocznicowe
- analizy brandu

WYKONANIE:
1. Zrób web_search aby zebrać materiał (maksymalnie ${MAX_SEARCHES_PER_ANCHOR} wyszukiwań)
2. Zsyntetyzuj
3. Wybierz 3 do 5 najmocniejszych elementów legendarnych
4. Dla każdego: opisz konkretny potencjał wizualny

FORMAT ODPOWIEDZI:
Najpierw krótka analiza w tekście (4 do 8 zdań). Następnie umieść strukturyzowany JSON w bloku kodu:

\`\`\`json
{
  "anchor": "B - legenda marki",
  "company_summary": "opis firmy w 2-3 zdaniach",
  "visual_identity": {
    "primary_colors": ["#hex1", "#hex2"],
    "style_notes": "styl wizualny firmy w jednym zdaniu"
  },
  "elements": [
    {
      "title": "nazwa elementu",
      "description": "co to jest i skąd się wzięło, 2-3 zdania",
      "why_iconic": "dlaczego legendarne dla marki",
      "visual_potential": "co konkretnie można pokazać w zestawie klocków",
      "source_urls": ["url1", "url2"]
    }
  ],
  "top_recommendation": "który element najmocniejszy i dlaczego, 2-3 zdania"
}
\`\`\`

Pisz po polsku. Preferuj elementy z historii lub rozpoznawalnego wizerunku, a nie ogólne hasła o firmie.`;
}

// =============================================
// LOGIKA
// =============================================
async function researchAnchor(label, prompt) {
  console.log(`[${label}] start...`);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: MAX_SEARCHES_PER_ANCHOR
    }],
    messages: [{ role: 'user', content: prompt }]
  });

  const finalText = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  const searchCount = response.content.filter(
    b => b.type === 'server_tool_use' && b.name === 'web_search'
  ).length;

  const jsonMatch = finalText.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    console.error(`[${label}] brak bloku JSON w odpowiedzi`);
    return { parse_error: true, raw_text: finalText, searches: searchCount };
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    console.log(`[${label}] OK. wyszukiwań: ${searchCount}, elementów: ${parsed.elements?.length ?? 0}`);
    return { ...parsed, _meta: { searches: searchCount } };
  } catch (e) {
    console.error(`[${label}] błąd parsowania JSON: ${e.message}`);
    return { parse_error: true, raw_text: finalText, searches: searchCount };
  }
}

// =============================================
// MAIN
// =============================================
async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const start = Date.now();

  console.log(`\n=== Blocki Lead Flow ===`);
  console.log(`Domena: ${LEAD.domain}`);
  console.log(`Kontakt: ${LEAD.contactEmail}`);
  console.log(`Model:  ${MODEL}\n`);

  const [anchorA, anchorB] = await Promise.all([
    researchAnchor('Kotwica A', buildAnchorAPrompt(LEAD)),
    researchAnchor('Kotwica B', buildAnchorBPrompt(LEAD))
  ]);

  const result = {
    lead: LEAD,
    model: MODEL,
    timestamp: new Date().toISOString(),
    duration_s: ((Date.now() - start) / 1000).toFixed(1),
    anchorA,
    anchorB
  };

  const outputPath = path.join(OUTPUT_DIR, 'research.json');
  await fs.writeFile(outputPath, JSON.stringify(result, null, 2));

  console.log(`\n=== Gotowe w ${result.duration_s}s ===`);
  console.log(`Zapisano: ${outputPath}\n`);
  console.log(`Kotwica A top: ${anchorA.top_recommendation ?? '(brak)'}`);
  console.log(`\nKotwica B top: ${anchorB.top_recommendation ?? '(brak)'}`);
}

main().catch(err => {
  console.error('Błąd:', err.message);
  process.exit(1);
});


