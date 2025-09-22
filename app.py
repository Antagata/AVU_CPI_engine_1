import pandas as pd
from pathlib import Path
# --- Missing function and variable stubs ---
def _load_winners_latest():
    # TODO: Implement actual winners loading logic
    return {d: [] for d in DAYS}

def _load_cadence_latest():
    # TODO: Implement actual cadence loading logic
    return {d: [] for d in DAYS}

def _is_engine_ready():
    # TODO: Implement engine ready check
    return True

FILTERS_PATH = Path("notebooks/filters.json")
TRANSIENT_LOCKED_SNAPSHOT = Path("notebooks/locked_calendar.json")
UI_SELECTION_PATH = Path("notebooks/ui_selection.json")
SELECTED_WINE_PATH = Path("notebooks/selected_wine.json")
# --- CALENDAR HELPERS (define above routes) ---
DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]

def _read_json(p: Path):
    try:
        if p.exists() and p.stat().st_size > 0:
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return None

def _norm(s): return str(s or "").strip().lower()
def _name_key(name, vintage): return f"{_norm(name)}::{_norm(vintage or 'NV')}"

def _parse_dt(s):
    try:
        return pd.to_datetime(s, errors="coerce")
    except Exception:
        return pd.NaT

def _load_campaign_index_merged():
    hist_pref = IRON_DATA_PATH / "history" / "wine_campaign_history.json"
    idx_legacy = IRON_DATA_PATH / "campaign_index.json"

    by_id, by_name = {}, {}
    e_id, e_nm = {}, {}

    H = _read_json(hist_pref) or {}
    if "by_id" in (H or {}):
        for k, v in (H.get("by_id") or {}).items():
            lcd = (v.get("last_campaign_date") if isinstance(v, dict) else v) or ""
            if lcd: by_id[str(k)] = lcd
        for k, v in (H.get("by_name") or {}).items():
            lcd = (v.get("last_campaign_date") if isinstance(v, dict) else v) or ""
            if lcd: by_name[str(k)] = lcd
        for k, v in (H.get("emails_sent_by_id") or {}).items():
            try: e_id[str(k)] = int(v or 0)
            except: pass
        for k, v in (H.get("emails_sent_by_name") or {}).items():
            try: e_nm[str(k)] = int(v or 0)
            except: pass
    else:
        for k, v in (H or {}).items():
            if isinstance(v, dict):
                lcd = v.get("last_campaign_date") or ""
                em  = int(v.get("emails_sent", 0) or 0)
            else:
                lcd, em = (str(v or ""), 0)
            if str(k).isdigit():
                if lcd: by_id[str(k)] = lcd
                e_id[str(k)] = em
            else:
                if lcd: by_name[str(k)] = lcd
                e_nm[str(k)] = em

    L = _read_json(idx_legacy) or {}
    legacy_by_id   = (L.get("by_id") or L.get("ids") or {})
    legacy_by_name = (L.get("by_name") or L.get("names") or {})
    for k, v in legacy_by_id.items():
        a, b = _parse_dt(by_id.get(str(k))), _parse_dt(v)
        if pd.isna(a) or (not pd.isna(b) and b > a): by_id[str(k)] = v
    for k, v in legacy_by_name.items():
        a, b = _parse_dt(by_name.get(str(k))), _parse_dt(v)
        if pd.isna(a) or (not pd.isna(b) and b > a): by_name[str(k)] = v

    return {"by_id": by_id, "by_name": by_name, "emails_by_id": e_id, "emails_by_name": e_nm}

def _load_weekly_calendar(year: int | None, week: int | None):
    if year and week:
        p = IRON_DATA_PATH / f"weekly_campaign_schedule_{int(year)}_week_{_clamp_week(week)}.json"
        if p.exists():
            raw = _read_json(p) or {}
            return raw.get("weekly_calendar", raw)
    if week:
        p = IRON_DATA_PATH / f"weekly_campaign_schedule_week_{_clamp_week(week)}.json"
        if p.exists():
            raw = _read_json(p) or {}
            return raw.get("weekly_calendar", raw)
    p = IRON_DATA_PATH / "weekly_campaign_schedule.json"
    raw = _read_json(p) or {}
    return raw.get("weekly_calendar", raw) if raw else {d: [] for d in DAYS}

def _load_leads(year: int | None, week: int | None):
    if year and week:
        p = IRON_DATA_PATH / f"leads_campaigns_{int(year)}_week_{_clamp_week(week)}.json"
        if p.exists(): return _read_json(p) or {"TueWed": [], "ThuFri": []}
    if week:
        p = IRON_DATA_PATH / f"leads_campaigns_week_{_clamp_week(week)}.json"
        if p.exists(): return _read_json(p) or {"TueWed": [], "ThuFri": []}
    p = IRON_DATA_PATH / "leads_campaigns.json"
    return _read_json(p) or {"TueWed": [], "ThuFri": []}

def _load_stock_for_ui():
    for name in ("stock_for_ui_latest.pkl","stock_df_final.pkl","stock_df_with_seasonality.pkl"):
        p = IRON_DATA_PATH / name
        if p.exists():
            try: return pd.read_pickle(p)
            except Exception: continue
    return pd.DataFrame()

