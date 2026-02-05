# Polymarket Latency Test

Mide la latencia hacia los servidores de Polymarket desde diferentes regiones.

## Uso Local

```bash
pip install -r requirements.txt
python main.py
```

## Deploy en Render.com

1. Crear repo en GitHub con estos archivos
2. En Render.com: New → Background Worker
3. Conectar el repo de GitHub
4. Seleccionar región (Frankfurt recomendado)
5. Runtime: Python 3
6. Build Command: `pip install -r requirements.txt`
7. Start Command: `python main.py`

## Variables de Entorno

| Variable        | Default | Descripción            |
| --------------- | ------- | ---------------------- |
| `TEST_INTERVAL` | 60      | Segundos entre pruebas |

## Regiones de Render.com

| Región    | Latencia esperada a Polymarket |
| --------- | ------------------------------ |
| Frankfurt | ~15-25ms                       |
| Oregon    | ~150-200ms                     |
| Ohio      | ~100-150ms                     |
| Singapore | ~250-300ms                     |

## Salida de Ejemplo

```
🌐 TEST DE LATENCIA A POLYMARKET
📅 2026-02-05T00:00:00

📊 CLOB API:
   Promedio:    18ms
   Mínimo:      15ms
   Máximo:      25ms
   Éxito:       10/10

📈 RESUMEN
   Latencia promedio general: 18ms
   ⭐ Latencia EXCELENTE - Ideal para arbitraje
```
