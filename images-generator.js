import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

// =============================================
// KONFIGURACJA
// =============================================
const INPUT_PATH = './output/briefs.json';
const IMAGES_DIR = './output/images';

const FAL_ENDPOINT = 'https://queue.fal.run/fal-ai/recraft-v3';
const FAL_KEY = process.env.FAL_KEY;

const IMAGE_STYLE = 'realistic_image';
const IMAGE_SIZE = 'square_hd';

// STAŁY "ODCISK PALCA" BLOCKI - doklejany na końcu każdego promptu
const BLOCKI_STYLE_SUFFIX = '. STYLE: photorealistic product shot of ABS plastic brick construction toy, rectangular orthogonal bricks with round cylindrical studs visible on flat surfaces, cubic blocky minifigures with simple square faces and rectangular bodies, sharp right-angle geometry, no smooth curves, matte plastic material, 3/4 isometric view, subtle contextual scene background, toy catalog photography.';

// =============================================
// LOGIKA
// =============================================
function composePrompt(brief) {
  const MAX_TOTAL = 995;
  const suffixLen = BLOCKI_STYLE_SUFFIX.length;
  const maxContent = MAX_TOTAL - suffixLen;

  let content = brief.image_prompt_en || '';
  if (content.length > maxContent) {
    content = content.slice(0, maxContent - 3) + '...';
  }
  return content + BLOCKI_STYLE_SUFFIX;
}

async function submitJob(brief) {
  const prompt = composePrompt(brief);
  console.log(`[${brief.id}] prompt length: ${prompt.length}`);

  const body = {
    prompt,
    style: IMAGE_STYLE,
    image_size: IMAGE_SIZE
  };

  const res = await fetch(FAL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${FAL_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`fal submit failed ${res.status}: ${errText}`);
  }

  const json = await res.json();
  return json.request_id;
}

async function pollJob(requestId) {
  const statusUrl = `${FAL_ENDPOINT}/requests/${requestId}/status`;
  const resultUrl = `${FAL_ENDPOINT}/requests/${requestId}`;

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));

    const statusRes = await fetch(statusUrl, {
      headers: { 'Authorization': `Key ${FAL_KEY}` }
    });
    const status = await statusRes.json();

    if (status.status === 'COMPLETED') {
      const resultRes = await fetch(resultUrl, {
        headers: { 'Authorization': `Key ${FAL_KEY}` }
      });
      return await resultRes.json();
    }
    if (status.status === 'FAILED') {
      throw new Error(`fal job failed: ${JSON.stringify(status)}`);
    }
  }
  throw new Error('fal timeout po 120s');
}

async function downloadImage(url, filepath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(filepath, buffer);
}

async function generateForBrief(brief) {
  console.log(`[${brief.id}] submit...`);
  const requestId = await submitJob(brief);
  console.log(`[${brief.id}] polling ${requestId}...`);
  const result = await pollJob(requestId);

  const imageUrl = result.images?.[0]?.url;
  if (!imageUrl) {
    throw new Error(`[${brief.id}] brak URL obrazka w odpowiedzi: ${JSON.stringify(result)}`);
  }

  const filepath = path.join(IMAGES_DIR, `${brief.id}.png`);
  await downloadImage(imageUrl, filepath);
  console.log(`[${brief.id}] OK -> ${filepath}`);

  return { id: brief.id, title: brief.title_pl, image_path: filepath, remote_url: imageUrl };
}

// =============================================
// MAIN
// =============================================
async function main() {
  if (!FAL_KEY) {
    console.error('Błąd: brak FAL_KEY w .env');
    process.exit(1);
  }

  const briefsData = JSON.parse(await fs.readFile(INPUT_PATH, 'utf8'));
  const briefs = briefsData.briefs.filter(b => !b.parse_error && b.image_prompt_en);

  console.log(`\n=== Blocki Images Generator ===`);
  console.log(`Briefy do wygenerowania: ${briefs.length}`);
  console.log(`Model:  Recraft V3 (${IMAGE_STYLE})`);
  console.log(`Rozmiar: ${IMAGE_SIZE}`);
  console.log(`Styl Blocki: wymuszony przez suffix\n`);

  const start = Date.now();
  const results = await Promise.all(briefs.map(b => generateForBrief(b).catch(err => {
    console.error(`[${b.id}] BŁĄD: ${err.message}`);
    return { id: b.id, error: err.message };
  })));

  const manifest = {
    timestamp: new Date().toISOString(),
    duration_s: ((Date.now() - start) / 1000).toFixed(1),
    lead: briefsData.lead,
    images: results
  };
  await fs.writeFile('./output/images-manifest.json', JSON.stringify(manifest, null, 2));

  console.log(`\n=== Gotowe w ${manifest.duration_s}s ===`);
  results.forEach(r => {
    if (r.error) console.log(`${r.id}: BŁĄD (${r.error})`);
    else        console.log(`${r.id}: ${r.image_path}`);
  });
  console.log(`\nManifest: ./output/images-manifest.json`);
}

main().catch(err => {
  console.error('Błąd główny:', err.message);
  process.exit(1);
});