def _inject_min_budget(calendar: dict, stock_df: pd.DataFrame, minimum=3, max_slots=5, allow_wed_overflow=True):
    def _is_budget(it): return str(it.get("price_tier","")).strip().lower() == "budget"
    current = sum(1 for d in DAYS for it in calendar.get(d, []) if _is_budget(it))
    if current >= minimum or stock_df.empty:
        return calendar

    in_ids = {str(it.get("id","")) for d in DAYS for it in (calendar.get(d) or []) if it}
    s = stock_df.copy()
    if "price_tier" not in s.columns: return calendar
    s["id"] = s.get("id","").astype(str)
    s = s[s["price_tier"].astype(str).str.lower().eq("budget")]
    s = s[~s["id"].isin(in_ids)]
    if "avg_cpi_score" not in s.columns: s["avg_cpi_score"] = 0.0
    if "stock" not in s.columns: s["stock"] = 0
    s = s.sort_values(["avg_cpi_score","stock"], ascending=[False, False])

    placement = ["Tuesday","Thursday","Sunday","Monday"]
    for _, r in s.iterrows():
        if current >= minimum: break
        for day in placement:
            cap = (len(calendar.get(day, [])) < max_slots) or (allow_wed_overflow and day == "Wednesday")
            if not cap: 
                continue
            calendar.setdefault(day, []).append({
                "id": str(r.get("id","")),
                "wine": r.get("wine") or "Unknown",
                "name": r.get("wine") or "Unknown",
                "vintage": str(r.get("vintage") or "NV"),
                "full_type": r.get("full_type") or "Unknown",
                "region_group": r.get("region_group") or "Unknown",
                "stock": int(pd.to_numeric(r.get("stock", 0), errors="coerce") or 0),
                "price_tier": "Budget",
                "price_tier_id": "budget",
                "match_quality": "Budget Fill",
                "avg_cpi_score": float(pd.to_numeric(r.get("avg_cpi_score", 0), errors="coerce") or 0.0),
                "locked": False
            })
            current += 1
            break
    return calendar

def _hydrate_history_fields(calendar: dict):
    idx = _load_campaign_index_merged()
    by_id, by_name = idx.get("by_id", {}), idx.get("by_name", {})
    e_id, e_nm = idx.get("emails_by_id", {}), idx.get("emails_by_name", {})
    for d in DAYS:
        out = []
        for it in (calendar.get(d) or []):
            it = dict(it or {})
            if not it.get("last_campaign_date"):
                k = str(it.get("id","")).strip()
                if k and by_id.get(k): it["last_campaign_date"] = by_id[k]
                else:
                    nk = _name_key(it.get("wine") or it.get("name"), it.get("vintage"))
                    if nk and by_name.get(nk): it["last_campaign_date"] = by_name[nk]
            if "emails_sent" not in it:
                k = str(it.get("id","")).strip()
                em = e_id.get(k)
                if em is None:
                    nk = _name_key(it.get("wine") or it.get("name"), it.get("vintage"))
                    em = e_nm.get(nk, 0)
                it["emails_sent"] = int(em or 0)
            out.append(it)
        calendar[d] = out
    return calendar

def build_calendar_bundle_v2(year: int | None, week: int | None, max_slots=5, allow_wed_overflow=True, ensure_budget_min=3):
    cal = _load_weekly_calendar(year, week)
    cal = {d: list(cal.get(d) or []) for d in DAYS}

    # Budget min + hydration
    stock_ui = _load_stock_for_ui()
    cal = _inject_min_budget(cal, stock_ui, minimum=ensure_budget_min, max_slots=max_slots, allow_wed_overflow=allow_wed_overflow)
    cal = _hydrate_history_fields(cal)

    leads = _load_leads(year, week)
    return {"weekly_calendar": clean_nans(cal), "leads_campaigns": clean_nans(leads)}
# --- Engine ready stub ---
def _set_engine_ready():
    # TODO: Implement engine ready logic
    pass

# --- Compose calendar stub (if missing) ---
def compose_calendar(*args, **kwargs):
    # TODO: Implement calendar composition logic
    return {}

from pathlib import Path
from pathlib import Path
# app.py (cleaned)
from flask import Flask, render_template, request, jsonify, g

# Initialize Flask app
app = Flask(__name__)
import math
from pathlib import Path
from datetime import datetime, timezone
from time import time as now_time
import threading, json, logging, uuid, os
import pandas as pd

from config import Settings
from utils.notebook_runner import run_notebook as nb_run  # avoid name shadowing
from utils.notebook_status import update_status, get_status, Heartbeat
from utils.schemas import ScheduleValidator, LockedValidator, list_errors

# -----------------------------------------------------------------------------
# Environment
# -----------------------------------------------------------------------------
os.environ.setdefault("ENABLE_OUTLOOK", "1")

# ---- Composer helpers ----

# --- Missing global variables and helpers ---
IRON_DATA_PATH = Path(r"C:\Users\Marco.Africani\OneDrive - AVU SA\AVU CPI Campaign\Puzzle_control_Reports\IRON_DATA")
SOURCE_PATH = Path(r"C:\Users\Marco.Africani\OneDrive - AVU SA\AVU CPI Campaign\Puzzle_control_Reports\SOURCE_FILES")

# ===== Catalog search backed by all_stock_cards.json =====
CARDS_JSON_PATH = Path(
    r"C:\Users\Marco.Africani\OneDrive - AVU SA\AVU CPI Campaign\Puzzle_control_Reports\SOURCE_FILES\all_stock_cards.json"
)

_CARDS_CACHE = {"rows": None, "mtime": None, "src": None}
_CATALOG_FALLBACK = {"df": None, "src": None, "mtime": None}  # PKL fallback
from flask import g
import numpy as np

