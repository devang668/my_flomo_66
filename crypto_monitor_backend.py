import json
import logging
import os
import smtplib
import threading
import time
from datetime import datetime, timezone
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
from flask import Flask, abort, jsonify, request, send_from_directory
from flask_cors import CORS


BASE_DIR = Path(__file__).resolve().parent
SETTINGS_PATH = BASE_DIR / "user_settings.json"
PRICE_TIMEOUT = 6
ALERT_COOLDOWN_SECONDS = 300

DEFAULT_SETTINGS: Dict[str, Any] = {
    "symbol": "BTCUSDT",
    "check_interval": 15,
    "email": {
        "sender": "",
        "password": "",
        "receiver": "",
        "smtp_server": "",
        "smtp_port": 465,
    },
    "rules": [],
}

SMTP_DEFAULTS: Dict[str, Tuple[str, int]] = {
    "qq.com": ("smtp.qq.com", 465),
    "gmail.com": ("smtp.gmail.com", 465),
    "163.com": ("smtp.163.com", 465),
    "126.com": ("smtp.126.com", 465),
    "outlook.com": ("smtp.office365.com", 587),
    "hotmail.com": ("smtp.office365.com", 587),
    "live.com": ("smtp.office365.com", 587),
}

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("crypto_monitor")

app = Flask(__name__)
CORS(app)

settings_lock = threading.Lock()
settings_cache: Optional[Dict[str, Any]] = None

price_cache_lock = threading.Lock()
price_cache: Dict[str, Dict[str, Any]] = {}

alert_history_lock = threading.Lock()
alert_history: Dict[str, float] = {}

monitor_thread: Optional[threading.Thread] = None
monitor_thread_lock = threading.Lock()
stop_event = threading.Event()


class PriceFetchError(Exception):
    """Custom exception raised when all price sources fail."""


def ensure_settings_file() -> None:
    if not SETTINGS_PATH.exists():
        save_settings(DEFAULT_SETTINGS)


def load_settings() -> Dict[str, Any]:
    global settings_cache
    ensure_settings_file()
    with settings_lock:
        if settings_cache is not None:
            return json.loads(json.dumps(settings_cache))
        with SETTINGS_PATH.open("r", encoding="utf-8") as handle:
            settings = json.load(handle)
        settings_cache = merge_settings_defaults(settings)
        return json.loads(json.dumps(settings_cache))


def merge_settings_defaults(settings: Dict[str, Any]) -> Dict[str, Any]:
    merged = json.loads(json.dumps(DEFAULT_SETTINGS))
    merged.update({k: v for k, v in settings.items() if k != "email"})

    merged["symbol"] = normalize_symbol(merged.get("symbol", DEFAULT_SETTINGS["symbol"]))
    try:
        merged["check_interval"] = max(int(merged.get("check_interval", DEFAULT_SETTINGS["check_interval"])), 5)
    except (TypeError, ValueError):
        merged["check_interval"] = DEFAULT_SETTINGS["check_interval"]

    email_settings = DEFAULT_SETTINGS["email"].copy()
    email_payload = settings.get("email", {}) or {}
    email_settings.update(email_payload)
    smtp_port_value = email_settings.get("smtp_port")
    if smtp_port_value in ("", None):
        email_settings.pop("smtp_port", None)
    elif smtp_port_value is not None:
        try:
            email_settings["smtp_port"] = int(smtp_port_value)
        except (TypeError, ValueError):
            email_settings["smtp_port"] = DEFAULT_SETTINGS["email"]["smtp_port"]
    merged["email"] = email_settings

    rules_payload = settings.get("rules", [])
    merged["rules"] = rules_payload if isinstance(rules_payload, list) else []
    return merged


def save_settings(settings: Dict[str, Any]) -> None:
    global settings_cache
    with settings_lock:
        with SETTINGS_PATH.open("w", encoding="utf-8") as handle:
            json.dump(settings, handle, ensure_ascii=False, indent=2)
        settings_cache = json.loads(json.dumps(settings))


