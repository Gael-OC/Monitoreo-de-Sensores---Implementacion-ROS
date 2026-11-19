# Plataforma de monitoreo

El panel y el recolector son procesos independientes. El recolector necesita ROS 2 Jazzy; la API y sus pruebas funcionan sin ROS. Requisitos: Python 3.12+, SQLite con JSON1 y MongoDB existente. Raspberry Pi: usar Ubuntu 24.04 de 64 bits para mantener el entorno ROS; pendiente de validar con hardware ARM.

## Instalación

Desde la raíz, en Ubuntu:

```bash
python3 -m venv --system-site-packages .venv
.venv/bin/pip install -r monitoring/requirements.txt
cp monitoring/.env.example monitoring/.env
bash scripts/start-monitoring.sh collector
# Otra terminal:
bash scripts/start-monitoring.sh web
```

En macOS, crear el venv sin `--system-site-packages` y arrancar solo el servidor:

```bash
.venv/bin/python -m uvicorn monitoring.api:app --host 127.0.0.1 --port 8000
```

Abrir http://127.0.0.1:8000. No se generan datos de demostración automáticamente. Las variables del proceso tienen prioridad, seguidas de `monitoring/.env` y `database/.env`. Mantener secretos fuera de Git. `MONGO_URI` y `MONGO_DB` reutilizan la configuración existente; `MONITOR_COLLECTION_PREFIX` vale `monitor_v1_`. Para pruebas aisladas usar otro prefijo y otro `MONITOR_SQLITE`.

Cada gateway debe tener un `GATEWAY_ID` distinto y estable. SQLite vive por defecto en `.monitoring/gateway.sqlite3`; hacer copias con la API de backup de SQLite, no copiando solo el archivo mientras hay procesos activos. Cada gateway conserva únicamente su copia local; la API central combina módulos mediante MongoDB. Si MongoDB cae, el panel del gateway sigue mostrando sus propios datos y deja de recibir novedades de otros gateways.

## Frecuencia del ESP

El firmware del fork publica cada 60 segundos (`PUBLISH_INTERVAL_MS=60000`). La placa USB del laboratorio es `240AC460C8E0`; el otro ESP requiere una actualización independiente cuando esté disponible por USB. No se cambia el intervalo de comprobación de conectividad del Agent.

La API admite `expected_interval_seconds` en los metadatos de cada módulo. El estado reciente usa `max(30, 3 × intervalo esperado)` segundos; para una publicación por minuto tolera 180 segundos. La actualización visual sigue siendo cada 10 segundos, sin inventar nuevas muestras entre señales.

## Qué se conserva

- Último mensaje por dispositivo para el panel; se sobreescribe y replica aproximadamente cada 10 segundos.
- Primera lectura recibida en cada minuto UTC, con retención de siete días después de sincronizar. Los pendientes no se eliminan aunque sean antiguos.
- Un documento horario por gateway, dispositivo y contexto: promedio aritmético descriptivo, mínimo, máximo y conteo por variable. Conservación indefinida. Cada lectura por minuto tiene igual peso; no es un promedio de todas las publicaciones de cuatro segundos.
- La puntual es la primera lectura del primer minuto de la hora. Si falta, no se sustituye con una lectura posterior. Cada sensor conserva su conteo; 60 muestras representan cobertura completa. La hora actual es provisional y se actualiza al ingresar minutos nuevos.
- El selector solo cambia presentación/exportación. No modifica adquisición ni borra la alternativa.

El contexto se copia en cada muestra. El contexto inicial es `dry_test`. No mezclar señales en seco con experimentos. En lecturas parciales no se exige pH ni temperatura. El firmware actual no comunica errores por canal de forma fiable: los números y el voltaje de diagnóstico quedan como calidad `unverified`, sin afirmar precisión ni inmersión. Las constantes de calibración existentes permanecen intactas.

Las fechas son de recepción en el gateway; `measured_at` es nulo para el ESP actual. El histórico antiguo usa la fecha de guardado y `source=legacy_storage_time`. Pantalla y filtros usan America/Santiago, incluyendo cambios de horario: los días pueden tener 23 o 25 horas.