def clean_nans(data):
    # Simple stub: replace NaN with None recursively
    if isinstance(data, dict):
        return {k: clean_nans(v) for k, v in data.items()}
    elif isinstance(data, list):
        return [clean_nans(v) for v in data]
    elif isinstance(data, float) and np.isnan(data):
        return None
    return data

from pathlib import Path
LOCKED_PATH = Path("notebooks")

def _load_cards_json():
    """Load & cache cards from all_stock_cards.json."""
    if not CARDS_JSON_PATH.exists():
        return None

    mtime = CARDS_JSON_PATH.stat().st_mtime
    if _CARDS_CACHE["rows"] is None or _CARDS_CACHE["mtime"] != mtime:
        try:
            raw = json.loads(CARDS_JSON_PATH.read_text(encoding="utf-8"))
            rows = raw.get("cards", []) or []
            # normalize for search
            for r in rows:
                r["wine"] = str(r.get("wine", "")).strip()
                r["wine_lc"] = r["wine"].lower()
                r["vintage"] = str(r.get("vintage", "NV") or "NV").strip()
                r["id"] = str(r.get("id", "")).strip()
            _CARDS_CACHE.update(rows=rows, mtime=mtime, src=str(CARDS_JSON_PATH))
        except Exception:
            return None
    return _CARDS_CACHE["rows"]

def _fallback_df_from_pkl():
    """Previous behavior: use stock PKL if cards JSON is missing."""
    candidates = [
        IRON_DATA_PATH / "stock_df_final.pkl",
        IRON_DATA_PATH / "stock_df_with_seasonality.pkl",
    ]
    src = next((p for p in candidates if p.exists()), None)
    if src is None:
        return None

    mtime = src.stat().st_mtime
    if _CATALOG_FALLBACK["df"] is None or _CATALOG_FALLBACK["src"] != str(src) or _CATALOG_FALLBACK["mtime"] != mtime:
        df = pd.read_pickle(src)
        df = df.rename(columns={"Stock": "stock"})
        for c in ("id", "wine", "vintage", "region_group", "full_type", "stock"):
            if c not in df.columns:
                df[c] = "" if c != "stock" else 0
        df["id"] = df["id"].astype(str).str.replace(r"\.0$", "", regex=True)
        df["wine_lc"] = df["wine"].astype(str).str.strip().str.lower()
        _CATALOG_FALLBACK.update(df=df, src=str(src), mtime=mtime)
    return _CATALOG_FALLBACK["df"]

# Ensure g.request_id exists for each request
@app.before_request
def set_request_id():
    g.request_id = str(uuid.uuid4())

def _end_run():
    # TODO: Implement actual end run logic
    pass

# --- Missing function stubs ---
def _load_leads(year=None, week=None):
    # TODO: Implement actual leads loading logic
    return []

def _clamp_week(week):
    # TODO: Implement actual week clamping logic
    try:
        w = int(week)
        return max(1, min(53, w))
    except Exception:
        return 1

def _start_run():
    # TODO: Implement actual engine start logic
    return True
# -----------------------------------------------------------------------------
# Homepage route
# -----------------------------------------------------------------------------
@app.route("/engine_ready")
def engine_ready():
    return jsonify({"status": "ready"})

@app.route("/api/campaign_index")
def campaign_index():
    # TODO: Implement actual campaign index logic
    return jsonify({"campaigns": []})
def _load_weekly_calendar(year: int | None, week: int | None):
    # year+week → weekly_campaign_schedule_{year}_week_{week}.json
    if year is not None and week is not None:
        p = IRON_DATA_PATH / f"weekly_campaign_schedule_{int(year)}_week_{_clamp_week(week)}.json"
        if p.exists():
            raw = _read_json(p) or {}
            return raw.get("weekly_calendar", raw)
    # week-only legacy
    if week is not None:
        p = IRON_DATA_PATH / f"weekly_campaign_schedule_week_{_clamp_week(week)}.json"
        if p.exists():
            raw = _read_json(p) or {}
            return raw.get("weekly_calendar", raw)
    # generic fallback
    p = IRON_DATA_PATH / "weekly_campaign_schedule.json"
    raw = _read_json(p) or {}
    return raw.get("weekly_calendar", raw) if raw else {d: [] for d in DAYS}

def _inject_min_budget(calendar: dict, stock_df: pd.DataFrame, minimum=3, max_slots=5, allow_wed_overflow=True):
    def _is_budget(it): return str(it.get("price_tier","")).strip().lower() == "budget"
    current = sum(1 for d in DAYS for it in calendar.get(d, []) if _is_budget(it))
    if current >= minimum or stock_df.empty:
        return calendar

    in_ids = {str(it.get("id","")) for d in DAYS for it in (calendar.get(d) or []) if it}
    s = stock_df.copy()
    if "price_tier" not in s.columns: return calendar
    s["id"] = s.get("id","").astype(str)
    s = s[s["price_tier"].astype(str).str.lower().eq("budget")]
    s = s[~s["id"].isin(in_ids)]
    if "avg_cpi_score" not in s.columns: s["avg_cpi_score"] = 0.0
    if "stock" not in s.columns: s["stock"] = 0
    s = s.sort_values(["avg_cpi_score","stock"], ascending=[False, False])

    placement = ["Tuesday","Thursday","Sunday","Monday"]
    for _, r in s.iterrows():
        if current >= minimum: break
        for day in placement:
            cap = (len(calendar.get(day, [])) < max_slots) or (allow_wed_overflow and day == "Wednesday")
            if not cap: 
                continue
            calendar.setdefault(day, []).append({
                "id": str(r.get("id","")),
                "wine": r.get("wine") or "Unknown",
                "name": r.get("wine") or "Unknown",
                "vintage": str(r.get("vintage") or "NV"),
                "full_type": r.get("full_type") or "Unknown",
                "region_group": r.get("region_group") or "Unknown",
                "stock": int(pd.to_numeric(r.get("stock", 0), errors="coerce") or 0),
                "price_tier": "Budget",
                "price_tier_id": "budget",
                "match_quality": "Budget Fill",
                "avg_cpi_score": float(pd.to_numeric(r.get("avg_cpi_score", 0), errors="coerce") or 0.0),
                "locked": False
            })
            current += 1
            break
    return calendar

