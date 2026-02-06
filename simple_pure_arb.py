import asyncio
import json
import time
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, Any, Dict, List
import httpx
import websockets

# --- LOGGING SETUP ---
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger("PureArbBot")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("websockets").setLevel(logging.WARNING)


# --- CONSTANTS ---
BTC_15M_WINDOW = 900  # 15 minutes


# --- WSS CLIENT LOGIC (from wss_market.py) ---

def _now_s() -> float:
    return time.time()

@dataclass
class L2BookState:
    bids: dict[float, float] = field(default_factory=dict)
    asks: dict[float, float] = field(default_factory=dict)
    last_timestamp_ms: Optional[int] = None

    def apply_snapshot(self, msg: dict[str, Any]) -> None:
        bids = msg.get("bids") or msg.get("buys") or []
        asks = msg.get("asks") or msg.get("sells") or []
        self.bids.clear()
        self.asks.clear()
        for lvl in bids:
            try:
                p, s = float(lvl["price"]), float(lvl["size"])
                if s > 0: self.bids[p] = s
            except: continue
        for lvl in asks:
            try:
                p, s = float(lvl["price"]), float(lvl["size"])
                if s > 0: self.asks[p] = s
            except: continue
        
        ts = msg.get("timestamp")
        if ts: self.last_timestamp_ms = int(ts)

    def apply_price_changes(self, msg: dict[str, Any]) -> None:
        ts = msg.get("timestamp")
        if ts: self.last_timestamp_ms = int(ts)
        
        for ch in msg.get("price_changes", []) or []:
            try:
                price = float(ch.get("price"))
                size = float(ch.get("size"))
                side = str(ch.get("side", "")).upper()
            except: continue

            book = self.bids if side == "BUY" else self.asks
            if size <= 0:
                book.pop(price, None)
            else:
                book[price] = size

    def get_best_ask(self) -> Optional[float]:
        if not self.asks: return None
        return min(self.asks.keys())

class MarketWssClient:
    def __init__(self, asset_ids: list[str]):
        self.ws_url = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
        self.asset_ids = asset_ids
        self._books: dict[str, L2BookState] = {aid: L2BookState() for aid in asset_ids}
        self._stop_event = asyncio.Event()
        self.updated_event = asyncio.Event() # Evento para notificar updates instantáneos

    def get_book(self, asset_id: str) -> Optional[L2BookState]:
        return self._books.get(asset_id)

    def stop(self):
        self._stop_event.set()

    async def run(self):
        while not self._stop_event.is_set():
            try:
                async with websockets.connect(self.ws_url, ping_interval=20) as ws:
                    sub_msg = {"assets_ids": self.asset_ids, "type": "MARKET"}
                    await ws.send(json.dumps(sub_msg))
                    logger.info(f"📡 WSS Conectado. Suscrito a {len(self.asset_ids)} assets.")

                    while not self._stop_event.is_set():
                        try:
                            msg = await asyncio.wait_for(ws.recv(), timeout=1.0)
                            payload = json.loads(msg)
                            msgs = payload if isinstance(payload, list) else [payload]
                            
                            updates_count = 0
                            for m in msgs:
                                if not isinstance(m, dict): continue
                                et = m.get("event_type")
                                aid = m.get("asset_id")
                                
                                if et == "book" and aid in self._books:
                                    self._books[aid].apply_snapshot(m)
                                    updates_count += 1
                                elif et == "price_change":
                                    for ch in m.get("price_changes", []) or []:
                                        caid = ch.get("asset_id")
                                        if caid in self._books:
                                            self._books[caid].apply_price_changes({"price_changes": [ch]})
                                            updates_count += 1
                            
                            if updates_count > 0:
                                self.updated_event.set()

                        except asyncio.TimeoutError:
                            continue # Check stop event
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"⚠️ WSS Desconectado: {e}. Reintentando en 2s...")
                await asyncio.sleep(2)


# --- MARKET LOOKUP LOGIC ---

def fetch_market_info(slug: str) -> Dict[str, Any]:
    """Obtiene ID del mercado y Token IDs dado un slug."""
    url = f"https://polymarket.com/event/{slug}"
    #logger.info(f"🔍 Buscando info del mercado: {slug}")
    
    try:
        resp = httpx.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        resp.raise_for_status()
        
        m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', resp.text, re.DOTALL)
        if not m: raise ValueError("No se encontró NEXT_DATA en la página")
        
        data = json.loads(m.group(1))
        queries = data.get("props", {}).get("pageProps", {}).get("dehydratedState", {}).get("queries", [])
        
        market = None
        for q in queries:
            d = q.get("state", {}).get("data")
            if isinstance(d, dict) and "markets" in d:
                for mk in d["markets"]:
                    if mk.get("slug") == slug:
                        market = mk
                        break
        
        if not market: raise ValueError("Market data not found in state")
        
        clob_tokens = market.get("clobTokenIds") or []
        if len(clob_tokens) != 2: raise ValueError("Mercado no binario o faltan tokens")
        
        return {
            "market_id": market.get("id"),
            "yes_token": clob_tokens[0],
            "no_token": clob_tokens[1],
            "end_date": market.get("endDate"), # ISO string
            "slug": slug
        }
    except Exception as e:
        logger.error(f"❌ Error buscando mercado {slug}: {e}")
        return None

