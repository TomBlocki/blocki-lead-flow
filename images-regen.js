import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

const INPUT_PATH = './output/briefs.json';
const IMAGES_DIR = './output/images';
const REGEN_IDS = ['totem_legenda', 'scenka_legenda'];

const FAL_ENDPOINT = 'https://queue.fal.run/fal-ai/recraft-v3';
const FAL_KEY = process.env.FAL_KEY;

const IMAGE_STYLE = 'realistic_image';
const IMAGE_SIZE = 'square_hd';

const BLOCKI_STYLE_SUFFIX = '. STYLE: photorealistic product shot of ABS plastic brick construction toy, rectangular orthogonal bricks with round cylindrical studs visible on flat surfaces, cubic blocky minifigures with simple square faces and rectangular bodies, sharp right-angle geometry, no smooth curves, matte plastic material, 3/4 isometric view, subtle contextual scene background, toy catalog photography.';

function composePrompt(brief) {
  const MAX_TOTAL = 995;
  const maxContent = MAX_TOTAL - BLOCKI_STYLE_SUFFIX.length;
  let content = brief.image_prompt_en || '';
  if (content.length > maxContent) {
    content = content.slice(0, maxContent - 3) + '...';
  }
  return content + BLOCKI_STYLE_SUFFIX;
}

async function submitJob(brief) {
  const prompt = composePrompt(brief);
  console.log(`[${brief.id}] prompt length: ${prompt.length}`);

  const res = await fetch(FAL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${FAL_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ prompt, style: IMAGE_STYLE, image_size: IMAGE_SIZE })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`submit failed ${res.status}: ${errText}`);
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
      throw new Error(`job failed: ${JSON.stringify(status)}`);
    }
  }
  throw new Error('timeout');
}

async function downloadImage(url, filepath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(filepath, buffer);
}

async function generateForBrief(brief) {
  console.log(`\n[${brief.id}] submit...`);
  const requestId = await submitJob(brief);
  console.log(`[${brief.id}] polling ${requestId}...`);
  const result = await pollJob(requestId);

  const imageUrl = result.images?.[0]?.url;
  if (!imageUrl) throw new Error('brak URL w odpowiedzi');

  const filepath = path.join(IMAGES_DIR, `${brief.id}.png`);
  await downloadImage(imageUrl, filepath);
  console.log(`[${brief.id}] OK -> ${filepath}`);
}

async function main() {
  if (!FAL_KEY) {
    console.error('Brak FAL_KEY w .env');
    process.exit(1);
  }

  const briefsData = JSON.parse(await fs.readFile(INPUT_PATH, 'utf8'));
  const toRegen = briefsData.briefs.filter(b => REGEN_IDS.includes(b.id));

  console.log(`\n=== Regeneracja ${toRegen.length} obrazków (sekwencyjnie) ===`);

  for (const brief of toRegen) {
    try {
      await generateForBrief(brief);
    } catch (err) {
      console.error(`[${brief.id}] BŁĄD: ${err.message}`);
    }
  }

  console.log('\n=== Gotowe ===');
}

main().catch(err => {
  console.error('Błąd główny:', err.message);
  process.exit(1);
});