def _hydrate_history_fields(calendar: dict):
    """
    Fill last_campaign_date & emails_sent for each card using the merged index.
    """
    idx = _load_campaign_index_merged()
    by_id = idx.get("by_id", {})
    by_name = idx.get("by_name", {})
    e_id = idx.get("emails_by_id", {})
    e_nm = idx.get("emails_by_name", {})

    for d in DAYS:
        out = []
        for it in (calendar.get(d) or []):
            it = dict(it or {})
            if "last_campaign_date" not in it or not it.get("last_campaign_date"):
                # prefer id
                k = str(it.get("id","")).strip()
                if k and by_id.get(k):
                    it["last_campaign_date"] = by_id[k]
                else:
                    nk = _name_key(it.get("wine") or it.get("name"), it.get("vintage"))
                    if nk and by_name.get(nk):
                        it["last_campaign_date"] = by_name[nk]
            if "emails_sent" not in it:
                k = str(it.get("id","")).strip()
                em = e_id.get(k)
                if em is None:
                    nk = _name_key(it.get("wine") or it.get("name"), it.get("vintage"))
                    em = e_nm.get(nk, 0)
                it["emails_sent"] = int(em or 0)
            out.append(it)
        calendar[d] = out
    return calendar

def compose_calendar(year: int | None, week: int | None, max_slots=5, allow_wed_overflow=True, ensure_budget_min=3):
    cal = _load_weekly_calendar(year, week)
    cal = {d: list(cal.get(d) or []) for d in DAYS}  # normalize

    # Merge winners
    winners = _load_winners_latest()
    for day in DAYS:
        day_list = cal.setdefault(day, [])
        have = {str(x.get("id","")) for x in day_list}
        for it in (winners.get(day) or []):
            rid = str((it or {}).get("id",""))
            if rid and rid not in have:
                if len(day_list) < max_slots or (allow_wed_overflow and day == "Wednesday"):
                    it.setdefault("locked", True)
                    day_list.append(it)
                    have.add(rid)

    # Merge cadence (Tue=Value, Wed=Luxury)
    cadence = _load_cadence_latest()
    for day in ("Tuesday","Wednesday"):
        day_list = cal.setdefault(day, [])
        have = {str(x.get("id","")) for x in day_list}
        for it in (cadence.get(day) or []):
            rid = str((it or {}).get("id",""))
            if rid and rid not in have:
                if len(day_list) < max_slots or (allow_wed_overflow and day == "Wednesday"):
                    it.setdefault("locked", True)
                    day_list.append(it)
                    have.add(rid)

    # Min 3 Budget
    stock_ui = _load_stock_for_ui()
    cal = _inject_min_budget(cal, stock_ui, minimum=ensure_budget_min, max_slots=max_slots, allow_wed_overflow=allow_wed_overflow)

    # Hydrate last_campaign_date + emails_sent
    cal = _hydrate_history_fields(cal)

    # Bundle with leads
    leads = _load_leads(year, week)
    return {"weekly_calendar": clean_nans(cal), "leads_campaigns": clean_nans(leads)}


    """
    Fill last_campaign_date & emails_sent for each card using the merged index.
    """
    idx = _load_campaign_index_merged()
    by_id = idx.get("by_id", {})
    by_name = idx.get("by_name", {})
    e_id = idx.get("emails_by_id", {})
    e_nm = idx.get("emails_by_name", {})

    for d in DAYS:
        out = []
        for it in (calendar.get(d) or []):
            it = dict(it or {})
            if "last_campaign_date" not in it or not it.get("last_campaign_date"):
                # prefer id
                k = str(it.get("id","")).strip()
                if k and by_id.get(k):
                    it["last_campaign_date"] = by_id[k]
                else:
                    nk = _name_key(it.get("wine") or it.get("name"), it.get("vintage"))
                    if nk and by_name.get(nk):
                        it["last_campaign_date"] = by_name[nk]
            if "emails_sent" not in it:
                k = str(it.get("id","")).strip()
                em = e_id.get(k)
                if em is None:
                    nk = _name_key(it.get("wine") or it.get("name"), it.get("vintage"))
                    em = e_nm.get(nk, 0)
                it["emails_sent"] = int(em or 0)
            out.append(it)
        calendar[d] = out
    return calendar