def find_active_btc_market() -> Optional[str]:
    """Encuentra el slug del mercado BTC 15min activo actual."""
    now_ts = int(datetime.now().timestamp())
    # Generar slugs probables
    for i in range(5):
        ts = now_ts + (i * BTC_15M_WINDOW)
        ts_rounded = (ts // BTC_15M_WINDOW) * BTC_15M_WINDOW
        slug = f"btc-updown-15m-{ts_rounded}"
        
        # Verificar si es futuro cercano
        if now_ts < ts_rounded + BTC_15M_WINDOW:
            # Validar que existe (simple check)
            try:
                fetch_market_info(slug)
                return slug
            except:
                pass
    return None


# --- MAIN LOGIC ---

async def monitor_market(market_info: dict):
    yes_token = market_info["yes_token"]
    no_token = market_info["no_token"]
    slug = market_info["slug"]
    
    # Calcular fin del mercado base al slug
    match = re.search(r'btc-updown-15m-(\d+)', slug)
    start_ts = int(match.group(1)) if match else 0
    end_ts = start_ts + BTC_15M_WINDOW
    
    logger.info(f"🎯 MERCADO ACTIVO ENCONTRADO: {slug}")
    logger.info(f"   Tokens: YES={yes_token} | NO={no_token}")
    logger.info(f"   Cierra en: {int(end_ts - time.time())}s")

    # Iniciar WSS
    wss = MarketWssClient([yes_token, no_token])
    wss_task = asyncio.create_task(wss.run())
    
    logger.info("⏳ Esperando datos de order book...")
    await asyncio.sleep(2) # Dar tiempo a conectar

    try:
        last_log_ts = 0.0
        
        while True:
            # EVENT-DRIVEN LOOP: Esperar actualización del WSS
            try:
                # Esperar hasta 1s (para chequear cierre de mercado también)
                await asyncio.wait_for(wss.updated_event.wait(), timeout=0.1)
                wss.updated_event.clear()
            except asyncio.TimeoutError:
                pass # Continuar si no hay update para chequear tiempo

            now = time.time()
            remaining = end_ts - now
            
            if remaining <= 0:
                logger.info("🛑 MERCADO CERRADO. Buscando siguiente...")
                break
                
            # Obtener precios
            yes_book = wss.get_book(yes_token)
            no_book = wss.get_book(no_token)
            
            best_ask_yes = yes_book.get_best_ask()
            best_ask_no = no_book.get_best_ask()
            
            if best_ask_yes and best_ask_no:
                total_cost = best_ask_yes + best_ask_no
                profit_pct = (1.0 - total_cost) * 100
                
                log_msg = (
                    f"[{int(remaining)}s] "
                    f"YES: ${best_ask_yes:.4f} | NO: ${best_ask_no:.4f} | "
                    f"SUM: ${total_cost:.4f}"
                )
                
                # SI HAY ARB: Imprimir SIEMPRE y rápido
                if total_cost < 1.0:
                    logger.info(f"💎 {log_msg} | 🚀 PURE ARB: {profit_pct:.2f}% PROFIT!")
                
                # SI NO HAY ARB: Imprimir todo lo que llegue para máxima velocidad visual
                else:
                    logger.info(f"   {log_msg}")
            else:
                if now - last_log_ts >= 1.0:
                    logger.debug("   Esperando liquidez en ambos lados...")
                    last_log_ts = now
            
    finally:
        wss.stop()
        await wss_task

async def main():
    logger.info("🤖 INICIANDO MONITOR DE PURE ARB (SINGLE FILE) 🤖")
    
    while True:
        try:
            # 1. Buscar mercado
            logger.info("🔎 Buscando mercado activo...")
            slug = find_active_btc_market()
            
            if not slug:
                logger.warning("⚠️ No se encontró mercado activo. Reintentando en 10s...")
                await asyncio.sleep(10)
                continue
                
            info = fetch_market_info(slug)
            if not info:
                await asyncio.sleep(5)
                continue
                
            # 2. Monitorizar mercado hasta que cierre
            await monitor_market(info)
            
            # 3. Esperar un poco antes de buscar el siguiente para evitar rate limit/spam
            await asyncio.sleep(5)
            
        except Exception as e:
            logger.error(f"💥 Error crítico en main loop: {e}")
            await asyncio.sleep(5)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("👋 Bot detenido por usuario.")
