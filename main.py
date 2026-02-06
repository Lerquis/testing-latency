"""
Polymarket Latency Test
Mide la latencia hacia los servidores de Polymarket desde el servidor actual.
"""

import time
import httpx
import logging
import os
import asyncio
from datetime import datetime
import simple_pure_arb

# Configurar logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Endpoints de Polymarket
ENDPOINTS = [
    ('CLOB API', 'https://clob.polymarket.com/'),
    ('Gamma API', 'https://gamma-api.polymarket.com/'),
    ('WebSocket', 'https://ws-subscriptions-clob.polymarket.com/'),
]

# Número de pruebas por endpoint
NUM_TESTS = 10

# Intervalo entre ciclos de prueba (segundos)
TEST_INTERVAL = int(os.getenv('TEST_INTERVAL', '60'))


def measure_latency(url: str, timeout: float = 10) -> float | None:
    """Mide la latencia de una request HTTP GET."""
    try:
        start = time.time()
        with httpx.Client() as client:
            client.get(url, timeout=timeout)
        return (time.time() - start) * 1000  # Convert to ms
    except Exception as e:
        logger.error(f"Error midiendo latencia para {url}: {e}")
        return None


def run_latency_test():
    """Ejecuta un ciclo completo de pruebas de latencia."""
    logger.info("=" * 60)
    logger.info("🌐 TEST DE LATENCIA A POLYMARKET")
    logger.info(f"📅 {datetime.now().isoformat()}")
    logger.info("=" * 60)
    
    results = {}
    
    for name, url in ENDPOINTS:
        latencies = []
        for i in range(NUM_TESTS):
            latency = measure_latency(url)
            if latency is not None:
                latencies.append(latency)
            time.sleep(0.1)  # Pequeña pausa entre requests
        
        if latencies:
            avg = sum(latencies) / len(latencies)
            min_lat = min(latencies)
            max_lat = max(latencies)
            
            results[name] = {
                'avg': avg,
                'min': min_lat,
                'max': max_lat,
                'success_rate': len(latencies) / NUM_TESTS * 100
            }
            
            logger.info(f"\n📊 {name}:")
            logger.info(f"   Promedio:    {avg:.0f}ms")
            logger.info(f"   Mínimo:      {min_lat:.0f}ms")
            logger.info(f"   Máximo:      {max_lat:.0f}ms")
            logger.info(f"   Éxito:       {len(latencies)}/{NUM_TESTS}")
        else:
            logger.warning(f"\n❌ {name}: Todas las pruebas fallaron")
    
    # Resumen general
    logger.info("\n" + "=" * 60)
    logger.info("📈 RESUMEN")
    logger.info("=" * 60)
    
    if results:
        avg_total = sum(r['avg'] for r in results.values()) / len(results)
        logger.info(f"   Latencia promedio general: {avg_total:.0f}ms")
        
        if avg_total < 50:
            logger.info("   ⭐ Latencia EXCELENTE - Ideal para arbitraje")
        elif avg_total < 100:
            logger.info("   ✅ Latencia BUENA - Aceptable para trading")
        elif avg_total < 200:
            logger.info("   ⚠️  Latencia MODERADA - Subóptima para arbitraje")
        else:
            logger.info("   🔴 Latencia ALTA - No recomendada para arbitraje")
    
    logger.info(f"\n📍 Polymarket servers: Londres (eu-west-2)")
    logger.info("=" * 60)
    
    return results


def main():
    """Función principal."""
    os.system('cls' if os.name == 'nt' else 'clear')
    
    # 1. Correr Latency Test una vez
    run_latency_test()
    
    # 2. Pasar control al bot de arbitraje
    print("\n" + "="*60)
    logger.info("🚀 Transfiriendo control a Simple Pure Arb...")
    print("="*60 + "\n")
    
    try:
        asyncio.run(simple_pure_arb.main())
    except KeyboardInterrupt:
        logger.info("\n👋 Programa finalizado por usuario")
    except Exception as e:
        logger.error(f"Error fatal ejecutando pure arb: {e}")


if __name__ == "__main__":
    main()