# Status polling (used by front-end progress panel)
    cal = _load_weekly_calendar(year, week)
    cal = {d: list(cal.get(d) or []) for d in DAYS}  # normalize

    # Merge winners
    winners = _load_winners_latest()
    for day in DAYS:
        day_list = cal.setdefault(day, [])
        have = {str(x.get("id","")) for x in day_list}
        for it in (winners.get(day) or []):
            rid = str((it or {}).get("id",""))
            if rid and rid not in have:
                if len(day_list) < max_slots or (allow_wed_overflow and day == "Wednesday"):
                    it.setdefault("locked", True)
                    day_list.append(it)
                    have.add(rid)

    # Merge cadence (Tue=Value, Wed=Luxury)
    cadence = _load_cadence_latest()
    for day in ("Tuesday","Wednesday"):
        day_list = cal.setdefault(day, [])
        have = {str(x.get("id","")) for x in day_list}
        for it in (cadence.get(day) or []):
            rid = str((it or {}).get("id",""))
            if rid and rid not in have:
                if len(day_list) < max_slots or (allow_wed_overflow and day == "Wednesday"):
                    it.setdefault("locked", True)
                    day_list.append(it)
                    have.add(rid)

    # Min 3 Budget
    stock_ui = _load_stock_for_ui()
    cal = _inject_min_budget(cal, stock_ui, minimum=ensure_budget_min, max_slots=max_slots, allow_wed_overflow=allow_wed_overflow)

    # Hydrate last_campaign_date + emails_sent
    cal = _hydrate_history_fields(cal)

    # Bundle with leads
    leads = _load_leads(year, week)
    return {"weekly_calendar": clean_nans(cal), "leads_campaigns": clean_nans(leads)}
@app.route("/status")
def status():
    data = get_status() or {}
    raw_progress = data.get("progress", 0)
    try:
        progress = int(float(raw_progress)) if isinstance(raw_progress, (int, float, str)) else 0
    except Exception:
        progress = 0

    payload = {
        "notebook": data.get("notebook", ""),
        "state": (data.get("state") or data.get("status") or "idle"),
        "progress": progress,
        "message": data.get("message") or "Waiting…",
        "updated_at": data.get("updated_at") or datetime.now(timezone.utc).isoformat(),
    }
    resp = jsonify(payload)
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp

# ADD THIS in app.py

# New year-aware endpoints

@app.get("/api/calendar")
def api_calendar():
    year = request.args.get("year", type=int)
    week = request.args.get("week", type=int)
    bundle = build_calendar_bundle_v2(year=year, week=week, max_slots=5, allow_wed_overflow=True, ensure_budget_min=3)
    resp = jsonify(bundle)
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp

@app.get("/api/leads")
def get_leads():
    year = request.args.get("year", type=int)
    week = request.args.get("week", type=int)
    data = _load_leads(year, week)
    resp = jsonify(clean_nans(data))
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp


