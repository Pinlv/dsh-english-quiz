#!/usr/bin/env python3
"""Import recent Anki review stats into progress/anki-stats.json.

The DSH English quiz plugin reads this JSON next to progress/quiz-log.jsonl
and shows an "Anki 复习" panel on the 英语统计 page.

The Anki collection is copied before opening, so a running Anki instance keeps
its lock and the original database is never written. All numbers come from the
revlog: Again (ease 1) counts as not passed; Hard, Good and Easy count as passed.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

DEFAULT_OUT = Path("progress/anki-stats.json")
DEFAULT_CANDIDATES = [
    Path.home() / "Library/Application Support/Anki2/账户 1/collection.anki2",
]


def find_database(explicit: str | None) -> Path:
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_file():
            raise SystemExit(f"Anki database not found: {path}")
        return path
    for path in DEFAULT_CANDIDATES:
        if path.is_file():
            return path
    matches = sorted(
        (Path.home() / "Library/Application Support/Anki2").glob("*/collection.anki2"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    if matches:
        return matches[0]
    raise SystemExit("No Anki collection.anki2 found; pass --db PATH.")


def local_iso(value_ms: int | None) -> str | None:
    if not value_ms:
        return None
    return datetime.fromtimestamp(value_ms / 1000).astimezone().isoformat(timespec="seconds")


def window_stats(cur: sqlite3.Cursor, start_ms: int) -> dict:
    reviews, again, time_ms = cur.execute(
        "select count(*), coalesce(sum(case when ease = 1 then 1 else 0 end), 0), "
        "coalesce(sum(time), 0) from revlog where id >= ?",
        (start_ms,),
    ).fetchone()
    passed = reviews - again
    return {
        "reviews": reviews,
        "again": again,
        "passed": passed,
        "accuracy": None if reviews == 0 else round(passed / reviews * 100),
        "minutes": round(time_ms / 60000),
        "timeMs": time_ms,
    }


def daily_series(cur: sqlite3.Cursor, today: datetime, days: int) -> list[dict]:
    start = today - timedelta(days=days - 1)
    rows = cur.execute(
        "select date(id / 1000, 'unixepoch', 'localtime') as day, "
        "count(*), sum(case when ease = 1 then 1 else 0 end), coalesce(sum(time), 0) "
        "from revlog where id >= ? group by day order by day",
        (int(start.timestamp() * 1000),),
    ).fetchall()
    by_day = {row[0]: row for row in rows}
    marks = []
    for offset in range(days):
        day = (start + timedelta(days=offset)).strftime("%Y-%m-%d")
        row = by_day.get(day)
        marks.append({
            "date": day,
            "reviews": row[1] if row else 0,
            "again": row[2] if row else 0,
            "minutes": round((row[3] if row else 0) / 60000),
        })
    return marks


def deck_stats(cur: sqlite3.Cursor, start_ms: int) -> list[dict]:
    rows = cur.execute(
        "select d.name, count(*), "
        "coalesce(sum(case when r.ease = 1 then 1 else 0 end), 0) "
        "from revlog r join cards c on c.id = r.cid join decks d on d.id = c.did "
        "where r.id >= ? group by d.name order by count(*) desc limit 5",
        (start_ms,),
    ).fetchall()
    result = []
    for name, reviews, again in rows:
        result.append({
            "name": str(name).replace("\x1f", " / "),
            "reviews": reviews,
            "again": again,
            "accuracy": None if reviews == 0 else round((reviews - again) / reviews * 100),
        })
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", help="path to collection.anki2")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="output JSON path")
    args = parser.parse_args()

    db = find_database(args.db)
    out = Path(args.out).expanduser()
    if not out.is_absolute():
        out = Path.cwd() / out
    out.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="anki-stats-") as tmp:
        copy = Path(tmp) / "collection.anki2"
        shutil.copy2(db, copy)
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(db) + suffix)
            if sidecar.exists():
                shutil.copy2(sidecar, Path(str(copy) + suffix))
        con = sqlite3.connect(copy)
        # Anki's deck names use a case-insensitive collation not registered by
        # the stock sqlite3 build.
        con.create_collation("unicase", lambda left, right: (left.lower() > right.lower()) - (left.lower() < right.lower()))
        cur = con.cursor()

        today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        start14 = today - timedelta(days=13)
        start30 = today - timedelta(days=29)

        total_reviews, first_id, last_id = cur.execute(
            "select count(*), min(id), max(id) from revlog"
        ).fetchone()
        total_cards = cur.execute("select count(*) from cards").fetchone()[0]
        total_notes = cur.execute("select count(*) from notes").fetchone()[0]

        last14 = window_stats(cur, int(start14.timestamp() * 1000))
        last30 = window_stats(cur, int(start30.timestamp() * 1000))
        last14["activeDays"] = sum(1 for day in daily_series(cur, today, 14) if day["reviews"] > 0)
        last30["activeDays"] = sum(1 for day in daily_series(cur, today, 30) if day["reviews"] > 0)

        payload = {
            "version": 1,
            "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "source": str(db),
            "collectionMtime": datetime.fromtimestamp(db.stat().st_mtime).astimezone().isoformat(timespec="seconds"),
            "definition": "通过率按非 Again 计算；Hard、Good、Easy 算通过。",
            "total": {
                "reviews": total_reviews,
                "cards": total_cards,
                "notes": total_notes,
                "firstReview": local_iso(first_id),
                "latestReview": local_iso(last_id),
            },
            "last14": last14,
            "last30": last30,
            "daily": daily_series(cur, today, 14),
            "decks": deck_stats(cur, int(start30.timestamp() * 1000)),
        }
        con.close()

    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out}")
    print(
        f"last14: {last14['reviews']} reviews, {last14['again']} again, "
        f"{last14['accuracy']}% pass, {last14['minutes']} min, {last14['activeDays']} active days"
    )
    print(
        f"total: {total_reviews} reviews across {total_cards} cards; "
        f"latest {payload['total']['latestReview']}"
    )
    for deck in payload["decks"]:
        print(f"  {deck['name']}: {deck['reviews']} reviews, {deck['accuracy']}% pass")


if __name__ == "__main__":
    main()
