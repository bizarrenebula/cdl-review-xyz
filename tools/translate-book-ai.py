#!/usr/bin/env python3
"""Fidelity-first German book translation with an independent AI review.

Loads OPENAI_API_KEY from .env, translates BOOK_DE in contextual groups, then
reviews every translated claim against German while using the earlier Google
translation only as a comparison signal. Final dictionaries are embedded in
index.html; resumable API responses and the review report stay in tools/cache.
"""
import argparse
import json
import os
import pathlib
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Literal

from dotenv import load_dotenv
from openai import OpenAI
from pydantic import BaseModel, Field

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = ROOT / "index.html"
CACHE = ROOT / "tools" / "cache" / "book-ai"
REPORT = ROOT / "tools" / "translation-review.json"

PRICES = {
    "gpt-5.6-terra": (2.00, 12.00),
    "gpt-5.6-sol": (5.00, 30.00),
}
LANGS = {"en": "English", "ru": "Russian", "bg": "Bulgarian"}

GLOSSARY = {
    "en": {
        "Lebensprinzip": "life principle", "Außenwelt": "outer world",
        "Innenwelt": "inner world", "biologische Entsprechung": "biological correspondence",
        "Selbstverwirklichung": "self-realization", "Durchsetzungsfähigkeit": "assertiveness",
    },
    "ru": {
        "Lebensprinzip": "жизненный принцип", "Außenwelt": "внешний мир",
        "Innenwelt": "внутренний мир", "biologische Entsprechung": "биологическое соответствие",
        "Selbstverwirklichung": "самореализация", "Durchsetzungsfähigkeit": "способность отстаивать себя",
    },
    "bg": {
        "Lebensprinzip": "жизнен принцип", "Außenwelt": "външен свят",
        "Innenwelt": "вътрешен свят", "biologische Entsprechung": "биологично съответствие",
        "Selbstverwirklichung": "себереализация", "Durchsetzungsfähigkeit": "способност за отстояване",
    },
}


class Reading(BaseModel):
    key: str
    m: list[str]
    a: str
    i: str
    b: str
    s: list[str]


class ReadingBatch(BaseModel):
    entries: list[Reading]


class Issue(BaseModel):
    key: str
    field: str
    severity: Literal["low", "medium", "high"]
    explanation: str
    needs_human_review: bool = False


class ReviewedBatch(BaseModel):
    entries: list[Reading]
    issues: list[Issue] = Field(default_factory=list)


def read_book(source: str, name: str):
    match = re.search(rf"const {name} = (\{{.*?\}});", source, re.S)
    if not match:
        raise RuntimeError(f"Cannot find {name}")
    return json.loads(match.group(1))


def as_entries(book, keys):
    return [Reading(key=k, **book[k]).model_dump() for k in keys]


def cache_path(lang, stage, group):
    return CACHE / f"{lang}-{stage}-{group:02d}.json"


def load_cached(path, model):
    if not path.exists():
        return None
    return model.model_validate_json(path.read_text(encoding="utf-8"))


def save_cached(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value.model_dump_json(indent=2), encoding="utf-8")


def usage_cost(response, model):
    usage = response.usage
    inp = getattr(usage, "input_tokens", 0) or 0
    out = getattr(usage, "output_tokens", 0) or 0
    pin, pout = PRICES[model]
    return inp, out, inp / 1_000_000 * pin + out / 1_000_000 * pout