@app.get("/api/schedule")
def get_schedule():
    year = request.args.get("year", type=int)
    week = request.args.get("week", type=int)
    try:
        bundle = build_calendar_bundle_v2(year=year, week=week, max_slots=5, allow_wed_overflow=True, ensure_budget_min=3)
        payload = bundle["weekly_calendar"]
    except Exception as e:
        logging.error(f"build_calendar_bundle_v2 failed: {e}")
        days = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]
        payload = {d: [None]*5 for d in days}
    payload = clean_nans(payload)
    resp = jsonify(payload)
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp

    # =========================
    # History / Campaign Index
    # =========================
    from datetime import date

    DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]

    def _read_json(p: Path):
        try:
            if p.exists() and p.stat().st_size > 0:
                return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
        return None

    def _norm(s): return str(s or "").strip().lower()
    def _name_key(name, vintage): return f"{_norm(name)}::{_norm(vintage or 'NV')}"

    def _parse_dt(s):
        try:
            return pd.to_datetime(s, errors="coerce")
        except Exception:
            return pd.NaT

    def _iso_week_monday(y: int, w: int):
        # Monday of ISO week
        try:
            return date.fromisocalendar(int(y), int(w), 1).isoformat()
        except Exception:
            # fallback to today (shouldn't happen)
            return datetime.now(timezone.utc).date().isoformat()

    def _load_campaign_index_merged():
        """
        Merge last-campaign info from:
          - IRON_DATA/history/wine_campaign_history.json (preferred)
          - IRON_DATA/campaign_index.json (legacy)
        Returns dict: { by_id, by_name, emails_by_id, emails_by_name }
        """
        hist_pref = IRON_DATA_PATH / "history" / "wine_campaign_history.json"
        idx_legacy = IRON_DATA_PATH / "campaign_index.json"

        by_id, by_name = {}, {}
        emails_by_id, emails_by_name = {}, {}

        # 1) Preferred history
        H = _read_json(hist_pref) or {}
        if "by_id" in H:
            # structured
            for k, v in (H.get("by_id") or {}).items():
                lcd = (v.get("last_campaign_date") if isinstance(v, dict) else v) or ""
                if lcd:
                    by_id[str(k)] = lcd
            for k, v in (H.get("by_name") or {}).items():
                lcd = (v.get("last_campaign_date") if isinstance(v, dict) else v) or ""
                if lcd:
                    by_name[str(k)] = lcd
            for k, v in (H.get("emails_sent_by_id") or {}).items():
                try: emails_by_id[str(k)] = int(v or 0)
                except: pass
            for k, v in (H.get("emails_sent_by_name") or {}).items():
                try: emails_by_name[str(k)] = int(v or 0)
                except: pass
        else:
            # tolerant flat shape
            for k, v in H.items():
                if isinstance(v, dict):
                    lcd = v.get("last_campaign_date") or ""
                    em  = v.get("emails_sent", 0) or 0
                else:
                    lcd, em = (str(v or ""), 0)
                if str(k).isdigit():
                    if lcd: by_id[str(k)] = lcd
                    emails_by_id[str(k)] = int(em)
                else:
                    if lcd: by_name[str(k)] = str(k)
                    emails_by_name[str(k)] = int(em)

        # 2) Legacy index merge (take max date per key)
        L = _read_json(idx_legacy) or {}
        legacy_by_id   = (L.get("by_id") or L.get("ids") or {})
        legacy_by_name = (L.get("by_name") or L.get("names") or {})
        for k, v in legacy_by_id.items():
            a, b = _parse_dt(by_id.get(str(k))), _parse_dt(v)
            if pd.isna(a) or (not pd.isna(b) and b > a):
                by_id[str(k)] = v
        for k, v in legacy_by_name.items():
            a, b = _parse_dt(by_name.get(str(k))), _parse_dt(v)
            if pd.isna(a) or (not pd.isna(b) and b > a):
                by_name[str(k)] = v

        return {
            "by_id": by_id,
            "by_name": by_name,
            "emails_by_id": emails_by_id,
            "emails_by_name": emails_by_name,
        }

    @app.get("/api/campaign_index")
    def api_campaign_index():
        idx = _load_campaign_index_merged()
        # keep payload small & compatible with app.js
        return jsonify({
            "by_id": idx.get("by_id", {}),
            "by_name": idx.get("by_name", {}),
            "emails_by_id": idx.get("emails_by_id", {}),
            "emails_by_name": idx.get("emails_by_name", {}),
            "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")
        })
    @app.get("/api/calendar")
    def api_calendar():
        # optional ?week=NN
        week = request.args.get("week", type=int)
        bundle = compose_calendar(week=week, max_slots=5, allow_wed_overflow=True, ensure_budget_min=3)
        resp = jsonify(bundle)
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        return resp
    # ---- Compose calendar (merge winners/cadence, budget injection, wed overflow) ----
    DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]

    def _read_json(p: Path):
        try:
            if p.exists() and p.stat().st_size > 0:
                return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
        return None

    def _load_weekly_calendar(week: int | None):
        # Prefer year+week file; fallback to generic
        if week:
            week = _clamp_week(week)
            p = IRON_DATA_PATH / f"weekly_campaign_schedule_week_{week}.json"
            if p.exists():
                raw = _read_json(p) or {}
                return raw.get("weekly_calendar", raw)  # tolerate ui.json shape
        p = IRON_DATA_PATH / "weekly_campaign_schedule.json"
        raw = _read_json(p) or {}
        return raw.get("weekly_calendar", raw) if raw else {d: [] for d in DAYS}

    def _load_winners_latest():
        p1 = IRON_DATA_PATH / "calendar" / "latest" / "winner_cards.json"
        p2 = IRON_DATA_PATH / "winner_cards_current_week.json"
        return _read_json(p1) or _read_json(p2) or {}

    def _load_cadence_latest():
        p1 = IRON_DATA_PATH / "calendar" / "latest" / "cadence_cards.json"
        p2 = IRON_DATA_PATH / "cadence_cards_current_week.json"
        payload = _read_json(p1) or _read_json(p2) or {}
        # normalize accepted shapes
        return payload.get("cards", payload) if isinstance(payload, dict) else {}

    def _load_leads(week: int | None):
        if week:
            p = IRON_DATA_PATH / f"leads_campaigns_week_{_clamp_week(week)}.json"
        else:
            p = IRON_DATA_PATH / "leads_campaigns.json"
        return _read_json(p) or {"TueWed": [], "ThuFri": []}

    def _load_stock_for_ui():
        for name in ("stock_for_ui_latest.pkl", "stock_df_final.pkl", "stock_df_with_seasonality.pkl"):
            p = IRON_DATA_PATH / name
            if p.exists():
                try:
                    return pd.read_pickle(p)
                except Exception:
                    continue
        return pd.DataFrame()

    def _inject_min_budget(calendar: dict, stock_df: pd.DataFrame, minimum=3, max_slots=5, allow_wed_overflow=True):
        # Count existing
        def _is_budget(it): return str(it.get("price_tier","")).strip().lower() == "budget"
        current = sum(1 for d in DAYS for it in calendar.get(d, []) if _is_budget(it))
        if current >= minimum or stock_df.empty:
            return calendar

        # Candidates not already in calendar
        in_ids = {str(it.get("id","")) for d in DAYS for it in (calendar.get(d) or []) if it}
        s = stock_df.copy()
        if "price_tier" not in s.columns: return calendar
        s["id"] = s.get("id","").astype(str)
        s = s[s["price_tier"].astype(str).str.lower().eq("budget")]
        s = s[~s["id"].isin(in_ids)]
        if "avg_cpi_score" not in s.columns: s["avg_cpi_score"] = 0.0
        if "stock" not in s.columns: s["stock"] = 0
        s = s.sort_values(["avg_cpi_score","stock"], ascending=[False, False])

        placement = ["Tuesday","Thursday","Sunday","Monday"]  # sensible default
        for _, r in s.iterrows():
            if current >= minimum: break
            for day in placement:
                cap = (len(calendar.get(day, [])) < max_slots) or (allow_wed_overflow and day == "Wednesday")
                if not cap: 
                    continue
                calendar.setdefault(day, []).append({
                    "id": str(r.get("id","")),
                    "wine": r.get("wine") or "Unknown",
                    "name": r.get("wine") or "Unknown",
                    "vintage": str(r.get("vintage") or "NV"),
                    "full_type": r.get("full_type") or "Unknown",
                    "region_group": r.get("region_group") or "Unknown",
                    "stock": int(pd.to_numeric(r.get("stock", 0), errors="coerce") or 0),
                    "price_tier": "Budget",
                    "price_tier_id": "budget",
                    "match_quality": "Budget Fill",
                    "avg_cpi_score": float(pd.to_numeric(r.get("avg_cpi_score", 0), errors="coerce") or 0.0),
                    "locked": False
                })
                current += 1
                break
        return calendar

    def compose_calendar(week: int | None, max_slots=5, allow_wed_overflow=True, ensure_budget_min=3):
        cal = _load_weekly_calendar(week)
        # Ensure day lists exist
        cal = {d: list(cal.get(d) or []) for d in DAYS}

        # Winners (Mon/Wed/Fri) — avoid duplicates by id
        winners = _load_winners_latest()
        for day in DAYS:
            for it in (winners.get(day) or []):
                it = it or {}
                it.setdefault("locked", True)
                day_list = cal.setdefault(day, [])
                ids = {str(x.get("id","")) for x in day_list}
                if str(it.get("id","")) not in ids:
                    if len(day_list) < max_slots or (allow_wed_overflow and day == "Wednesday"):
                        day_list.append(it)

        # Cadence (Tue value / Wed luxury)
        cadence = _load_cadence_latest()  # {"Tuesday":[...], "Wednesday":[...]}
        for day in ("Tuesday","Wednesday"):
            for it in (cadence.get(day) or []):
                it = it or {}
                it.setdefault("locked", True)
                day_list = cal.setdefault(day, [])
                ids = {str(x.get("id","")) for x in day_list}
                if str(it.get("id","")) not in ids:
                    if len(day_list) < max_slots or (allow_wed_overflow and day == "Wednesday"):
                        day_list.append(it)

        # Ensure ≥3 Budget items over the week
        stock_ui = _load_stock_for_ui()
        cal = _inject_min_budget(cal, stock_ui, minimum=ensure_budget_min, max_slots=max_slots, allow_wed_overflow=allow_wed_overflow)

        # Leads bundle
        leads = _load_leads(week)
        return {"weekly_calendar": clean_nans(cal), "leads_campaigns": clean_nans(leads)}
