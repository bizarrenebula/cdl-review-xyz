#!/usr/bin/env python3
"""
Fill the per-language reading dictionaries (BOOK_EN / BOOK_RU / BOOK_BG) in
index.html by machine-translating the German original (BOOK_DE).

Why this is a separate local script: the hosted build sandbox blocks outbound
translation APIs, so this has to run on a machine with normal internet access.

Usage:
    pip install deep-translator
    python tools/translate-book.py            # translates de -> en, ru, bg
    python tools/translate-book.py en ru      # only some targets

It edits index.html in place, replacing the empty `const BOOK_EN = {};` etc.
Re-running re-translates from scratch. The app already falls back to German for
any entry a target book is missing, so a partial run is safe.

NOTE: the mottos ("m") are the author's rhyming couplets — machine translation
will convey the meaning but lose the rhyme. Have the author review those.
"""
import json, re, sys, time, pathlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from deep_translator import GoogleTranslator   # or swap for DeepL, see below

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = ROOT / "index.html"
TARGETS = sys.argv[1:] or ["en", "ru", "bg"]

src = HTML.read_text(encoding="utf-8")
book_de = json.loads(re.search(r"const BOOK_DE = (\{.*?\});", src, re.S).group(1))

# Translate each unique source string once. A small worker pool keeps the
# one-time build practical without overwhelming the free endpoint.
def make_cache(tgt):
    strings = []
    seen = set()
    for sec in book_de.values():
        values = [*sec.get("m", []), sec.get("a", ""), sec.get("i", ""),
                  sec.get("b", ""), *sec.get("s", [])]
        for value in values:
            value = (value or "").strip()
            if value and value not in seen:
                seen.add(value)
                strings.append(value)

    def translate_one(s):
        tr = GoogleTranslator(source="de", target=tgt)
        for attempt in range(5):
            try:
                return s, tr.translate(s), None
            except Exception as ex:
                if attempt == 4:
                    return s, s, ex
                time.sleep(2 * (attempt + 1))

    cache = {}
    done = 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(translate_one, s) for s in strings]
        for future in as_completed(futures):
            source, translated, error = future.result()
            cache[source] = translated
            done += 1
            if error:
                print("  ! failed:", source[:60], error, flush=True)
            if done % 100 == 0 or done == len(strings):
                print(f"  {done}/{len(strings)} unique strings", flush=True)
    return cache

def translate_entry(t, sec):
    return {
        "m": [t(x) for x in sec.get("m", [])],
        "a": t(sec.get("a", "")),
        "i": t(sec.get("i", "")),
        "b": t(sec.get("b", "")),
        "s": [t(x) for x in sec.get("s", [])],
    }

for tgt in TARGETS:
    print(f"== {tgt} ==", flush=True)
    cache = make_cache(tgt)
    t = lambda s: cache.get((s or "").strip(), (s or "").strip())
    out = {}
    for n, (key, sec) in enumerate(book_de.items(), 1):
        out[key] = translate_entry(t, sec)
        if n % 12 == 0:
            print(f"  {n}/{len(book_de)}")
    payload = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    var = f"BOOK_{tgt.upper()}"
    src = re.sub(rf"const {var} = \{{.*?\}};", f"const {var} = {payload};", src, count=1, flags=re.S)
    HTML.write_text(src, encoding="utf-8")
    print(f"  wrote {var} ({len(out)} entries)")

print("Done. Review index.html, then commit.")

# --- To use DeepL instead (better quality, needs an API key) ---
# pip install deepl ; then replace the GoogleTranslator line with:
#   import deepl; _d = deepl.Translator("YOUR_KEY")
#   and in make(): cache[s] = _d.translate_text(s, source_lang="DE",
#                                                target_lang=tgt.upper()).text