def call_structured(client, model, effort, schema, system, payload):
    response = client.responses.parse(
        model=model,
        reasoning={"effort": effort},
        input=[
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        text_format=schema,
        max_output_tokens=30000,
    )
    if not response.output_parsed:
        raise RuntimeError(f"{model} returned no parsed output")
    return response.output_parsed, response


def validate_batch(source_entries, translated_entries):
    source = {x["key"]: x for x in source_entries}
    output = {x.key: x for x in translated_entries}
    if set(source) != set(output):
        raise RuntimeError(f"Key mismatch: expected {set(source)}, got {set(output)}")
    for key, original in source.items():
        item = output[key]
        if len(item.m) != len(original["m"]) or len(item.s) != len(original["s"]):
            raise RuntimeError(f"List length changed for {key}")
        if not all([item.a.strip(), item.i.strip(), item.b.strip(),
                    *[x.strip() for x in item.m], *[x.strip() for x in item.s]]):
            raise RuntimeError(f"Empty translated field for {key}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("languages", nargs="*", choices=LANGS, default=list(LANGS))
    ap.add_argument("--budget", type=float, default=9.50)
    ap.add_argument("--group-size", type=int, default=6)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--spent", type=float, default=0.0,
                    help="API cost already consumed by an interrupted cached run")
    args = ap.parse_args()

    load_dotenv(ROOT / ".env")
    if not os.getenv("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY is missing")
    client = OpenAI()
    source_text = HTML.read_text(encoding="utf-8")
    german = read_book(source_text, "BOOK_DE")
    google = {lang: read_book(source_text, f"BOOK_{lang.upper()}") for lang in args.languages}
    keys = list(german)
    total_cost = args.spent
    totals = {"input_tokens": 0, "output_tokens": 0}
    reports = {}
    final_books = {}

    for lang in args.languages:
        target = LANGS[lang]
        translated = {}
        issues = []
        groups = [keys[i:i + args.group_size] for i in range(0, len(keys), args.group_size)]

        def process_group(group_no, group_keys):
            group_cost = 0.0
            group_input = group_output = 0
            source_entries = as_entries(german, group_keys)
            draft_path = cache_path(lang, "draft", group_no)
            draft = load_cached(draft_path, ReadingBatch)
            if draft is None:
                draft, response = call_structured(
                    client, "gpt-5.6-terra", "medium", ReadingBatch,
                    f"""Translate the supplied complete German book readings into {target}.
FIDELITY OVERRIDES STYLE. Preserve every claim, relationship, referent, body part,
number, condition, qualification, repetition, and ambiguity. Add nothing, omit
nothing, and do not reinterpret the author's worldview. Keep m and s list lengths
and item boundaries exactly unchanged. Produce natural {target} only where doing
so does not alter meaning. Use this glossary consistently: {json.dumps(GLOSSARY[lang], ensure_ascii=False)}.
Return every key and exactly the requested schema.""",
                    {"german_entries": source_entries},
                )
                inp, out, cost = usage_cost(response, "gpt-5.6-terra")
                group_cost += cost; group_input += inp; group_output += out
                save_cached(draft_path, draft)
            validate_batch(source_entries, draft.entries)

            review_path = cache_path(lang, "review", group_no)
            reviewed = load_cached(review_path, ReviewedBatch)
            if reviewed is None:
                google_entries = as_entries(google[lang], group_keys)
                reviewed, response = call_structured(
                    client, "gpt-5.6-sol", "high", ReviewedBatch,
                    f"""Act as a meticulous bilingual semantic editor for German and {target}.
Compare each candidate against German clause by clause. Correct any omission,
addition, softened/strengthened claim, changed causal relation, changed family
relationship, pronoun/referent error, terminology drift, number/body-part error,
or misleading fluency. German is the sole authority; the Google version is only
an alternate clue and must never override it. Preserve list lengths and boundaries.
Prefer faithful ambiguity over invented certainty. Return the corrected complete
entries plus issues for material corrections or genuinely ambiguous source text.
Use this glossary: {json.dumps(GLOSSARY[lang], ensure_ascii=False)}.""",
                    {"german_entries": source_entries,
                     "candidate_entries": [x.model_dump() for x in draft.entries],
                     "google_comparison": google_entries},
                )
                inp, out, cost = usage_cost(response, "gpt-5.6-sol")
                group_cost += cost; group_input += inp; group_output += out
                save_cached(review_path, reviewed)
            validate_batch(source_entries, reviewed.entries)
            normalize_path = cache_path(lang, "normalize", group_no)
            normalized = load_cached(normalize_path, ReadingBatch)
            if normalized is None:
                normalized, response = call_structured(
                    client, "gpt-5.6-terra", "low", ReadingBatch,
                    f"""Apply one narrowly defined editorial convention to these reviewed {target} readings.
The book addresses the reader. German lowercase possessives ihr-/ihre-/ihrer-/ihren-/ihrem-/ihres-
in these relationship statements are inconsistent capitalization of formal reader-address Ihr-.
Render those references naturally as second-person 'your' in {target}, with correct grammar.
Remove her/their ambiguity and slash alternatives caused only by this convention.
DO NOT change, improve, reinterpret, add, omit, or otherwise edit any other meaning or wording.
Preserve every key, field, list length, and list boundary exactly.""",
                    {"german_entries": source_entries,
                     "reviewed_entries": [x.model_dump() for x in reviewed.entries]},
                )
                inp, out, cost = usage_cost(response, "gpt-5.6-terra")
                group_cost += cost; group_input += inp; group_output += out
                save_cached(normalize_path, normalized)
            validate_batch(source_entries, normalized.entries)
            group_book = {}
            for item in normalized.entries:
                data = item.model_dump(); data.pop("key"); group_book[item.key] = data
            return group_no, group_book, [x.model_dump() for x in reviewed.issues], group_input, group_output, group_cost

        completed = 0
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(process_group, n, group) for n, group in enumerate(groups)]
            for future in as_completed(futures):
                group_no, group_book, group_issues, inp, out, cost = future.result()
                translated.update(group_book); issues.extend(group_issues)
                totals["input_tokens"] += inp; totals["output_tokens"] += out
                total_cost += cost; completed += 1
                print(f"{lang}: {completed}/{len(groups)} groups; estimated API cost ${total_cost:.2f}", flush=True)
                if total_cost >= args.budget:
                    for pending in futures: pending.cancel()
                    raise SystemExit(f"Stopped at budget guard ${total_cost:.2f}; cached progress is safe")

        final_books[lang] = translated
        reports[lang] = issues

    for lang, book in final_books.items():
        payload = json.dumps(book, ensure_ascii=False, separators=(",", ":"))
        source_text = re.sub(rf"const BOOK_{lang.upper()} = \{{.*?\}};",
                             f"const BOOK_{lang.upper()} = {payload};",
                             source_text, count=1, flags=re.S)
    HTML.write_text(source_text, encoding="utf-8")
    REPORT.write_text(json.dumps({"models": {"translation": "gpt-5.6-terra",
                                               "review": "gpt-5.6-sol",
                                               "reader_address_normalization": "gpt-5.6-terra"},
                                  "editorial_convention": "German lowercase ihr- relationship references are treated as formal second-person reader address (Ihr-).",
                                  "estimated_cost_usd": round(total_cost, 4),
                                  "usage": totals, "issues": reports},
                                 ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Done. Estimated API cost: ${total_cost:.2f}; report: {REPORT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