# ---- Run full engine (AVU_ignition_1.ipynb) ----
@app.post("/run_full_engine")
def run_full_engine():
    if not _start_run():
        return jsonify({"error": "A run is already in progress."}), 409

    notebook = "AVU_ignition_1.ipynb"
    input_path = Path("notebooks") / notebook
    output_path = Path("notebooks") / f"executed_{notebook}"
    week_number = _clamp_week(datetime.now().isocalendar().week)

    hb = Heartbeat(interval=5, notebook=notebook, base_message="🔥 Ignition running…")

    def run_thread():
        hb.start()
        update_status({
            "notebook": notebook, "state": "running", "done": False,
            "progress": 0, "message": "🚀 Starting full AVU engine…"
        })
        try:
            nb_run(str(input_path), str(output_path), {
                "input_path": str(SOURCE_PATH),
                "output_path": str(IRON_DATA_PATH),
                "week_number": week_number,
            })
            update_status({"progress": 95, "message": "Writing schedule…"})
        except Exception as e:
            update_status({
                "notebook": notebook, "state": "error", "done": True,
                "progress": 0, "message": f"❌ Error: {e}"
            })
        else:
            _set_engine_ready()
            update_status({
                "notebook": notebook, "state": "completed", "done": True,
                "progress": 100, "message": "✅ AVU engine finished."
            })
        finally:
            hb.stop()
            _end_run()

    threading.Thread(target=run_thread, daemon=True).start()
    return jsonify({"message": "✅ Full AVU Engine started.", "rid": g.request_id}), 200

# ---- Run notebook (schedule-only or explicit offer) ----
@app.post("/run_notebook")
def run_notebook_route():
    if not _start_run():
        return jsonify({"error": "A run is already in progress."}), 409

    try:
        data = request.get_json(force=True, silent=False) or {}
    except Exception as e:
        _end_run()
        return jsonify({"error": f"Invalid JSON: {e}"}), 400

    run_mode = data.get("mode", "full")  # 'partial' (schedule), 'offer', or 'full'
    requested_nb = (data.get("notebook") or "").strip()
    filters = data.get("filters") or {}
    week_number = _clamp_week(data.get("week_number"))
    ui_sel = data.get("ui_selection")
    selected_wine = data.get("selected_wine")
    locked_calendar = data.get("locked_calendar") or {}

    # Gate schedule-only & offer notebooks behind ignition
    if (run_mode in ("partial", "offer") or requested_nb) and not _is_engine_ready():
        _end_run()
        return jsonify({"error": "Engine not ready. Please run AVU ignition first."}), 409

    # Persist transient UI state (used by notebooks)
    try:
        FILTERS_PATH.write_text(json.dumps(filters, indent=2), encoding="utf-8")
        TRANSIENT_LOCKED_SNAPSHOT.write_text(json.dumps(locked_calendar, indent=2), encoding="utf-8")
        if ui_sel is not None:
            UI_SELECTION_PATH.write_text(json.dumps(ui_sel, indent=2), encoding="utf-8")
        if selected_wine is not None:
            SELECTED_WINE_PATH.write_text(json.dumps(selected_wine, indent=2), encoding="utf-8")
    except Exception as e:
        _end_run()
        return jsonify({"error": f"Failed to write transient UI state: {e}"}), 500

    # Choose notebook
    if requested_nb:
        notebook = requested_nb
    elif run_mode == "partial":
        notebook = "AVU_schedule_only.ipynb"
    elif run_mode == "offer":
        notebook = "AUTONOMOUS_AVU_OMT_3.ipynb"
    else:
        notebook = "AVU_ignition_1.ipynb"

    input_path = Path("notebooks") / notebook
    output_path = Path("notebooks") / f"executed_{notebook}"

    hb = Heartbeat(interval=5, notebook=notebook, base_message="⏳ Processing…")

    def run_with_status():
        hb.start()
        update_status({
            "notebook": notebook, "state": "running", "done": False,
            "progress": 0, "message": f"Notebook started for Week {week_number}…"
        })
        try:
            nb_run(str(input_path), str(output_path), {
                "input_path": str(SOURCE_PATH),
                "output_path": str(IRON_DATA_PATH),
                "week_number": week_number,
            })
            update_status({"progress": 95, "message": "Writing schedule…"})
        except Exception as e:
            update_status({
                "notebook": notebook, "state": "error", "done": True,
                "progress": 0, "message": f"❌ Error: {e}"
            })
        else:
            update_status({
                "notebook": notebook, "state": "completed", "done": True,
                "progress": 100, "message": f"✅ Notebook executed for Week {week_number}."
            })
        finally:
            hb.stop()
            _end_run()

    threading.Thread(target=run_with_status, daemon=True).start()
    return jsonify({"ok": True, "notebook": notebook, "rid": g.request_id})

