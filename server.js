const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// ----------------------------------------------------
// Stremio manifest
// ----------------------------------------------------

const manifest = {
  id: "org.subtitlecat.serbianlatin",
  version: "4.0.0",
  name: "SubtitleCat Serbian Latin AI",
  description:
    "Automatic English to Serbian Latin subtitle translation with Gemini AI",
  logo: "https://www.stremio.com/website/stremio-logo-small.png",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: []
};

// ----------------------------------------------------
// Simple memory cache
// ----------------------------------------------------

const cache = new Map();

function cacheKey(text) {
  return Buffer.from(text).toString("base64");
}

// ----------------------------------------------------
// Health check
// ----------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    ok: true,
    addon: "SubtitleCat Serbian Latin AI",
    version: "4.0.0",
    geminiConfigured: !!GEMINI_API_KEY
  });
});

// ----------------------------------------------------
// Manifest
// ----------------------------------------------------

app.get("/manifest.json", (req, res) => {
  res.json(manifest);
});

// ----------------------------------------------------
// Translate subtitle text with Gemini
// ----------------------------------------------------

async function translateText(text) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const key = cacheKey(text);

  if (cache.has(key)) {
    return cache.get(key);
  }

  const prompt = `
You are a professional subtitle translator.

Translate the following subtitle text from English to Serbian Latin.

Rules:
- Serbian Latin alphabet only.
- Do NOT use Serbian Cyrillic.
- Preserve subtitle meaning and tone.
- Preserve names of people and places when appropriate.
- Do not add explanations.
- Do not add quotation marks unless they exist in the original.
- Return ONLY the translated subtitle text.

Subtitle:
${text}
`;

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
      encodeURIComponent(GEMINI_API_KEY),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192
        }
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Gemini API error ${response.status}: ${errorText}`
    );
  }

  const data = await response.json();

  const translated =
    data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

  if (!translated) {
    throw new Error("Gemini returned empty translation");
  }

  cache.set(key, translated);

  return translated;
}

// ----------------------------------------------------
// SRT parser
// ----------------------------------------------------

function parseSrt(srt) {
  const normalized = srt.replace(/\r/g, "").trim();

  const blocks = normalized.split(/\n{2,}/);

  return blocks.map((block) => {
    const lines = block.split("\n");

    let index = "";
    let timing = "";
    let textStart = 0;

    if (/^\d+$/.test(lines[0]?.trim())) {
      index = lines[0].trim();
      textStart = 1;
    }

    if (lines[textStart] && lines[textStart].includes("-->")) {
      timing = lines[textStart].trim();
      textStart++;
    }

    const text = lines.slice(textStart).join("\n").trim();

    return {
      index,
      timing,
      text
    };
  }).filter(x => x.timing && x.text);
}

// ----------------------------------------------------
// SRT builder
// ----------------------------------------------------

function buildSrt(items) {
  return items
    .map((item, i) => {
      const index = item.index || String(i + 1);

      return (
        index +
        "\n" +
        item.timing +
        "\n" +
        item.text +
        "\n"
      );
    })
    .join("\n");
}

// ----------------------------------------------------
// Subtitle translation endpoint
// ----------------------------------------------------

app.get("/translate", async (req, res) => {
  try {
    const subtitleUrl = req.query.url;

    if (!subtitleUrl) {
      return res.status(400).send("Missing subtitle URL");
    }

    const sourceResponse = await fetch(subtitleUrl);

    if (!sourceResponse.ok) {
      return res
        .status(502)
        .send(`Could not download subtitle: ${sourceResponse.status}`);
    }

    const original = await sourceResponse.text();

    if (!original.trim()) {
      return res.status(400).send("Subtitle is empty");
    }

    const subtitles = parseSrt(original);

    if (!subtitles.length) {
      return res.status(400).send("Could not parse SRT subtitle");
    }

    // Translate in small batches to keep Gemini fast.
    const batchSize = 25;

    for (let i = 0; i < subtitles.length; i += batchSize) {
      const batch = subtitles.slice(i, i + batchSize);

      const numberedText = batch
        .map((item, n) => {
          return `[${n + 1}] ${item.text.replace(/\n/g, " ")}`;
        })
        .join("\n");

      const translated = await translateText(numberedText);

      const lines = translated.split("\n");

      for (let j = 0; j < batch.length; j++) {
        const expectedPrefix = `[${j + 1}]`;

        const line = lines.find((x) =>
          x.trim().startsWith(expectedPrefix)
        );

        if (line) {
          batch[j].text = line
            .replace(expectedPrefix, "")
            .trim();
        }
      }
    }

    const output = buildSrt(subtitles);

    res.setHeader("Content-Type", "application/x-subrip; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="serbian-latin.srt"'
    );

    res.send(output);
  } catch (error) {
    console.error(error);

    res.status(500).send(
      "Translation error: " +
        (error?.message || "Unknown error")
    );
  }
});

// ----------------------------------------------------
// Start
// ----------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `SubtitleCat Serbian Latin AI running on port ${PORT}`
  );
});
