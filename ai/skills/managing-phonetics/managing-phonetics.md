# Reactory Speech Service — Pronunciation & Phonetics Management Skill

## Overview

The Reactory Speech Service generates natural speech audio using Kokoro-82M ONNX and Grapheme-to-Phoneme (G2P) conversion via espeak-ng / phonemizer. High-quality speech requires fine-tuning how difficult names, domain acronyms, technical terminology, and foreign words are pronounced.

Pronunciation customization is handled at multiple levels without requiring service or container restarts:

| Level | Scope | Use Case |
|---|---|---|
| **Persistent Lexicon** (`data/lexicon.json`) | Global, permanent | Platform names, company terms, common tech acronyms (`Reactory`, `Kubernetes`, `GraphQL`) |
| **REST API** (`/api/tts/lexicon`) | Global, runtime | Dynamic updates from admin portals, backoffice forms, or automation workflows |
| **Per-Request Overrides** (`custom_lexicon`) | Scoped to 1 request | User profile names, temporary tenant terms, dynamic report generation |
| **Inline Text Markup** (`[word\|...]`, `<phoneme>`) | Scoped to text token | LLM prompts, agent chat responses, inline speech templates |

---

## 1. Choosing Between Respellings and IPA

Two pronunciation styles are supported:

### 1.1 Syllable Respellings (Simple English approximations)
Best for general English words, acronyms, and compound names:
- `"Reactory"` $\rightarrow$ `"Ree-actory"`
- `"Kubernetes"` $\rightarrow$ `"koo-ber-net-eez"`
- `"PostgreSQL"` $\rightarrow$ `"post-gress Q L"`
- `"Nginx"` $\rightarrow$ `"engine-X"`
- `"Werner"` $\rightarrow$ `"Vair-ner"`

### 1.2 Direct IPA (International Phonetic Alphabet)
Best when syllable respelling cannot capture the exact vowel sound, stress marker, or regional accent:
- Wrapped in slashes `/.../` or passed via the `ipa` field.
- Uses Kokoro's neural vocabulary symbols (e.g. `ɹiˈæktɚɹi`, `vˈɛərnər`, `kˈuːbɚnˌɛtiːz`).

---

## 2. Previewing Pronunciation (`/api/tts/phonemize`)

Always test a word or sentence before generating audio:

```bash
curl -X POST http://localhost:8765/api/tts/phonemize \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Welcome Werner to Reactory!",
    "language": "en-us"
  }'
```

**Response:**
```json
{
  "text": "Welcome Werner to Reactory!",
  "normalized": "Welcome Vair-ner to Ree-actory!",
  "phonemes": "wˈɛlkʌm vˈɛərnər tə ɹˈiːˈæktɚɹi!",
  "language": "en-us"
}
```

---

## 3. The Four Customization Patterns

### Pattern A: REST CRUD Endpoints (Zero Downtime)

The speech service exposes full CRUD endpoints for dictionary management:

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/tts/lexicon` | List all active pronunciations (built-in defaults + custom) |
| `GET` | `/api/tts/lexicon/custom` | List only custom entries |
| `GET` | `/api/tts/lexicon/{word}` | Inspect pronunciation for a single word |
| `POST` | `/api/tts/lexicon` | Add or update a word pronunciation |
| `DELETE` | `/api/tts/lexicon/{word}` | Remove a custom word pronunciation |

#### Adding a word via API:
```bash
# Using syllable respelling:
curl -X POST http://localhost:8765/api/tts/lexicon \
  -H "Content-Type: application/json" \
  -d '{"word": "Temporal", "replacement": "tem-puh-ruhl"}'

# Using exact IPA:
curl -X POST http://localhost:8765/api/tts/lexicon \
  -H "Content-Type: application/json" \
  -d '{"word": "Kafka", "replacement": "koff-ka", "ipa": "kˈɑːfkə"}'
```

---

### Pattern B: Persistent Lexicon File (`data/lexicon.json`)

The file is mounted into the container (`/app/data:Z`). The service monitors the file timestamp (`mtime`) and **automatically reloads edits on the next request**:

```json
{
  "entries": {
    "Reactory": {
      "replacement": "Ree-actory",
      "ipa": "ɹiˈæktɚɹi"
    },
    "Werner": {
      "replacement": "Vair-ner",
      "ipa": "vˈɛərnər"
    },
    "Kubernetes": {
      "replacement": "koo-ber-net-eez",
      "ipa": "kˈuːbɚnˌɛtiːz"
    }
  }
}
```

---

### Pattern C: Per-Request Overrides (`custom_lexicon`)

Pass temporary pronunciation overrides directly in the synthesis payload. This does not modify the global dictionary:

```bash
curl -X POST http://localhost:8765/api/tts/synthesize \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello Werner, welcome to the platform.",
    "voice": "af_heart",
    "custom_lexicon": {
      "Werner": "Vair-ner"
    }
  }' \
  --output greeting.wav
```

*(Tip: values wrapped in slashes `/.../` are parsed as exact IPA tokens, while unslashed values are treated as syllable respellings).*

---

### Pattern D: Inline Phonetic Markup

AI agents and notification templates can inject pronunciation annotations directly inside text strings:

1. **Bracket Syllable Respelling**:
   `"Welcome [Werner|Vair-ner] to [K8s|koo-ber-net-eez]."`
2. **Bracket IPA Notation**:
   `"Welcome [Werner|/vˈɛərnər/]."`
3. **SSML Phoneme Tag**:
   `'Welcome <phoneme ph="vˈɛərnər">Werner</phoneme> to Reactory.'`

The phonetic engine parses these markers, isolates the phonetic targets, phonemizes the remaining natural text, and stitches the continuous audio together.

---

## 4. Agent Best Practices & Rules

1. **Verify before synthesizing**: If a customer reports a mispronounced name or company term, call `POST /api/tts/phonemize` first to inspect how espeak-ng interprets it.
2. **Prefer syllable respellings first**: Start with simple hyphenated respellings (e.g. `koo-ber-net-eez`). Use IPA only when specific vowel stresses or consonants need exact phonemic control.
3. **Keep domain terms global**: Common technical terms (`Postgres`, `GraphQL`, `K8s`, platform names) belong in the persistent lexicon (`POST /api/tts/lexicon` or `data/lexicon.json`).
4. **Keep personal names scoped or inline**: Highly variable user names or temporary entity names should use per-request `custom_lexicon` or bracket notation `[Name|Pronunciation]` to avoid cluttering the global dictionary.
5. **No pod restarts needed**: Changes written via `/api/tts/lexicon` or edited directly in `data/lexicon.json` are picked up live.