@app.get("/api/catalog")
def catalog_search():
    """
    Search wines using the prebuilt all_stock_cards.json.
    Keeps the existing response shape expected by the UI:
      { items: [ { wine, vintages[], ids_by_vintage{v->id}, region_group, full_type } ] }
    """
    q = (request.args.get("q") or "").strip().lower()
    limit = min(max(int(request.args.get("limit", 15)), 1), 50)

    rows = _load_cards_json()
    if rows is None:
        # Fallback to old PKL logic if JSON missing
        df = _fallback_df_from_pkl()
        if df is None:
            return jsonify({"items": []})
        sub = df if not q else df[df["wine_lc"].str.contains(q, na=False)]
        grp = sub.groupby("wine", dropna=False).agg({
            "vintage": lambda s: sorted(set(str(x).strip() for x in s.dropna())),
            "id":      lambda s: {str(v): str(i) for v, i in zip(sub.loc[s.index, "vintage"], s)},
            "region_group": "first",
            "full_type": "first",
        }).reset_index()

        items = []
        for _, r in grp.head(limit).iterrows():
            items.append({
                "wine": r["wine"],
                "vintages": r["vintage"],
                "ids_by_vintage": r["id"],
                "region_group": (r["region_group"] or "Unknown"),
                "full_type": (r["full_type"] or "Unknown"),
            })
        return jsonify({"items": items})

    # JSON path (preferred)
    filtered = rows if not q else [r for r in rows if q in r["wine_lc"]]

    # Group into the same structure as before (by truncated UI name)
    by_wine = {}
    for r in filtered:
        w = r["wine"]  # already truncated to 20 chars in the generator
        entry = by_wine.setdefault(w, {
            "wine": w,
            "vintages": [],
            "ids_by_vintage": {},
            "region_group": "Unknown",
            "full_type": "Unknown",
        })
        v = r["vintage"]
        if v not in entry["vintages"]:
            entry["vintages"].append(v)
        entry["ids_by_vintage"][v] = r["id"]

    items = list(by_wine.values())[:limit]
    resp = jsonify({"items": items})
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp

@app.get("/api/card/<card_id>")
def get_card(card_id):
    rows = _load_cards_json()
    if rows is None:
        return jsonify({"error": "cards json not found"}), 404
    card = next((r for r in rows if str(r.get("id")) == str(card_id)), None)
    return (jsonify(card), 200) if card else (jsonify({"error": "not found"}), 404)

# ---- Locked calendar (validate before saving) ----
@app.post("/api/locked")
def save_locked_calendar():
    try:
        data = request.get_json(force=True) or {}
        week = str(_clamp_week(data.get("week")))
        locked_calendar = data.get("locked_calendar")
        if locked_calendar is None:
            return jsonify({"error": "locked_calendar required"}), 400

        errs = list_errors(LockedValidator, locked_calendar)
        if errs:
            logging.warning("rid=%s locked_calendar validation failed: %s", g.request_id, errs)
            return jsonify({"error": "Validation failed", "details": errs}), 400

        out = LOCKED_PATH / f"locked_calendar_week_{week}.json"
        out.write_text(json.dumps(locked_calendar, indent=2), encoding="utf-8")
        return jsonify({"ok": True, "saved": out.name})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.get("/api/locked")
def get_locked_calendar():
    week = _clamp_week(request.args.get("week"))
    path = LOCKED_PATH / f"locked_calendar_week_{week}.json"
    if not path.exists():
        return jsonify({"locked_calendar": {}}), 200
    data = json.loads(path.read_text(encoding="utf-8"))
    return jsonify({"locked_calendar": data})



# ---- UI selection (optional endpoint; not required by app.js) ----
@app.post("/api/ui_selection")
def set_ui_selection():
    try:
        payload = request.get_json(force=True) or {}
        if not {"day","slot","wine"} <= payload.keys():
            return jsonify({"error": "Fields day, slot, wine are required"}), 400
        UI_SELECTION_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# -----------------------------------------------------------------------------
# Homepage route
# -----------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("cockpit_ui.html")

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    app.run(debug=Settings.DEBUG, use_reloader=False, host="0.0.0.0", port=5000)