## API y adaptación

- `GET /api/v1/devices`: configuración, última lectura, antigüedad y estado de sincronización.
- `PATCH /api/v1/devices/{gateway}/{device}`: `alias`, `location`, `expected_interval_seconds`, `context` (`dry_test`, `culture`, `unknown`). Los cambios remotos se aplican cuando el gateway sincroniza.
- `GET /api/v1/history` y `/api/v1/export.csv`: `gateway`, `device`, `start`, `end` (fechas con zona; intervalo semiabierto), `resolution=hour|minute`, `mode=summary|point`, `context` opcional. Rango máximo 31 días por solicitud. Exportar períodos mayores por partes.
- `GET /healthz`: pendientes y disponibilidad central observada en la última operación. No certifica la salud física de los sensores.
- `/docs`: contrato OpenAPI. No hay endpoint de órdenes a motores ni ingesta pública.

El futuro adaptador digital debe llamar `monitoring.model.reading()` con un mapa variable de mediciones. Cada variable incluye `value`, `unit`, `quality`; las identidades son cadenas estables. Ejemplo probado: oxígeno sin pH ni temperatura. El adaptador debe normalizar las unidades antes de ingresar datos. El protocolo físico del otro proyecto no está implementado.

## Activación y reversión en el laboratorio

Respaldar cambios locales, configuración privada y estado de servicios antes de actualizar. Desplegar esta carpeta por separado; no sobrescribir el firmware o el repositorio operativo. Para probar con las señales reales, basta iniciar el nuevo recolector junto al original: usa otro nombre ROS y otras colecciones.

Después de verificar la prueba paralela, detener sus procesos temporales antes de instalar los servicios. Ejecutar desde el PC:

```bash
sudo bash scripts/monitoring-services.sh activate
```

El script guarda servicios/cron, conserva el Agent, retira el puente anterior y Telegram del flujo activo y habilita recolector/panel con systemd y acceso privado Tailscale Serve. Puede pedir habilitar HTTPS en la tailnet. No usar Funnel. El servidor solo escucha en loopback. No exponerlo públicamente sin añadir autenticación y autorización a la API. La protección de origen de las escrituras no reemplaza la autenticación.

Reversión:

```bash
sudo bash scripts/monitoring-services.sh rollback
```

Consultar `journalctl -u monitoring-collector -u monitoring-web`, `tailscale serve status` y `/healthz`. Un disco lleno provoca error visible del recolector: no se borran pendientes para ocultarlo. La cola requiere espacio disponible durante cortes prolongados.

## Historial antiguo

El importador escribe únicamente en las colecciones nuevas y SQLite; el origen se mantiene intacto. Selecciona la primera lectura válida por minuto y etiqueta todo como contexto desconocido, sin inventar fecha de adquisición. Ejecutarlo con un límite fijo anterior al inicio de la captura nueva; repetir el mismo comando no duplica registros:

```bash
.venv/bin/python -m monitoring.import_legacy --before 2026-11-16T02:00:00+00:00
```

Cambiar el límite del ejemplo por la hora real de corte registrada en el despliegue. No ejecutarlo contra el archivo SQLite de otro gateway. La importación puede requerir varios lotes de sincronización.

## Verificación

```bash
.venv/bin/pip install -r monitoring/requirements-dev.txt
.venv/bin/python -m unittest discover -s tests -v
node --check monitoring/static/comun.js monitoring/static/app.js monitoring/static/pared.js
bash -n scripts/start-monitoring.sh scripts/monitoring-services.sh
```

Las pruebas cubren identidades, mensajes corruptos, selección por minuto, puntual/resumen, contextos, sensor digital parcial, reinicio con pendientes, reintentos, reconocimiento concurrente, CSV y validación HTTP. La desconexión de Mongo se simula sin cortar la red real ni provocar avisos Telegram. Node solo se usa para verificar sintaxis, no es dependencia de producción.

## Pantallas del panel

