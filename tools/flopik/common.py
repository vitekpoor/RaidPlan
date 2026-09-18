"""Flopik – shared combat log helpers."""
import datetime

DAMAGE_EVENTS = ("SPELL_DAMAGE", "SPELL_ABSORBED", "SPELL_MISSED")
HIT_EVENTS = DAMAGE_EVENTS + ("SPELL_AURA_APPLIED",)


def parse_ts(s):
    d, t = s.split(" ", 1)
    m, dd, y = d.split("/")
    hh, mm, ss = t.split(":")
    sec = float(ss)
    if len(y) == 2:
        y = "20" + y
    return datetime.datetime(int(y), int(m), int(dd), int(hh), int(mm), int(sec), int(round((sec % 1) * 1e6)))


def split_fields(s):
    out, cur, q, depth = [], "", False, 0
    for ch in s:
        if ch == '"':
            q = not q
            cur += ch
        elif ch in "[(" and not q:
            depth += 1
            cur += ch
        elif ch in "])" and not q:
            depth -= 1
            cur += ch
        elif ch == "," and not q and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return out


def parse_line(line):
    """'9/17/2026 22:06:41.5872  EVENT,a,b,...' -> (datetime, [fields]) or None."""
    try:
        ts, rest = line.rstrip("\r\n").split("  ", 1)
        return parse_ts(ts), split_fields(rest)
    except ValueError:
        return None


def nm(s):
    """'"Hase-Drak\'thul-EU"' -> 'Hase'"""
    return s.strip('"').split("-")[0]


def near(lst, t, w):
    return any(abs((t - x).total_seconds()) <= w for x in lst)


def clusters(times, window):
    """Number of groups of timestamps separated by more than `window` seconds (= distinct casts)."""
    n, last = 0, None
    for t in sorted(times):
        if last is None or (t - last).total_seconds() > window:
            n += 1
        last = t
    return n