def normalize_symbol(symbol: str) -> str:
    if not symbol:
        return DEFAULT_SETTINGS["symbol"]
    return symbol.upper()


def to_market_pair(symbol: str) -> str:
    symbol = normalize_symbol(symbol)
    if "-" in symbol:
        return symbol
    quote_assets = ["USDT", "USDC", "BTC", "ETH", "BUSD", "USD"]
    for quote in quote_assets:
        if symbol.endswith(quote) and len(symbol) > len(quote):
            base = symbol[: -len(quote)]
            return f"{base}-{quote}"
    return symbol


def infer_smtp_settings(sender: str) -> Tuple[str, int]:
    if "@" not in sender:
        return "", 465
    domain = sender.split("@")[-1].lower()
    return SMTP_DEFAULTS.get(domain, (f"smtp.{domain}", 465))


def is_email_configured(email_settings: Dict[str, Any]) -> bool:
    required = [email_settings.get("sender"), email_settings.get("password"), email_settings.get("receiver")]
    return all(bool(item) for item in required)


def normalize_rule(rule: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(rule, dict):
        raise ValueError("规则格式不正确")
    rule_type = (rule.get("type") or "").lower()
    message = (rule.get("message") or "").strip()

    if rule_type == "buy":
        price_value = float(rule.get("price", 0))
        if price_value <= 0:
            raise ValueError("买入信号价格必须大于 0")
        return {
            "type": "buy",
            "condition": "below",
            "price": price_value,
            "message": message or f"【买入信号】价格已低于 {price_value}",
        }

    if rule_type == "sell":
        price_value = float(rule.get("price", 0))
        if price_value <= 0:
            raise ValueError("卖出信号价格必须大于 0")
        return {
            "type": "sell",
            "condition": "above",
            "price": price_value,
            "message": message or f"【卖出信号】价格已高于 {price_value}",
        }

    if rule_type == "alert":
        low = float(rule.get("low", 0))
        high = float(rule.get("high", 0))
        if low <= 0 or high <= 0 or low >= high:
            raise ValueError("区间提醒的价格范围无效")
        return {
            "type": "alert",
            "condition": "between",
            "low": low,
            "high": high,
            "message": message or f"【区间提醒】价格位于 {low} ~ {high}",
        }

    raise ValueError("不支持的规则类型")


def validate_and_normalize_settings(payload: Dict[str, Any]) -> Dict[str, Any]:
    normalized: Dict[str, Any] = json.loads(json.dumps(DEFAULT_SETTINGS))

    symbol = normalize_symbol(payload.get("symbol", DEFAULT_SETTINGS["symbol"]))
    normalized["symbol"] = symbol

    interval = payload.get("check_interval", DEFAULT_SETTINGS["check_interval"])
    try:
        interval_val = int(interval)
    except (TypeError, ValueError):
        raise ValueError("检查间隔必须是数字")
    normalized["check_interval"] = max(5, interval_val)

    email_payload = payload.get("email", {}) or {}
    email_settings = DEFAULT_SETTINGS["email"].copy()
    email_settings.update(email_payload)
    for key in ("sender", "receiver", "password", "smtp_server"):
        if key in email_settings and isinstance(email_settings[key], str):
            email_settings[key] = email_settings[key].strip()
    smtp_port_value = email_settings.get("smtp_port")
    if smtp_port_value in ("", None):
        email_settings.pop("smtp_port", None)
    elif isinstance(smtp_port_value, (int, float)):
        if int(smtp_port_value) <= 0:
            raise ValueError("SMTP 端口需为正整数")
        email_settings["smtp_port"] = int(smtp_port_value)
    else:
        try:
            smtp_port_int = int(smtp_port_value)
        except (TypeError, ValueError) as exc:
            raise ValueError("SMTP 端口需为正整数") from exc
        if smtp_port_int <= 0:
            raise ValueError("SMTP 端口需为正整数")
        email_settings["smtp_port"] = smtp_port_int
    normalized["email"] = email_settings

    rules_payload = payload.get("rules", [])
    if not isinstance(rules_payload, list):
        raise ValueError("提醒规则须为列表")
    normalized_rules: List[Dict[str, Any]] = []
    for rule_payload in rules_payload:
        normalized_rules.append(normalize_rule(rule_payload))
    normalized["rules"] = normalized_rules
    return normalized


def fetch_from_binance(symbol: str) -> float:
    url = "https://api.binance.com/api/v3/ticker/price"
    response = requests.get(url, params={"symbol": normalize_symbol(symbol)}, timeout=PRICE_TIMEOUT)
    response.raise_for_status()
    data = response.json()
    if "price" not in data:
        raise ValueError("Binance 返回数据缺少价格")
    return float(data["price"])


def fetch_from_okx(symbol: str) -> float:
    url = "https://www.okx.com/api/v5/market/ticker"
    inst_id = to_market_pair(symbol)
    response = requests.get(url, params={"instId": inst_id}, timeout=PRICE_TIMEOUT)
    response.raise_for_status()
    data = response.json()
    if data.get("code") != "0":
        raise ValueError(data.get("msg", "OKX 返回错误"))
    entries = data.get("data") or []
    if not entries:
        raise ValueError("OKX 返回数据为空")
    last_price = entries[0].get("last")
    if last_price is None:
        raise ValueError("OKX 返回数据缺少价格")
    return float(last_price)


def fetch_from_kucoin(symbol: str) -> float:
    url = "https://api.kucoin.com/api/v1/market/orderbook/level1"
    response = requests.get(url, params={"symbol": to_market_pair(symbol)}, timeout=PRICE_TIMEOUT)
    response.raise_for_status()
    data = response.json()
    if data.get("code") != "200000":
        raise ValueError(data.get("msg", "KuCoin 返回错误"))
    payload = data.get("data") or {}
    price = payload.get("price")
    if price is None:
        raise ValueError("KuCoin 返回数据缺少价格")
    return float(price)


PRICE_SOURCES: List[Tuple[str, Any]] = [
    ("binance", fetch_from_binance),
    ("okx", fetch_from_okx),
    ("kucoin", fetch_from_kucoin),
]


def fetch_price_from_sources(symbol: str) -> Dict[str, Any]:
    errors: List[str] = []
    for name, fetcher in PRICE_SOURCES:
        try:
            price_value = fetcher(symbol)
            timestamp = datetime.now(timezone.utc).isoformat()
            return {
                "symbol": normalize_symbol(symbol),
                "price": price_value,
                "source": name,
                "timestamp": timestamp,
                "stale": False,
            }
        except (requests.RequestException, ValueError) as exc:
            errors.append(f"{name}: {exc}")
            logger.debug("Price source %s failed: %s", name, exc)
            continue
    raise PriceFetchError("; ".join(errors))


def store_price_in_cache(symbol: str, info: Dict[str, Any]) -> None:
    with price_cache_lock:
        price_cache[symbol] = json.loads(json.dumps(info))


def get_cached_price(symbol: str) -> Optional[Dict[str, Any]]:
    with price_cache_lock:
        cached = price_cache.get(symbol)
        if cached:
            return json.loads(json.dumps(cached))
    return None


def fetch_price(symbol: str, use_cache_on_failure: bool = True) -> Dict[str, Any]:
    normalized_symbol = normalize_symbol(symbol)
    try:
        info = fetch_price_from_sources(normalized_symbol)
        store_price_in_cache(normalized_symbol, info)
        return info
    except PriceFetchError as exc:
        if use_cache_on_failure:
            cached = get_cached_price(normalized_symbol)
            if cached:
                cached["stale"] = True
                cached["error"] = str(exc)
                return cached
        raise


def evaluate_rules(price: float, settings: Dict[str, Any]) -> List[Dict[str, Any]]:
    triggered: List[Dict[str, Any]] = []
    for rule in settings.get("rules", []):
        rule_type = rule.get("type")
        condition = rule.get("condition")
        if rule_type == "buy" and condition == "below":
            threshold = rule.get("price")
            if threshold is not None and price <= threshold:
                triggered.append(dict(rule))
        elif rule_type == "sell" and condition == "above":
            threshold = rule.get("price")
            if threshold is not None and price >= threshold:
                triggered.append(dict(rule))
        elif rule_type == "alert" and condition == "between":
            low = rule.get("low")
            high = rule.get("high")
            if low is not None and high is not None and low <= price <= high:
                triggered.append(dict(rule))
    return triggered


def rule_key(rule: Dict[str, Any]) -> str:
    parts = [
        rule.get("type", ""),
        rule.get("condition", ""),
        str(rule.get("price", "")),
        str(rule.get("low", "")),
        str(rule.get("high", "")),
        rule.get("message", ""),
    ]
    return "|".join(parts)


def alert_on_cooldown(rule: Dict[str, Any], now_ts: float) -> Tuple[bool, float]:
    key = rule_key(rule)
    with alert_history_lock:
        last_ts = alert_history.get(key)
        if last_ts is None:
            return False, 0.0
        elapsed = now_ts - last_ts
        if elapsed < ALERT_COOLDOWN_SECONDS:
            return True, ALERT_COOLDOWN_SECONDS - elapsed
        return False, 0.0


def record_alert_trigger(rule: Dict[str, Any], now_ts: float) -> None:
    key = rule_key(rule)
    with alert_history_lock:
        alert_history[key] = now_ts


def send_email_alert(subject: str, body: str, email_settings: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    sender = email_settings.get("sender", "").strip()
    password = email_settings.get("password", "").strip()
    receiver = email_settings.get("receiver", "").strip()
    smtp_server = email_settings.get("smtp_server", "").strip()
    smtp_port = email_settings.get("smtp_port", 0)

    if not sender or not password or not receiver:
        return False, "邮件通知未完整配置"

    if not smtp_server:
        inferred_server, inferred_port = infer_smtp_settings(sender)
        smtp_server = inferred_server
        smtp_port = smtp_port or inferred_port

    try:
        smtp_port_int = int(smtp_port) if smtp_port else 465
    except (TypeError, ValueError):
        smtp_port_int = 465

    message = MIMEText(body, "plain", "utf-8")
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = receiver

    try:
        if smtp_port_int == 465:
            with smtplib.SMTP_SSL(smtp_server, smtp_port_int) as server:
                server.login(sender, password)
                server.sendmail(sender, [receiver], message.as_string())
        else:
            with smtplib.SMTP(smtp_server, smtp_port_int) as server:
                server.starttls()
                server.login(sender, password)
                server.sendmail(sender, [receiver], message.as_string())
        logger.info("Alert email sent to %s", receiver)
        return True, None
    except smtplib.SMTPException as exc:
        logger.error("Failed to send alert email: %s", exc)
        return False, str(exc)


def build_alert_body(symbol: str, price: float, rule: Dict[str, Any]) -> str:
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = [
        f"交易对: {symbol}",
        f"当前价格: {price}",
        f"提醒内容: {rule.get('message', '')}",
        f"触发时间: {timestamp}",
    ]
    return "\n".join(lines)


def handle_triggered_rules(
    symbol: str,
    price: float,
    triggered: List[Dict[str, Any]],
    settings: Dict[str, Any],
) -> List[Dict[str, Any]]:
    notifications: List[Dict[str, Any]] = []
    email_settings = settings.get("email", {})
    now_ts = time.time()

    for rule in triggered:
        rule_copy = dict(rule)
        record = {
            "rule": rule_copy,
            "current_price": price,
            "email_sent": False,
        }

        on_cooldown, remaining = alert_on_cooldown(rule_copy, now_ts)
        if on_cooldown:
            record["skipped_reason"] = f"提醒冷却中，还需 {int(remaining)} 秒"
            notifications.append(record)
            continue

        if not is_email_configured(email_settings):
            record["skipped_reason"] = "邮件通知未配置完整，已跳过发送"
            notifications.append(record)
            continue

        subject = f"Crypto Monitor 提醒 - {symbol}"
        body = build_alert_body(symbol, price, rule_copy)
        sent, error = send_email_alert(subject, body, email_settings)
        record["email_sent"] = sent
        if error:
            record["skipped_reason"] = error
        notifications.append(record)
        record_alert_trigger(rule_copy, now_ts)

    return notifications


def run_alert_check(symbol_override: Optional[str] = None) -> Dict[str, Any]:
    settings = load_settings()
    symbol = normalize_symbol(symbol_override or settings.get("symbol", DEFAULT_SETTINGS["symbol"]))
    price_info = fetch_price(symbol, use_cache_on_failure=False)
    price_value = price_info["price"]
    triggered_rules = evaluate_rules(price_value, settings)
    notifications = handle_triggered_rules(symbol, price_value, triggered_rules, settings)
    result = {
        "symbol": symbol,
        "price": price_info,
        "triggered": notifications,
    }
    return result


def monitor_loop() -> None:
    logger.info("Price monitor thread started")
    while not stop_event.is_set():
        interval = max(int(DEFAULT_SETTINGS["check_interval"]), 5)
        try:
            settings = load_settings()
            symbol = settings.get("symbol", DEFAULT_SETTINGS["symbol"])
            interval = max(int(settings.get("check_interval", interval)), 5)
            try:
                result = run_alert_check(symbol)
                triggered = result.get("triggered", [])
                if triggered:
                    logger.info("Triggered %d rule(s) for %s", len(triggered), symbol)
            except PriceFetchError as exc:
                logger.warning("价格获取失败: %s", exc)
            except Exception as exc:  # noqa: BLE001
                logger.exception("监控线程发生异常: %s", exc)
        except Exception as exc:  # noqa: BLE001
            logger.exception("读取配置失败: %s", exc)
        stop_event.wait(interval)


@app.route("/")
def serve_home() -> Any:
    if not (BASE_DIR / "crypto_monitor.html").exists():
        abort(404)
    return send_from_directory(BASE_DIR, "crypto_monitor.html")


@app.route("/assets/<path:filename>")
def serve_static(filename: str) -> Any:
    file_path = BASE_DIR / filename
    if not file_path.exists():
        abort(404)
    return send_from_directory(BASE_DIR, filename)


@app.get("/api/price/<string:symbol>")
def api_get_price(symbol: str) -> Any:
    try:
        price_info = fetch_price(symbol, use_cache_on_failure=True)
        return jsonify(price_info)
    except PriceFetchError as exc:
        logger.error("Failed to fetch price for %s: %s", symbol, exc)
        return jsonify({"error": "价格获取失败", "details": str(exc)}), 502


@app.get("/api/settings")
def api_get_settings() -> Any:
    settings = load_settings()
    return jsonify(settings)


@app.post("/api/settings")
def api_update_settings() -> Any:
    payload = request.get_json(silent=True) or {}
    try:
        normalized = validate_and_normalize_settings(payload)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    save_settings(normalized)
    return jsonify({"message": "设置已保存", "settings": normalized})


@app.post("/api/check-alerts")
def api_check_alerts() -> Any:
    payload = request.get_json(silent=True) or {}
    symbol = payload.get("symbol")
    try:
        result = run_alert_check(symbol)
        return jsonify(result)
    except PriceFetchError as exc:
        cached = get_cached_price(normalize_symbol(symbol or DEFAULT_SETTINGS["symbol"]))
        response = {"error": "价格获取失败", "details": str(exc)}
        if cached:
            cached["stale"] = True
            response["price"] = cached
        return jsonify(response), 502


def start_monitor_thread() -> None:
    global monitor_thread
    with monitor_thread_lock:
        if monitor_thread is None or not monitor_thread.is_alive():
            monitor_thread = threading.Thread(target=monitor_loop, name="crypto-monitor", daemon=True)
            monitor_thread.start()


start_monitor_thread()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