Cada ruta ocupa una pantalla completa, sin desplazar la página; lo que no cabe se desplaza dentro de su propio recuadro. En pantallas angostas (menos de 960 px) o bajas (menos de 640 px) vuelve a ser una página normal.

- `/` En vivo: microalga ASCII que refleja el estado de los nodos visibles, una tarjeta compacta por nodo, red de sensores, escala de pH y señales entrantes.
- `/nodos`: tarjetas completas con anillo de próxima señal, tendencia de 24 h (promedio por hora), mínimo y máximo de 24 h, cobertura de la hora en curso y configuración. Incluye el intervalo esperado (`expected_interval_seconds`).
- `/historial`: filtros, gráficos con banda mínimo–máximo por hora y tabla. Acepta `?nodo=<gateway>:<dispositivo>`.
- `/pared`: modo TV oscuro, pensado para 1920×1080 y escalable. Muestra hasta seis nodos; `?nodos=ID1,ID2` fija cuáles.

La selección de nodos visibles se guarda en el navegador (`localStorage`) y la comparten las cuatro rutas de ese mismo navegador. Estados: «Recibiendo», «Atrasado» (más de 1,5 veces el intervalo más el ciclo de consulta), «Sin datos recientes» (la misma regla que `recent` en la API) y «Esperando señal». La CSP solo permite estilos y scripts propios, así que no hay estilos en línea ni fuentes externas. Las animaciones se detienen si el sistema pide reducir movimiento.

## Rendimiento del navegador

Los cambios de filtros cancelan la solicitud anterior y muestran carga inmediata. El gráfico conserva la serie completa; para más de 240 puntos dibuja una línea SVG sin miles de círculos individuales. La tabla muestra los últimos 200 registros, con aviso explícito; el CSV incluye todo el rango seleccionado.

## Prueba de cola realizada

Se usó una copia SQLite aislada con lecturas reales y una URI Mongo hacia un puerto local cerrado. Los ocho registros pendientes sobrevivieron al error `ServerSelectionTimeoutError` y a la reapertura del archivo. Después se enviaron a `monitor_queue_proof_*`: dos dispositivos, dos últimas señales, dos muestras por minuto y dos horas. Una segunda sincronización no añadió duplicados. La red y la base activa no se detuvieron durante la prueba.

## Captura limitada a la placa USB

En el laboratorio está configurado `MONITOR_DEVICE_IDS=240AC460C8E0` en `monitoring/.env`. El recolector ignora los mensajes de otros IDs y el panel oculta esos módulos del gateway local. El historial anterior permanece almacenado, sin nuevos registros del módulo excluido. Vaciar esta variable vuelve a admitir todos los dispositivos; reiniciar API y recolector después de cambiarla.

## WiFi antes de recompilar

La configuración antigua apuntaba a `Microalgas-Gateway`, mientras el hotspot activo de este PC es `lab-ros`. Para evitar grabar una placa con credenciales antiguas, el asistente selecciona el perfil activo por UUID (pueden existir varios perfiles llamados Hotspot), sin imprimir la contraseña:

```bash
sudo python3 /home/lab-ros/microalgas-monitor/scripts/configure-lab-wifi.py /home/lab-ros/Documentos/Github/sensores/microros-esp
```

Después compilar con ESP-IDF de la instalación y usar `app-flash`, sin `erase_flash`. La imagen nueva publica una lectura al arrancar y luego cada 60 segundos. El respaldo completo previo permanece en el PC, en la ruta indicada por `.monitoring/firmware-backup-path.txt`. El asistente solo lee el perfil normal de NetworkManager, no extrae credenciales del respaldo de flash.

La preparación WiFi ahora ocurre en el CMake raíz **antes** de cargar `project.cmake` y Kconfig. El mismo generador actualiza `wifi_config.h`, el `sdkconfig` existente y los valores por defecto para la primera compilación. Se admiten valores entre comillas en `.env`. El componente `main` ya no reescribe credenciales después de cargar la configuración. El archivo generado `.wifi-sdkconfig.defaults` contiene secretos y está excluido de Git.
